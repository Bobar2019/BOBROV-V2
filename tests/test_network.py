"""Tests réseau : parsing nmcli et routes WiFi (nmcli simulé par monkeypatch)."""
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

    def __init__(self, wifi_enabled: bool = True) -> None:
        self.wifi_enabled = wifi_enabled
        self.patches: list[dict] = []

    def get(self) -> dict:
        return {"network": {"wifi_enabled": self.wifi_enabled}}

    def update(self, patch: dict) -> dict:
        self.patches.append(patch)
        if "network" in patch:
            self.wifi_enabled = bool(patch["network"].get("wifi_enabled", self.wifi_enabled))
        return self.get()


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


# -- Routes /api/network -------------------------------------------------------------

def test_status_reports_devices_and_wifi(client, monkeypatch):
    def fake(args, timeout=network._CMD_TIMEOUT_S):
        if "device" in args:
            return _proc("eth0:ethernet:connected:Wired connection 1\n"
                         "wlan0:wifi:connected:MonWifi\n")
        return _proc("enabled\n")
    monkeypatch.setattr(network, "_run", fake)
    data = client.get("/api/network").json()
    assert data["nmcli"] is True and data["wifi_radio"] is True
    assert data["wifi"] == {"device": "wlan0", "connected": True, "connection": "MonWifi"}
    assert isinstance(data["addresses"], list)
    assert data["wifi_enabled"] is True


def test_status_degraded_without_nmcli(client, monkeypatch):
    def boom(args, timeout=network._CMD_TIMEOUT_S):
        raise network.NetworkError("nmcli introuvable")
    monkeypatch.setattr(network, "_run", boom)
    data = client.get("/api/network").json()
    assert data["nmcli"] is False and "introuvable" in data["error"]
    assert data["devices"] == [] and data["wifi"]["connected"] is False


def test_scan_parses_and_sorts(client, monkeypatch):
    monkeypatch.setattr(network, "_run",
                        lambda args, timeout=network._CMD_TIMEOUT_S:
                        _proc("*:Nautilus:88:WPA2\n:Port voisin:42:WPA2\n"))
    data = client.post("/api/network/scan").json()
    assert data["count"] == 2
    assert [n["ssid"] for n in data["networks"]] == ["Nautilus", "Port voisin"]
    assert data["networks"][0]["active"] is True


def test_scan_failure_reported(client, monkeypatch):
    monkeypatch.setattr(network, "_run",
                        lambda args, timeout=network._CMD_TIMEOUT_S:
                        _proc("", "Error: Scanning not allowed.", 1))
    response = client.post("/api/network/scan")
    assert response.status_code == 503
    assert response.json()["detail"] == "Scanning not allowed."


def test_connect_passes_credentials_and_stores_preference(monkeypatch):
    stub = _StubConfig()
    monkeypatch.setattr(network, "get_config", lambda: stub)
    calls = []

    def fake(args, timeout=network._CMD_TIMEOUT_S):
        calls.append(list(args))
        return _proc("Device 'wlan0' successfully activated.")

    monkeypatch.setattr(network, "_run", fake)
    data = TestClient(app).post("/api/network/connect",
                                json={"ssid": "Nautilus", "password": "secret"}).json()
    assert data["status"] == "ok"
    assert calls[0][:4] == ["dev", "wifi", "connect", "Nautilus"]
    assert "secret" in calls[0]                       # transmis à nmcli…
    assert "secret" not in str(data)                  # …jamais renvoyé
    assert stub.patches == [{"network": {"wifi_enabled": True}}]


def test_connect_rejects_empty_ssid(client):
    assert client.post("/api/network/connect", json={}).status_code == 422


def test_connect_failure_is_reported(client, monkeypatch):
    monkeypatch.setattr(network, "_run",
                        lambda args, timeout=network._CMD_TIMEOUT_S:
                        _proc("", "Error: No network with SSID 'X' found.", 4))
    response = client.post("/api/network/connect", json={"ssid": "X"})
    assert response.status_code == 400
    assert response.json()["detail"] == "No network with SSID 'X' found."


def test_disconnect_sets_lan_preference(monkeypatch):
    stub = _StubConfig(wifi_enabled=True)
    monkeypatch.setattr(network, "get_config", lambda: stub)
    calls = []

    def fake(args, timeout=network._CMD_TIMEOUT_S):
        calls.append(list(args))
        if args[:2] == ["-t", "-f"]:
            return _proc("wlan0:wifi:connected:MonWifi\n")
        return _proc("Device 'wlan0' successfully disconnected.")

    monkeypatch.setattr(network, "_run", fake)
    data = TestClient(app).post("/api/network/disconnect").json()
    assert data["status"] == "ok" and "wlan0" in data["message"]
    assert any(c[:2] == ["device", "disconnect"] for c in calls)
    assert stub.patches == [{"network": {"wifi_enabled": False}}]


def test_enforce_lan_preference_noop_when_enabled(monkeypatch):
    calls = []

    def fake(args, timeout=network._CMD_TIMEOUT_S):
        calls.append(list(args))
        return _proc("enabled\n")

    monkeypatch.setattr(network, "get_config", lambda: _StubConfig(wifi_enabled=True))
    monkeypatch.setattr(network, "_run", fake)
    network.enforce_lan_preference()
    assert calls == []                                # préférence WiFi : aucune commande
