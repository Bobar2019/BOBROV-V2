"""Tests réseau : parsing nmcli et routes (nmcli/sudo simulés par monkeypatch).

Depuis la refonte de la section RÉSEAU : modes de priorité des liens
(lan_first / wifi_first / lan_only / wifi_only), renommage du Pi (mDNS) et
échantillon de débit. Les écritures nmcli partent avec ``sudo=True`` : polkit
refuse les modifications de profil hors session graphique.
"""
from __future__ import annotations

import subprocess

import pytest
from fastapi.testclient import TestClient

from app import network
from app.main import app


def _proc(stdout: str = "", stderr: str = "", returncode: int = 0) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["nmcli"], returncode=returncode,
                                       stdout=stdout, stderr=stderr)


class _StubConfig:
    """Remplace le gestionnaire de configuration : aucun accès disque."""

    def __init__(self, mode: str = "lan_first", speedtest: dict | None = None) -> None:
        self.mode = mode
        self.speedtest = speedtest or {"duration_s": 8, "mbps_per_camera": 8}
        self.patches: list[dict] = []

    def get(self) -> dict:
        return {"network": {"mode": self.mode, "port": 8080,
                            "speedtest": dict(self.speedtest)}}

    def update(self, patch: dict) -> dict:
        self.patches.append(patch)
        if "network" in patch and "mode" in patch["network"]:
            self.mode = str(patch["network"]["mode"])
        return self.get()


DEVICES_OUT = ("eth0:ethernet:connected:netplan-eth0\n"
               "wlan0:wifi:connected:netplan-wlan0-BOB\n")
CONNS_OUT = ("netplan-eth0:802-3-ethernet\n"
             "netplan-wlan0-BOB:802-11-wireless\n"
             "lo:loopback\n")
DETAILS_OUT = ("GENERAL.DEVICE:eth0\nGENERAL.CARRIER:yes\n"
               "IP4.ADDRESS[1]:192.168.1.125/24\n"
               "IP4.ROUTE[1]:dst = 192.168.1.0/24, nh = 0.0.0.0, mt = 100\n"
               "IP4.ROUTE[2]:dst = 0.0.0.0/0, nh = 192.168.1.1, mt = 100\n\n"
               "GENERAL.DEVICE:wlan0\nGENERAL.CARRIER:yes\n"
               "IP4.ADDRESS[1]:192.168.1.127/24\n"
               "IP4.ROUTE[1]:dst = 0.0.0.0/0, nh = 192.168.1.1, mt = 600\n")


def _fake_nmcli(devices: str = DEVICES_OUT, details: str = DETAILS_OUT,
                signal: str = "*:74\n"):
    """Faux nmcli routant selon la commande demandée."""
    def fake(args, timeout=network._CMD_TIMEOUT_S, sudo=False):
        joined = " ".join(args)
        if "CONNECTION" in joined:
            return _proc(devices)
        if "NAME,TYPE" in joined:
            return _proc(CONNS_OUT)
        if "device show" in joined:
            return _proc(details)
        if "IN-USE,SIGNAL" in joined:
            return _proc(signal)
        if joined.startswith("-t radio"):
            return _proc("enabled\n")
        return _proc("ok\n")
    return fake


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(network, "get_config", lambda: _StubConfig())
    return TestClient(app)


# -- Parsing des sorties terse -----------------------------------------------------

def test_parse_device_list():
    output = "eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:disconnected:\n\n"
    devices = network.parse_device_list(output)
    assert devices[0] == {"device": "eth0", "type": "ethernet", "state": "connected",
                          "connection": "Wired connection 1"}
    assert devices[1] == {"device": "wlan0", "type": "wifi", "state": "disconnected",
                          "connection": ""}


def test_parse_wifi_list_dedupes_escapes_and_skips_hidden():
    output = ("*:Maison\\:5G:82:WPA2\n:Maison\\:5G:64:WPA2\n"
              ":Voisin:47:WPA1 WPA2\n:Très\\:loin:12:\n::55:WPA2\n")
    networks = network.parse_wifi_list(output)
    assert [n["ssid"] for n in networks] == ["Maison:5G", "Voisin", "Très:loin"]
    assert networks[0]["active"] is True and networks[0]["signal"] == 82
    assert networks[2]["security"] == "" and networks[2]["active"] is False


def test_parse_device_details_extracts_ip_carrier_and_default_route():
    details = network.parse_device_details(DETAILS_OUT)
    assert details["eth0"] == {"ip4": "192.168.1.125", "gateway": "192.168.1.1",
                               "metric": 100, "default": True, "carrier": True}
    assert details["wlan0"]["metric"] == 600 and details["wlan0"]["default"] is True


