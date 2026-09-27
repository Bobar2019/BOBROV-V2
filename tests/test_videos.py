"""Tests de la médiathèque « Mes Vidéos » : listing, notes/étoiles, service HTTP."""
from __future__ import annotations

import os
import struct
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import videos
from app.main import app


def _box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def _video_trak(codec: str) -> bytes:
    """Piste vidéo minimale : mdia{hdlr « vide », minf{stbl{stsd{codec}}}}."""
    entry = _box(codec.encode("ascii"), b"\x00" * 6 + struct.pack(">H", 1) + b"\x00" * 24)
    stsd = _box(b"stsd", b"\x00\x00\x00\x00" + struct.pack(">I", 1) + entry)
    stbl = _box(b"stbl", stsd)
    minf = _box(b"minf", stbl)
    hdlr = _box(b"hdlr", b"\x00" * 8 + b"vide" + b"\x00" * 12)
    return _box(b"trak", _box(b"mdia", hdlr + minf))


def _fake_mp4(duration_s: float = 20.0, timescale: int = 600, codec: str | None = None) -> bytes:
    """MP4 minimal : ftyp + moov{mvhd [, trak vidéo au 4CC ``codec``]}.

    Durée lisible par le parseur pur Python ; la piste vidéo permet de tester
    la détection de codec (« mp4v » = MJPEG ffmpeg, « avc1 » = H.264).
    """
    mvhd = (b"\x00" + b"\x00\x00\x00"                       # version 0 + flags
            + struct.pack(">II", 0, 0)                       # création / modification
            + struct.pack(">II", timescale, int(duration_s * timescale))
            + b"\x00" * 80)                                  # reste de la boîte
    moov = _box(b"mvhd", mvhd) + (_video_trak(codec) if codec else b"")
    return _box(b"ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2") + _box(b"moov", moov)


