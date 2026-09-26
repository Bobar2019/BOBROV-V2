"""Réseau du cockpit — état des interfaces et gestion WiFi via NetworkManager.

Le Pi pilote lui-même son WiFi (scan, connexion, déconnexion) en s'appuyant sur
``nmcli`` (NetworkManager). L'application tournant sous systemd (hors session
graphique), une règle polkit peut être nécessaire pour les actions d'écriture
— elle est documentée dans le README du projet.

Aucune commande shell n'est construite par concaténation : ``subprocess`` reçoit
une liste d'arguments (jamais de shell), le SSID et le mot de passe transitent
donc sans risque d'injection. Le mot de passe n'est jamais journalisé.

La préférence « rester en LAN uniquement » (``network.wifi_enabled = false``
dans config.json) déclenche une déconnexion WiFi au démarrage du service.
"""
from __future__ import annotations

import logging
import shutil
import subprocess

from fastapi import APIRouter, HTTPException

from app.config import get_config
from app.routers.api_system import _local_addresses

log = logging.getLogger("bobrov.network")

NMCLI = shutil.which("nmcli") or "/usr/bin/nmcli"
_CMD_TIMEOUT_S = 25
_CONNECT_TIMEOUT_S = 45


class NetworkError(RuntimeError):
    """nmcli indisponible ou délai dépassé."""


def _run(args: list[str], timeout: float = _CMD_TIMEOUT_S) -> subprocess.CompletedProcess:
    """Exécute nmcli avec une liste d'arguments (jamais de shell)."""
    try:
        return subprocess.run([NMCLI, *args], capture_output=True, text=True,
                              timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise NetworkError("nmcli introuvable — NetworkManager n'est pas installé") from exc
    except subprocess.TimeoutExpired as exc:
        raise NetworkError(f"nmcli : délai dépassé ({args[0] if args else '?'})") from exc


def _clean_err(text: str) -> str:
    """Message nmcli nettoyé (« Error: » retiré, espaces compactés)."""
    message = " ".join((text or "").split())
    for prefix in ("Error:", "Erreur :", "Erreur:"):
        if message.startswith(prefix):
            message = message[len(prefix):].strip()
    return message or "échec de la commande nmcli"


# ---------------------------------------------------------------------------
# Parsing des sorties terse (testable sans NetworkManager)
# ---------------------------------------------------------------------------

def _unescape(field: str) -> str:
    """Dé-échappe un champ terse nmcli (``\\:`` → « : », ``\\\\`` → « \\ »)."""
    out: list[str] = []
    index = 0
    while index < len(field):
        char = field[index]
        if char == "\\" and index + 1 < len(field):
            out.append(field[index + 1])
            index += 2
        else:
            out.append(char)
            index += 1
    return "".join(out)


def _split_terse(line: str) -> list[str]:
    """Découpe une ligne terse nmcli sur les « : » non échappés."""
    fields: list[str] = []
    current: list[str] = []
    index = 0
    while index < len(line):
        char = line[index]
        if char == "\\" and index + 1 < len(line):
            current.append(char)
            current.append(line[index + 1])
            index += 2
        elif char == ":":
            fields.append(_unescape("".join(current)))
            current = []
            index += 1
        else:
            current.append(char)
            index += 1
    fields.append(_unescape("".join(current)))
    return fields


def parse_device_list(output: str) -> list[dict]:
    """Lignes ``DEVICE:TYPE:STATE:CONNECTION`` → liste de dicts."""
    devices = []
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = _split_terse(line)
        while len(fields) < 4:
            fields.append("")
        devices.append({"device": fields[0], "type": fields[1],
                        "state": fields[2], "connection": fields[3]})
    return devices


def parse_wifi_list(output: str) -> list[dict]:
    """Lignes ``IN-USE:SSID:SIGNAL:SECURITY`` → réseaux triés par signal.

    Les doublons de SSID (même réseau vu via plusieurs points d'accès) sont
    fusionnés en gardant le meilleur signal ; les noms vides (réseaux masqués)
    sont écartés.
    """
    networks: dict[str, dict] = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = _split_terse(line)
        while len(fields) < 4:
            fields.append("")
        in_use, ssid, signal, security = fields[0], fields[1].strip(), fields[2], fields[3]
        if not ssid:
            continue
        try:
            level = int(signal)
        except ValueError:
            level = 0
        active = in_use.strip() == "*"
        current = networks.get(ssid)
        if current is None or level > current["signal"]:
            networks[ssid] = {"ssid": ssid, "signal": level,
                              "security": security, "active": active or (current["active"] if current else False)}
        elif active:
            current["active"] = True
    return sorted(networks.values(), key=lambda item: item["signal"], reverse=True)


def _wifi_device(devices: list[dict]) -> dict | None:
    """Premier périphérique WiFi de la liste (wlan0 en général)."""
    return next((device for device in devices if device["type"] == "wifi"), None)


def _device_status() -> list[dict]:
    return parse_device_list(_run(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION",
                                   "device", "status"]).stdout)