def test_parse_device_details_without_ip_or_route():
    output = ("GENERAL.DEVICE:wlan0\nGENERAL.CARRIER:no\n")
    details = network.parse_device_details(output)
    assert details["wlan0"] == {"ip4": "", "gateway": "", "metric": None,
                                "default": False, "carrier": False}


def test_device_details_reads_carrier_from_sysfs_when_nmcli_omits_it(monkeypatch):
    """nmcli 1.52 n'expose pas GENERAL.CARRIER : le câble est lu dans sysfs."""
    output = ("GENERAL.DEVICE:eth0\nIP4.ADDRESS[1]:192.168.1.125/24\n"
              "IP4.ROUTE[1]:dst = 0.0.0.0/0, nh = 192.168.1.1, mt = 100\n")
    monkeypatch.setattr(network, "_run",
                        lambda args, timeout=0, sudo=False: _proc(output))
    monkeypatch.setattr(network, "_read_carrier", lambda device: device == "eth0")
    details = network._device_details()
    assert details["eth0"]["carrier"] is True
    assert details["eth0"]["ip4"] == "192.168.1.125"
    assert details["eth0"]["metric"] == 100


# -- Exécution sudo ------------------------------------------------------------------

def test_run_prefixes_sudo_only_for_writes(monkeypatch):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = list(cmd)
        return _proc("ok")

    monkeypatch.setattr(network.subprocess, "run", fake_run)
    network._run(["device", "disconnect", "wlan0"], sudo=True)
    assert captured["cmd"] == ["sudo", "-n", network.NMCLI, "device", "disconnect", "wlan0"]
    network._run(["-t", "radio", "wifi"])
    assert captured["cmd"] == [network.NMCLI, "-t", "radio", "wifi"]


# -- Routes /api/network : état -------------------------------------------------------

def test_status_reports_interfaces_access_and_speedtest(client, monkeypatch):
    monkeypatch.setattr(network, "_run", _fake_nmcli())
    monkeypatch.setattr(network, "web_port_80_active", False)
    data = client.get("/api/network").json()
    assert data["nmcli"] is True and data["wifi_radio"] is True
    assert data["mode"] == "lan_first"
    assert data["modes"] == ["lan_first", "wifi_first", "lan_only", "wifi_only"]
    assert data["mdns"] == data["hostname"] + ".local"
    assert data["port"] == 8080
    assert isinstance(data["ssh_user"], str)
    assert data["speedtest"] == {"duration_s": 8, "mbps_per_camera": 8.0}
    assert data["web_port_80"] is False
    assert data["lan"] == {"device": "eth0", "connected": True, "connection": "netplan-eth0",
                           "ip4": "192.168.1.125", "carrier": True, "default_route": True,
                           "metric": 100, "primary": True, "signal": None}
    assert data["wifi"]["connection"] == "netplan-wlan0-BOB"
    assert data["wifi"]["connected"] is True and data["wifi"]["signal"] == 74
    assert data["wifi"]["primary"] is False
    assert data["devices"][0]["ip4"] == "192.168.1.125"
    assert data["devices"][0]["primary"] is True
    assert data["devices"][1]["default_route"] is True and data["devices"][1]["metric"] == 600
    assert data["devices"][1]["primary"] is False


def test_status_degraded_without_nmcli(client, monkeypatch):
    def boom(args, timeout=network._CMD_TIMEOUT_S, sudo=False):
        raise network.NetworkError("nmcli introuvable")
    monkeypatch.setattr(network, "_run", boom)
    data = client.get("/api/network").json()
    assert data["nmcli"] is False and "introuvable" in data["error"]
    assert data["devices"] == [] and data["wifi"]["connected"] is False
    assert data["lan"]["device"] == "" and data["mode"] == "lan_first"


# -- Routes /api/network : modes de priorité -----------------------------------------

def test_mode_lan_first_applies_metrics_with_sudo(monkeypatch):
    stub = _StubConfig("wifi_first")
    monkeypatch.setattr(network, "get_config", lambda: stub)
    calls: list[tuple[list[str], bool]] = []

    def fake(args, timeout=network._CMD_TIMEOUT_S, sudo=False):
        calls.append((list(args), sudo))
        return _fake_nmcli()(args, timeout, sudo)

    monkeypatch.setattr(network, "_run", fake)
    data = TestClient(app).post("/api/network/mode", json={"mode": "lan_first"}).json()
    assert data["status"] == "ok" and data["mode"] == "lan_first"
    assert stub.patches == [{"network": {"mode": "lan_first"}}]
    assert (["con", "mod", "netplan-eth0", "ipv4.route-metric", "100"], True) in calls
    assert (["con", "mod", "netplan-wlan0-BOB", "ipv4.route-metric", "600"], True) in calls
    assert (["device", "reapply", "eth0"], True) in calls
    assert not any(c[0][:2] == ["device", "disconnect"] for c in calls)


