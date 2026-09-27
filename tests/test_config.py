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
    # Liaison UART natif GPIO 14/15 par défaut (Protocole §7 : « UART GPIO : /dev/serial0 »).
    assert cfg["serial"]["port"] == "/dev/serial0"
    assert cfg["serial"]["baud"] == 921600


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


# -- Réseau : priorité des liens et test de débit ---------------------------------

def test_network_defaults_mode_and_speedtest(tmp_path):
    cfg = ConfigManager(tmp_path / "config.json").load()
    assert cfg["network"]["mode"] == "lan_first"
    assert cfg["network"]["speedtest"] == {"duration_s": 8, "mbps_per_camera": 8}


def test_network_mode_and_speedtest_validated(tmp_path):
    mgr = ConfigManager(tmp_path / "config.json")
    mgr.load()
    mgr.update({"network": {"mode": "lan_only"}})
    assert mgr.get()["network"]["mode"] == "lan_only"
    for bad in ({"mode": "auto"},
                {"speedtest": {"duration_s": 0}},
                {"speedtest": {"duration_s": 31}},
                {"speedtest": {"mbps_per_camera": 0}},
                {"speedtest": {"mbps_per_camera": 500}}):
        with pytest.raises(ConfigError):
            mgr.update({"network": bad})
    assert mgr.get()["network"]["mode"] == "lan_only"      # échecs sans écriture


def test_network_legacy_wifi_enabled_migrated(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"network": {"wifi_enabled": False}}), encoding="utf-8")
    cfg = ConfigManager(path).load()
    assert cfg["network"]["mode"] == "lan_only"             # False ⇒ LAN uniquement
    written = json.loads(path.read_text(encoding="utf-8"))
    assert "wifi_enabled" not in written["network"]
    assert written["network"]["mode"] == "lan_only"


def test_network_legacy_speedtest_size_migrated_to_duration(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"network": {"speedtest": {"size_mb": 32}}}),
                    encoding="utf-8")
    cfg = ConfigManager(path).load()
    assert cfg["network"]["speedtest"] == {"duration_s": 8, "mbps_per_camera": 8}
    written = json.loads(path.read_text(encoding="utf-8"))
    assert "size_mb" not in written["network"]["speedtest"]


# -- Mise en page HUD (section CONFIG COCKPIT) -------------------------------------

def test_hud_layout_defaults_present_and_valid(tmp_path):
    cfg = ConfigManager(tmp_path / "config.json").load()
    elements = cfg["cockpit"]["hud"]["elements"]
    assert set(elements) == {"horizon", "heading", "depth", "temperature", "gauges",
                             "grip", "aux", "voltage", "motor_v", "motor_h"}
    for element in elements.values():
        assert 0 <= element["x"] <= 100 and 0 <= element["y"] <= 100
        assert element["w"] >= 4 and element["h"] >= 4
        assert 0.05 <= element["opacity"] <= 1
        assert element["color"] == "#00d9ff" and element["weight"] == 1.0
        assert element["font"] == 1.0
    # Jauges moteurs M1–M8, pince (voies 9-10) et voies restantes (11-16) :
    # les colonnes restent dans la scène (x + w ≤ 100, y + h ≤ 100).
    for key in ("gauges", "grip", "aux"):
        element = elements[key]
        assert element["x"] + element["w"] <= 100 and element["y"] + element["h"] <= 100


def test_cockpit_overlay_defaults_cover_every_instrument(tmp_path):
    cfg = ConfigManager(tmp_path / "config.json").load()
    overlay = cfg["cockpit"]["overlay"]
    assert set(overlay) == {"horizon", "heading", "depth", "temperature", "gauges",
                            "grip", "aux", "voltage", "motor_v", "motor_h"}
    assert all(isinstance(value, bool) for value in overlay.values())


def test_hud_layout_update_persists_element(tmp_path):
    path = tmp_path / "config.json"
    mgr = ConfigManager(path)
    mgr.load()
    mgr.update({"cockpit": {"hud": {"elements": {
        "horizon": {"x": 10.0, "y": 20.0, "w": 30.0, "h": 35.0, "opacity": 0.5,
                    "color": "#ff8800", "weight": 2.0, "font": 1.6}}}}})
    reloaded = ConfigManager(path).load()
    assert reloaded["cockpit"]["hud"]["elements"]["horizon"] == {
        "x": 10.0, "y": 20.0, "w": 30.0, "h": 35.0, "opacity": 0.5,
        "color": "#ff8800", "weight": 2.0, "font": 1.6}
    # Les autres instruments conservent leur mise en page.
    assert reloaded["cockpit"]["hud"]["elements"]["heading"]["x"] == 34.0


