"""Réseau du cockpit — accès, priorité des liens (LAN / WiFi), nom .local et débit.

Le Pi pilote lui-même son réseau en s'appuyant sur ``nmcli`` (NetworkManager) :

* état des interfaces (IP, câble branché, lien porteur de la route par défaut) ;
* mode de priorité des liens (``network.mode`` dans config.json) : LAN
  prioritaire (défaut), WiFi prioritaire, LAN uniquement ou WiFi uniquement —
  appliqué au démarrage du service et depuis la section RÉSEAU ;
* scan des réseaux WiFi et connexion à un réseau ;
* nom d'hôte du Pi (= adresse mDNS « <nom>.local » républiée par Avahi) ;
* échantillon de débit téléchargeable pour qualifier le lien du navigateur.

Les lectures (état, listes) passent par ``nmcli`` en tant qu'utilisateur ;
les écritures (modification de profil, connexion/déconnexion, radio) exigent
les droits root côté polkit et passent donc par ``sudo -n`` — bob dispose de
NOPASSWD, jamais de prompt dans un service. ``subprocess`` reçoit toujours une
liste d'arguments (jamais de shell) : SSID et mot de passe transitent sans
risque d'injection et le mot de passe n'est jamais journalisé.
"""
from __future__ import annotations

import getpass
import logging
import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Iterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.config import NETWORK_MODES, get_config
from app.routers.api_system import _local_addresses

log = logging.getLogger("bobrov.network")

NMCLI = shutil.which("nmcli") or "/usr/bin/nmcli"
_CMD_TIMEOUT_S = 25
_CONNECT_TIMEOUT_S = 45
_APPLY_TIMEOUT_S = 40

# Taille maximale de l'échantillon de débit montant (navigateur → Pi).
_UPLOAD_MAX_BYTES = 64 * 1024 * 1024

# Redirection du port HTTP standard (80) vers le cockpit : table nftables
# dédiée, posée au démarrage pour rendre http://<nom>.local utilisable sans
# préciser « :8080 ».
_NFT_TABLE = "bobrov_web"
web_port_80_active = False

# Métriques de route par type de lien : la plus basse gagne la route par
# défaut. 100 / 600 reproduisent les valeurs auto de NetworkManager
# (ethernet 100, WiFi 600) ; le mode inverse les deux.
_METRICS: dict[str, dict[str, int]] = {
    "lan_first": {"ethernet": 100, "wifi": 600},
    "lan_only": {"ethernet": 100, "wifi": 600},
    "wifi_first": {"ethernet": 600, "wifi": 100},
    "wifi_only": {"ethernet": 600, "wifi": 100},
}

_MODE_MESSAGES = {
    "lan_first": "LAN prioritaire — le câble guide la connexion, le WiFi reste en secours",
    "wifi_first": "WiFi prioritaire — le WiFi guide la connexion, le câble reste en secours",
    "lan_only": "LAN uniquement — le WiFi est déconnecté (il reste activable ici)",
    "wifi_only": "WiFi uniquement — l'Ethernet est déconnecté (installations sans câble)",
}

# Types de profils NetworkManager (colonne TYPE de « nmcli con show »).
_NM_TYPES = {"ethernet": "802-3-ethernet", "wifi": "802-11-wireless"}

_HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


class NetworkError(RuntimeError):
    """nmcli/sudo indisponible ou délai dépassé."""


def _run(args: list[str], timeout: float = _CMD_TIMEOUT_S,
         sudo: bool = False) -> subprocess.CompletedProcess:
    """Exécute nmcli avec une liste d'arguments (jamais de shell).

    ``sudo=True`` préfixe par ``sudo -n`` : les écritures NetworkManager
    (modification de profil, connexion, radio) sont refusées par polkit hors
    session graphique — vérifié sur le Pi — et bob dispose de NOPASSWD.
    """
    cmd = ["sudo", "-n", NMCLI, *args] if sudo else [NMCLI, *args]
    try:
        return subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise NetworkError("nmcli introuvable — NetworkManager n'est pas installé") from exc
    except subprocess.TimeoutExpired as exc:
        raise NetworkError(f"nmcli : délai dépassé ({args[0] if args else '?'})") from exc