def test_mode_wifi_only_disconnects_lan(monkeypatch):
    stub = _StubConfig("lan_first")
    monkeypatch.setattr(network, "get_config", lambda: stub)
    calls: list[list[str]] = []

    def fake(args, timeout=network._CMD_TIMEOUT_S, sudo=False):
        calls.append(list(args))
        return _fake_nmcli()(args, timeout, sudo)

    monkeypatch.setattr(network, "_run", fake)
    data = TestClient(app).post("/api/network/mode", json={"mode": "wifi_only"}).json()
    assert data["mode"] == "wifi_only"
    assert (["con", "mod", "netplan-eth0", "ipv4.route-metric", "600"]) in calls
    assert (["con", "mod", "netplan-wlan0-BOB", "ipv4.route-metric", "100"]) in calls
    assert ["device", "disconnect", "eth0"] in calls
    assert any("Ethernet déconnecté" in message for message in data["applied"])


def test_mode_invalid_rejected(client):
    response = client.post("/api/network/mode", json={"mode": "auto"})
    assert response.status_code == 422


def test_enforce_lan_only_disconnects_wifi(monkeypatch):
    stub = _StubConfig("lan_only")
    monkeypatch.setattr(network, "get_config", lambda: stub)
    calls: list[list[str]] = []

    def fake(args, timeout=network._CMD_TIMEOUT_S, sudo=False):
        calls.append(list(args))
        return _fake_nmcli()(args, timeout, sudo)

    monkeypatch.setattr(network, "_run", fake)
    network.enforce_network_preference()
    assert ["device", "disconnect", "wlan0"] in calls
    assert stub.patches == []                       # l'enforcement ne réécrit pas la config


def test_enforce_lan_first_never_cuts_links(monkeypatch):
    monkeypatch.setattr(network, "get_config", lambda: _StubConfig("lan_first"))
    calls: list[list[str]] = []

    def fake(args, timeout=network._CMD_TIMEOUT_S, sudo=False):
        calls.append(list(args))
        return _fake_nmcli()(args, timeout, sudo)

    monkeypatch.setattr(network, "_run", fake)
    network.enforce_network_preference()
    assert not any("disconnect" in call for call in calls)


# -- Routes /api/network : WiFi -------------------------------------------------------

def test_scan_parses_and_sorts(client, monkeypatch):
    monkeypatch.setattr(network, "_run",
                        lambda args, timeout=network._CMD_TIMEOUT_S, sudo=False:
                        _proc("*:Nautilus:88:WPA2\n:Port voisin:42:WPA2\n"))
    data = client.post("/api/network/scan").json()
    assert data["count"] == 2
    assert [n["ssid"] for n in data["networks"]] == ["Nautilus", "Port voisin"]
    assert data["networks"][0]["active"] is True


def test_scan_failure_reported(client, monkeypatch):
    monkeypatch.setattr(network, "_run",
                        lambda args, timeout=network._CMD_TIMEOUT_S, sudo=False:
                        _proc("", "Error: Scanning not allowed.", 1))
    response = client.post("/api/network/scan")
    assert response.status_code == 503
    assert response.json()["detail"] == "Scanning not allowed."


def test_connect_passes_credentials_with_sudo(monkeypatch):
    stub = _StubConfig("lan_only")
    monkeypatch.setattr(network, "get_config", lambda: stub)
    calls: list[tuple[list[str], bool]] = []

    def fake(args, timeout=network._CMD_TIMEOUT_S, sudo=False):
        calls.append((list(args), sudo))
        return _proc("Device 'wlan0' successfully activated.")

    monkeypatch.setattr(network, "_run", fake)
    data = TestClient(app).post("/api/network/connect",
                                json={"ssid": "Nautilus", "password": "secret"}).json()
    assert data["status"] == "ok"
    assert calls[0][0][:4] == ["dev", "wifi", "connect", "Nautilus"]
    assert calls[0][1] is True                        # écriture ⇒ sudo -n
    assert "secret" in calls[0][0]                    # transmis à nmcli…
    assert "secret" not in str(data)                  # …jamais renvoyé
    assert stub.patches == [{"network": {"mode": "lan_first"}}]