def test_hud_layout_depth_max_accepted_and_persisted(tmp_path):
    path = tmp_path / "config.json"
    mgr = ConfigManager(path)
    mgr.load()
    # La profondeur max de la jauge fait partie de l'élément « depth » (défaut 100 m).
    assert mgr.get()["cockpit"]["hud"]["elements"]["depth"]["max"] == 100.0
    mgr.update({"cockpit": {"hud": {"elements": {
        "depth": {"x": 87.0, "y": 6.7, "w": 12.2, "h": 54.2, "opacity": 1.0,
                  "color": "#0091ff", "weight": 1.0, "font": 1.7, "max": 150.0}}}}})
    assert ConfigManager(path).load()["cockpit"]["hud"]["elements"]["depth"]["max"] == 150.0


def test_hud_layout_depth_max_invalid_rejected(tmp_path):
    path = tmp_path / "config.json"
    mgr = ConfigManager(path)
    mgr.load()
    for bad in (2.0, 501.0, 0.0, -10.0, "profond"):
        with pytest.raises(ConfigError):
            mgr.update({"cockpit": {"hud": {"elements": {"depth": {"max": bad}}}}})
    assert mgr.get()["cockpit"]["hud"]["elements"]["depth"]["max"] == 100.0


def test_hud_layout_invalid_values_rejected_without_write(tmp_path):
    path = tmp_path / "config.json"
    mgr = ConfigManager(path)
    mgr.load()
    for bad in ({"x": 120.0}, {"y": -5.0}, {"w": 2.0}, {"h": 2.0},
                {"opacity": 2.0}, {"opacity": 0.01},
                {"color": "cyan"}, {"color": "#00d9ff00"},
                {"weight": 0.1}, {"weight": 4.0},
                {"font": 0.2}, {"font": 3.0}):
        with pytest.raises(ConfigError):
            mgr.update({"cockpit": {"hud": {"elements": {"horizon": bad}}}})
        assert mgr.get()["cockpit"]["hud"]["elements"]["horizon"]["x"] == 37.0
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["cockpit"]["hud"]["elements"]["horizon"]["x"] == 37.0


# -- Actions manette (section MANETTE) --------------------------------------------

def test_gamepad_defaults_include_poste_actions(tmp_path):
    cfg = ConfigManager(tmp_path / "config.json").load()
    actions = cfg["input"]["gamepad"]["actions"]
    assert [action["id"] for action in actions[:6]] == [
        "voie1", "voie2", "voie3", "voie4", "voie5", "voie6"]
    for action_id in ("rec_view", "rec", "rec_3d", "swap_cams", "toggle_toolbar", "fullscreen",
                      "assist_rt", "assist_depth", "assist_cap", "assist_passif",
                      "head_tracker_engage"):
        entry = next(action for action in actions if action["id"] == action_id)
        assert entry["source"] is None
        assert isinstance(entry["label"], str) and entry["label"]
    assert cfg["input"]["head_tracker"] == {
        "enabled": False, "device_id": "", "mode": "hold", "routes": []}


def test_gamepad_rec_view_source_accepted(tmp_path):
    path = tmp_path / "config.json"
    mgr = ConfigManager(path)
    mgr.load()
    actions = [{"id": "rec_view", "label": "Enregistrer la vue (vidéo + HUD)",
                "source": {"type": "button", "index": 3}}]
    mgr.update({"input": {"gamepad": {"actions": actions}}})
    reloaded = ConfigManager(path).load()
    assert reloaded["input"]["gamepad"]["actions"] == actions


def test_gamepad_sources_per_pad_accepted(tmp_path):
    path = tmp_path / "config.json"
    mgr = ConfigManager(path)
    mgr.load()
    actions = [
        {"id": "surge", "label": "Avance / recul",
         "sources": [{"type": "axis", "index": 1, "invert": True,
                      "pad": "Wireless Controller (STANDARD GAMEPAD Vendor: 054c)"},
                     {"type": "button", "index": 0, "invert": False, "pad": "BOB BL AR"}]},
        {"id": "rec_view", "label": "Enregistrer la vue (vidéo + HUD)", "sources": []},
    ]
    mgr.update({"input": {"gamepad": {"actions": actions}}})
    reloaded = ConfigManager(path).load()
    assert reloaded["input"]["gamepad"]["actions"] == actions


def test_head_tracker_routes_accepted_and_rejected(tmp_path):
    mgr = ConfigManager(tmp_path / "config.json")
    mgr.load()
    route = {"axis": 2, "action": "yaw", "invert": True}
    mgr.update({"input": {"head_tracker": {
        "enabled": True, "device_id": "BOB BL AR", "mode": "hold", "routes": [route]}}})
    assert mgr.get()["input"]["head_tracker"]["routes"] == [route]

    for bad in (
        {"enabled": "oui", "device_id": "", "mode": "hold", "routes": []},
        {"enabled": True, "device_id": "", "mode": "toggle", "routes": []},
        {"enabled": True, "device_id": "", "mode": "hold",
         "routes": [{"axis": 65, "action": "yaw", "invert": False}]},
        {"enabled": True, "device_id": "", "mode": "hold",
         "routes": [{"axis": 1, "action": "", "invert": False}]},
    ):
        with pytest.raises(ConfigError):
            mgr.update({"input": {"head_tracker": bad}})


