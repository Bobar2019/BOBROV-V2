"""Tests des flux vidéo (étape 6) : générateur MJPEG, état, devices, capture réelle."""
from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import video
from app.main import app

FRAME_1 = b"\xff\xd8" + b"cam1-frame-1" * 8 + b"\xff\xd9"
FRAME_2 = b"\xff\xd8" + b"cam1-frame-2" * 4 + b"\xff\xd9"
FRAME_3 = b"\xff\xd8" + b"cam1-frame-3" + b"\xff\xd9"


class FakeSource:
    """Source factice : sert des frames préprogrammées puis plus rien."""

    name = "cam1"

    def __init__(self, frames: list[bytes]):
        self._frames = list(frames)
        self._next = 0
        self.added = 0
        self.removed = 0

    def add_client(self, quiet: bool = False) -> int:
        self.added += 1
        return 1

    def remove_client(self, quiet: bool = False) -> None:
        self.removed += 1

    def wait_frame(self, after_id: int, timeout: float = 0.0):
        if self._next >= len(self._frames):
            return None
        frame_id = self._next + 1
        if frame_id <= after_id:
            return None
        frame = self._frames[self._next]
        self._next += 1
        return frame_id, frame

    def wait_fresh_frame(self, max_age_s: float, timeout: float = 0.0):
        return self.wait_frame(0, timeout)


def _run(coro):
    return asyncio.run(coro)


# -- Générateur MJPEG --------------------------------------------------------

def test_mjpeg_stream_encapsulation():
    """Chaque frame est encapsulée en partie multipart avec son entête."""
    source = FakeSource([FRAME_1, FRAME_2, FRAME_3])

    async def collect():
        chunks = []
        agen = video.mjpeg_stream(source)
        async for chunk in agen:
            chunks.append(chunk)
            if len(chunks) == 3:
                break
        await agen.aclose()
        return chunks

    chunks = _run(collect())
    assert [chunk.split(b"\r\n\r\n", 1)[1][:-2] for chunk in chunks] == [FRAME_1, FRAME_2, FRAME_3]
    for chunk, frame in zip(chunks, (FRAME_1, FRAME_2, FRAME_3)):
        assert chunk.startswith(b"--bobrovframe\r\nContent-Type: image/jpeg\r\n")
        assert f"Content-Length: {len(frame)}".encode() in chunk
        assert chunk.endswith(frame + b"\r\n")
    assert source.added == 1
    assert source.removed == 1  # le finally de fermeture est bien passé


def test_mjpeg_stream_terminates_without_frames(monkeypatch):
    """Aucune image : le flux se termine seul (le client JS bascule en « pas de signal »)."""
    monkeypatch.setattr(video, "_STALL_TIMEOUT_S", 0.2)
    source = FakeSource([])

    async def drain():
        return [chunk async for chunk in video.mjpeg_stream(source)]

    started = time.monotonic()
    chunks = _run(asyncio.wait_for(drain(), timeout=3.0))
    assert chunks == []
    assert time.monotonic() - started < 2.0
    assert source.added == 1 and source.removed == 1


def test_mjpeg_stream_resumes_after_stall(monkeypatch):
    """Une frame arrivant avant l'échéance re-arme le délai du flux."""
    monkeypatch.setattr(video, "_STALL_TIMEOUT_S", 1.0)
    source = FakeSource([FRAME_1, FRAME_2])

    async def collect():
        chunks = []
        async for chunk in video.mjpeg_stream(source):
            chunks.append(chunk)
            if len(chunks) == 2:
                break
        return chunks

    assert len(_run(collect())) == 2


# -- Endpoints ----------------------------------------------------------------

def test_video_status_endpoint():
    client = TestClient(app)
    response = client.get("/api/video/status")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert set(data["cameras"]) == {"cam1", "cam2"}
    for cam in data["cameras"].values():
        assert cam["state"] in ("idle", "streaming", "error")
        assert isinstance(cam["clients"], int)
        assert cam["frames_total"] >= 0


def test_video_unknown_camera_404():
    client = TestClient(app)
    assert client.get("/api/video/cam3").status_code == 404
    assert client.get("/api/video/cam1x").status_code == 404


def test_video_reload_endpoint():
    client = TestClient(app)
    response = client.post("/api/video/reload")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


# -- Sonde de frames (repli WebKit iPadOS/iOS) --------------------------------

def _patch_sources(monkeypatch, **sources):
    """Remplace le gestionnaire vidéo global par des sources factices nommées."""

    class FakeManager:
        def source(self, name):
            return sources.get(name)

    monkeypatch.setattr(video, "get_video", lambda: FakeManager())


def test_video_frame_endpoint_returns_jpeg(monkeypatch):
    """Une image JPEG unique, jamais mise en cache, à chaque sondage."""
    source = FakeSource([FRAME_1])
    _patch_sources(monkeypatch, cam1=source)
    client = TestClient(app)
    response = client.get("/api/video/frame/cam1")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.content == FRAME_1
    assert "no-store" in response.headers["cache-control"]
    assert source.added == 1 and source.removed == 1   # abonné puis retiré (quiet)


def test_video_frame_endpoint_404_unknown_camera(monkeypatch):
    _patch_sources(monkeypatch)
    client = TestClient(app)
    assert client.get("/api/video/frame/cam3").status_code == 404