def test_connect_keeps_mode_when_wifi_already_allowed(monkeypatch):
    stub = _StubConfig("lan_first")
    monkeypatch.setattr(network, "get_config", lambda: stub)
    monkeypatch.setattr(network, "_run",
                        lambda args, timeout=network._CMD_TIMEOUT_S, sudo=False:
                        _proc("Device 'wlan0' successfully activated."))
    TestClient(app).post("/api/network/connect", json={"ssid": "Nautilus"})
    assert stub.patches == []                         # aucun passage par LAN uniquement


def test_connect_rejects_empty_ssid(client):
    assert client.post("/api/network/connect", json={}).status_code == 422


def test_connect_failure_is_reported(client, monkeypatch):
    monkeypatch.setattr(network, "_run",
                        lambda args, timeout=network._CMD_TIMEOUT_S, sudo=False:
                        _proc("", "Error: No network with SSID 'X' found.", 4))
    response = client.post("/api/network/connect", json={"ssid": "X"})
    assert response.status_code == 400
    assert response.json()["detail"] == "No network with SSID 'X' found."


def test_disconnect_sets_lan_only_mode(monkeypatch):
    stub = _StubConfig("lan_first")
    monkeypatch.setattr(network, "get_config", lambda: stub)
    calls: list[tuple[list[str], bool]] = []

    def fake(args, timeout=network._CMD_TIMEOUT_S, sudo=False):
        calls.append((list(args), sudo))
        if "CONNECTION" in " ".join(args):
            return _proc("wlan0:wifi:connected:MonWifi\n")
        return _proc("Device 'wlan0' successfully disconnected.")

    monkeypatch.setattr(network, "_run", fake)
    data = TestClient(app).post("/api/network/disconnect").json()
    assert data["status"] == "ok" and "wlan0" in data["message"]
    assert (["device", "disconnect", "wlan0"], True) in calls
    assert stub.patches == [{"network": {"mode": "lan_only"}}]


# -- Routes /api/network : nom .local --------------------------------------------------

def test_hostname_valid_normalizes_and_republishes(client, monkeypatch):
    root_calls: list[list[str]] = []

    def fake_root(args, timeout=network._CMD_TIMEOUT_S):
        root_calls.append(list(args))
        return _proc("")

    monkeypatch.setattr(network, "_run_root", fake_root)
    monkeypatch.setattr(network, "_rewrite_hosts_local", lambda name: True)
    data = client.post("/api/network/hostname", json={"name": "Bobrov-V2"}).json()
    assert data["status"] == "ok"
    assert data["hostname"] == "bobrov-v2" and data["mdns"] == "bobrov-v2.local"
    assert root_calls[0] == ["hostnamectl", "set-hostname", "bobrov-v2"]
    assert root_calls[1] == ["systemctl", "restart", "avahi-daemon"]
    assert data["warnings"] == []


def test_hostname_invalid_rejected(client):
    for bad in ("", "-bob", "bob-", "bob local", "bob.local", "x" * 64, "böb"):
        assert client.post("/api/network/hostname", json={"name": bad}).status_code == 422


def test_hostname_reports_avahi_failure_as_warning(client, monkeypatch):
    monkeypatch.setattr(network, "_run_root",
                        lambda args, timeout=network._CMD_TIMEOUT_S:
                        _proc("", "systemctl: failed", 1) if args[0] == "systemctl"
                        else _proc(""))
    monkeypatch.setattr(network, "_rewrite_hosts_local", lambda name: False)
    data = client.post("/api/network/hostname", json={"name": "bobrov"}).json()
    assert data["status"] == "ok"
    assert any("Avahi" in warning for warning in data["warnings"])
    assert any("/etc/hosts" in warning for warning in data["warnings"])


# -- Redirection du port 80 (accès http://<nom>.local sans « :8080 ») ------------------

