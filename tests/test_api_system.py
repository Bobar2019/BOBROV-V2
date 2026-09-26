"""Tests des routes système : télémétrie temps réel exposée au HUD du cockpit.

La liaison série est remplacée par un double : aucun accès matériel, aucune
écriture disque. Le HUD bascule sur des données simulées quand ``live`` est
faux, d'où la vérification de la fenêtre de fraîcheur (1,5 s).

Maintenance (section SYSTÈME) : les commandes root sont interceptées — aucun
``systemctl`` réel n'est exécuté.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.routers import api_system


class _StubLink:
    """Remplace la liaison série : télémétrie figée, comme ``SerialLink``."""

    def __init__(self, telemetry: dict | None) -> None:
        self._telemetry = telemetry

    def get_telemetry(self) -> dict | None:
        return self._telemetry


def _client_with(monkeypatch, telemetry: dict | None) -> TestClient:
    monkeypatch.setattr(api_system, "get_serial_link", lambda: _StubLink(telemetry))
    return TestClient(app)


def test_telemetry_offline_without_frame(monkeypatch):
    """Aucune trame reçue : « live » faux, l'interface simulera les données."""
    data = _client_with(monkeypatch, None).get("/api/system/telemetry").json()
    assert data == {"status": "ok", "live": False, "telemetry": None}


def test_telemetry_live_with_fresh_frame(monkeypatch):
    """Trame fraîche (age_s ≤ 1,5 s) : « live » vrai, trame transmise telle quelle."""
    frame = {"quat": [1.0, 0.0, 0.0, 0.0], "pressure_mbar": 1020.3,
             "temperature_c": 21.4, "age_s": 0.2}
    data = _client_with(monkeypatch, frame).get("/api/system/telemetry").json()
    assert data["live"] is True
    assert data["telemetry"] == frame


def test_telemetry_stale_frame_is_not_live(monkeypatch):
    """Trame périmée (liaison coupée) : transmise pour diagnostic mais « live » faux."""
    frame = {"pressure_mbar": 1020.3, "age_s": 3.5}
    data = _client_with(monkeypatch, frame).get("/api/system/telemetry").json()
    assert data["live"] is False
    assert data["telemetry"] == frame


def test_restart_refused_outside_systemd(monkeypatch):
    """Lancement manuel (hors systemd) : la relance du service est refusée."""
    monkeypatch.delenv("INVOCATION_ID", raising=False)
    response = TestClient(app).post("/api/system/restart")
    assert response.status_code == 409


def test_restart_schedules_service_restart(monkeypatch):
    """Sous systemd : « systemctl restart bob-rov » est programmé via sudo."""
    calls: list[list[str]] = []
    monkeypatch.setenv("INVOCATION_ID", "test")
    monkeypatch.setattr(api_system, "_run_detached", lambda args, *a, **k: calls.append(args))
    data = TestClient(app).post("/api/system/restart").json()
    assert data["status"] == "ok"
    assert calls == [["sudo", "-n", "systemctl", "restart", "bob-rov"]]


def test_reboot_schedules_pi_reboot(monkeypatch):
    """« systemctl reboot » est programmé pour le Raspberry Pi entier."""
    calls: list[list[str]] = []
    monkeypatch.setattr(api_system, "_run_detached", lambda args, *a, **k: calls.append(args))
    data = TestClient(app).post("/api/system/reboot").json()
    assert data["status"] == "ok"
    assert calls == [["sudo", "-n", "systemctl", "reboot"]]