def _run_root(args: list[str], timeout: float = _CMD_TIMEOUT_S) -> subprocess.CompletedProcess:
    """Commande système sous droits root via ``sudo -n`` (hostnamectl, avahi)."""
    try:
        return subprocess.run(["sudo", "-n", *args], capture_output=True, text=True,
                              timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise NetworkError("sudo introuvable") from exc
    except subprocess.TimeoutExpired as exc:
        raise NetworkError(f"sudo : délai dépassé ({args[0] if args else '?'})") from exc


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


def parse_device_details(output: str) -> dict[str, dict]:
    """Sortie terse ``device show`` → {device: {ip4, gateway, metric, default, carrier}}.

    Champs pris en compte : ``GENERAL.DEVICE``, ``GENERAL.CARRIER`` (câble
    branché — champ optionnel, absent de certaines versions de nmcli),
    ``IP4.ADDRESS[n]`` (première adresse IPv4) et ``IP4.ROUTE[n]`` (route par
    défaut ``dst 0.0.0.0/0`` → métrique effective de l'interface).
    """
    details: dict[str, dict] = {}
    current: str | None = None
    for line in output.splitlines():
        if not line.strip():
            current = None
            continue
        fields = _split_terse(line)
        key = fields[0]
        value = ":".join(fields[1:])
        if key == "GENERAL.DEVICE":
            current = value.strip()
            details.setdefault(current, {"ip4": "", "gateway": "", "metric": None,
                                         "default": False, "carrier": None})
            continue
        if current is None:
            continue
        entry = details[current]
        if key == "GENERAL.CARRIER":
            entry["carrier"] = value.strip().lower() == "yes"
        elif key.startswith("IP4.ADDRESS") and not entry["ip4"]:
            entry["ip4"] = value.split("/")[0].strip()
        elif key.startswith("IP4.ROUTE") and not entry["default"]:
            match = re.search(r"dst = 0\.0\.0\.0/0\b.*?mt = (\d+)", value)
            if match:
                gateway = re.search(r"nh = (\S+?)(?:,|$)", value)
                entry["default"] = True
                entry["metric"] = int(match.group(1))
                entry["gateway"] = gateway.group(1) if gateway and gateway.group(1) != "0.0.0.0" else ""
    return details


# ---------------------------------------------------------------------------
# Lectures réseau (nmcli sans droits root)
# ---------------------------------------------------------------------------

def _device_status() -> list[dict]:
    return parse_device_list(_run(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION",
                                   "device", "status"]).stdout)


def _read_carrier(device: str) -> bool | None:
    """Lien physique présent (câble branché) lu dans sysfs — meilleur effort."""
    try:
        return Path(f"/sys/class/net/{device}/carrier").read_text().strip() == "1"
    except OSError:
        return None


def _device_details() -> dict[str, dict]:
    """Détails par interface : IP, câble, métrique de la route par défaut.

    ``GENERAL.CARRIER`` n'existe pas dans toutes les versions de nmcli
    (absente en 1.52 : la commande entière échouerait) — le carrier est donc
    lu dans ``/sys/class/net/<dev>/carrier`` quand nmcli ne le fournit pas.
    """
    details = parse_device_details(_run(["-t", "-f", "GENERAL.DEVICE,"
                                         "IP4.ADDRESS,IP4.ROUTE", "device", "show"]).stdout)
    for device, entry in details.items():
        if entry.get("carrier") is None:
            entry["carrier"] = _read_carrier(device)
    return details


def _wifi_radio_enabled() -> bool:
    return _run(["-t", "radio", "wifi"]).stdout.strip().lower().startswith("enabled")


def _first_device(devices: list[dict], kind: str) -> dict | None:
    """Premier périphérique du type demandé (« ethernet » ou « wifi »)."""
    return next((device for device in devices if device["type"] == kind), None)