@pytest.fixture()
def library(tmp_path, monkeypatch):
    """Médiathèque isolée dans un dossier temporaire."""
    tmp_path.joinpath("plongee_test.mp4").write_bytes(_fake_mp4(20.0))
    tmp_path.joinpath("notes.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"\x00" * 64)
    tmp_path.joinpath("ignore.txt").write_text("pas une vidéo")
    now = 1_750_000_000.0
    os.utime(tmp_path / "notes.mkv", (now - 500, now - 500))
    os.utime(tmp_path / "plongee_test.mp4", (now, now))     # le plus récent
    lib = videos.VideosLibrary()
    lib.folder_override = tmp_path
    monkeypatch.setattr(videos, "LIBRARY", lib)
    return lib


@pytest.fixture()
def client(library):
    return TestClient(app)


@pytest.fixture()
def jobs(monkeypatch):
    """Gestionnaire d'aperçus web isolé (remplace le singleton global)."""
    fresh = videos.WebProxyJobs()
    monkeypatch.setattr(videos, "JOBS", fresh)
    return fresh


# -- Listing -------------------------------------------------------------------

def test_list_counts_and_order(client):
    data = client.get("/api/videos").json()
    assert data["status"] == "ok"
    assert data["count"] == 2                                # le .txt est ignoré
    names = [item["name"] for item in data["items"]]
    assert names == ["plongee_test.mp4", "notes.mkv"]        # plus récent d'abord
    mp4 = data["items"][0]
    assert mp4["duration_s"] == pytest.approx(20.0, abs=0.01)
    assert mp4["stars"] == 0 and mp4["notes"] == ""
    assert data["items"][1]["duration_s"] is None            # MKV : durée inconnue


def test_mp4_duration_parser_edge_cases(tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"\x00\x01\x02\x03")                     # trop court
    assert videos.mp4_duration_s(bad) is None
    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    assert videos.mp4_duration_s(empty) is None
    assert videos.mp4_duration_s(tmp_path / "absent.mp4") is None


# -- Notes & étoiles -------------------------------------------------------------

def test_meta_roundtrip_and_merge(client, library):
    response = client.post("/api/videos/meta/plongee_test.mp4",
                           json={"stars": 4, "notes": "Épave à 12 m, visibilité superbe."})
    assert response.status_code == 200
    body = response.json()
    assert body["stars"] == 4 and "Épave" in body["notes"]

    # Mise à jour partielle : seules les étoiles changent, les notes restent.
    body = client.post("/api/videos/meta/plongee_test.mp4", json={"stars": 2}).json()
    assert body["stars"] == 2 and "Épave" in body["notes"]

    got = client.get("/api/videos/meta/plongee_test.mp4").json()
    assert got["stars"] == 2 and got["notes"].startswith("Épave")

    # Nettoyage : 0 étoile + notes vides → la fiche disparaît de l'index.
    client.post("/api/videos/meta/plongee_test.mp4", json={"stars": 0, "notes": ""})
    assert "plongee_test.mp4" not in library._load_index()


def test_meta_validation(client):
    assert client.post("/api/videos/meta/plongee_test.mp4", json={"stars": 7}).status_code == 422
    assert client.post("/api/videos/meta/plongee_test.mp4", json={"stars": "4"}).status_code == 422
    assert client.post("/api/videos/meta/plongee_test.mp4", json={"notes": "x" * 6000}).status_code == 422
    assert client.post("/api/videos/meta/plongee_test.mp4", json={}).status_code == 422


def test_names_rejected(client):
    assert client.get("/api/videos/meta/x.docx").status_code == 404        # extension
    # Slash encodé : le routeur rejette (405) — jamais de traversée possible.
    assert client.post("/api/videos/meta/..%2Fsecret.mp4", json={"stars": 1}).status_code in (404, 405, 422)
    assert client.get("/api/videos/file/absent.mp4").status_code == 404
    assert client.get("/api/videos/file/.bobrov_index.json").status_code == 404


# -- Service des fichiers (lecteur vidéo + Range) ---------------------------------

def test_file_serving_with_range(client):
    whole = client.get("/api/videos/file/plongee_test.mp4")
    assert whole.status_code == 200
    assert whole.headers["content-type"] == "video/mp4"
    assert int(whole.headers["content-length"]) == len(whole.content) > 0

    partial = client.get("/api/videos/file/plongee_test.mp4", headers={"Range": "bytes=0-15"})
    assert partial.status_code == 206
    assert partial.headers["content-range"].startswith("bytes 0-15/")
    assert partial.content == whole.content[:16]


# -- Photos, dépôt et suppression -------------------------------------------------

def test_photo_kind_and_no_duration(client, library):
    library.folder_override.joinpath("cliche.jpg").write_bytes(b"\xff\xd8\xff\xe0jpeg")
    data = client.get("/api/videos").json()
    photo = next(item for item in data["items"] if item["name"] == "cliche.jpg")
    assert photo["kind"] == "photo" and photo["duration_s"] is None
    video = next(item for item in data["items"] if item["name"] == "notes.mkv")
    assert video["kind"] == "video"


def test_upload_stores_and_dedupes(client, library):
    first = client.post("/api/videos/upload", params={"name": "bobrov_cam1.webm"},
                        content=b"webm-bytes" * 16)
    assert first.status_code == 200 and first.json()["name"] == "bobrov_cam1.webm"
    assert (library.folder_override / "bobrov_cam1.webm").read_bytes().startswith(b"webm")
    second = client.post("/api/videos/upload", params={"name": "bobrov_cam1.webm"}, content=b"x")
    assert second.json()["name"] == "bobrov_cam1-1.webm"     # jamais écrasé
    names = [item["name"] for item in client.get("/api/videos").json()["items"]]
    assert "bobrov_cam1.webm" in names and "bobrov_cam1-1.webm" in names
    assert not list(library.folder_override.glob("*.part"))


def test_upload_rejects_bad_requests(client):
    assert client.post("/api/videos/upload", params={"name": "x.exe"},
                       content=b"z").status_code == 422                 # extension
    assert client.post("/api/videos/upload", params={"name": ".hidden.jpg"},
                       content=b"z").status_code == 422                 # point initial
    assert client.post("/api/videos/upload", params={"name": "../x.jpg"},
                       content=b"z").status_code == 422                 # chemin
    assert client.post("/api/videos/upload", params={"name": "x.jpg"},
                       content=b"").status_code == 422                  # corps vide


def test_delete_removes_file_and_meta(client, library):
    client.post("/api/videos/meta/notes.mkv", json={"stars": 3})
    response = client.delete("/api/videos/file/notes.mkv")
    assert response.status_code == 200
    assert not (library.folder_override / "notes.mkv").exists()
    assert "notes.mkv" not in library._load_index()
    assert client.delete("/api/videos/file/notes.mkv").status_code == 404
    assert client.delete("/api/videos/file/.bobrov_index.json").status_code == 404


# -- Renommage --------------------------------------------------------------------

def test_rename_moves_file_and_meta(client, library):
    client.post("/api/videos/meta/plongee_test.mp4", json={"stars": 5, "notes": "Épave à 12 m"})
    response = client.post("/api/videos/rename",
                           json={"name": "plongee_test.mp4", "new_name": "epave_chaouen.mp4"})
    assert response.status_code == 200
    body = response.json()
    assert body["old_name"] == "plongee_test.mp4" and body["name"] == "epave_chaouen.mp4"
    assert not (library.folder_override / "plongee_test.mp4").exists()
    assert (library.folder_override / "epave_chaouen.mp4").exists()
    meta = client.get("/api/videos/meta/epave_chaouen.mp4").json()
    assert meta["stars"] == 5 and meta["notes"].startswith("Épave")   # fiche suivie
    assert "plongee_test.mp4" not in library._load_index()
    assert client.get("/api/videos/file/plongee_test.mp4").status_code == 404


def test_rename_keeps_original_extension(client):
    body = client.post("/api/videos/rename",
                       json={"name": "notes.mkv", "new_name": "briefing"}).json()
    assert body["name"] == "briefing.mkv"                    # extension conservée


def test_rename_never_overwrites(client, library):
    conflict = client.post("/api/videos/rename",
                           json={"name": "notes.mkv", "new_name": "plongee_test.mp4"})
    assert conflict.status_code == 409
    assert (library.folder_override / "notes.mkv").exists()   # source intacte
    assert (library.folder_override / "plongee_test.mp4").exists()


def test_rename_rejects_bad_requests(client):
    assert client.post("/api/videos/rename",
                       json={"name": "absent.mp4", "new_name": "x.mp4"}).status_code == 404
    assert client.post("/api/videos/rename",
                       json={"name": "notes.mkv", "new_name": "x.exe"}).status_code == 422
    assert client.post("/api/videos/rename",
                       json={"name": "notes.mkv", "new_name": ".cache"}).status_code == 422
    assert client.post("/api/videos/rename",
                       json={"name": "notes.mkv", "new_name": "../x.mkv"}).status_code == 422
    assert client.post("/api/videos/rename",
                       json={"name": "notes.mkv", "new_name": "   "}).status_code == 422
    assert client.post("/api/videos/rename", json={"name": "notes.mkv"}).status_code == 422
    assert client.post("/api/videos/rename", json={"name": 3, "new_name": "x"}).status_code == 422


def test_rename_same_name_is_noop(client, library):
    body = client.post("/api/videos/rename",
                       json={"name": "notes.mkv", "new_name": "notes.mkv"}).json()
    assert body["name"] == "notes.mkv"
    assert (library.folder_override / "notes.mkv").exists()


# -- Aperçus web (proxy H.264 des bruts non lisibles navigateur) ------------------

def test_mp4_video_codec_detection(tmp_path):
    mjpeg = tmp_path / "mjpeg.mp4"
    mjpeg.write_bytes(_fake_mp4(5.0, codec="mp4v"))
    assert videos.mp4_video_codec(mjpeg) == "mp4v"
    h264 = tmp_path / "h264.mp4"
    h264.write_bytes(_fake_mp4(5.0, codec="avc1"))
    assert videos.mp4_video_codec(h264) == "avc1"
    no_trak = tmp_path / "sans-trak.mp4"
    no_trak.write_bytes(_fake_mp4(5.0))
    assert videos.mp4_video_codec(no_trak) is None        # pas de piste vidéo
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"\x00\x01\x02\x03")
    assert videos.mp4_video_codec(bad) is None
    assert videos.mp4_video_codec(tmp_path / "absent.mp4") is None
    assert not videos.needs_web_proxy(no_trak)            # illisible → pas de conversion
    assert videos.needs_web_proxy(mjpeg) and not videos.needs_web_proxy(h264)


