"""Tests de la médiathèque « Mes Vidéos » : listing, notes/étoiles, service HTTP."""
from __future__ import annotations

import os
import struct

import pytest
from fastapi.testclient import TestClient

from app import videos
from app.main import app


def _box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def _fake_mp4(duration_s: float = 20.0, timescale: int = 600) -> bytes:
    """MP4 minimal : ftyp + moov{mvhd} — durée lisible par le parseur pur Python."""
    mvhd = (b"\x00" + b"\x00\x00\x00"                       # version 0 + flags
            + struct.pack(">II", 0, 0)                       # création / modification
            + struct.pack(">II", timescale, int(duration_s * timescale))
            + b"\x00" * 80)                                  # reste de la boîte
    return _box(b"ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2") + _box(b"moov", _box(b"mvhd", mvhd))


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