def _wifi_signal() -> int | None:
    """Signal (%) du réseau WiFi actif — lecture seule, meilleur effort."""
    try:
        proc = _run(["-t", "-f", "IN-USE,SIGNAL", "dev", "wifi", "list"], timeout=15)
    except NetworkError:
        return None
    if proc.returncode != 0:
        return None
    for line in proc.stdout.splitlines():
        fields = _split_terse(line)
        if len(fields) > 1 and fields[0].strip() == "*":
            try:
                return int(fields[1])
            except ValueError:
                return None
    return None


def _con_names_by_type() -> dict[str, list[str]]:
    """Profils NetworkManager connectables, par type (« ethernet », « wifi »)."""
    proc = _run(["-t", "-f", "NAME,TYPE", "con", "show"])
    if proc.returncode != 0:
        raise NetworkError(_clean_err(proc.stderr or proc.stdout))
    groups: dict[str, list[str]] = {"ethernet": [], "wifi": []}
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        fields = _split_terse(line)
        name = fields[0].strip()
        conn_type = fields[1].strip() if len(fields) > 1 else ""
        for kind, nm_type in _NM_TYPES.items():
            if conn_type == nm_type and name:
                groups[kind].append(name)
    return groups


def _hostname() -> str:
    """Nom d'hôte système (sa forme « .local » est l'adresse mDNS Avahi)."""
    try:
        return socket.gethostname().strip() or "bobrov"
    except OSError:
        return "bobrov"


def _ssh_user() -> str:
    """Utilisateur à utiliser pour « ssh <utilisateur>@<pi> »."""
    try:
        return getpass.getuser()
    except Exception:                       # identité indéterminable : commande masquée
        return ""


# ---------------------------------------------------------------------------
# Application du mode de priorité des liens (écritures nmcli via sudo -n)
# ---------------------------------------------------------------------------

def _connect_device(device: str, label: str, applied: list[str], warnings: list[str]) -> None:
    proc = _run(["device", "connect", device], sudo=True, timeout=_APPLY_TIMEOUT_S)
    if proc.returncode != 0:
        warnings.append(f"reconnexion de {label} ({device}) impossible : "
                        f"{_clean_err(proc.stderr or proc.stdout)}")
    else:
        applied.append(f"{label} reconnecté ({device})")


def _disconnect_device(device: str, label: str, applied: list[str], warnings: list[str]) -> None:
    proc = _run(["device", "disconnect", device], sudo=True, timeout=30)
    if proc.returncode != 0:
        warnings.append(f"déconnexion de {label} ({device}) impossible : "
                        f"{_clean_err(proc.stderr or proc.stdout)}")
    else:
        applied.append(f"{label} déconnecté ({device})")


def apply_mode(mode: str) -> dict:
    """Applique un mode de priorité des liens et retourne le journal des actions.

    Étapes : métriques de route des profils (100/600 selon le mode),
    réapplication à chaud des interfaces connectées (effet immédiat sur la
    route par défaut, sans lâcher les baux DHCP), puis activation ou
    déconnexion du lien non prioritaire. Aucun échec unitaire n'interrompt le
    reste : chaque opération finit dans ``applied`` ou ``warnings``.
    """
    if mode not in NETWORK_MODES:
        raise ValueError(f"mode inconnu : {mode}")
    applied: list[str] = []
    warnings: list[str] = []
    devices = _device_status()
    names = _con_names_by_type()

    for kind, metric in _METRICS[mode].items():
        for name in names.get(kind, []):
            proc = _run(["con", "mod", name, "ipv4.route-metric", str(metric)], sudo=True)
            if proc.returncode != 0:
                warnings.append(f"métrique {metric} sur « {name} » refusée : "
                                f"{_clean_err(proc.stderr or proc.stdout)}")
            else:
                applied.append(f"métrique {metric} posée sur « {name} »")

    lan = _first_device(devices, "ethernet")
    wifi = _first_device(devices, "wifi")
    for device in (lan, wifi):
        if device and device["state"] == "connected":
            proc = _run(["device", "reapply", device["device"]], sudo=True, timeout=_APPLY_TIMEOUT_S)
            if proc.returncode != 0:
                warnings.append(f"réapplication de {device['device']} refusée : "
                                f"{_clean_err(proc.stderr or proc.stdout)}")

    if mode == "lan_only":
        if wifi and wifi["state"] == "connected":
            _disconnect_device(wifi["device"], "WiFi", applied, warnings)
    elif mode == "wifi_only":
        if lan and lan["state"] == "connected":
            _disconnect_device(lan["device"], "Ethernet", applied, warnings)
    elif mode == "lan_first":
        if lan and lan["state"] != "connected":
            # Câble absent : le LAN reprendra seul au branchement (autoconnect).
            details = _device_details().get(lan["device"], {})
            if details.get("carrier"):
                _connect_device(lan["device"], "LAN", applied, warnings)
    elif mode == "wifi_first":
        if not _wifi_radio_enabled():
            proc = _run(["radio", "wifi", "on"], sudo=True)
            if proc.returncode != 0:
                warnings.append("radio WiFi impossible à rallumer")
            else:
                applied.append("radio WiFi rallumée")
        if wifi and wifi["state"] != "connected":
            _connect_device(wifi["device"], "WiFi", applied, warnings)

    return {"applied": applied, "warnings": warnings}