def _wifi_radio_enabled() -> bool:
    return _run(["-t", "radio", "wifi"]).stdout.strip().lower().startswith("enabled")


def enforce_lan_preference() -> None:
    """Applique « rester en LAN uniquement » au démarrage (meilleur effort).

    Appelée en tâche de fond par le lifespan : si la préférence est désactivée
    et que le WiFi est connecté, l'interface est déconnectée. Toute erreur est
    journalisée sans interrompre le démarrage.
    """
    try:
        if bool(get_config().get()["network"].get("wifi_enabled", True)):
            return
        wifi = _wifi_device(_device_status())
        if wifi and wifi["state"] == "connected":
            _run(["device", "disconnect", wifi["device"]], timeout=30)
            log.info("Préférence LAN uniquement : WiFi (%s) déconnecté au démarrage",
                     wifi["device"])
    except NetworkError as exc:
        log.warning("Préférence LAN uniquement : action WiFi impossible (%s)", exc)


# ---------------------------------------------------------------------------
# Routes /api/network
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/network", tags=["network"])


@router.get("", summary="État réseau du Pi")
def network_status() -> dict:
    """Périphériques, radio WiFi, préférence LAN-only et adresses locales."""
    net_cfg = get_config().get()["network"]
    base = {
        "addresses": _local_addresses(),
        "wifi_enabled": bool(net_cfg.get("wifi_enabled", True)),
        "wifi": {"device": "", "connected": False, "connection": ""},
    }
    try:
        devices = _device_status()
        radio = _wifi_radio_enabled()
    except NetworkError as exc:
        log.warning("état réseau dégradé (%s)", exc)
        return {"status": "ok", "nmcli": False, "error": str(exc),
                "devices": [], "wifi_radio": False, **base}
    wifi = _wifi_device(devices)
    return {
        **base,                                       # wifi vide : écrasé ci-dessous
        "status": "ok",
        "nmcli": True,
        "devices": devices,
        "wifi_radio": radio,
        "wifi": {
            "device": wifi["device"] if wifi else "",
            "connected": bool(wifi and wifi["state"] == "connected"),
            "connection": wifi["connection"] if wifi else "",
        },
    }


@router.post("/scan", summary="Scanner les réseaux WiFi")
def wifi_scan() -> dict:
    """Scan actif (``--rescan yes``) — peut prendre quelques secondes."""
    try:
        proc = _run(["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY",
                     "dev", "wifi", "list", "--rescan", "yes"], timeout=30)
    except NetworkError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if proc.returncode != 0:
        raise HTTPException(status_code=503, detail=_clean_err(proc.stderr)) from None
    networks = parse_wifi_list(proc.stdout)
    log.info("scan WiFi : %d réseau(x) trouvé(s)", len(networks))
    return {"status": "ok", "count": len(networks), "networks": networks}


@router.post("/connect", summary="Connexion WiFi")
def wifi_connect(payload: dict) -> dict:
    """Corps : {"ssid": "…", "password": "…"} — mot de passe optionnel."""
    ssid = str(payload.get("ssid", "")).strip()
    password = str(payload.get("password", "") or "")
    if not ssid:
        raise HTTPException(status_code=422, detail="ssid requis")
    if len(ssid) > 128 or len(password) > 256:
        raise HTTPException(status_code=422, detail="ssid ou mot de passe trop long")
    args = ["dev", "wifi", "connect", ssid]
    if password:
        args += ["password", password]
    try:
        proc = _run(args, timeout=_CONNECT_TIMEOUT_S)
    except NetworkError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=_clean_err(proc.stderr or proc.stdout)) from None
    get_config().update({"network": {"wifi_enabled": True}})
    log.info("WiFi : connexion demandée à « %s »", ssid)
    return {"status": "ok",
            "message": _clean_err(proc.stdout) or f"connexion à « {ssid} » demandée"}


@router.post("/disconnect", summary="Déconnexion WiFi (rester en LAN)")
def wifi_disconnect() -> dict:
    """Déconnecte l'interface WiFi et retient la préférence « LAN uniquement »."""
    try:
        devices = _device_status()
    except NetworkError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    wifi = _wifi_device(devices)
    if wifi is None:
        raise HTTPException(status_code=503, detail="aucun périphérique WiFi détecté")
    try:
        proc = _run(["device", "disconnect", wifi["device"]], timeout=30)
    except NetworkError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=_clean_err(proc.stderr or proc.stdout)) from None
    get_config().update({"network": {"wifi_enabled": False}})
    log.info("WiFi déconnecté (%s) — préférence LAN uniquement", wifi["device"])
    return {"status": "ok", "message": f"WiFi déconnecté ({wifi['device']})"}