def test_video_frame_endpoint_503_without_frame(monkeypatch):
    """Aucune image prête : 503 — le client JS conserve la dernière frame affichée."""
    monkeypatch.setattr(video, "_FRAME_WAIT_TIMEOUT_S", 0.1)
    source = FakeSource([])
    _patch_sources(monkeypatch, cam1=source)
    client = TestClient(app)
    response = client.get("/api/video/frame/cam1")
    assert response.status_code == 503
    assert source.added == 1 and source.removed == 1


def test_wait_fresh_frame_rejects_stale_and_serves_fresh():
    """Une frame fraîche est servie ; au-delà du seuil elle est refusée (image figée)."""
    source = video.CameraSource("cam1")
    source._publish(FRAME_1)
    assert source.wait_fresh_frame(5.0, timeout=0.0) == (1, FRAME_1)
    source._last_frame_ts -= 10.0
    assert source.wait_fresh_frame(5.0, timeout=0.0) is None


def test_wait_fresh_frame_waits_for_new_frame():
    """Tampon figé : la sonde attend une nouvelle image et la sert dès publication."""
    source = video.CameraSource("cam2")
    source._publish(FRAME_1)
    source._last_frame_ts -= 10.0
    threading.Thread(target=lambda: (time.sleep(0.1), source._publish(FRAME_2))).start()
    assert source.wait_fresh_frame(5.0, timeout=2.0) == (2, FRAME_2)


# -- Complément JPEG (caméras sans tables de Huffman, ex. LifeCam HD-5000) ----

def test_complete_jpeg_inserts_jfif_and_dht_when_missing():
    """JPEG nu : APP0/JFIF après SOI, tables par défaut juste avant SOS."""
    raw = b"\xff\xd8" + b"\xff\xdb\x00\x04\x00\x01" + b"\xff\xda\x00\x08" + b"scan" + b"\xff\xd9"
    fixed = video._complete_jpeg(raw)
    assert fixed[:2] == b"\xff\xd8"
    assert fixed[2:2 + len(video._JPEG_APP0_JFIF)] == video._JPEG_APP0_JFIF
    sos = fixed.index(b"\xff\xda")
    assert fixed[sos - len(video._JPEG_DEFAULT_DHT):sos] == video._JPEG_DEFAULT_DHT
    assert fixed[sos:] == raw[raw.index(b"\xff\xda"):]     # SOS + données intacts
    assert fixed.endswith(b"\xff\xd9")


def test_complete_jpeg_leaves_frames_with_dht_untouched():
    """Un JPEG contenant déjà des tables (PC-LM1E) n'est jamais modifié."""
    raw = b"\xff\xd8" + b"\xff\xc4\x00\x04\x00\x00" + b"\xff\xda\x00\x08" + b"scan" + b"\xff\xd9"
    assert video._complete_jpeg(raw) is raw
    assert video._complete_jpeg(b"pas un jpeg") == b"pas un jpeg"


def test_publish_completes_dht_less_frames():
    """Les frames publiées par une source sont complétées avant partage."""
    source = video.CameraSource("cam1")
    raw = b"\xff\xd8" + b"\xff\xda\x00\x08" + b"scan" + b"\xff\xd9"
    source._publish(raw)
    got = source.wait_frame(0)
    assert got is not None and b"\xff\xc4" in got[1] and got[1].endswith(b"\xff\xd9")


def test_video_devices_listing():
    """Liste des caméras V4L2 : structure valide ; nœuds metadata exclus."""
    client = TestClient(app)
    response = client.get("/api/video/devices")
    assert response.status_code == 200
    devices = response.json()["devices"]
    assert isinstance(devices, list)
    for device in devices:
        assert device["device"].startswith("/dev/video")
        assert device["name"]
        assert isinstance(device["mjpeg"], bool)
        for fmt in device["formats"]:
            assert len(fmt["fourcc"]) == 4
            for size in fmt["sizes"]:
                assert size["width"] > 0 and size["height"] > 0
                assert all(fps > 0 for fps in size["fps"])
    if devices:
        assert any(dev["formats"] or dev["busy"] for dev in devices)


# -- Capture réelle (conditionnelle : matériel requis) --------------------------

@pytest.mark.skipif(not Path("/dev/video0").exists(), reason="aucune caméra sur /dev/video0")
def test_real_capture_frames_are_jpeg():
    """Ouvre la caméra 0 en 640×480 et vérifie 5 frames MJPEG réelles."""
    try:
        cam = video.V4L2Camera("/dev/video0", 640, 480, 30)
        cam.open()
    except video.V4L2Error as exc:
        pytest.skip(f"caméra /dev/video0 indisponible : {exc}")
    try:
        assert cam.card, "nom de carte non lu"
        frames: list[bytes] = []
        deadline = time.monotonic() + 8.0
        while len(frames) < 5 and time.monotonic() < deadline:
            frame = cam.next_frame(timeout_s=1.0)
            if frame:
                frames.append(frame)
        assert len(frames) >= 5, f"seulement {len(frames)} frame(s) en 8 s"
        for frame in frames:
            assert frame[:2] == b"\xff\xd8", "début JPEG attendu (SOI)"
            assert frame[-2:] == b"\xff\xd9", "fin JPEG attendue (EOI)"
    finally:
        cam.close()
