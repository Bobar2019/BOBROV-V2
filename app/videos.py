"""Médiathèque « Mes Vidéos » — vidéos et photos locales, notes et étoiles.

Les médias vivent dans le dossier ``videos.folder`` de config.json (défaut
``videos/`` à la racine du projet, créé au besoin). Chaque média peut recevoir
une note texte et une évaluation en étoiles (0–5), persistées dans un index
JSON discret ``.bobrov_index.json`` posé à côté des fichiers — supprimer un
média n'affecte jamais l'index des autres.

Le cockpit dépose ici ses enregistrements (``POST /upload``, corps binaire :
photo JPEG ou vidéo WebM issue du navigateur) ; la vue « MES VIDÉOS » y
supprime (``DELETE /file/{name}``) et renomme (``POST /rename``, la fiche
notes/étoiles suit le fichier).

Aperçus web : les captures 3D (MJPEG tagué ``mp4v``) ne sont pas décodées
par les balises HTML5. ``POST /proxy/{name}`` lance en arrière-plan une
conversion H.264 légère (``-preset fast -crf 23 -movflags +faststart``)
vers un fichier distinct ``<stem>_web.mp4`` — le brut reste le rush maître,
jamais modifié. Le listing fusionne l'aperçu dans la ligne de son brut.

Service des fichiers : ``FileResponse`` (Starlette) gère nativement les
requêtes ``Range`` — le lecteur HTML5 peut donc se déplacer dans la vidéo sans
tout télécharger. La durée est extraite en pur Python pour MP4/MOV/M4V
(box ``mvhd``) ; les autres conteneurs affichent « durée inconnue ».

Sécurité : les noms demandés passent par ``resolve()`` — aucun caractère de
chemin, extension vidéo ou photo imposée, le fichier doit exister dans le
dossier ; les dépôts sont plafonnés (1 Gio) et jamais écrasants.
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import shutil
import struct
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from app.config import PROJECT_ROOT, get_config

log = logging.getLogger("bobrov.videos")

VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".mpe", ".mpeg", ".mpg"}
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ALL_EXTENSIONS = VIDEO_EXTENSIONS | PHOTO_EXTENSIONS
INDEX_FILE = ".bobrov_index.json"
MAX_NOTES_LEN = 5000
MAX_INDEX_BYTES = 4 * 1024 * 1024
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024           # 1 Gio : au-delà, dépôt refusé (413)

# Aperçus web : les captures 3D (MJPEG tagué ``mp4v``) ne sont pas décodées
# par les balises HTML5 — un proxy H.264 distinct ``<stem>_web.mp4`` est
# généré à la demande. Le fichier brut (rush maître du montage 3D) est
# toujours lu en lecture seule et jamais modifié.
PROXY_SUFFIX = "_web"
PROXY_CONTAINERS = (".mp4", ".m4v", ".mov")   # conteneurs ISO BMFF analysables
WEB_SAFE_CODECS = frozenset({"avc1", "avc3", "vp09", "av01"})


class LibraryError(ValueError):
    """Vidéo inconnue, nom invalide ou hors dossier — traité en 404 par les routes."""


class LibraryConflictError(LibraryError):
    """Cible déjà occupée (renommage) — traité en 409 par les routes."""


# ---------------------------------------------------------------------------
# Durée MP4/MOV (box mvhd) — sans ffprobe, sans dépendance
# ---------------------------------------------------------------------------

def _iter_boxes(fh, start: int, end: int):
    """Itère les boîtes ISO BMFF (offset, type, taille, taille d'en-tête).

    La position du fichier est resynchronisée sur ``pos`` à chaque tour : le
    lecteur appelant peut avoir déplacé le curseur entre deux itérations.
    """
    pos = start
    while pos + 8 <= end:
        fh.seek(pos)
        header = fh.read(8)
        if len(header) < 8:
            return
        size, kind = struct.unpack(">I4s", header)
        header_size = 8
        if size == 1:                       # largesize (64 bits)
            extra = fh.read(8)
            if len(extra) < 8:
                return
            size = struct.unpack(">Q", extra)[0]
            header_size = 16
        elif size == 0:                     # boîte jusqu'à la fin du fichier
            size = end - pos
        if size < header_size:
            return
        yield pos, kind, size, header_size
        pos += size


def mp4_duration_s(path: Path) -> float | None:
    """Durée en secondes d'un MP4/MOV (box ``mvhd``), ``None`` si illisible."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            file_size = fh.tell()
            for pos, kind, size, header_size in _iter_boxes(fh, 0, file_size):
                if kind != b"moov":
                    continue
                box_end = min(pos + size, file_size)
                for mpos, mkind, _msize, mhsize in _iter_boxes(fh, pos + header_size, box_end):
                    if mkind != b"mvhd":
                        continue
                    fh.seek(mpos + mhsize)
                    data = fh.read(32)
                    if len(data) < 20:
                        return None
                    if data[0] == 1:        # version 1 : timescale/duration 64 bits
                        timescale = int.from_bytes(data[20:24], "big")
                        duration = int.from_bytes(data[24:32], "big")
                    else:                   # version 0 : 32 bits
                        timescale = int.from_bytes(data[12:16], "big")
                        duration = int.from_bytes(data[16:20], "big")
                    if timescale > 0 and duration > 0:
                        return duration / timescale
                    return None
    except (OSError, struct.error):
        return None
    return None


def _first_box(fh, start: int, end: int, kind: bytes):
    """Première boîte ``kind`` dans [start, end) : (position, taille, en-tête)."""
    for pos, box_kind, size, header_size in _iter_boxes(fh, start, end):
        if box_kind == kind:
            return pos, size, header_size
    return None


def _video_handler(fh, mdia_pos: int, mdia_end: int, mdia_header: int) -> bytes | None:
    """Type de média du trak (box ``hdlr``) : ``b\"vide\"`` pour la vidéo."""
    hdlr = _first_box(fh, mdia_pos + mdia_header, mdia_end, b"hdlr")
    if hdlr is None:
        return None
    hpos, _hsize, hheader = hdlr
    fh.seek(hpos + hheader + 8)         # version/flags (4) + pre_defined (4)
    data = fh.read(4)
    return data if len(data) == 4 else None


def mp4_video_codec(path: Path) -> str | None:
    """Codec vidéo d'un MP4/MOV (premier sample entry du trak vidéo).

    Parcourt moov → trak (dont ``hdlr`` vaut ``vide``) → mdia → minf → stbl
    → stsd et lit le 4CC de la première entrée : ``mp4v`` pour le MJPEG des
    captures ffmpeg, ``avc1`` pour du H.264… ``None`` si le fichier n'est pas
    un MP4 analysable ou n'a pas de piste vidéo lisible.
    """
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            file_size = fh.tell()
            moov = _first_box(fh, 0, file_size, b"moov")
            if moov is None:
                return None
            moov_pos, moov_size, moov_header = moov
            moov_end = min(moov_pos + moov_size, file_size)
            for tpos, tkind, tsize, theader in _iter_boxes(fh, moov_pos + moov_header, moov_end):
                if tkind != b"trak":
                    continue
                trak_end = min(tpos + tsize, moov_end)
                mdia = _first_box(fh, tpos + theader, trak_end, b"mdia")
                if mdia is None:
                    continue
                mpos, msize, mheader = mdia
                mdia_end = min(mpos + msize, trak_end)
                if _video_handler(fh, mpos, mdia_end, mheader) != b"vide":
                    continue
                minf = _first_box(fh, mpos + mheader, mdia_end, b"minf")
                if minf is None:
                    continue
                fpos, fsize, fheader = minf
                stbl = _first_box(fh, fpos + fheader, min(fpos + fsize, mdia_end), b"stbl")
                if stbl is None:
                    continue
                spos, ssize, sheader = stbl
                stsd = _first_box(fh, spos + sheader, min(spos + ssize, mdia_end), b"stsd")
                if stsd is None:
                    continue
                epos, _esize, eheader = stsd
                fh.seek(epos + eheader + 8)     # version/flags (4) + entry_count (4)
                entry = fh.read(8)
                if len(entry) < 8:
                    return None
                _entry_size, entry_kind = struct.unpack(">I4s", entry)
                return entry_kind.decode("ascii", "replace")
    except (OSError, struct.error):
        return None
    return None


def proxy_name(name: str) -> str:
    """Nom du fichier aperçu web d'un média : ``<stem>_web.mp4``."""
    return Path(name).stem + PROXY_SUFFIX + ".mp4"


def needs_web_proxy(path: Path) -> bool:
    """Vrai si ce fichier est un MP4/MOV au codec non décodé par les navigateurs.

    Un codec illisible (fichier atypique, parseur en échec) ne déclenche rien :
    on ne propose un aperçu que lorsque l'incompatibilité est certaine.
    """
    if path.suffix.lower() not in PROXY_CONTAINERS:
        return False
    codec = mp4_video_codec(path)
    return codec is not None and codec not in WEB_SAFE_CODECS


# ---------------------------------------------------------------------------
# Bibliothèque
# ---------------------------------------------------------------------------

class VideosLibrary:
    """Accès thread-safe au dossier vidéos et à l'index notes/étoiles."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.folder_override: Path | None = None   # utilisé par les tests

    # -- Dossier & index -------------------------------------------------------

    def folder(self) -> Path:
        if self.folder_override is not None:
            base = self.folder_override
        else:
            rel = str(get_config().get()["videos"]["folder"])
            base = Path(rel) if os.path.isabs(rel) else PROJECT_ROOT / rel
        base.mkdir(parents=True, exist_ok=True)
        return base

    def _index_path(self) -> Path:
        return self.folder() / INDEX_FILE

    def _load_index(self) -> dict:
        path = self._index_path()
        if not path.exists():
            return {}
        try:
            if path.stat().st_size > MAX_INDEX_BYTES:
                log.warning("%s anormalement gros — index ignoré", path)
                return {}
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("index vidéos illisible (%s) — réinitialisé", exc)
            return {}

    def _save_index(self, index: dict) -> None:
        path = self._index_path()
        tmp = path.with_name(path.name + ".tmp")
        try:
            tmp.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:
            raise LibraryError(f"écriture de l'index vidéos impossible : {exc}") from exc

    # -- Résolution sécurisée ----------------------------------------------------

    def resolve(self, name: str) -> Path:
        """Chemin absolu d'un média du dossier — rejette tout nom douteux."""
        if (not name or name != Path(name).name or "/" in name or "\\" in name
                or name in (".", "..") or name.startswith(".")):
            raise LibraryError(f"nom de média invalide : {name!r}")
        if Path(name).suffix.lower() not in ALL_EXTENSIONS:
            raise LibraryError(f"extension non supportée pour {name!r}")
        path = self.folder() / name
        if not path.is_file():
            raise LibraryError(f"média introuvable : {name}")
        return path

    # -- API publique -------------------------------------------------------------

    def list_items(self) -> list[dict]:
        """Tous les médias du dossier, plus récents d'abord (index fusionné).

        Les aperçus web (``<stem>_web.mp4``) sont fusionnés dans la ligne de
        leur brut — jamais listés à part tant que le brut est présent.
        """
        with self._lock:
            folder = self.folder()
            index = self._load_index()
            jobs = get_proxy_jobs()
            items = []
            for path in folder.iterdir():
                suffix = path.suffix.lower()
                if suffix not in ALL_EXTENSIONS or not path.is_file():
                    continue
                if self._is_hidden_proxy(path, folder):
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                meta = index.get(path.name, {})
                item = {
                    "name": path.name,
                    "kind": "photo" if suffix in PHOTO_EXTENSIONS else "video",
                    "size_bytes": stat.st_size,
                    "mtime": stat.st_mtime,
                    "duration_s": (mp4_duration_s(path)
                                   if suffix in (".mp4", ".mov", ".m4v") else None),
                    "stars": int(meta.get("stars", 0) or 0),
                    "notes": str(meta.get("notes", "") or ""),
                }
                if suffix in PROXY_CONTAINERS:
                    item["needs_web"] = needs_web_proxy(path)
                    if item["needs_web"]:
                        proxy = proxy_name(path.name)
                        has_proxy = (folder / proxy).is_file()
                        job = jobs.state(path.name)
                        item["web_proxy"] = proxy if has_proxy else None
                        item["proxy_state"] = ("ready" if has_proxy
                                               else (job["state"] if job else "none"))
                        item["proxy_progress"] = job["progress"] if job else None
                        item["proxy_error"] = job["error"] if job else None
                items.append(item)
            items.sort(key=lambda item: item["mtime"], reverse=True)
            return items

    def _is_hidden_proxy(self, path: Path, folder: Path) -> bool:
        """Vrai pour un ``<stem>_web.mp4`` qui est l'aperçu d'un brut du dossier.

        Le proxy n'est masqué que si son brut existe et a réellement besoin
        d'un aperçu (codec non lisible navigateur) ; sinon c'est un média
        indépendant de la bibliothèque.
        """
        if path.suffix.lower() not in PROXY_CONTAINERS or not path.stem.endswith(PROXY_SUFFIX):
            return False
        base = path.stem[: -len(PROXY_SUFFIX)]
        if not base:
            return False
        for ext in PROXY_CONTAINERS:
            candidate = folder / (base + ext)
            if candidate.is_file():
                return needs_web_proxy(candidate)
        return False

    def purge_partials(self) -> None:
        """Supprime les écritures avortées (``*.part``) d'un arrêt brutal."""
        try:
            for junk in self.folder().glob("*.part"):
                try:
                    junk.unlink()
                    log.info("écriture partielle nettoyée : %s", junk.name)
                except OSError:
                    pass
        except OSError:
            pass

    def meta_get(self, name: str) -> dict:
        """Notes/étoiles d'une vidéo (0 et chaîne vide si jamais annotée)."""
        self.resolve(name)
        with self._lock:
            meta = self._load_index().get(name, {})
        return {"stars": int(meta.get("stars", 0) or 0), "notes": str(meta.get("notes", "") or "")}

    def meta_set(self, name: str, stars: int | None = None, notes: str | None = None) -> dict:
        """Met à jour étoiles et/ou notes ; une fiche vide est retirée de l'index."""
        self.resolve(name)
        if stars is not None and (not isinstance(stars, int) or isinstance(stars, bool) or not 0 <= stars <= 5):
            raise LibraryError("stars : entier attendu entre 0 et 5")
        if notes is not None and (not isinstance(notes, str) or len(notes) > MAX_NOTES_LEN):
            raise LibraryError(f"notes : texte attendu (max {MAX_NOTES_LEN} caractères)")
        with self._lock:
            index = self._load_index()
            current = index.get(name, {})
            new_stars = int(current.get("stars", 0)) if stars is None else stars
            new_notes = str(current.get("notes", "")) if notes is None else notes
            if new_stars == 0 and not new_notes.strip():
                index.pop(name, None)
            else:
                index[name] = {"stars": new_stars, "notes": new_notes}
            self._save_index(index)
            log.info("fiche vidéo mise à jour : %s (%s étoile%s, notes %s)",
                     name, new_stars, "s" if new_stars > 1 else "",
                     f"{len(new_notes)} caractères" if new_notes else "vides")
        return {"stars": new_stars, "notes": new_notes}

    def delete(self, name: str) -> dict:
        """Supprime définitivement un média et retire sa fiche de l'index.

        L'aperçu web du média est retiré avec lui (le cas échéant),
        et une conversion en cours pour ce média est interrompue.
        """
        path = self.resolve(name)
        jobs = get_proxy_jobs()
        jobs.cancel(name)
        remove_proxy = needs_web_proxy(path)        # à évaluer avant l'unlink
        proxy = self.folder() / proxy_name(name)
        with self._lock:
            try:
                path.unlink()
            except OSError as exc:
                raise LibraryError(f"suppression impossible : {exc}") from exc
            removed_meta = False
            index = self._load_index()
            removed_meta = index.pop(name, None) is not None
            if remove_proxy and proxy.is_file():
                try:
                    proxy.unlink()
                    removed_meta = index.pop(proxy.name, None) is not None or removed_meta
                    log.info("aperçu web supprimé avec le média : %s", proxy.name)
                except OSError as exc:
                    log.warning("aperçu web non supprimé (%s) : %s", proxy.name, exc)
            if removed_meta:
                self._save_index(index)
            log.info("média supprimé : %s", name)
        return {"name": name}

    def rename(self, name: str, new_name: str) -> dict:
        """Renomme un média et fait suivre sa fiche notes/étoiles.

        ``new_name`` est un simple nom de fichier ; fourni sans extension,
        celle d'origine est conservée (le média garde son type). Un nom déjà
        occupé est refusé : un renommage n'écrase jamais l'existant. L'aperçu
        web (``<stem>_web.mp4``) suit son brut renommé.
        """
        path = self.resolve(name)
        new_name = str(new_name or "").strip()
        if (not new_name or new_name != Path(new_name).name or "/" in new_name
                or "\\" in new_name or new_name in (".", "..") or new_name.startswith(".")):
            raise LibraryError(f"nouveau nom invalide : {new_name!r}")
        if not Path(new_name).suffix:
            new_name += path.suffix
        if Path(new_name).suffix.lower() not in ALL_EXTENSIONS:
            raise LibraryError(f"extension non supportée pour {new_name!r}")
        with self._lock:
            job = get_proxy_jobs().state(name)
            if job is not None and job["state"] in ("queued", "converting"):
                raise LibraryConflictError(f"aperçu web en cours de génération pour « {name} » — "
                                           "réessayez dans un instant")
            target = self.folder() / new_name
            if target == path:
                return {"name": name}                   # même nom : rien à faire
            if target.exists():
                raise LibraryConflictError(f"un média nommé « {new_name} » existe déjà")
            move_proxy = needs_web_proxy(path)           # à évaluer avant le rename
            proxy_source = self.folder() / proxy_name(name)
            proxy_target = self.folder() / proxy_name(new_name)
            if move_proxy and proxy_source.is_file() and proxy_target.exists():
                raise LibraryConflictError(f"un aperçu web « {proxy_target.name} » existe déjà")
            try:
                path.rename(target)
            except OSError as exc:
                raise LibraryError(f"renommage impossible : {exc}") from exc
            if move_proxy and proxy_source.is_file():
                try:
                    proxy_source.rename(proxy_target)
                    log.info("aperçu web renommé avec le média : %s → %s",
                             proxy_source.name, proxy_target.name)
                except OSError as exc:
                    log.warning("aperçu web non renommé (%s) : %s", proxy_source.name, exc)
            index = self._load_index()
            meta = index.pop(name, None)
            if meta is not None:
                index[new_name] = meta
                self._save_index(index)
            log.info("média renommé : %s → %s", name, new_name)
        return {"name": new_name}

    def prepare_upload(self, name: str) -> Path:
        """Valide un nom de dépôt et réserve un chemin unique dans le dossier.

        Le nom doit être un simple nom de fichier (jamais de chemin), avec une
        extension vidéo ou photo connue. En cas de collision, un suffixe
        ``-1``, ``-2``… est ajouté : un dépôt n'écrase jamais l'existant.
        """
        if (not name or name != Path(name).name or "/" in name or "\\" in name
                or name in (".", "..") or name.startswith(".")):
            raise LibraryError(f"nom de fichier invalide : {name!r}")
        if Path(name).suffix.lower() not in ALL_EXTENSIONS:
            raise LibraryError(f"extension non supportée pour {name!r}")
        with self._lock:
            folder = self.folder()
            candidate = folder / name
            stem, suffix = Path(name).stem, Path(name).suffix
            counter = 1
            while candidate.exists():
                candidate = folder / f"{stem}-{counter}{suffix}"
                counter += 1
            return candidate


LIBRARY = VideosLibrary()


def get_library() -> VideosLibrary:
    """Accès à la médiathèque globale."""
    return LIBRARY


# ---------------------------------------------------------------------------
# Aperçus web — conversions libx264 en arrière-plan
# ---------------------------------------------------------------------------

_FFMPEG = "ffmpeg"


def _ffmpeg_available() -> bool:
    """Vrai si le binaire ffmpeg est installé (prérequis des aperçus web)."""
    return shutil.which(_FFMPEG) is not None


class WebProxyJobs:
    """File d'attente des conversions « aperçu web » (un ffmpeg à la fois).

    Chaque job convertit un brut non lisible navigateur (MJPEG tagué
    ``mp4v``…) en H.264 ``-preset fast -crf 23 -movflags +faststart`` vers
    ``<stem>_web.mp4``. La sortie est écrite en ``.part`` puis renommée
    atomiquement : un aperçu n'apparaît jamais à moitié fait. Le fichier
    source est ouvert en lecture seule — les rushs maîtres ne sont jamais
    modifiés ni écrasés.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._jobs: dict[str, dict] = {}
        self._queue: deque[str] = deque()
        self._worker: threading.Thread | None = None

    # -- API publique ------------------------------------------------------

    def state(self, name: str) -> dict | None:
        """État public du job d'un média (None si aucun job connu)."""
        with self._lock:
            job = self._jobs.get(name)
            if job is None:
                return None
            return {"state": job["state"], "progress": job["progress"], "error": job["error"]}

    def start(self, name: str, source: Path, target: Path) -> dict:
        """Valide puis met en file la conversion (idempotent par média).

        Un job en échec peut être relancé ; un job en cours ou en attente
        renvoie simplement son état. Un aperçu déjà présent renvoie « ready ».
        """
        if not _ffmpeg_available():
            raise LibraryError("ffmpeg introuvable sur le Raspberry Pi — "
                               "installez-le (« apt install ffmpeg »)")
        if target.is_file():
            return {"state": "ready", "progress": None, "error": None}
        with self._lock:
            job = self._jobs.get(name)
            if job is not None and job["state"] != "error":
                return {"state": job["state"], "progress": job["progress"], "error": job["error"]}
            job = {"name": name, "source": source, "target": target,
                   "state": "queued", "progress": None, "error": None, "proc": None}
            self._jobs[name] = job
            self._queue.append(name)
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._worker_loop,
                                                name="bobrov-webproxy", daemon=True)
                self._worker.start()
            log.info("aperçu web : %s mis en file", name)
            return {"state": "queued", "progress": None, "error": None}

    def cancel(self, name: str) -> None:
        """Retire un job en attente ou interrompt la conversion en cours."""
        with self._lock:
            job = self._jobs.get(name)
            if job is None:
                return
            if job["state"] == "queued":
                try:
                    self._queue.remove(name)
                except ValueError:
                    pass
                self._jobs.pop(name, None)
                log.info("aperçu web : %s retiré de la file", name)
                return
            job["cancelled"] = True
            proc = job.get("proc")
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass

    def shutdown(self) -> None:
        """Arrêt du service : interrompt les conversions en cours."""
        with self._lock:
            active = [job for job in self._jobs.values()
                      if job["state"] in ("queued", "converting")]
            for job in active:
                job["cancelled"] = True
            procs = [job.get("proc") for job in active]
        for proc in procs:
            if proc is not None and proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass
        if active:
            log.info("arrêt du service : %d conversion(s) d'aperçu web interrompue(s)",
                     len(active))

    def wait_idle(self, timeout: float = 10.0) -> bool:
        """Attend la fin de toutes les conversions (diagnostic et tests)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if not self._queue and self._worker is None:
                    return True
            time.sleep(0.02)
        return False

    # -- Worker ------------------------------------------------------------

    def _worker_loop(self) -> None:
        """Consomme la file, un média après l'autre."""
        while True:
            with self._lock:
                if not self._queue:
                    self._worker = None
                    return
                name = self._queue.popleft()
                job = self._jobs.get(name)
                if job is None:
                    continue
                job["state"] = "converting"
            self._run_job(job)

    def _run_job(self, job: dict) -> None:
        """Conversion d'un job : ``.part`` → renommage atomique, ou erreur propre."""
        name = job["name"]
        source, target = job["source"], job["target"]
        part = target.with_name(target.name + ".part")
        try:
            if part.exists():
                part.unlink()
        except OSError:
            pass
        duration = mp4_duration_s(source)
        log.info("aperçu web : conversion de %s", name)
        error = self.convert(source, part, duration,
                             self._progress_setter(job), self._spawn_setter(job))
        with self._lock:
            cancelled = bool(job.get("cancelled"))
        installed = 0
        if error is None and not cancelled:
            try:
                installed = part.stat().st_size
                if installed > 0:
                    os.replace(part, target)
                else:
                    error = "ffmpeg n'a produit aucun contenu"
            except OSError as exc:
                error = f"installation de l'aperçu impossible : {exc}"
        if error is not None or cancelled:
            try:
                if part.exists():
                    part.unlink()
            except OSError:
                pass
        with self._lock:
            self._jobs.pop(name, None)
            if cancelled:
                log.info("aperçu web : conversion de %s interrompue", name)
            elif error is None:
                log.info("aperçu web prêt : %s (%.1f Mo)", target.name, installed / 1e6)
            else:
                job["state"] = "error"
                job["error"] = error
                job["progress"] = None
                job["proc"] = None
                self._jobs[name] = job
                log.warning("aperçu web : échec pour %s — %s", name, error)

    def convert(self, source: Path, target: Path, duration: float | None,
                on_progress, on_spawn) -> str | None:
        """Lance ffmpeg (source en lecture seule) — None si la conversion réussit.

        Sortie H.264 yuv420p lisible par les balises HTML5, moov en tête
        (``+faststart``). La progression (µs converties / durée) est remontée
        via ``on_progress`` ; ``on_spawn`` reçoit le processus pour permettre
        l'interruption. Remplaçable en test (sans ffmpeg réel).
        """
        cmd = [_FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error",
               "-progress", "pipe:1", "-nostats",
               "-i", str(source), "-map", "0:v:0",
               "-c:v", "libx264", "-preset", "fast", "-crf", "23",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart",
               "-f", "mp4", "-y", str(target)]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as exc:
            return f"lancement ffmpeg impossible : {exc}"
        on_spawn(proc)
        errors: deque[str] = deque(maxlen=10)

        def drain_stdout() -> None:
            """Convertit les lignes ``-progress`` en fraction 0–1 (µs/durée)."""
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                key, sep, value = line.partition("=")
                if not sep or key not in ("out_time_us", "out_time_ms"):
                    continue
                try:
                    micro = int(value)
                except ValueError:
                    continue
                if micro >= 0 and duration and duration > 0:
                    on_progress(min(micro / 1e6 / duration, 0.99))

        def drain_stderr() -> None:
            for raw in proc.stderr:
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    errors.append(line)

        threading.Thread(target=drain_stdout, name="bobrov-webproxy-out",
                         daemon=True).start()
        threading.Thread(target=drain_stderr, name="bobrov-webproxy-err",
                         daemon=True).start()
        code = proc.wait()
        if code != 0:
            detail = errors[-1] if errors else f"code ffmpeg {code}"
            return f"conversion interrompue ({detail})"
        return None

    def _progress_setter(self, job: dict):
        """Callback ffmpeg → pourcentage (0–99) du job."""
        def setter(fraction: float) -> None:
            with self._lock:
                job["progress"] = min(99, max(0, int(fraction * 100)))
        return setter

    def _spawn_setter(self, job: dict):
        """Callback de lancement → processus conservé pour l'interruption."""
        def setter(proc: subprocess.Popen) -> None:
            with self._lock:
                job["proc"] = proc
        return setter


