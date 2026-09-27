"""Tests des routes de pilotage ROV : choix du type d'autopilot.

La liaison série est remplacée par un double : aucun accès matériel, aucune
trame émise. Le masque d'assistances suit PROTOCOLE_RPI5.md §4 (v1.4.0+) :
0x01 auto R/T, 0x02 tenue de profondeur, 0x04 auto cap, 0x08 retour surface
(prioritaire) ; 0 = passif. Le firmware n'applique le masque que sur trames
armées (§6.2) — hors périmètre de ces routes.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.routers import api_rov


class _StubLink:
    """Remplace la liaison série : mode figé, appels enregistrés."""

    def __init__(self, mode: int = 0) -> None:
        self.mode = mode
        self.calls: list[dict] = []

    def get_status(self) -> dict:
        return {"command": {"mode": self.mode}}

    def set_command(self, **kwargs) -> None:
        mode = kwargs.get("mode")
        if mode is not None and not 0 <= int(mode) <= 0x0F:
            raise ValueError(f"mode : {mode} hors masque 4 bits [0, 15]")
        self.calls.append(kwargs)
        if mode is not None:
            self.mode = int(mode)


def _client_with(monkeypatch, mode: int = 0):
    stub = _StubLink(mode)
    monkeypatch.setattr(api_rov, "get_serial_link", lambda: stub)
    return TestClient(app), stub


def test_autopilot_reads_current_mode(monkeypatch):
    """GET : le mode commandé est relu depuis l'état de la liaison série."""
    client, _ = _client_with(monkeypatch, mode=0x05)
    assert client.get("/api/rov/autopilot").json() == {"status": "ok", "mode": 0x05}


def test_autopilot_accepts_mask(monkeypatch):
    """POST : un masque combiné (ancien « Auto Full » = 0x07) passe tel quel."""
    client, stub = _client_with(monkeypatch)
    data = client.post("/api/rov/autopilot", json={"mode": 0x07}).json()
    assert data == {"status": "ok", "mode": 0x07}
    assert stub.calls == [{"mode": 0x07}]


def test_autopilot_rejects_out_of_range(monkeypatch):
    """POST : hors masque 4 bits (16, -1, 255) → 422, liaison non touchée."""
    client, stub = _client_with(monkeypatch)
    for bad in (16, -1, 255):
        assert client.post("/api/rov/autopilot", json={"mode": bad}).status_code == 422
    assert stub.calls == []


def test_autopilot_rejects_non_integer(monkeypatch):
    """POST : chaîne, flottant, booléen ou champ absent → 422."""
    client, stub = _client_with(monkeypatch)
    for body in ({"mode": "full"}, {"mode": 1.5}, {"mode": True}, {}):
        assert client.post("/api/rov/autopilot", json=body).status_code == 422
    assert stub.calls == []