def test_ensure_web_redirect_builds_nftables_redirect(monkeypatch):
    monkeypatch.setattr(network, "get_config", lambda: _StubConfig())
    monkeypatch.setattr(network, "web_port_80_active", False)
    calls: list[list[str]] = []

    def fake_root(args, timeout=network._CMD_TIMEOUT_S):
        calls.append(list(args))
        return _proc("")

    monkeypatch.setattr(network, "_run_root", fake_root)
    assert network.ensure_web_redirect() is True
    assert network.web_port_80_active is True
    # Table recréée (delete best-effort puis add) : idempotent à chaque démarrage.
    assert calls[0] == ["nft", "delete", "table", "ip", "bobrov_web"]
    assert calls[1] == ["nft", "add", "table", "ip", "bobrov_web"]
    assert calls[2][:5] == ["nft", "add", "chain", "ip", "bobrov_web"]
    assert "type nat hook prerouting" in " ".join(calls[2])
    # Règle finale : port 80 redirigé vers le port du cockpit (8080 ici).
    assert calls[3] == ["nft", "add", "rule", "ip", "bobrov_web", "prerouting",
                        "tcp", "dport", "80", "redirect", "to", ":8080"]
    # Accès depuis le Pi lui-même (navigateur local) : chaîne OUTPUT, jamais
    # vue par PREROUTING — destination locale uniquement.
    assert calls[4][:5] == ["nft", "add", "chain", "ip", "bobrov_web"]
    assert "type nat hook output" in " ".join(calls[4])
    assert calls[5] == ["nft", "add", "rule", "ip", "bobrov_web", "output",
                        "fib", "daddr", "type", "local", "tcp", "dport", "80",
                        "redirect", "to", ":8080"]


def test_ensure_web_redirect_degrades_without_error(monkeypatch):
    monkeypatch.setattr(network, "get_config", lambda: _StubConfig())
    monkeypatch.setattr(network, "web_port_80_active", False)

    def fake_root(args, timeout=network._CMD_TIMEOUT_S):
        failed = args[:3] == ["nft", "add", "rule"]
        return _proc("", "Operation not permitted", 1) if failed else _proc("")

    monkeypatch.setattr(network, "_run_root", fake_root)
    assert network.ensure_web_redirect() is False
    assert network.web_port_80_active is False


# -- Routes /api/network : test de débit ----------------------------------------------

def test_speedtest_streams_requested_size(client):
    response = client.get("/api/network/speedtest?mb=2")
    assert response.status_code == 200
    assert len(response.content) == 2 * 1024 * 1024
    assert response.headers["content-length"] == str(2 * 1024 * 1024)
    assert response.headers["cache-control"] == "no-store"


def test_speedtest_seconds_mode_streams_without_content_length(client):
    # Mode durée (utilisé par le cockpit) : le flux s'arrête à l'échéance, la
    # taille est inconnue d'avance — pas de Content-Length (transmission morcelée).
    response = client.get("/api/network/speedtest?mb=8&seconds=0.5")
    assert response.status_code == 200
    assert "content-length" not in response.headers
    assert len(response.content) > 0


def test_speedtest_params_bounds():
    # Sans paramètre : échantillon manuel de 128 Mo, pas de durée.
    assert network._speedtest_params(0, 0) == (128 * 1024 * 1024, 0.0)
    # Avec durée : 1 Go autorisé (le client coupe à l'échéance), durée plafonnée.
    assert network._speedtest_params(0, 8) == (1024 * 1024 * 1024, 8.0)
    assert network._speedtest_params(0, 60) == (1024 * 1024 * 1024, 30.0)
    assert network._speedtest_params(0, -2) == (128 * 1024 * 1024, 0.0)
    # mb explicite : borné à [1 Mo, 1 Go].
    assert network._speedtest_params(4, 8) == (4 * 1024 * 1024, 8.0)
    assert network._speedtest_params(5000, 0) == (1024 * 1024 * 1024, 0.0)


def test_speedtest_size_clamped_to_bounds(client):
    assert len(client.get("/api/network/speedtest?mb=-5").content) == 1 * 1024 * 1024


# -- Routes /api/network : ping et débit montant --------------------------------

def test_ping_returns_timestamp(client):
    data = client.get("/api/network/ping").json()
    assert data["status"] == "ok"
    assert isinstance(data["t"], float)


def test_speedtest_upload_measures_received_bytes(client):
    # TestClient remet le corps en un bloc : « seconds » peut être ~0 (mesure
    # instantanée) — la cohérence octets/débit est ce qui compte ici.
    payload = b"x" * (256 * 1024)
    data = client.post("/api/network/speedtest/upload", content=payload).json()
    assert data["status"] == "ok"
    assert data["bytes"] == len(payload)
    assert data["seconds"] >= 0 and data["mbps"] > 0


def test_speedtest_upload_rejects_oversized_sample(client, monkeypatch):
    monkeypatch.setattr(network, "_UPLOAD_MAX_BYTES", 1024)
    response = client.post("/api/network/speedtest/upload", content=b"x" * 4096)
    assert response.status_code == 413
