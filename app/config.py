"""Configuration centralisée du cockpit BOBROV — source unique de vérité.

Le fichier ``config.json`` (racine du projet) est créé automatiquement au
premier lancement depuis les ``DEFAULTS`` ci-dessous, puis reste la référence :
toute clé absente est complétée par son défaut, toute écriture est validée
(types + bornes) puis persistée de façon atomique (fichier temporaire +
``os.replace``), jamais de config.json tronquée.

Bornes série issues de PROTOCOLE_RPI5.md §4.2 : cadence descendante
recommandée 20–50 Hz, watchdog firmware 500 ms par défaut (§6.1).
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

DEFAULTS: dict = {
    "config_version": 1,
    "serial": {
        "port": "/dev/ttyACM0",
        "baud": 921600,
        "tx_hz": 25,
        "reconnect_delay_s": 2,
    },
    "network": {
        "host": "0.0.0.0",
        "port": 8080,
    },
    "cameras": {
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
        "pip": {
            "enabled": True,
            "corner": "bottom-right",
            "width_percent": 28,
            "opacity": 0.9,
        },
    },
    "input": {
        "deadzone": 0.08,
        "expo": 1.5,
        "max_speed_us": 400,
        "imu": {"enabled": False, "device": ""},
    },
    "ar_glasses": {"enabled": False, "host": "", "port": 5000},
    "interface": {"theme": "dark", "language": "fr", "tile_order": []},
    "videos": {"folder": "videos", "auto_record": False},
    "simulator": {"enabled": False},
    "safety": {"watchdog_ms": 500, "surface_pressure_mbar": 1013.25, "neutral_us": 1500},
}


class ConfigError(Exception):
    """Configuration invalide : lecture impossible, type ou borne incorrects."""


# ---------------------------------------------------------------------------
# Helpers internes
# ---------------------------------------------------------------------------

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


def _validate(cfg: dict) -> None:
    """Vérifie types et bornes des sections connues (les clés libres sont tolérées)."""
    serial = cfg["serial"]
    _require(isinstance(serial["port"], str) and serial["port"].strip() != "",
             "serial.port : chaîne non vide attendue (ex. /dev/ttyACM0)")
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

    for name in ("cam1", "cam2"):
        cam = cfg["cameras"][name]
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

    pip = cfg["cameras"]["pip"]
    _require(isinstance(pip["enabled"], bool), "cameras.pip.enabled : booléen attendu")
    _require(pip["corner"] in PIP_CORNERS,
             "cameras.pip.corner : valeur attendue parmi " + ", ".join(PIP_CORNERS))
    _require(_is_number(pip["width_percent"]) and 5 <= pip["width_percent"] <= 100,
             "cameras.pip.width_percent : largeur du PIP attendue entre 5 et 100 %")
    _require(_is_number(pip["opacity"]) and 0 <= pip["opacity"] <= 1,
             "cameras.pip.opacity : opacité attendue entre 0 et 1")

    inp = cfg["input"]
    _require(_is_number(inp["deadzone"]) and 0 <= inp["deadzone"] < 1,
             "input.deadzone : zone morte attendue entre 0 et 1 (valeur 1 exclue)")
    _require(_is_number(inp["expo"]) and 0.1 <= inp["expo"] <= 5,
             "input.expo : exposant de courbe attendu entre 0,1 et 5")
    _require(_is_number(inp["max_speed_us"]) and 1 <= inp["max_speed_us"] <= 500,
             "input.max_speed_us : débattement maximal attendu entre 1 et 500 µs")
    _require(isinstance(inp["imu"]["enabled"], bool), "input.imu.enabled : booléen attendu")
    _require(isinstance(inp["imu"]["device"], str), "input.imu.device : chaîne attendue")

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
            merged = _deep_merge(DEFAULTS, raw)
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
