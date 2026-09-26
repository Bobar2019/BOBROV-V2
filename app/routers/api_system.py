"""Routes système : état général du cockpit (footer SPA, diagnostics) et
maintenance (relance du service systemd, redémarrage du Pi — section SYSTÈME)."""
from __future__ import annotations

import logging
import os
import socket
import subprocess
import threading
import time

from fastapi import APIRouter, HTTPException, Request

from app import __version__
from app.config import get_config
from app.serial_link import get_serial_link

log = logging.getLogger("bobrov.system")

router = APIRouter(prefix="/api/system", tags=["system"])


def _local_addresses() -> list[str]:
    """IPv4 locales du Pi (section « Réseau » de la SPA) — sans émission réseau."""
    found: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))          # aucun paquet émis (UDP non connecté au réseau)
            found.add(probe.getsockname()[0])
    except OSError:
        pass
    return sorted(addr for addr in found if not addr.startswith("127."))


@router.get("/status", summary="État du cockpit")
async def system_status(request: Request) -> dict:
    """Version, uptime, adresses locales et état temps réel de la liaison série."""
    data = get_config().get()
    started_at = getattr(request.app.state, "started_at", None)
    return {
        "status": "ok",
        "app": "BOBROV",
        "version": __version__,
        "uptime_s": round(time.time() - started_at, 1) if started_at else 0.0,
        "config_version": data["config_version"],
        "addresses": _local_addresses(),
        "serial": get_serial_link().get_status(),
    }


@router.get("/telemetry", summary="Dernière télémétrie du sous-marin")
async def system_telemetry() -> dict:
    """Trame 0x02 décodée (quaternion, pression, température, puissance, PWM).

    ``live`` vaut vrai si une trame a été reçue il y a moins de 1,5 s ;
    sinon l'interface du cockpit bascule sur des données simulées.
    """
    telemetry = get_serial_link().get_telemetry()
    live = bool(telemetry) and float(telemetry.get("age_s", 999.0)) <= 1.5
    return {"status": "ok", "live": live, "telemetry": telemetry}


# ---------------------------------------------------------------------------
# Maintenance : relance du service systemd et redémarrage du Pi
# ---------------------------------------------------------------------------

SERVICE_NAME = "bob-rov"          # unité versionnée dans deploy/bob-rov.service
_RESPONSE_DELAY_S = 0.8           # la réponse HTTP doit partir avant l'arrêt du serveur


def _run_detached(args: list[str], name: str, delay_s: float = _RESPONSE_DELAY_S) -> None:
    """Programme une commande root juste après la réponse HTTP.

    L'arrêt du service (ou du Pi) est provoqué par la commande elle-même :
    elle s'exécute donc dans un thread, une fois la réponse envoyée au
    navigateur. La relance repose sur sudo sans mot de passe (NOPASSWD) ;
    un échec est journalisé (« journalctl -u bob-rov ») sans jamais faire
    échouer l'appel HTTP.
    """
    def _worker() -> None:
        time.sleep(delay_s)
        try:
            proc = subprocess.run(args, capture_output=True, text=True,
                                  timeout=20, check=False)
            if proc.returncode != 0:
                log.error("%s : échec (%s)", name,
                          " ".join((proc.stderr or proc.stdout).split()) or proc.returncode)
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.error("%s : commande impossible (%s)", name, exc)

    threading.Thread(target=_worker, name=name, daemon=True).start()


@router.post("/restart", summary="Relancer le service du cockpit")
async def system_restart() -> dict:
    """Relance « bob-rov » : coupure d'environ 3 s, le SPA se reconnecte seul.

    Refusé hors systemd (lancement manuel de run.sh) : la relance reste dans
    ce cas une opération de terminal.
    """
    if not os.environ.get("INVOCATION_ID"):
        raise HTTPException(status_code=409,
                            detail="Le cockpit ne tourne pas sous systemd — relance manuelle requise")
    _run_detached(["sudo", "-n", "systemctl", "restart", SERVICE_NAME], "restart-service")
    log.info("Relance du service %s demandée depuis l'interface", SERVICE_NAME)
    return {"status": "ok", "message": f"Relance du service {SERVICE_NAME} programmée"}


@router.post("/reboot", summary="Redémarrer le Raspberry Pi")
async def system_reboot() -> dict:
    """Reboot complet du Pi (caméras et liaison série comprises, ~1 minute).

    Le délai avant la commande laisse à la réponse HTTP le temps d'atteindre
    le navigateur, qui bascule alors sur son voile de reconnexion.
    """
    _run_detached(["sudo", "-n", "systemctl", "reboot"], "reboot-pi", delay_s=1.2)
    log.info("Redémarrage du Pi demandé depuis l'interface")
    return {"status": "ok", "message": "Redémarrage du Raspberry Pi programmé"}