JOBS = WebProxyJobs()


def get_proxy_jobs() -> WebProxyJobs:
    """Accès au gestionnaire global des conversions d'aperçu web."""
    return JOBS


# ---------------------------------------------------------------------------
# Routes /api/videos
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/videos", tags=["videos"])


@router.get("", summary="Liste de la médiathèque")
async def videos_list() -> dict:
    """Vidéos du dossier configuré, avec notes/étoiles et durées."""
    library = get_library()
    items = library.list_items()
    return {"status": "ok", "folder": str(library.folder()), "count": len(items), "items": items}


@router.get("/file/{name}", summary="Fichier vidéo (Range supporté)")
async def videos_file(name: str) -> FileResponse:
    """Sert la vidéo — les requêtes Range de la balise ``<video>`` sont gérées."""
    try:
        path = get_library().resolve(name)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    media_type, _ = mimetypes.guess_type(path.name)
    return FileResponse(path, media_type=media_type or "application/octet-stream")


@router.delete("/file/{name}", summary="Supprimer un média")
async def videos_delete(name: str) -> dict:
    """Suppression définitive d'un fichier — notes/étoiles retirés avec lui."""
    try:
        return {"status": "ok", **get_library().delete(name)}
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/rename", summary="Renommer un média")
async def videos_rename(payload: dict) -> dict:
    """Corps : ``{"name": "actuel.webm", "new_name": "nouveau"}``.

    L'extension d'origine est conservée si ``new_name`` n'en porte pas.
    """
    name = payload.get("name")
    new_name = payload.get("new_name")
    if not isinstance(name, str) or not isinstance(new_name, str):
        raise HTTPException(status_code=422, detail="name et new_name : textes attendus")
    library = get_library()
    try:
        library.resolve(name)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        renamed = library.rename(name, new_name)
    except LibraryConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LibraryError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "ok", "old_name": name, **renamed}