def test_gamepad_sources_rejected(tmp_path):
    mgr = ConfigManager(tmp_path / "config.json")
    mgr.load()
    bad_sources = [
        [{"type": "trigger", "index": 3}],                   # type inconnu
        [{"type": "axis", "index": 65}],                     # index hors bornes
        [{"type": "axis", "index": 1, "invert": "oui"}],     # invert non booléen
        [{"type": "button", "index": 3, "pad": 42}],         # pad non textuel
        [{"type": "button", "index": 3, "pad": "x" * 121}],  # pad trop long
        ["bouton 3"],                                        # entrée non objet
    ]
    for sources in bad_sources:
        with pytest.raises(ConfigError):
            mgr.update({"input": {"gamepad": {"actions": [
                {"id": "surge", "label": "Avance / recul", "sources": sources}]}}})


# -- Enregistrement stéréo 3D (section CAMÉRAS → stéréo) --------------------------

def test_stereo_defaults_present_and_valid(tmp_path):
    cfg = ConfigManager(tmp_path / "config.json").load()
    assert cfg["cameras"]["stereo"] == {"left_device": "/dev/video0",
                                         "right_device": "/dev/video2"}
    actions = cfg["input"]["gamepad"]["actions"]
    entry = next(action for action in actions if action["id"] == "rec_3d")
    assert entry["source"] is None
    assert isinstance(entry["label"], str) and entry["label"]


def test_stereo_migrated_from_existing_cameras(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"cameras": {"cam1": {"device": "/dev/video4"},
                                             "cam2": {"device": "/dev/video6"}}}),
                    encoding="utf-8")
    cfg = ConfigManager(path).load()
    assert cfg["cameras"]["stereo"] == {"left_device": "/dev/video4",
                                         "right_device": "/dev/video6"}
    # Choix indépendants : une valeur explicite n'est jamais écrasée au rechargement.
    mgr = ConfigManager(path)
    mgr.update({"cameras": {"stereo": {"left_device": "/dev/video1"}}})
    reloaded = ConfigManager(path).load()
    assert reloaded["cameras"]["stereo"] == {"left_device": "/dev/video1",
                                              "right_device": "/dev/video6"}


def test_stereo_devices_validated(tmp_path):
    mgr = ConfigManager(tmp_path / "config.json")
    mgr.load()
    for bad in ({"left_device": ""}, {"left_device": "  "}, {"right_device": ""},
                {"left_device": 3}, {"right_device": None}):
        with pytest.raises(ConfigError):
            mgr.update({"cameras": {"stereo": bad}})
    assert mgr.get()["cameras"]["stereo"] == {"left_device": "/dev/video0",
                                              "right_device": "/dev/video2"}


def test_stereo_same_device_allowed_and_warned(tmp_path, caplog):
    mgr = ConfigManager(tmp_path / "config.json")
    mgr.load()
    with caplog.at_level("WARNING", logger="bobrov.config"):
        mgr.update({"cameras": {"stereo": {"left_device": "/dev/video5",
                                             "right_device": "/dev/video5"}}})
    assert mgr.get()["cameras"]["stereo"]["left_device"] == "/dev/video5"
    assert any("même périphérique" in record.message for record in caplog.records)


# -- Caméra 3 (vue Arrière) : assignation optionnelle ---------------------------

def test_cam3_defaults_unassigned_and_valid(tmp_path):
    """cam3 existe par défaut sans périphérique ; tout chemin fourni est validé."""
    cfg = ConfigManager(tmp_path / "config.json").load()
    assert cfg["cameras"]["cam3"]["device"] == ""
    mgr = ConfigManager(tmp_path / "config.json")
    mgr.load()
    mgr.update({"cameras": {"cam3": {"device": "/dev/video4"}}})
    assert mgr.get()["cameras"]["cam3"]["device"] == "/dev/video4"
    mgr.update({"cameras": {"cam3": {"device": ""}}})
    assert mgr.get()["cameras"]["cam3"]["device"] == ""
    with pytest.raises(ConfigError):
        mgr.update({"cameras": {"cam3": {"device": 3}}})
    with pytest.raises(ConfigError):
        mgr.update({"cameras": {"cam3": {"jpeg_quality": 0}}})


def test_cockpit_source_accepts_cam3(tmp_path):
    mgr = ConfigManager(tmp_path / "config.json")
    mgr.load()
    mgr.update({"cockpit": {"source": "cam3"}})
    assert mgr.get()["cockpit"]["source"] == "cam3"
    with pytest.raises(ConfigError):
        mgr.update({"cockpit": {"source": "cam4"}})
