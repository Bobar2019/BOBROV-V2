"""Tests de l'enregistrement stéréoscopique 3D (module app.stereo).

Un faux ffmpeg (script shell) remplace le binaire réel : il écrit la cible
puis finalise sur SIGINT — le cycle start/stop complet est ainsi exercé sans
caméra ni vrai encodage.
"""
from __future__ import annotations

import copy
import stat
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import stereo, videos
from app.config import DEFAULTS
from app.main import app

FAKE_OK = """#!/bin/sh
# faux ffmpeg : la cible est le dernier argument ; finalise sur SIGINT.
for last; do :; done
printf 'FAKE' > "$last"
trap 'printf "MOOV" >> "$last"; exit 255' INT TERM
while :; do sleep 0.05; done
"""

FAKE_DOOMED = """#!/bin/sh
# faux ffmpeg : produit un fichier puis meurt aussitôt (code 3).
for last; do :; done
printf 'X' > "$last"
exit 3
"""

FAKE_SLOW_DOOMED = """#!/bin/sh
# faux ffmpeg : vivant au contrôle de lancement, puis meurt en plein vol.
for last; do :; done
printf 'FAKE' > "$last"
sleep 0.3
exit 7
"""


def _make_executable(path: Path, script: str) -> str:
    path.write_text(script, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(path)


class StubConfig:
    """Configuration figée (évite tout accès au vrai config.json)."""

    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg

    def get(self) -> dict:
        return self._cfg

    def get_section(self, name: str) -> dict:
        return self._cfg[name]


class StubSource:
    """CameraSource minimale : compte les abonnements, trame fraîche immédiate."""

    def __init__(self) -> None:
        self.clients = 0
        self.released = threading.Event()

    def add_client(self, quiet: bool = False) -> int:
        self.clients += 1
        return self.clients

    def remove_client(self, quiet: bool = False) -> None:
        self.clients = max(0, self.clients - 1)
        self.released.set()

    def wait_fresh_frame(self, max_age_s: float, timeout: float = 0.0):
        return (1, b"\xff\xd8\xff\xd9")


class StubVideo:
    def __init__(self) -> None:
        self.sources = {"cam1": StubSource(), "cam2": StubSource()}

    def source(self, name: str | None):
        return self.sources.get(name) if name else None


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Environnement isolé : faux ffmpeg, config et relais simulés, dossier vidéos."""
    monkeypatch.setattr(stereo, "_FFMPEG", _make_executable(tmp_path / "ffmpeg", FAKE_OK))
    monkeypatch.setattr(stereo, "_START_CHECK_S", 0.05)
    monkeypatch.setattr(stereo, "_WARM_HOLD_S", 0.05)
    monkeypatch.setattr(stereo, "_STOP_GRACE_S", 3.0)
    folder = tmp_path / "videos"
    folder.mkdir()
    library = videos.VideosLibrary()
    library.folder_override = folder
    monkeypatch.setattr(videos, "LIBRARY", library)
    cfg = copy.deepcopy(DEFAULTS)
    cfg["cameras"]["cam1"]["device"] = "/dev/video2"     # relayé → gauche
    cfg["cameras"]["cam2"]["device"] = "/dev/video0"     # relayé, non utilisé
    cfg["cameras"]["stereo"] = {"left_device": "/dev/video2", "right_device": "/dev/video6"}
    monkeypatch.setattr(stereo, "get_config", lambda: StubConfig(cfg))
    video = StubVideo()
    monkeypatch.setattr(stereo, "get_video", lambda: video)
    recorder = stereo.StereoRecorder()
    monkeypatch.setattr(stereo, "STEREO", recorder)
    return SimpleNamespace(folder=folder, cfg=cfg, video=video, recorder=recorder, tmp=tmp_path)


@pytest.fixture()
def client(env):
    return TestClient(app)


def _wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


# -- Construction de la ligne de commande -----------------------------------------

def test_build_command_relay_and_direct(tmp_path):
    target = tmp_path / "x.mp4"
    relay = stereo._build_command("/dev/video2", "cam1", 8080, target)
    assert relay[0] == stereo._FFMPEG
    assert "-use_wallclock_as_timestamps" in relay          # durée toujours fidèle
    assert "mpjpeg" in relay and "http://127.0.0.1:8080/api/video/cam1" in relay
    assert relay[-4:] == ["-c:v", "copy", "-y", str(target)]
    direct = stereo._build_command("/dev/video6", None, 8080, target)
    assert "v4l2" in direct and "mpjpeg" not in direct
    assert "/dev/video6" in direct


def test_status_idle_shape(env):
    status = env.recorder.status()
    assert status["state"] == "idle"
    assert status["recording"] is False
    assert status["sides"] == []
    assert status["ffmpeg"] is True
    assert status["started_at"] is None and status["elapsed_s"] is None


# -- Cycle start / stop ------------------------------------------------------------

def test_start_then_stop_produces_pair(env):
    status = env.recorder.start()
    assert status["state"] == "recording" and status["recording"] is True
    stamp = status["stamp"]
    assert [side["file"] for side in status["sides"]] == [f"{stamp}_camG.mp4", f"{stamp}_camD.mp4"]
    assert all(side["alive"] for side in status["sides"])
    assert _wait_for(lambda: all((env.folder / side["file"]).exists() for side in status["sides"]))
    result = env.recorder.stop()
    assert result["stamp"] == stamp and result["seconds"] >= 0
    assert [entry["file"] for entry in result["files"]] == [f"{stamp}_camG.mp4", f"{stamp}_camD.mp4"]
    for entry in result["files"]:
        assert entry["bytes"] > 0 and entry["duration_s"] == 0.0
        assert "error" not in entry
    payload = (env.folder / f"{stamp}_camG.mp4").read_bytes()
    assert payload.startswith(b"FAKE") and payload.endswith(b"MOOV")
    assert env.recorder.status()["state"] == "idle"


def test_relay_warmed_then_released(env):
    env.recorder.start()
    assert env.video.sources["cam1"].clients == 1            # gauche relayée : préchauffée
    assert env.video.sources["cam2"].clients == 0            # droite directe : aucun relais
    env.recorder.stop()
    assert env.video.sources["cam1"].released.wait(2.0)
    assert env.video.sources["cam1"].clients == 0


def test_start_refuses_second_and_stop_refuses_when_idle(env):
    env.recorder.start()
    with pytest.raises(stereo.StereoError):
        env.recorder.start()
    env.recorder.stop()
    with pytest.raises(stereo.StereoError):
        env.recorder.stop()


def test_start_refuses_without_ffmpeg(env, monkeypatch):
    monkeypatch.setattr(stereo, "_FFMPEG", str(env.tmp / "absent-ffmpeg"))
    with pytest.raises(stereo.StereoError) as err:
        env.recorder.start()
    assert "ffmpeg introuvable" in str(err.value)
    assert env.recorder.status()["state"] == "idle"


def test_dead_on_arrival_tears_down_both(env, monkeypatch):
    monkeypatch.setattr(stereo, "_FFMPEG", _make_executable(env.tmp / "ffmpeg", FAKE_DOOMED))
    with pytest.raises(stereo.StereoError) as err:
        env.recorder.start()
    assert "capture 3D impossible" in str(err.value)
    assert env.recorder.status()["state"] == "idle"
    assert list(env.folder.iterdir()) == []                  # aucun fichier résiduel
    assert env.video.sources["cam1"].clients == 0            # préchauffage rendu


def test_collision_with_existing_file_refused(env, monkeypatch):
    monkeypatch.setattr(stereo, "_now_stamp", lambda: "20260101_120000")
    existing = env.folder / "20260101_120000_camG.mp4"
    existing.write_bytes(b"deja la")
    with pytest.raises(stereo.StereoError) as err:
        env.recorder.start()
    assert "existe déjà" in str(err.value)
    assert existing.read_bytes() == b"deja la"               # jamais écrasé
    assert env.recorder.status()["state"] == "idle"


def test_sides_dying_midway_surface_error_state(env, monkeypatch):
    monkeypatch.setattr(stereo, "_FFMPEG", _make_executable(env.tmp / "ffmpeg", FAKE_SLOW_DOOMED))
    env.recorder.start()
    assert _wait_for(lambda: env.recorder.status()["state"] == "error")
    status = env.recorder.status()
    assert all(side["error"] and not side["alive"] for side in status["sides"])
    assert status["last_error"]
    result = env.recorder.stop()
    for entry in result["files"]:
        assert entry["bytes"] > 0 and "error" in entry       # rapport : partiel + motif
    assert env.recorder.status()["state"] == "idle"


# -- Routes /api/stereo ------------------------------------------------------------

def test_status_route(client):
    data = client.get("/api/stereo/status").json()
    assert data["status"] == "ok"
    assert data["stereo"]["state"] == "idle"
    assert data["stereo"]["ffmpeg"] is True


def test_start_stop_routes(client, env):
    started = client.post("/api/stereo/start")
    assert started.status_code == 200
    stereo_payload = started.json()["stereo"]
    assert stereo_payload["recording"] is True
    assert len(stereo_payload["sides"]) == 2
    conflict = client.post("/api/stereo/start")
    assert conflict.status_code == 409
    stopped = client.post("/api/stereo/stop")
    assert stopped.status_code == 200
    body = stopped.json()
    assert [entry["file"] for entry in body["result"]["files"]] == \
        [f"{stereo_payload['stamp']}_camG.mp4", f"{stereo_payload['stamp']}_camD.mp4"]
    assert body["stereo"]["state"] == "idle"
    assert client.post("/api/stereo/stop").status_code == 409