@router.post("/upload", summary="Déposer un média (corps binaire)")
async def videos_upload(request: Request, name: str = Query(..., min_length=1)) -> dict:
    """Reçoit un fichier brut (photo JPEG ou vidéo WebM du cockpit).

    Le nom passe en query string ; le corps est écrit en flux dans un
    ``.part`` plafonné à ``MAX_UPLOAD_BYTES``, puis renommé proprement.
    """
    library = get_library()
    try:
        target = library.prepare_upload(name)
    except LibraryError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    tmp = target.with_name(target.name + ".part")
    received = 0
    try:
        with open(tmp, "wb") as handle:
            async for chunk in request.stream():
                received += len(chunk)
                if received > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413,
                                        detail="fichier trop volumineux (max 1 Gio)")
                handle.write(chunk)
        if received == 0:
            raise HTTPException(status_code=422, detail="corps vide — aucun octet reçu")
        os.replace(tmp, target)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"écriture impossible : {exc}") from exc
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    log.info("média déposé : %s (%d octets)", target.name, received)
    return {"status": "ok", "name": target.name, "size_bytes": received}


@router.get("/meta/{name}", summary="Notes et étoiles")
async def videos_meta_get(name: str) -> dict:
    try:
        meta = get_library().meta_get(name)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "ok", "name": name, **meta}