def enforce_network_preference() -> None:
    """Applique le mode de priorité au démarrage du service (meilleur effort).

    Appelée en tâche de fond par le lifespan : les liens sont réglés selon
    ``network.mode`` de config.json. Toute erreur est journalisée sans
    interrompre le démarrage.
    """
    try:
        mode = get_config().get()["network"].get("mode", "lan_first")
        result = apply_mode(mode)
        log.info("Priorité réseau « %s » appliquée : %s", mode,
                 "; ".join(result["applied"]) or "aucun changement")
        for warning in result["warnings"]:
            log.warning("Priorité réseau : %s", warning)
    except (NetworkError, ValueError) as exc:
        log.warning("Priorité réseau non appliquée (%s)", exc)


def startup() -> None:
    """Tâches réseau du démarrage du service (exécutées en tâche de fond)."""
    enforce_network_preference()
    ensure_web_redirect()


def ensure_web_redirect() -> bool:
    """Redirige le port HTTP standard (80) vers le cockpit via nftables.

    Objectif : ``http://<nom>.local`` sans « :8080 ». Une table dédiée
    (« bobrov_web ») est recréée à chaque démarrage avec le port courant de
    config.json : les autres règles du pare-feu ne sont pas touchées et la
    redirection survit aux reboots tant que le service démarre. Couvre les
    deux chemins : PREROUTING (navigateurs arrivés par le réseau) et OUTPUT
    (navigateur du Pi lui-même, jamais vu par PREROUTING). Retourne True si
    la redirection réseau est en place.
    """
    global web_port_80_active
    try:
        port = int(get_config().get()["network"].get("port", 8080) or 8080)
    except (TypeError, ValueError):
        port = 8080
    # « delete » best-effort (table absente au premier lancement) puis table
    # recréée : garantit une redirection unique, alignée sur le port courant.
    # Les règles OUTPUT (accès local) sont un bonus : leur échec ne remet pas
    # en cause l'accès réseau.
    steps = [
        (["nft", "delete", "table", "ip", _NFT_TABLE], ""),
        (["nft", "add", "table", "ip", _NFT_TABLE], "table"),
        (["nft", "add", "chain", "ip", _NFT_TABLE, "prerouting",
          "{ type nat hook prerouting priority dstnat; policy accept; }"], "chaîne"),
        (["nft", "add", "rule", "ip", _NFT_TABLE, "prerouting",
          "tcp", "dport", "80", "redirect", "to", f":{port}"], "redirection"),
        (["nft", "add", "chain", "ip", _NFT_TABLE, "output",
          "{ type nat hook output priority -100; policy accept; }"], ""),
        (["nft", "add", "rule", "ip", _NFT_TABLE, "output",
          "fib", "daddr", "type", "local", "tcp", "dport", "80",
          "redirect", "to", f":{port}"], ""),
    ]
    try:
        for args, label in steps:
            proc = _run_root(args, timeout=10)
            if proc.returncode != 0 and label:
                log.warning("Accès http://<nom>.local (%s) : %s",
                            label, _clean_err(proc.stderr))
                return False
    except NetworkError as exc:
        log.warning("Redirection du port 80 indisponible (%s)", exc)
        return False
    web_port_80_active = True
    log.info("Accès http://<nom>.local — port 80 redirigé vers le cockpit (:%d)", port)
    return True


