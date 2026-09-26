"""Tests du routeur d'assets du Sub Simulator (bibliothèque + imports GLB).

Les fichiers importés sont écrits dans un dossier temporaire (monkeypatch
d'``api_sim_assets.IMPORTS_DIR``) : aucun octet ne touche le dépôt. Le
catalogue « intégrés » reste celui livré avec le module (lecture seule).
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.routers import api_sim_assets

PAYLOAD = b"glTF\x02\x00\x00\x00" + b"x" * 64


def _client(monkeypatch, tmp_path) -> TestClient:
    monkeypatch.setattr(api_sim_assets, "IMPORTS_DIR", tmp_path)
    return TestClient(app)


def test_listing_contains_integrated_models(monkeypatch, tmp_path):
    """Le catalogue expose les modèles livrés avec le module (lecture seule)."""
    data = _client(monkeypatch, tmp_path).get("/api/sim/assets/models").json()
    assert data["status"] == "ok"
    files = {model["file"] for model in data["models"]}
    assert {"bob_rov_3D.glb", "guppy.glb", "sea_weed.glb"} <= files
    assert all(model["source"] == "integrated" for model in data["models"])
    assert all(model["url"].startswith("/sim/assets/models/") for model in data["models"])


def test_upload_list_delete_roundtrip(monkeypatch, tmp_path):
    """Import (corps brut) → listage « imported » → suppression ciblée."""
    client = _client(monkeypatch, tmp_path)
    response = client.post("/api/sim/assets/models",
                           params={"name": "mon_modele.glb"}, content=PAYLOAD)
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["file"] == "mon_modele.glb"
    assert data["size"] == len(PAYLOAD)
    assert data["url"] == "/sim/assets/importes/mon_modele.glb"
    assert (tmp_path / "mon_modele.glb").read_bytes() == PAYLOAD

    imported = [m for m in client.get("/api/sim/assets/models").json()["models"]
                if m["source"] == "imported"]
    assert [model["file"] for model in imported] == ["mon_modele.glb"]

    deleted = client.delete("/api/sim/assets/models/mon_modele.glb").json()
    assert deleted == {"status": "ok", "name": "mon_modele.glb"}
    assert not (tmp_path / "mon_modele.glb").exists()
    imported = [m for m in client.get("/api/sim/assets/models").json()["models"]
                if m["source"] == "imported"]
    assert imported == []


def test_upload_sanitizes_name_and_avoids_collision(monkeypatch, tmp_path):
    """Nom nettoyé (chemin et espaces neutralisés) puis suffixe horodaté."""
    client = _client(monkeypatch, tmp_path)
    first = client.post("/api/sim/assets/models",
                        params={"name": "../../modele sale.glb"}, content=b"a")
    assert first.status_code == 200
    assert first.json()["file"] == "modele_sale.glb"

    second = client.post("/api/sim/assets/models",
                         params={"name": "modele sale.glb"}, content=b"b")
    assert second.status_code == 200
    renamed = second.json()["file"]
    assert renamed != "modele_sale.glb"
    assert renamed.startswith("modele_sale_") and renamed.endswith(".glb")
    assert sorted(p.name for p in tmp_path.iterdir()) == ["modele_sale.glb", renamed]


def test_upload_rejects_bad_extension_and_empty_body(monkeypatch, tmp_path):
    """Extensions autres que .glb/.gltf refusées ; corps vide refusé."""
    client = _client(monkeypatch, tmp_path)
    bad_ext = client.post("/api/sim/assets/models",
                          params={"name": "notes.txt"}, content=b"a")
    assert bad_ext.status_code == 415

    empty = client.post("/api/sim/assets/models",
                        params={"name": "vide.glb"}, content=b"")
    assert empty.status_code == 422
    assert not list(tmp_path.iterdir())


def test_delete_only_touches_imported_models(monkeypatch, tmp_path):
    """Un modèle intégré ne peut pas être supprimé via ce routeur."""
    client = _client(monkeypatch, tmp_path)
    missing = client.delete("/api/sim/assets/models/guppy.glb")
    assert missing.status_code == 404
    assert (api_sim_assets.MODELS_DIR / "guppy.glb").is_file()

    traversal = client.delete("/api/sim/assets/models/..%2Fguppy.glb")
    # 400/404 si le routeur reçoit le nom ; 405 si la barre encodée retombe
    # sur le montage statique (qui refuse DELETE) — jamais 200.
    assert traversal.status_code in (400, 404, 405)
