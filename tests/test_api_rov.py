"""Tests des routes de pilotage ROV : armement et choix du type d'autopilot.

La liaison série est remplacée par un double : aucun accès matériel, aucune
trame émise. Le masque d'assistances suit PROTOCOLE_RPI5.md §4 (v1.4.0+) :
0x01 auto R/T, 0x02 tenue de profondeur, 0x04 auto cap, 0x08 retour surface
(prioritaire) ; 0 = passif. L'état d'armement suit §6.2 : 0 désarmé (voies 0-7
au neutre, masque ignoré), 1 armé, 2 E-Stop.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.routers import api_rov


class _StubLink:
    """Remplace la liaison série : mode et armement figés, appels enregistrés."""

    def __init__(self, mode: int = 0, arm_state: int = 0) -> None:
        self.mode = mode
        self.arm_state = arm_state
        self.calls: list[dict] = []

    def get_status(self) -> dict:
        return {"command": {"mode": self.mode, "arm_state": self.arm_state}}

    def set_command(self, **kwargs) -> None:
        mode = kwargs.get("mode")
        if mode is not None and not 0 <= int(mode) <= 0x0F:
            raise ValueError(f"mode : {mode} hors masque 4 bits [0, 15]")
        arm = kwargs.get("arm_state")
        if arm is not None and int(arm) not in (0, 1, 2):
            raise ValueError(f"arm_state : {arm} invalide (0 = désarmé, 1 = armé, 2 = E-Stop)")
        self.calls.append(kwargs)
        if mode is not None:
            self.mode = int(mode)
        if arm is not None:
            self.arm_state = int(arm)


def _client_with(monkeypatch, mode: int = 0, arm_state: int = 0):
    stub = _StubLink(mode, arm_state)
    monkeypatch.setattr(api_rov, "get_serial_link", lambda: stub)
    return TestClient(app), stub


def test_arm_reads_current_state(monkeypatch):
    """GET : l'armement commandé est relu depuis l'état de la liaison série."""
    client, _ = _client_with(monkeypatch, arm_state=1)
    assert client.get("/api/rov/arm").json() == {"status": "ok", "arm_state": 1}


def test_arm_accepts_three_states(monkeypatch):
    """POST : 0, 1 et 2 passent et atteignent la liaison."""
    client, stub = _client_with(monkeypatch)
    for state in (0, 1, 2):
        assert client.post("/api/rov/arm", json={"arm_state": state}).json() == {
            "status": "ok", "arm_state": state}
    assert stub.calls == [{"arm_state": 0}, {"arm_state": 1}, {"arm_state": 2}]


def test_arm_rejects_out_of_range(monkeypatch):
    """POST : hors {0, 1, 2} (3, -1, 255) → 422, liaison non touchée."""
    client, stub = _client_with(monkeypatch)
    for bad in (3, -1, 255):
        assert client.post("/api/rov/arm", json={"arm_state": bad}).status_code == 422
    assert stub.calls == []


def test_arm_rejects_non_integer(monkeypatch):
    """POST : chaîne, flottant, booléen ou champ absent → 422."""
    client, stub = _client_with(monkeypatch)
    for body in ({"arm_state": "armed"}, {"arm_state": 1.5}, {"arm_state": True}, {}):
        assert client.post("/api/rov/arm", json=body).status_code == 422
    assert stub.calls == []


def test_arm_leaves_autopilot_mode_untouched(monkeypatch):
    """Armer ne modifie pas le masque d'assistances déjà commandé."""
    client, stub = _client_with(monkeypatch, mode=0x01)
    client.post("/api/rov/arm", json={"arm_state": 1})
    assert stub.mode == 0x01
    assert client.get("/api/rov/autopilot").json() == {"status": "ok", "mode": 0x01}


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