# ---------------------------------------------------------------------------
# Renommage du Pi (hostname système = adresse mDNS publiée par Avahi)
# ---------------------------------------------------------------------------

def _rewrite_hosts_local(name: str) -> bool:
    """Met à jour la ligne 127.0.1.1 de /etc/hosts (sudo, meilleur effort)."""
    hosts = Path("/etc/hosts")
    try:
        text = hosts.read_text(encoding="utf-8")
    except OSError:
        return False
    line = f"127.0.1.1\t{name}"
    if re.search(r"^127\.0\.1\.1\s+\S+", text, flags=re.M):
        new_text = re.sub(r"^127\.0\.1\.1\s+.*$", line, text, count=1, flags=re.M)
    else:
        separator = "" if text.endswith("\n") else "\n"
        new_text = text + separator + line + "\n"
    try:
        proc = subprocess.run(["sudo", "-n", "tee", str(hosts)], input=new_text,
                              capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


# ---------------------------------------------------------------------------
# Routes /api/network
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/network", tags=["network"])


def _device_summary(device: dict | None, details: dict[str, dict],
                    signal: int | None = None, primary: str = "") -> dict:
    """Résumé d'une interface pour l'interface : IP, lien porteur, métrique.

    ``primary`` désigne le périphérique porteur effectif de la route par
    défaut (métrique la plus basse) : lui seul est qualifié de « lien actif ».
    """
    if device is None:
        summary = {"device": "", "connected": False, "connection": "", "ip4": "",
                   "carrier": None, "default_route": False, "metric": None}
    else:
        entry = details.get(device["device"], {})
        summary = {"device": device["device"], "connected": device["state"] == "connected",
                   "connection": device["connection"], "ip4": entry.get("ip4", ""),
                   "carrier": entry.get("carrier"), "default_route": bool(entry.get("default")),
                   "metric": entry.get("metric")}
    summary["primary"] = bool(summary["device"]) and summary["device"] == primary
    summary["signal"] = signal
    return summary


@router.get("", summary="État réseau du Pi")
def network_status() -> dict:
    """Mode de priorité, interfaces (IP, câble, lien actif), WiFi et nom .local."""
    net_cfg = get_config().get()["network"]
    speedtest = net_cfg.get("speedtest", {})
    hostname = _hostname()
    base = {
        "addresses": _local_addresses(),
        "hostname": hostname,
        "mdns": f"{hostname}.local",
        "ssh_user": _ssh_user(),
        "port": net_cfg.get("port", 8080),
        "mode": net_cfg.get("mode", "lan_first"),
        "modes": list(NETWORK_MODES),
        "speedtest": {"duration_s": float(speedtest.get("duration_s", 8)),
                      "mbps_per_camera": float(speedtest.get("mbps_per_camera", 8))},
        "web_port_80": web_port_80_active,
    }
    try:
        devices = _device_status()
        radio = _wifi_radio_enabled()
        details = _device_details()
    except NetworkError as exc:
        log.warning("état réseau dégradé (%s)", exc)
        return {"status": "ok", "nmcli": False, "error": str(exc), "devices": [],
                "wifi_radio": False, "lan": _device_summary(None, {}),
                "wifi": _device_summary(None, {}), **base}
    for device in devices:
        entry = details.get(device["device"], {})
        device["ip4"] = entry.get("ip4", "")
        device["carrier"] = entry.get("carrier")
        device["default_route"] = bool(entry.get("default"))
        device["metric"] = entry.get("metric")
    # Les deux liens peuvent avoir une route par défaut : le « lien actif » est
    # celui qui gagne, c'est-à-dire la métrique la plus basse.
    default_devices = [device for device in devices
                       if device["default_route"] and device["metric"] is not None]
    primary = (min(default_devices, key=lambda device: device["metric"])["device"]
               if default_devices else "")
    for device in devices:
        device["primary"] = device["device"] == primary
    wifi = _first_device(devices, "wifi")
    signal = _wifi_signal() if wifi and wifi["state"] == "connected" else None
    return {
        **base,
        "status": "ok",
        "nmcli": True,
        "wifi_radio": radio,
        "devices": devices,
        "lan": _device_summary(_first_device(devices, "ethernet"), details, primary=primary),
        "wifi": _device_summary(wifi, details, signal, primary=primary),
    }


@router.post("/mode", summary="Changer la priorité des liens (LAN / WiFi)")
def network_mode(payload: dict) -> dict:
    """Corps : {"mode": "lan_first" | "wifi_first" | "lan_only" | "wifi_only"}.

    La préférence est persistée dans config.json puis appliquée immédiatement
    (métriques de route, réapplication à chaud, activation ou déconnexion du
    lien non prioritaire). Le résultat détaille chaque opération.
    """
    mode = str(payload.get("mode", "")).strip()
    if mode not in NETWORK_MODES:
        raise HTTPException(status_code=422,
                            detail="mode requis parmi : " + ", ".join(NETWORK_MODES))
    get_config().update({"network": {"mode": mode}})
    try:
        result = apply_mode(mode)
    except NetworkError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    log.info("Priorité réseau « %s » : %s", mode,
             "; ".join(result["applied"]) or "aucun changement")
    return {"status": "ok", "mode": mode, "message": _MODE_MESSAGES[mode], **result}


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
    """Corps : {"ssid": "…", "password": "…"} — mot de passe optionnel.

    Se connecter au WiFi vaut acceptation du lien : si le mode était « LAN
    uniquement », il passe à « LAN prioritaire » (WiFi en secours).
    """
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
        proc = _run(args, timeout=_CONNECT_TIMEOUT_S, sudo=True)
    except NetworkError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=_clean_err(proc.stderr or proc.stdout)) from None
    if get_config().get()["network"].get("mode") == "lan_only":
        get_config().update({"network": {"mode": "lan_first"}})
    log.info("WiFi : connexion demandée à « %s »", ssid)
    return {"status": "ok",
            "message": _clean_err(proc.stdout) or f"connexion à « {ssid} » demandée"}