@router.post("/meta/{name}", summary="Enregistrer notes et/ou étoiles")
async def videos_meta_set(name: str, payload: dict) -> dict:
    """Corps : {"stars": 0-5, "notes": "…"} — chaque champ est optionnel."""
    stars = payload.get("stars")
    notes = payload.get("notes")
    if stars is None and notes is None:
        raise HTTPException(status_code=422, detail="aucun champ à mettre à jour (stars, notes)")
    try:
        meta = get_library().meta_set(name, stars=stars, notes=notes)
    except LibraryError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "ok", "name": name, **meta}


@router.post("/proxy/{name}", summary="Générer l'aperçu web d'une vidéo brute")
async def videos_proxy_start(name: str) -> dict:
    """Convertit en arrière-plan une vidéo brute (MJPEG/mp4v) en H.264
    lisible par les navigateurs. La source n'est jamais modifiée : la sortie
    est un ``<stem>_web.mp4`` distinct, produit par un seul ffmpeg à la fois.

    Réponses : 404 média inconnu ; 422 conversion inutile (codec déjà lisible
    ou conteneur non pris en charge) ; sinon l'état du job (ready / queued /
    converting / error — idempotent par média).
    """
    library = get_library()
    try:
        path = library.resolve(name)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not needs_web_proxy(path):
        raise HTTPException(status_code=422,
                            detail="cette vidéo n'a pas besoin d'aperçu web "
                                   "(codec déjà lisible ou conteneur non pris en charge)")
    try:
        job = get_proxy_jobs().start(name, path, library.folder() / proxy_name(name))
    except LibraryError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "ok", "name": name, "proxy": job}
