"""Tests de la configuration centralisée (étape 1).

Chaque test utilise un config.json isolé dans tmp_path : aucune écriture
dans le vrai fichier du projet.
"""
import json

import pytest

from app.config import DEFAULTS, ConfigError, ConfigManager


def test_load_generates_file_with_defaults(tmp_path):
    path = tmp_path / "config.json"
    cfg = ConfigManager(path).load()
    assert path.exists()
    assert cfg == DEFAULTS
    assert json.loads(path.read_text(encoding="utf-8")) == DEFAULTS


def test_missing_keys_are_completed(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"network": {"port": 9090}}), encoding="utf-8")
    cfg = ConfigManager(path).load()
    assert cfg["network"]["port"] == 9090          # valeur utilisateur conservée
    assert cfg["network"]["host"] == "0.0.0.0"     # défaut complété
    assert cfg["serial"]["baud"] == 921600


def test_update_persists_deep_patch(tmp_path):
    path = tmp_path / "config.json"
    mgr = ConfigManager(path)
    mgr.load()
    mgr.update({"interface": {"theme": "light"}})
    assert mgr.get()["interface"]["theme"] == "light"
    reloaded = ConfigManager(path).load()
    assert reloaded["interface"]["theme"] == "light"
    assert reloaded["interface"]["language"] == "fr"   # clé non touchée conservée


def test_invalid_value_rejected_without_write(tmp_path):
    path = tmp_path / "config.json"
    mgr = ConfigManager(path)
    mgr.load()
    with pytest.raises(ConfigError):
        mgr.update({"network": {"port": 99999}})
    assert mgr.get()["network"]["port"] == 8080        # échec sans écriture
    assert json.loads(path.read_text(encoding="utf-8"))["network"]["port"] == 8080


def test_unknown_keys_are_preserved(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"custom": {"flag": True}}), encoding="utf-8")
    cfg = ConfigManager(path).load()
    assert cfg["custom"] == {"flag": True}


def test_unknown_section_rejected(tmp_path):
    mgr = ConfigManager(tmp_path / "config.json")
    with pytest.raises(ConfigError):
        mgr.get_section("inconnue")