def test_list_flags_raw_mp4v(client, library):
    raw = library.folder_override / "20260101_120000_camG.mp4"
    raw.write_bytes(_fake_mp4(11.0, codec="mp4v"))
    safe = library.folder_override / "deja_h264.mp4"
    safe.write_bytes(_fake_mp4(3.0, codec="avc1"))
    items = {item["name"]: item for item in client.get("/api/videos").json()["items"]}
    flagged = items["20260101_120000_camG.mp4"]
    assert flagged["needs_web"] is True
    assert flagged["web_proxy"] is None and flagged["proxy_state"] == "none"
    assert flagged["proxy_error"] is None and flagged["proxy_progress"] is None
    assert items["deja_h264.mp4"]["needs_web"] is False
    assert "web_proxy" not in items["deja_h264.mp4"]     # rien à générer


def test_list_merges_proxy_into_raw_row(client, library):
    raw = library.folder_override / "prise_camD.mp4"
    raw.write_bytes(_fake_mp4(9.0, codec="mp4v"))
    proxy = library.folder_override / "prise_camD_web.mp4"
    proxy.write_bytes(_fake_mp4(9.0, codec="avc1"))
    data = client.get("/api/videos").json()
    names = [item["name"] for item in data["items"]]
    assert "prise_camD_web.mp4" not in names              # fusionné dans la ligne du brut
    item = next(it for it in data["items"] if it["name"] == "prise_camD.mp4")
    assert item["web_proxy"] == "prise_camD_web.mp4"
    assert item["proxy_state"] == "ready"


