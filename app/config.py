"""Configuration centralisée du cockpit BOBROV — source unique de vérité.

Le fichier ``config.json`` (racine du projet) est créé automatiquement au
premier lancement depuis les ``DEFAULTS`` ci-dessous, puis reste la référence :
toute clé absente est complétée par son défaut, toute écriture est validée
(types + bornes) puis persistée de façon atomique (fichier temporaire +
``os.replace``), jamais de config.json tronquée.

Bornes série issues de PROTOCOLE_RPI5.md §4.2 : cadence descendante
recommandée 20–50 Hz, watchdog firmware 500 ms par défaut (§6.1).

Liaison : 921600 bauds 8N1, UART natif GPIO 14/15 → ``/dev/serial0``
(alias udev stable : ttyAMA10 sur Pi 5, ttyAMA0 sur Pi 4/3) ; alternative
USB-CDC : ``/dev/ttyACM0``.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
from pathlib import Path

log = logging.getLogger("bobrov.config")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.json"

PIP_CORNERS = ("top-left", "top-right", "bottom-left", "bottom-right")

# Priorité des liens réseau (section RÉSEAU) :
#   lan_first  — le câble d'abord, le WiFi en secours (défaut) ;
#   wifi_first — le WiFi d'abord, le câble en secours ;
#   lan_only   — WiFi déconnecté (relançable depuis l'interface) ;
#   wifi_only  — Ethernet déconnecté (installations sans câble).
NETWORK_MODES = ("lan_first", "wifi_first", "lan_only", "wifi_only")

DEFAULTS: dict = {
    "config_version": 1,
    "serial": {
        # UART natif GPIO 14/15 : /dev/serial0 (alias stable → ttyAMA10 sur Pi 5,
        # ttyAMA0 sur Pi 4/3). Alternative USB-CDC : /dev/ttyACM0.
        "port": "/dev/serial0",
        "baud": 921600,
        "tx_hz": 25,
        "reconnect_delay_s": 2,
    },
    "network": {
        "host": "0.0.0.0",
        "port": 8080,
        # Priorité des liens, appliquée au démarrage et depuis la section
        # RÉSEAU (métriques de route 100/600 posées via nmcli + activation ou
        # déconnexion du WiFi / de l'Ethernet selon le mode).
        "mode": "lan_first",
        # Test de débit navigateur → Pi (section RÉSEAU) : durée de chaque
        # phase (le débit s'adapte à la vitesse du lien) et débit considéré
        # comme confortable pour une caméra MJPEG (≈ 6–12 Mbit/s selon la scène).
        "speedtest": {"duration_s": 8, "mbps_per_camera": 8},
    },
    "cameras": {
        # Rôles du poste (section CAMÉRAS) : cam1 = Caméra Gauche (Avant G),
        # cam2 = Caméra Droite (Avant D), cam3 = Caméra Arrière.
        "cam1": {
            "device": "/dev/video0",
            "width": 1280,
            "height": 720,
            "fps": 30,
            "jpeg_quality": 80,
        },
        "cam2": {
            "device": "/dev/video2",
            "width": 640,
            "height": 480,
            "fps": 30,
            "jpeg_quality": 75,
        },
        # Vue Arrière : chemin vide tant qu'aucun périphérique n'est assigné
        # (la validation l'accepte) ; renseignez-le depuis Paramètres → Caméras.
        "cam3": {
            "device": "",
            "width": 640,
            "height": 480,
            "fps": 30,
            "jpeg_quality": 75,
        },
        "pip": {
            "enabled": True,
            "corner": "bottom-right",
            "width_percent": 28,
            "opacity": 0.9,
        },
        # Enregistrement depuis le cockpit (section CAMÉRAS → carte dédiée).
        "recording": {
            "video_fps": 30,
            "video_bitrate_mbps": 4,
            "photo_quality": 90,
        },
        # Enregistrement stéréoscopique 3D (case « 3D » du cockpit) : un flux
        # par œil — deux fichiers MP4 horodatés <stamp>_camG.mp4 et
        # <stamp>_camD.mp4, capturés en parallèle par le backend (ffmpeg).
        "stereo": {"left_device": "/dev/video0", "right_device": "/dev/video2"},
    },
    "input": {
        "deadzone": 0.08,
        "expo": 1.5,
        "max_speed_us": 400,
        "imu": {"enabled": False, "device": ""},
        # Manettes (section MANETTE) : voies PWM du ROV et commandes du poste
        # (ex. enregistrement de la vue) ; la source est
        # {"type": "axis"|"button", "index": n, "invert": bool}.
        "gamepad": {
            "enabled": False,
            "actions": [
                {"id": "voie1", "label": "Voie 1", "source": None},
                {"id": "voie2", "label": "Voie 2", "source": None},
                {"id": "voie3", "label": "Voie 3", "source": None},
                {"id": "voie4", "label": "Voie 4", "source": None},
                {"id": "voie5", "label": "Voie 5", "source": None},
                {"id": "voie6", "label": "Voie 6", "source": None},
                {"id": "rec_view", "label": "Enregistrer la vue (vidéo + HUD)",
                 "source": None},
                {"id": "rec", "label": "Enregistrer la vidéo (sans HUD)",
                 "source": None},
                {"id": "rec_3d", "label": "Enregistrer la vidéo en stéréo 3D (deux caméras)",
                 "source": None},
                {"id": "swap_cams", "label": "Permuter les caméras",
                 "source": None},
                {"id": "toggle_toolbar", "label": "Replier / déplier la barre de commandes",
                 "source": None},
                {"id": "fullscreen", "label": "Plein écran — activer / quitter",
                 "source": None},
                # Autopilote BOB-CONTROL : bascules du masque d'assistances
                # (PROTOCOLE_RPI5.md §4, v1.4.0+) — assignables aux boutons.
                {"id": "assist_rt", "label": "Autopilote — stabiliser roulis / tangage",
                 "source": None},
                {"id": "assist_depth", "label": "Autopilote — tenir la profondeur",
                 "source": None},
                {"id": "assist_cap", "label": "Autopilote — tenir le cap",
                 "source": None},
                {"id": "assist_passif", "label": "Autopilote — tout couper (passif)",
                 "source": None},
                {"id": "head_tracker_engage", "label": "Activer / recentrer le head-tracker BOB BL AR",
                 "source": None},
            ],
        },
        # BOB BL AR : source d'orientation BLE routable vers une action axe
        # existante. Aucune destination matérielle n'est imposée ici.
        "head_tracker": {
            "enabled": False,
            "device_id": "",
            "mode": "hold",              # hold = bouton maintenu, always = routage permanent
            "routes": [],                  # {axis, action, invert}
        },
    },
    "ar_glasses": {"enabled": False, "host": "", "port": 5000},
    "interface": {
        "theme": "dark",
        "language": "fr",
        "tile_order": [],
        "parameters_order": [],
    },
    # Vue de pilotage (section CONFIG COCKPIT) : disposition par défaut,
    # éléments de télémétrie à incruster et mise en page HUD (positions en %
    # de l'image vidéo — réglables à la souris dans le Cockpit).
    "cockpit": {
        "mode": "pip",
        "source": "cam1",
        "overlay": {
            "horizon": True,
            "heading": True,
            "depth": True,
            "temperature": True,
            "gauges": True,
            "grip": True,
            "aux": True,
            "voltage": True,
            "motor_v": True,
            "motor_h": True,
        },
        "hud": {
            "elements": {
                "horizon":  {"x": 37.0, "y": 12.0, "w": 26.0, "h": 40.0, "opacity": 0.92,
                             "color": "#00d9ff", "weight": 1.0, "font": 1.0},
                "heading":  {"x": 34.0, "y": 3.0,  "w": 32.0, "h": 8.0,  "opacity": 0.92,
                             "color": "#00d9ff", "weight": 1.0, "font": 1.0},
                # Jauge de profondeur : « max » = profondeur max en mètres
                # (échelle du cadran, virage au rouge et clignotement à −2 m).
                "depth":    {"x": 82.0, "y": 8.0,  "w": 15.0, "h": 56.0, "opacity": 0.92,
                             "color": "#00d9ff", "weight": 1.0, "font": 1.0, "max": 100.0},
                # Température de l'eau : instrument séparé, réglable indépendamment.
                "temperature": {"x": 82.0, "y": 64.5, "w": 15.0, "h": 5.2, "opacity": 0.92,
                                "color": "#00d9ff", "weight": 1.0, "font": 1.0},
                # Jauges moteurs M1–M8 (style Sub Simulator) : 8 barres divergentes
                # du neutre, alimentées par l'écho PWM des voies 1 à 8.
                "gauges":   {"x": 0.5,  "y": 56.0, "w": 26.0, "h": 25.0, "opacity": 0.92,
                             "color": "#00d9ff", "weight": 1.0, "font": 1.0},
                # Pince et rotation de pince : voies PWM 9 et 10 en microsecondes.
                "grip":     {"x": 27.0, "y": 56.0, "w": 12.5, "h": 8.5,  "opacity": 0.92,
                             "color": "#00d9ff", "weight": 1.0, "font": 1.0},
                # Voies PWM restantes 11 à 16 (auxiliaires).
                "aux":      {"x": 27.0, "y": 65.5, "w": 12.5, "h": 27.0, "opacity": 0.92,
                             "color": "#00d9ff", "weight": 1.0, "font": 1.0},
                # Trois jauges réglables séparément : tension batterie, courant des
                # moteurs verticaux et horizontaux (empilées en bas à gauche).
                "voltage":  {"x": 0.5,  "y": 81.5, "w": 13.8, "h": 5.2,  "opacity": 0.92,
                             "color": "#00d9ff", "weight": 1.0, "font": 1.0},
                "motor_v":  {"x": 0.5,  "y": 87.3, "w": 13.8, "h": 5.2,  "opacity": 0.92,
                             "color": "#00d9ff", "weight": 1.0, "font": 1.0},
                "motor_h":  {"x": 0.5,  "y": 93.1, "w": 13.8, "h": 5.2,  "opacity": 0.92,
                             "color": "#00d9ff", "weight": 1.0, "font": 1.0},
            },
        },
    },
    "videos": {"folder": "videos", "auto_record": False},
    "simulator": {"enabled": False},
    "safety": {"watchdog_ms": 500, "surface_pressure_mbar": 1013.25, "neutral_us": 1500},
}


class ConfigError(Exception):
    """Configuration invalide : lecture impossible, type ou borne incorrects."""


# ---------------------------------------------------------------------------
# Helpers internes
# ---------------------------------------------------------------------------

def _migrate(raw: dict) -> dict:
    """Migrations douces des anciennes clés (fichier utilisateur conservé).

    ``network.wifi_enabled`` (booléen historique) devient ``network.mode`` :
    True équivalait à « LAN prioritaire », False à « LAN uniquement ».
    ``network.speedtest.size_mb`` (échantillon fixe) disparaît au profit de
    ``duration_s`` : le test s'adapte désormais à la vitesse du lien.
    ``cameras.stereo`` (enregistrement 3D) : les deux côtés sont initialisés
    avec le binôme cam1/cam2 déjà configuré (Avant G + Avant D), puis restent
    indépendants.
    """
    net = raw.get("network")
    if isinstance(net, dict):
        if "wifi_enabled" in net:
            legacy = net.pop("wifi_enabled")
            net.setdefault("mode", "lan_first" if legacy else "lan_only")
        speedtest = net.get("speedtest")
        if isinstance(speedtest, dict):
            speedtest.pop("size_mb", None)
    cams = raw.get("cameras")
    if isinstance(cams, dict):
        stereo = cams.get("stereo")
        if not isinstance(stereo, dict):
            stereo = {}
            cams["stereo"] = stereo
        for side, cam_name in (("left_device", "cam1"), ("right_device", "cam2")):
            current = stereo.get(side)
            if isinstance(current, str) and current.strip():
                continue
            cam = cams.get(cam_name)
            device = cam.get("device") if isinstance(cam, dict) else None
            stereo[side] = str(device).strip() or DEFAULTS["cameras"][cam_name]["device"]
    return raw


def _deep_merge(base: dict, override: dict) -> dict:
    """Fusion récursive de ``override`` par-dessus ``base`` (sans mutation)."""
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ConfigError(message)


def _valid_source(source) -> bool:
    """Source manette : {type: axis|button, index: 0-64, invert: bool, pad?: str}.

    ``pad`` identifie la manette d'origine (``Gamepad.id`` du navigateur) ;
    absent, la source vaut pour toutes les manettes.
    """
    return (isinstance(source, dict)
            and source.get("type") in ("axis", "button")
            and _is_int(source.get("index")) and 0 <= source["index"] <= 64
            and isinstance(source.get("invert", False), bool)
            and (source.get("pad") is None
                 or (isinstance(source.get("pad"), str) and len(source["pad"]) <= 120)))


def _validate(cfg: dict) -> None:
    """Vérifie types et bornes des sections connues (les clés libres sont tolérées)."""
    serial = cfg["serial"]
    _require(isinstance(serial["port"], str) and serial["port"].strip() != "",
             "serial.port : chaîne non vide attendue (ex. /dev/serial0)")
    _require(_is_int(serial["baud"]) and serial["baud"] > 0,
             "serial.baud : entier positif attendu (ex. 921600)")
    _require(_is_number(serial["tx_hz"]) and 1 <= serial["tx_hz"] <= 100,
             "serial.tx_hz : cadence descendante attendue entre 1 et 100 Hz (recommandé 20–50)")
    _require(_is_number(serial["reconnect_delay_s"]) and 0.1 <= serial["reconnect_delay_s"] <= 60,
             "serial.reconnect_delay_s : délai de reconnexion attendu entre 0,1 et 60 s")

    network = cfg["network"]
    _require(isinstance(network["host"], str) and network["host"].strip() != "",
             "network.host : chaîne non vide attendue (ex. 0.0.0.0)")
    _require(_is_int(network["port"]) and 1 <= network["port"] <= 65535,
             "network.port : port TCP attendu entre 1 et 65535")
    _require(network["mode"] in NETWORK_MODES,
             "network.mode : valeur attendue parmi " + ", ".join(NETWORK_MODES))
    speedtest = network["speedtest"]
    _require(_is_number(speedtest["duration_s"]) and 1 <= speedtest["duration_s"] <= 30,
             "network.speedtest.duration_s : durée attendue entre 1 et 30 secondes")
    _require(_is_number(speedtest["mbps_per_camera"]) and 1 <= speedtest["mbps_per_camera"] <= 200,
             "network.speedtest.mbps_per_camera : débit attendu entre 1 et 200 Mbit/s")

    for name in ("cam1", "cam2", "cam3"):
        cam = cfg["cameras"][name]
        # cam3 (vue Arrière) peut rester non assignée : chemin vide accepté,
        # mais tout chemin fourni est validé comme les deux autres caméras.
        if name != "cam3" or str(cam["device"]).strip() != "":
            _require(isinstance(cam["device"], str) and cam["device"].strip() != "",
                     f"cameras.{name}.device : chaîne non vide attendue (ex. /dev/video0)")
        _require(_is_int(cam["width"]) and 16 <= cam["width"] <= 7680,
                 f"cameras.{name}.width : largeur attendue entre 16 et 7680")
        _require(_is_int(cam["height"]) and 16 <= cam["height"] <= 4320,
                 f"cameras.{name}.height : hauteur attendue entre 16 et 4320")
        _require(_is_number(cam["fps"]) and 1 <= cam["fps"] <= 120,
                 f"cameras.{name}.fps : cadence attendue entre 1 et 120")
        _require(_is_int(cam["jpeg_quality"]) and 1 <= cam["jpeg_quality"] <= 100,
                 f"cameras.{name}.jpeg_quality : qualité JPEG attendue entre 1 et 100")

    stereo = cfg["cameras"]["stereo"]
    for side, example in (("left_device", "/dev/video0"), ("right_device", "/dev/video2")):
        _require(isinstance(stereo[side], str) and stereo[side].strip() != "",
                 f"cameras.stereo.{side} : chaîne non vide attendue (ex. {example})")

    pip = cfg["cameras"]["pip"]
    _require(isinstance(pip["enabled"], bool), "cameras.pip.enabled : booléen attendu")
    _require(pip["corner"] in PIP_CORNERS,
             "cameras.pip.corner : valeur attendue parmi " + ", ".join(PIP_CORNERS))
    _require(_is_number(pip["width_percent"]) and 5 <= pip["width_percent"] <= 100,
             "cameras.pip.width_percent : largeur du PIP attendue entre 5 et 100 %")
    _require(_is_number(pip["opacity"]) and 0 <= pip["opacity"] <= 1,
             "cameras.pip.opacity : opacité attendue entre 0 et 1")

    recording = cfg["cameras"]["recording"]
    _require(_is_number(recording["video_fps"]) and 1 <= recording["video_fps"] <= 60,
             "cameras.recording.video_fps : cadence vidéo attendue entre 1 et 60")
    _require(_is_number(recording["video_bitrate_mbps"]) and 0.1 <= recording["video_bitrate_mbps"] <= 50,
             "cameras.recording.video_bitrate_mbps : débit attendu entre 0,1 et 50 Mbit/s")
    _require(_is_int(recording["photo_quality"]) and 1 <= recording["photo_quality"] <= 100,
             "cameras.recording.photo_quality : qualité photo attendue entre 1 et 100")

    inp = cfg["input"]
    _require(_is_number(inp["deadzone"]) and 0 <= inp["deadzone"] < 1,
             "input.deadzone : zone morte attendue entre 0 et 1 (valeur 1 exclue)")
    _require(_is_number(inp["expo"]) and 0.1 <= inp["expo"] <= 5,
             "input.expo : exposant de courbe attendu entre 0,1 et 5")
    _require(_is_number(inp["max_speed_us"]) and 1 <= inp["max_speed_us"] <= 500,
             "input.max_speed_us : débattement maximal attendu entre 1 et 500 µs")
    _require(isinstance(inp["imu"]["enabled"], bool), "input.imu.enabled : booléen attendu")
    _require(isinstance(inp["imu"]["device"], str), "input.imu.device : chaîne attendue")

    head_tracker = inp["head_tracker"]
    _require(isinstance(head_tracker, dict), "input.head_tracker : objet attendu")
    _require(isinstance(head_tracker.get("enabled"), bool),
             "input.head_tracker.enabled : booléen attendu")
    _require(isinstance(head_tracker.get("device_id"), str)
             and len(head_tracker["device_id"]) <= 120,
             "input.head_tracker.device_id : chaîne de 120 caractères maximum attendue")
    _require(head_tracker.get("mode") in ("hold", "always"),
             "input.head_tracker.mode : valeur 'hold' ou 'always' attendue")
    routes = head_tracker.get("routes")
    _require(isinstance(routes, list), "input.head_tracker.routes : liste attendue")
    for route in routes:
        _require(isinstance(route, dict)
                 and _is_int(route.get("axis")) and 0 <= route["axis"] <= 64
                 and isinstance(route.get("action"), str) and route["action"].strip() != ""
                 and len(route["action"]) <= 64
                 and isinstance(route.get("invert", False), bool),
                 "input.head_tracker.routes[] : objet {axis: 0-64, action: texte, invert: bool} attendu")

    gamepad = inp["gamepad"]
    _require(isinstance(gamepad["enabled"], bool), "input.gamepad.enabled : booléen attendu")
    _require(isinstance(gamepad["actions"], list), "input.gamepad.actions : liste attendue")
    for action in gamepad["actions"]:
        _require(isinstance(action, dict) and isinstance(action.get("id"), str) and action["id"].strip() != "",
                 "input.gamepad.actions[] : objet {id, label, sources} attendu")
        _require(isinstance(action.get("label"), str),
                 f"input.gamepad.actions[{action['id']}].label : chaîne attendue")
        source = action.get("source")                       # format hérité : une seule source
        _require(source is None or _valid_source(source),
                 f"input.gamepad.actions[{action['id']}].source : "
                 "{type: axis|button, index: 0-64, invert: bool} attendu")
        sources = action.get("sources")                     # format courant : une source par manette
        _require(sources is None
                 or (isinstance(sources, list) and all(_valid_source(item) for item in sources)),
                 f"input.gamepad.actions[{action['id']}].sources : liste de "
                 "{type: axis|button, index: 0-64, invert: bool, pad: nom de manette} attendue")

    ar = cfg["ar_glasses"]
    _require(isinstance(ar["enabled"], bool), "ar_glasses.enabled : booléen attendu")
    _require(isinstance(ar["host"], str), "ar_glasses.host : chaîne attendue")
    _require(_is_int(ar["port"]) and 1 <= ar["port"] <= 65535,
             "ar_glasses.port : port attendu entre 1 et 65535")

    ui = cfg["interface"]
    _require(ui["theme"] in ("dark", "light"), "interface.theme : « dark » ou « light » attendu")
    _require(ui["language"] in ("fr", "en"), "interface.language : « fr » ou « en » attendu")
    _require(isinstance(ui["tile_order"], list) and all(isinstance(t, str) for t in ui["tile_order"]),
             "interface.tile_order : liste d'identifiants (chaînes) attendue")
    _require(isinstance(ui["parameters_order"], list) and all(isinstance(t, str) for t in ui["parameters_order"]),
             "interface.parameters_order : liste d'identifiants (chaînes) attendue")

    cockpit = cfg["cockpit"]
    _require(cockpit["mode"] in ("solo", "duo", "pip"),
             "cockpit.mode : « solo », « duo » ou « pip » attendu")
    _require(cockpit["source"] in ("cam1", "cam2", "cam3"),
             "cockpit.source : « cam1 », « cam2 » ou « cam3 » attendu")
    for key, value in cockpit["overlay"].items():
        _require(isinstance(value, bool), f"cockpit.overlay.{key} : booléen attendu")

    hud_elements = cockpit["hud"]["elements"]
    _require(isinstance(hud_elements, dict) and bool(hud_elements),
             "cockpit.hud.elements : objet non vide attendu")
    for key, element in hud_elements.items():
        _require(isinstance(element, dict),
                 f"cockpit.hud.elements.{key} : objet {{x, y, w, h, opacity, color, weight, font, max ?}} attendu")
        for field in ("x", "y", "w", "h"):
            _require(_is_number(element.get(field)) and 0 <= element[field] <= 100,
                     f"cockpit.hud.elements.{key}.{field} : pourcentage attendu entre 0 et 100")
        _require(element["w"] >= 4 and element["h"] >= 4,
                 f"cockpit.hud.elements.{key} : taille minimale de 4 % de l'écran attendue")
        _require(_is_number(element.get("opacity")) and 0.05 <= element["opacity"] <= 1,
                 f"cockpit.hud.elements.{key}.opacity : opacité attendue entre 0,05 et 1")
        color = element.get("color", "#00d9ff")
        _require(isinstance(color, str) and len(color) == 7 and color.startswith("#")
                 and all(ch in "0123456789abcdefABCDEF" for ch in color[1:]),
                 f"cockpit.hud.elements.{key}.color : couleur « #rrggbb » attendue")
        weight = element.get("weight", 1.0)
        _require(_is_number(weight) and 0.5 <= weight <= 2.5,
                 f"cockpit.hud.elements.{key}.weight : finesse attendue entre 0,5 et 2,5")
        font = element.get("font", 1.0)
        _require(_is_number(font) and 0.5 <= font <= 2.5,
                 f"cockpit.hud.elements.{key}.font : taille de texte attendue entre 0,5 et 2,5")
        # « max » (optionnel, jauge de profondeur) : profondeur max en mètres.
        max_depth = element.get("max")
        if max_depth is not None:
            _require(_is_number(max_depth) and 5 <= max_depth <= 500,
                     f"cockpit.hud.elements.{key}.max : profondeur max attendue entre 5 et 500 m")

    videos = cfg["videos"]
    _require(isinstance(videos["folder"], str) and videos["folder"].strip() != "",
             "videos.folder : chemin de dossier non vide attendu")
    _require(isinstance(videos["auto_record"], bool), "videos.auto_record : booléen attendu")

    _require(isinstance(cfg["simulator"]["enabled"], bool), "simulator.enabled : booléen attendu")

    safety = cfg["safety"]
    _require(_is_int(safety["watchdog_ms"]) and 100 <= safety["watchdog_ms"] <= 5000,
             "safety.watchdog_ms : 100–5000 ms attendu (défaut firmware : 500)")
    _require(_is_number(safety["surface_pressure_mbar"]) and 800 <= safety["surface_pressure_mbar"] <= 1100,
             "safety.surface_pressure_mbar : pression de référence attendue entre 800 et 1100 mbar")
    _require(_is_int(safety["neutral_us"]) and 1000 <= safety["neutral_us"] <= 2000,
             "safety.neutral_us : neutre attendu entre 1000 et 2000 µs")


def _warn(cfg: dict) -> None:
    """Avertissements non bloquants (cohérence PROTOCOLE_RPI5.md §4.2, watchdog 500 ms)."""
    tx_hz = cfg["serial"]["tx_hz"]
    if tx_hz < 2.5:
        log.warning("serial.tx_hz=%.1f Hz : sous 2,5 Hz, le watchdog firmware (500 ms) déclenche le failsafe", tx_hz)
    elif tx_hz > 50:
        log.warning("serial.tx_hz=%.1f Hz : au-delà de 50 Hz, bande passante inutile (recommandé 20–50)", tx_hz)
    stereo = cfg["cameras"]["stereo"]
    if stereo["left_device"].strip() == stereo["right_device"].strip():
        log.warning("cameras.stereo : gauche et droite sur le même périphérique (%s) — "
                    "les deux fichiers 3D montreront la même scène", stereo["left_device"])


# ---------------------------------------------------------------------------
# Gestionnaire de configuration
# ---------------------------------------------------------------------------

class ConfigManager:
    """Accès thread-safe à la configuration courante (instance unique ``CONFIG``)."""

    def __init__(self, path: Path = CONFIG_PATH):
        self._path = Path(path)
        self._lock = threading.RLock()
        self._data: dict | None = None

    # -- API publique --------------------------------------------------------

    def load(self) -> dict:
        """Charge (ou crée) config.json, complète les défauts manquants et valide."""
        with self._lock:
            created = not self._path.exists()
            raw: dict = {}
            if not created:
                try:
                    raw = json.loads(self._path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as exc:
                    raise ConfigError(f"lecture de {self._path} impossible : {exc}") from exc
                if not isinstance(raw, dict):
                    raise ConfigError(f"{self._path} : la racine doit être un objet JSON")
            merged = _deep_merge(DEFAULTS, _migrate(raw))
            _validate(merged)
            if created or merged != raw:
                self._write(merged)
                log.info("config.json %s (%s)",
                         "généré depuis les défauts" if created else "complété avec les clés manquantes",
                         self._path)
            else:
                log.info("config.json chargé (%s)", self._path)
            self._data = merged
            _warn(merged)
            return copy.deepcopy(merged)

    def get(self) -> dict:
        """Copie profonde de la configuration courante."""
        with self._lock:
            return copy.deepcopy(self._ensure_loaded())

    def get_section(self, name: str) -> dict:
        """Copie profonde d'une section (ex. « serial », « network »)."""
        with self._lock:
            section = self._ensure_loaded().get(name)
            if not isinstance(section, dict):
                raise ConfigError(f"section inconnue : {name}")
            return copy.deepcopy(section)

    def update(self, patch: dict) -> dict:
        """Fusionne un patch partiel, valide, persiste puis retourne la configuration.

        Les clés absentes du patch conservent leur valeur courante. En cas de
        validation en échec, aucune écriture n'est effectuée.
        """
        if not isinstance(patch, dict) or not patch:
            raise ConfigError("patch invalide : objet JSON non vide attendu")
        with self._lock:
            candidate = _deep_merge(self._ensure_loaded(), patch)
            _validate(candidate)
            self._write(candidate)
            self._data = candidate
            _warn(candidate)
            log.info("config.json mis à jour (sections modifiées : %s)", ", ".join(sorted(patch)))
            return copy.deepcopy(candidate)

    # -- Interne -------------------------------------------------------------

    def _ensure_loaded(self) -> dict:
        """Chargement paresseux (filet de sécurité si load() n'a pas été appelé)."""
        if self._data is None:
            self.load()
        assert self._data is not None
        return self._data

    def _write(self, data: dict) -> None:
        """Écriture atomique : fichier temporaire puis os.replace (même dossier)."""
        tmp = self._path.with_name(self._path.name + ".tmp")
        try:
            tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError as exc:
            raise ConfigError(f"écriture de {self._path} impossible : {exc}") from exc


# Instance unique de l'application, partagée par tous les modules métier.
CONFIG = ConfigManager()


def get_config() -> ConfigManager:
    """Accès au gestionnaire de configuration global."""
    return CONFIG
