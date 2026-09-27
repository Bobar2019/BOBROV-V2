"""Enregistrement stéréoscopique 3D — deux flux remuxés sans réencodage.

La case « 3D » du cockpit (et l'action manette ``rec_3d``) déclenche la
capture simultanée des deux caméras — gauche (``cameras.stereo.left_device``)
et droite (``cameras.stereo.right_device``) — dans deux fichiers MP4 horodatés
``<stamp>_camG.mp4`` et ``<stamp>_camD.mp4``, déposés dans la médiathèque
(dossier ``videos.folder``).

Chaque fichier est produit par un processus ffmpeg d'arrière-plan qui pompe
le flux JPEG sans le réencoder (``-c:v copy``). Pendant la vue live, les
périphériques sont tenus exclusivement par la capture Python : ffmpeg
s'abonne donc au relais MJPEG local (``/api/video/<cam>`` où ``<cam>`` est la
caméra du cockpit qui porte le périphérique, cam1/cam2/cam3) plutôt
que d'ouvrir ``/dev/video*`` ; un périphérique non relayé (troisième caméra)
est ouvert directement en V4L2.

Horodatage ``-use_wallclock_as_timestamps 1`` : chaque trame est datée à son
arrivée réelle. C'est le seul estampillage toujours fidèle — la LifeCam varie
spontanément entre 15 et 30 i/s selon l'exposition, une cadence supposée
fausserait la durée des fichiers. Les MP4 produits sont en MJPEG (tag
``mp4v``) : lecture recommandée avec VLC, les balises HTML5 des navigateurs
ne décodent pas ce codec.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import signal
import subprocess
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.config import get_config
from app.video import get_video
from app.videos import get_library, mp4_duration_s

log = logging.getLogger("bobrov.stereo")

_FFMPEG = "ffmpeg"
_RW_TIMEOUT_US = 10_000_000     # relais muet > 10 s : ffmpeg s'arrête de lui-même
_WARM_TIMEOUT_S = 2.5           # attente des premières trames des relais préchauffés
_WARM_HOLD_S = 1.5              # maintien des abonnements de préchauffage après lancement
_START_CHECK_S = 0.8            # contrôle de survie des deux ffmpeg juste après lancement
_STOP_GRACE_S = 6.0             # délai maximal de finalisation après SIGINT
_STDERR_TAIL = 40               # lignes de diagnostic conservées par côté


class StereoError(RuntimeError):
    """Enregistrement 3D refusé : état incompatible, ffmpeg absent, config invalide."""


def ffmpeg_available() -> bool:
    """Vrai si le binaire ffmpeg est installé (prérequis de l'enregistrement 3D)."""
    return shutil.which(_FFMPEG) is not None


def _now_stamp() -> str:
    """Horodatage des fichiers : AAAAMMJJ_HHMMSS (même format que le cockpit)."""
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _file_size(path: Path) -> int:
    """Taille du fichier en octets, 0 s'il a disparu entre-temps (course)."""
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _drain_stderr(proc: subprocess.Popen, tail: deque) -> None:
    """Vide le stderr d'ffmpeg dans un tampon borné — jamais bloquer le processus."""
    try:
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            if line:
                tail.append(line)
    except (OSError, ValueError):
        pass


def _build_command(device: str, relay_cam: str | None, port: int, target: Path) -> list[str]:
    """Ligne de commande ffmpeg d'un œil : remux copie, horodatage wallclock.

    ``relay_cam`` renseigné : le relais multipart local est démuxé en MJPEG
    (le périphérique est alors déjà tenu par la capture Python du relais) ;
    sinon le périphérique est ouvert directement en V4L2.
    """
    cmd = [_FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "warning",
           "-use_wallclock_as_timestamps", "1"]
    if relay_cam:
        cmd += ["-rw_timeout", str(_RW_TIMEOUT_US),
                "-f", "mpjpeg", "-i", f"http://127.0.0.1:{port}/api/video/{relay_cam}"]
    else:
        cmd += ["-f", "v4l2", "-input_format", "mjpeg", "-i", device]
    return cmd + ["-c:v", "copy", "-y", str(target)]


class _Side:
    """Un œil de la paire 3D : processus ffmpeg, fichier cible et diagnostics."""

    def __init__(self, key: str, device: str, relay_cam: str | None, target: Path) -> None:
        self.key = key                      # « left » (camG) ou « right » (camD)
        self.device = device
        self.relay_cam = relay_cam          # cam1/cam2/cam3 quand le périphérique est relayé
        self.target = target
        self.proc: subprocess.Popen | None = None
        self.stderr_tail: deque = deque(maxlen=_STDERR_TAIL)
        self.error: str | None = None

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def public(self) -> dict:
        return {
            "key": self.key,
            "device": self.device,
            "relay_cam": self.relay_cam,
            "file": self.target.name,
            "bytes": _file_size(self.target),
            "alive": self.alive(),
            "error": self.error,
        }


class StereoRecorder:
    """Machine à états du double enregistrement (un seul enregistrement à la fois)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = "idle"                # idle | recording | stopping | error
        self._sides: dict[str, _Side] = {}
        self._stamp = ""
        self._started_at = 0.0
        self._last_error: str | None = None

    # -- Lecture ---------------------------------------------------------------

    def status(self) -> dict:
        with self._lock:
            if self._state == "recording":
                for side in self._sides.values():
                    _refresh_side_state(side)
                if self._sides and all(side.error for side in self._sides.values()):
                    self._state = "error"
                    self._last_error = self._last_error or "les deux flux se sont arrêtés avant l'arrêt demandé"
            return {
                "state": self._state,
                "recording": self._state in ("recording", "stopping"),
                "ffmpeg": ffmpeg_available(),
                "started_at": self._started_at or None,
                "elapsed_s": (round(time.time() - self._started_at, 1)
                              if self._state in ("recording", "stopping") else None),
                "stamp": self._stamp or None,
                "sides": [side.public() for side in self._sides.values()],
                "last_error": self._last_error,
            }

    # -- Commandes -------------------------------------------------------------

    def start(self) -> dict:
        """Préchauffe les relais puis lance les deux ffmpeg (fichiers camG/camD)."""
        if not ffmpeg_available():
            raise StereoError("ffmpeg introuvable sur le Raspberry Pi — "
                              "installez-le (« apt install ffmpeg »)")
        with self._lock:
            if self._state == "error":
                raise StereoError("l'enregistrement 3D précédent doit d'abord être clôturé (STOP)")
            if self._state != "idle":
                raise StereoError("un enregistrement 3D est déjà en cours")
            cfg = get_config().get()
            stereo = cfg["cameras"]["stereo"]
            devices = {"left": str(stereo["left_device"]).strip(),
                       "right": str(stereo["right_device"]).strip()}
            relays = {}
            for name in ("cam1", "cam2", "cam3"):
                cam = cfg["cameras"].get(name) or {}
                device = str(cam.get("device", "")).strip()
                if device:
                    relays[device] = name
            folder = get_library().folder()
            stamp = _now_stamp()
            names = {"left": f"{stamp}_camG.mp4", "right": f"{stamp}_camD.mp4"}
            sides = {key: _Side(key, device, relays.get(device), folder / names[key])
                     for key, device in devices.items()}
            for side in sides.values():
                if side.target.exists():
                    raise StereoError(f"{side.target.name} existe déjà — relancez dans une seconde")
            port = int(cfg["network"]["port"])
            self._sides = sides
            self._stamp = stamp
            self._state = "recording"
            self._started_at = time.time()
            self._last_error = None
        # -- hors verrou : préchauffage, lancement, contrôle de survie --
        warm = []
        for side in sides.values():
            source = get_video().source(side.relay_cam) if side.relay_cam else None
            if source is not None:
                source.add_client(quiet=True)
                warm.append(source)
        deadline = time.monotonic() + _WARM_TIMEOUT_S
        for source in warm:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            source.wait_fresh_frame(2.0, timeout=remaining)
        failed: str | None = None
        for side in sides.values():
            try:
                side.proc = subprocess.Popen(
                    _build_command(side.device, side.relay_cam, port, side.target),
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE)
            except OSError as exc:
                failed = f"lancement ffmpeg impossible pour {side.device} : {exc}"
                break
            threading.Thread(target=_drain_stderr, args=(side.proc, side.stderr_tail),
                             name=f"bobrov-stereo-{side.key}", daemon=True).start()
        if failed is None:
            # ffmpeg meurt en moins d'une seconde sur périphérique occupé ou
            # relais injoignable : on rend la main avec un diagnostic clair.
            time.sleep(_START_CHECK_S)
            dead = [side for side in sides.values() if not side.alive()]
            if dead:
                failed = "capture 3D impossible — " + " · ".join(
                    f"{side.key} : {side.stderr_tail[-1] if side.stderr_tail else 'arrêt immédiat'}"
                    for side in dead)
        if failed is not None:
            self._teardown(sides, warm)
            raise StereoError(failed)
        threading.Thread(target=_release_warmers, args=(warm,),
                         name="bobrov-stereo-warm", daemon=True).start()
        for side in sides.values():
            log.info("stéréo : %s (%s%s) → %s", side.key, side.device,
                     f" via relais {side.relay_cam}" if side.relay_cam else " en direct",
                     side.target.name)
        log.info("enregistrement 3D lancé (%s)", stamp)
        return self.status()

    def stop(self) -> dict:
        """SIGINT aux deux ffmpeg (finalisation du moov) puis rapport des fichiers."""
        with self._lock:
            if self._state not in ("recording", "error", "stopping"):
                raise StereoError("aucun enregistrement 3D en cours")
            self._state = "stopping"
            sides = list(self._sides.values())
            started_at = self._started_at
            stamp = self._stamp
        for side in sides:
            if side.alive():
                try:
                    side.proc.send_signal(signal.SIGINT)
                except OSError:
                    pass
        deadline = time.monotonic() + _STOP_GRACE_S
        for side in sides:
            if side.proc is None:
                continue
            try:
                side.proc.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                log.warning("stéréo : %s n'a pas finalisé à temps — arrêt forcé", side.key)
                side.proc.kill()
                try:
                    side.proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    pass
        result = {"stamp": stamp, "seconds": round(time.time() - started_at, 1), "files": []}
        for side in sides:
            entry = {"key": side.key, "device": side.device, "file": side.target.name}
            entry["bytes"] = _file_size(side.target)
            entry["duration_s"] = (round(mp4_duration_s(side.target) or 0.0, 3)
                                   if entry["bytes"] else 0.0)
            if side.error:
                entry["error"] = side.error
            elif entry["bytes"] == 0:
                entry["error"] = "fichier vide : la capture n'a rien produit"
            result["files"].append(entry)
        with self._lock:
            self._state = "idle"
            self._sides = {}
            self._stamp = ""
            self._started_at = 0.0
            self._last_error = None
        log.info("enregistrement 3D terminé (%ss) : %s", result["seconds"],
                 " · ".join(f"{entry['file']} ({entry['bytes'] / 1e6:.1f} Mo)"
                            for entry in result["files"]))
        return result

    def shutdown(self) -> None:
        """Arrêt du service : clôture propre de l'enregistrement en cours."""
        with self._lock:
            active = self._state in ("recording", "error", "stopping")
        if not active:
            return
        log.info("arrêt du service : clôture de l'enregistrement 3D en cours")
        try:
            self.stop()
        except StereoError:
            pass

    # -- Interne ---------------------------------------------------------------

    def _teardown(self, sides: dict[str, _Side], sources: list) -> None:
        """Échec de lancement : tue les ffmpeg partis, efface les fichiers partiels."""
        for side in sides.values():
            if side.alive():
                try:
                    side.proc.kill()
                    side.proc.wait(timeout=2.0)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            try:
                if side.target.exists():
                    side.target.unlink()
            except OSError:
                pass
        _release_warmers(sources, hold_s=0.0)
        with self._lock:
            self._state = "idle"
            self._sides = {}
            self._stamp = ""
            self._last_error = None


def _release_warmers(sources: list, hold_s: float | None = None) -> None:
    """Rend les abonnements de préchauffage (les relais voient alors ffmpeg)."""
    hold = _WARM_HOLD_S if hold_s is None else hold_s
    if hold > 0:
        time.sleep(hold)
    for source in sources:
        source.remove_client(quiet=True)


def _refresh_side_state(side: _Side) -> None:
    """Repère un ffmpeg mort en cours d'enregistrement (diagnostic du côté)."""
    if side.error or side.proc is None:
        return
    code = side.proc.poll()
    if code is None:
        return
    detail = side.stderr_tail[-1] if side.stderr_tail else ""
    side.error = f"ffmpeg s'est arrêté (code {code})" + (f" — {detail}" if detail else "")


# ---------------------------------------------------------------------------
# Instance unique
# ---------------------------------------------------------------------------

STEREO = StereoRecorder()


def get_stereo() -> StereoRecorder:
    """Accès au gestionnaire stéréo global (instance unique)."""
    return STEREO


# ---------------------------------------------------------------------------
# Routes /api/stereo
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/stereo", tags=["stereo"])


@router.get("/status", summary="État de l'enregistrement stéréo 3D")
async def stereo_status() -> dict:
    """État temps réel des deux côtés (fichiers, tailles, erreurs éventuelles)."""
    return {"status": "ok", "stereo": get_stereo().status()}


@router.post("/start", summary="Démarrer l'enregistrement stéréo 3D")
async def stereo_start() -> dict:
    """Lance les deux captures (camG/camD) — échoue vite si ffmpeg ou caméra manque."""
    try:
        recording = await asyncio.to_thread(get_stereo().start)
    except StereoError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "ok", "stereo": recording}


@router.post("/stop", summary="Arrêter l'enregistrement stéréo 3D")
async def stereo_stop() -> dict:
    """Finalise les deux MP4 et retourne le rapport (noms, tailles, durées)."""
    try:
        result = await asyncio.to_thread(get_stereo().stop)
    except StereoError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "ok", "result": result, "stereo": get_stereo().status()}