def test_web_named_files_stay_visible_when_independent(client, library):
    # Sans brut associé : média indépendant, listé normalement.
    solo = library.folder_override / "clip_web.mp4"
    solo.write_bytes(_fake_mp4(4.0, codec="avc1"))
    # Brut web-safe : le _web.mp4 n'est pas un aperçu généré, il reste visible.
    safe = library.folder_override / "duo.mp4"
    safe.write_bytes(_fake_mp4(4.0, codec="avc1"))
    extra = library.folder_override / "duo_web.mp4"
    extra.write_bytes(_fake_mp4(4.0, codec="avc1"))
    names = [item["name"] for item in client.get("/api/videos").json()["items"]]
    assert "clip_web.mp4" in names
    assert "duo.mp4" in names and "duo_web.mp4" in names


def test_proxy_route_and_jobs_flow(client, library, jobs, monkeypatch):
    raw = library.folder_override / "stereo_camG.mp4"
    original = _fake_mp4(12.0, codec="mp4v")
    raw.write_bytes(original)
    gate = threading.Event()
    calls = []

    def fake_convert(source, target, duration, on_progress, on_spawn):
        calls.append((source.name, target.name))
        on_progress(0.3)
        gate.wait(5)                                      # conversion « en cours » pilotée
        target.write_bytes(b"h264-proxy" * 8)
        return None

    monkeypatch.setattr(jobs, "convert", fake_convert)
    response = client.post("/api/videos/proxy/stereo_camG.mp4")
    assert response.status_code == 200
    assert response.json()["proxy"]["state"] in ("queued", "converting")

    deadline = time.time() + 5                            # l'UI doit voir « converting » + %
    while time.time() < deadline:
        item = next(it for it in client.get("/api/videos").json()["items"]
                    if it["name"] == "stereo_camG.mp4")
        if item["proxy_state"] == "converting":
            break
        time.sleep(0.05)
    assert item["proxy_state"] == "converting"
    assert item["proxy_progress"] == 30

    gate.set()
    assert jobs.wait_idle(5.0)
    assert calls == [("stereo_camG.mp4", "stereo_camG_web.mp4.part")]
    assert raw.read_bytes() == original                   # rush maître intact
    item = next(it for it in client.get("/api/videos").json()["items"]
                if it["name"] == "stereo_camG.mp4")
    assert item["web_proxy"] == "stereo_camG_web.mp4" and item["proxy_state"] == "ready"
    assert (library.folder_override / "stereo_camG_web.mp4").read_bytes().startswith(b"h264")
    assert not list(library.folder_override.glob("*.part"))

    again = client.post("/api/videos/proxy/stereo_camG.mp4")   # idempotent : rien à refaire
    assert again.json()["proxy"]["state"] == "ready"
    assert len(calls) == 1