@router.post("/disconnect", summary="Déconnexion WiFi (rester en LAN)")
def wifi_disconnect() -> dict:
    """Déconnecte l'interface WiFi et retient le mode « LAN uniquement »."""
    try:
        devices = _device_status()
    except NetworkError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    wifi = _first_device(devices, "wifi")
    if wifi is None:
        raise HTTPException(status_code=503, detail="aucun périphérique WiFi détecté")
    try:
        proc = _run(["device", "disconnect", wifi["device"]], timeout=30, sudo=True)
    except NetworkError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=_clean_err(proc.stderr or proc.stdout)) from None
    get_config().update({"network": {"mode": "lan_only"}})
    log.info("WiFi déconnecté (%s) — mode LAN uniquement", wifi["device"])
    return {"status": "ok", "message": f"WiFi déconnecté ({wifi['device']}) — LAN uniquement"}


@router.post("/hostname", summary="Renommer le Pi (adresse .local)")
def network_hostname(payload: dict) -> dict:
    """Corps : {"name": "bobrov"} → hostname système et républication Avahi.

    Le nom validé (minuscules, chiffres, tirets, 63 caractères maximum)
    devient l'adresse mDNS « <nom>.local » : ``hostnamectl`` est persistant,
    /etc/hosts est mis à jour et avahi-daemon republie immédiatement.
    """
    name = str(payload.get("name", "")).strip().lower()
    if not _HOSTNAME_RE.match(name):
        raise HTTPException(status_code=422,
                            detail="nom invalide — minuscules, chiffres et tirets "
                                   "(63 caractères maximum, sans tiret aux extrémités)")
    try:
        proc = _run_root(["hostnamectl", "set-hostname", name])
    except NetworkError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if proc.returncode != 0:
        raise HTTPException(status_code=500,
                            detail=_clean_err(proc.stderr or proc.stdout)) from None
    warnings: list[str] = []
    if not _rewrite_hosts_local(name):
        warnings.append("/etc/hosts non mis à jour (sans effet après un redémarrage)")
    try:
        avahi = _run_root(["systemctl", "restart", "avahi-daemon"], timeout=20)
        if avahi.returncode != 0:
            warnings.append(f"Avahi n'a pas redémarré : {_clean_err(avahi.stderr or avahi.stdout)}")
    except NetworkError as exc:
        warnings.append(f"Avahi non redémarré ({exc})")
    user = _ssh_user()
    log.info("Pi renommé : %s.local", name)
    return {"status": "ok", "hostname": name, "mdns": f"{name}.local",
            "message": f"Le Pi répond à http://{name}.local"
                       + (f" (ssh {user}@{name}.local)" if user else ""),
            "warnings": warnings}