def test_proxy_route_reports_failures(client, library, jobs, monkeypatch):
    raw = library.folder_override / "rate_camG.mp4"
    raw.write_bytes(_fake_mp4(6.0, codec="mp4v"))

    def failing_convert(source, target, duration, on_progress, on_spawn):
        target.write_bytes(b"partiel")
        return "conversion interrompue (codec bidon)"

    monkeypatch.setattr(jobs, "convert", failing_convert)
    assert client.post("/api/videos/proxy/rate_camG.mp4").status_code == 200
    assert jobs.wait_idle(5.0)
    item = next(it for it in client.get("/api/videos").json()["items"]
                if it["name"] == "rate_camG.mp4")
    assert item["proxy_state"] == "error"
    assert "codec bidon" in item["proxy_error"]
    assert not list(library.folder_override.glob("*.part"))   # le .part raté est nettoyé
    assert not (library.folder_override / "rate_camG_web.mp4").exists()


def test_proxy_route_rejects(client, library, jobs):
    assert client.post("/api/videos/proxy/absent.mp4").status_code == 404
    safe = library.folder_override / "deja_h264.mp4"
    safe.write_bytes(_fake_mp4(2.0, codec="avc1"))
    assert client.post("/api/videos/proxy/deja_h264.mp4").status_code == 422
    assert client.post("/api/videos/proxy/notes.mkv").status_code == 422
    hidden = library.folder_override / "probe_camG.mp4"
    hidden.write_bytes(_fake_mp4(2.0, codec="mp4v"))
    proxy = library.folder_override / "probe_camG_web.mp4"
    proxy.write_bytes(_fake_mp4(2.0, codec="avc1"))
    # Un aperçu (fichier déjà H.264) n'a jamais besoin d'un aperçu.
    assert client.post("/api/videos/proxy/probe_camG_web.mp4").status_code == 422


def test_delete_removes_proxy_too(client, library):
    raw = library.folder_override / "supp_camG.mp4"
    raw.write_bytes(_fake_mp4(6.0, codec="mp4v"))
    proxy = library.folder_override / "supp_camG_web.mp4"
    proxy.write_bytes(_fake_mp4(6.0, codec="avc1"))
    assert client.delete("/api/videos/file/supp_camG.mp4").status_code == 200
    assert not raw.exists() and not proxy.exists()


def test_rename_moves_proxy(client, library):
    raw = library.folder_override / "avant_camG.mp4"
    raw.write_bytes(_fake_mp4(6.0, codec="mp4v"))
    proxy = library.folder_override / "avant_camG_web.mp4"
    proxy.write_bytes(_fake_mp4(6.0, codec="avc1"))
    body = client.post("/api/videos/rename",
                       json={"name": "avant_camG.mp4", "new_name": "apres_camG.mp4"}).json()
    assert body["name"] == "apres_camG.mp4"
    assert (library.folder_override / "apres_camG_web.mp4").exists()
    assert not (library.folder_override / "avant_camG_web.mp4").exists()
    item = next(it for it in client.get("/api/videos").json()["items"]
                if it["name"] == "apres_camG.mp4")
    assert item["web_proxy"] == "apres_camG_web.mp4"


def test_rename_refused_while_proxy_converting(client, library, jobs):
    raw = library.folder_override / "occupe_camG.mp4"
    raw.write_bytes(_fake_mp4(6.0, codec="mp4v"))
    jobs._jobs["occupe_camG.mp4"] = {
        "name": "occupe_camG.mp4", "source": raw,
        "target": library.folder_override / "occupe_camG_web.mp4",
        "state": "converting", "progress": 40, "error": None, "proc": None}
    response = client.post("/api/videos/rename",
                           json={"name": "occupe_camG.mp4", "new_name": "jamais.mp4"})
    assert response.status_code == 409
    assert not (library.folder_override / "jamais.mp4").exists()


def test_purge_partials(library):
    junk = library.folder_override / "x_web.mp4.part"
    junk.write_bytes(b"partiel")
    keep = library.folder_override / "garde.mp4"
    keep.write_bytes(b"x")
    library.purge_partials()
    assert not junk.exists() and keep.exists()