def _speedtest_params(mb: int, seconds: float) -> tuple[int, float]:
    """(octets max, durée max) du test de débit — bornes de sécurité.

    Sans ``mb`` explicite : 1 Go autorisé quand une durée est demandée (le
    client coupe à l'échéance), 128 Mo sinon (appel manuel type curl).
    """
    secs = max(0.0, min(30.0, float(seconds or 0)))
    limit_mb = int(mb) or (1024 if secs else 128)
    return max(1, min(1024, limit_mb)) * 1024 * 1024, secs


@router.get("/speedtest", summary="Échantillon de débit (navigateur → Pi)")
def network_speedtest(mb: int = 0, seconds: float = 0) -> StreamingResponse:
    """Flux continu pour mesurer le débit du lien (phase « descente »).

    Avec ``seconds`` (ex. 8 s), le serveur streame pendant au plus cette durée
    et le débit est mesuré quelle que soit la vitesse du lien (pas de
    « Content-Length » : transmission morcelée). Sans ``seconds``, le flux
    fait exactement ``mb`` Mo (appels manuels, scripts et tests). Les octets
    sont aléatoires (aucune compression possible en route) et le contenu
    n'est jamais mis en cache.
    """
    max_bytes, secs = _speedtest_params(mb, seconds)
    chunk = os.urandom(min(max_bytes, 1 << 20))

    def _chunks() -> Iterator[bytes]:
        remaining = max_bytes
        deadline = time.monotonic() + secs if secs else 0.0
        while remaining > 0:
            if deadline and time.monotonic() >= deadline:
                break
            size = min(len(chunk), remaining)
            yield chunk if size == len(chunk) else chunk[:size]
            remaining -= size

    headers = {"Cache-Control": "no-store"}
    if not secs:
        headers["Content-Length"] = str(max_bytes)
    return StreamingResponse(_chunks(), media_type="application/octet-stream",
                             headers=headers)


@router.get("/ping", summary="Ping applicatif (latence du chemin web)")
def network_ping() -> dict:
    """Réponse minimale horodatée : le navigateur mesure l'aller-retour.

    Sert au test de connexion web (latence, gigue, pertes) et à la phase
    « ping » du test de vitesse — réponse instantanée, jamais mise en cache.
    """
    return {"status": "ok", "t": time.time()}


@router.post("/speedtest/upload", summary="Échantillon de débit montant (Pi)")
async def network_speedtest_upload(request: Request) -> dict:
    """Reçoit un échantillon d'octets et mesure le débit de réception.

    Le chrono part au premier bloc reçu et s'arrête au dernier : il couvre le
    transfert lui-même, sans le temps de préparation de la requête. Le corps
    est jeté au fil de l'eau (jamais écrit sur disque) et l'échantillon est
    plafonné à ``_UPLOAD_MAX_BYTES``.
    """
    received = 0
    started = 0.0
    async for chunk in request.stream():
        if not started:
            started = time.monotonic()
        received += len(chunk)
        if received > _UPLOAD_MAX_BYTES:
            raise HTTPException(status_code=413,
                                detail="échantillon trop volumineux (64 Mo max)")
    if not received:
        return {"status": "ok", "bytes": 0, "seconds": 0.0, "mbps": 0.0}
    elapsed = max(time.monotonic() - started, 1e-6)
    return {"status": "ok", "bytes": received, "seconds": round(elapsed, 4),
            "mbps": round((received * 8 / 1e6) / elapsed, 2)}
