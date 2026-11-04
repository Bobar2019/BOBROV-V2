"""Tests des rapports de bug : les cinq routes du §6.7 de Rapport_Bug.md.

Le stockage est redirigé vers un dossier temporaire : aucun test n'écrit dans
``Rapport_bug/data/``. Les bornes sont vérifiées côté serveur — la description
et le contexte viennent d'un navigateur et ne sont pas des données de
confiance.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import api_bugs


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    """Client HTTP sur un fichier de rapports neuf, isolé du dossier réel."""
    monkeypatch.setattr(api_bugs, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api_bugs, "STORE_PATH", tmp_path / "rapports_bug.json")
    return TestClient(app)


def _signaler(client: TestClient, description: str = "la tuile est trop petite",
              contexte: dict | str | None = None) -> dict:
    reponse = client.post("/api/bugs/signaler",
                          json={"description": description, "contexte": contexte or {}})
    assert reponse.status_code == 200
    return reponse.json()


def test_liste_vide_au_depart(client):
    """Sans fichier de stockage, la liste est vide et la route reste saine."""
    assert client.get("/api/bugs/liste").json() == {"ok": True, "rapports": []}


def test_signaler_enregistre_le_rapport(client, tmp_path):
    """Le rapport reçoit un identifiant, un horodatage et la page du contexte."""
    contexte = {"page": "cockpit.html", "reseau": True,
                "element": {"tag": "div", "id": "tuile-video", "chemin": "main > div#tuile-video"}}
    rep = _signaler(client, contexte=contexte)
    assert rep["ok"] is True and rep["total"] == 1
    assert rep["id"].startswith("bg_")

    rapports = client.get("/api/bugs/liste").json()["rapports"]
    assert len(rapports) == 1
    rapport = rapports[0]
    assert rapport["id"] == rep["id"]
    assert rapport["page"] == "cockpit.html"
    assert rapport["description"] == "la tuile est trop petite"
    assert rapport["contexte"] == contexte
    assert isinstance(rapport["ts"], int)

    # Le fichier de stockage est bien celui demandé par la page de rapports.
    fichier = json.loads((tmp_path / "rapports_bug.json").read_text(encoding="utf-8"))
    assert fichier["rapports"][0]["id"] == rep["id"]


def test_signaler_refuse_une_description_vide(client):
    """Description absente, vide ou réduite à du balisage → ok:false, rien d'écrit."""
    for description in ("", "   ", "<b></b>"):
        rep = _signaler(client, description=description)
        assert rep["ok"] is False
        assert "description" in rep["error"]
    assert client.get("/api/bugs/liste").json()["rapports"] == []


def test_signaler_retire_le_html_et_borne_la_description(client):
    """Le texte est nettoyé du balisage et plafonné à 4000 caractères."""
    rep = _signaler(client, description="<script>alert(1)</script>" + "x" * 4200)
    assert rep["ok"] is True
    description = client.get("/api/bugs/liste").json()["rapports"][0]["description"]
    assert "<script>" not in description
    assert len(description) == api_bugs.MAX_DESCRIPTION


def test_signaler_accepte_le_contexte_en_chaine_json(client):
    """Contrat du module d'origine : le contexte arrive sérialisé en une chaîne."""
    rep = _signaler(client, contexte=json.dumps({"page": "ancien-module.html"}))
    assert rep["ok"] is True
    rapport = client.get("/api/bugs/liste").json()["rapports"][0]
    assert rapport["page"] == "ancien-module.html"
    assert rapport["contexte"] == {"page": "ancien-module.html"}


def test_signaler_tronque_un_contexte_trop_gros(client):
    """Au-delà de 24 Ko, le contexte est remplacé par {"tronque": true}."""
    rep = _signaler(client, contexte={"blob": "x" * (api_bugs.MAX_CONTEXTE + 1)})
    assert rep["ok"] is True
    rapport = client.get("/api/bugs/liste").json()["rapports"][0]
    assert rapport["contexte"] == {"tronque": True}
    assert rapport["page"] == ""


def test_signaler_ignore_un_contexte_non_json(client):
    """Chaîne non JSON ou type inattendu : contexte vide, le rapport est gardé."""
    for contexte in ("pas du json", 42, [1, 2, 3]):
        assert _signaler(client, contexte=contexte)["ok"] is True
    for rapport in client.get("/api/bugs/liste").json()["rapports"]:
        assert rapport["contexte"] == {}


def test_liste_recent_d_abord_et_ejection_au_dela_de_200(client):
    """200 rapports maximum : les plus anciens sont éjectés."""
    for index in range(api_bugs.MAX_RAPPORTS + 3):
        assert _signaler(client, description=f"rapport {index}")["ok"] is True
    rapports = client.get("/api/bugs/liste").json()["rapports"]
    assert len(rapports) == api_bugs.MAX_RAPPORTS
    assert rapports[0]["description"] == f"rapport {api_bugs.MAX_RAPPORTS + 2}"
    assert rapports[-1]["description"] == "rapport 3"


def test_completer_ajoute_un_complement_horodate(client):
    """Le complément est ajouté à la suite : le rapport d'origine est intact."""
    rep = _signaler(client)
    complement = client.post("/api/bugs/completer",
                             json={"id": rep["id"], "texte": "précision ajoutée"})
    assert complement.json() == {"ok": True}
    rapport = client.get("/api/bugs/liste").json()["rapports"][0]
    assert rapport["description"] == "la tuile est trop petite"
    assert len(rapport["complements"]) == 1
    assert rapport["complements"][0]["texte"] == "précision ajoutée"
    assert isinstance(rapport["complements"][0]["ts"], int)


def test_completer_refuse_au_dela_de_20_et_si_introuvable(client):
    """20 compléments maximum ; un identifiant inconnu est signalé."""
    rep = _signaler(client)
    for index in range(api_bugs.MAX_COMPLEMENTS):
        assert client.post("/api/bugs/completer",
                           json={"id": rep["id"], "texte": f"note {index}"}).json()["ok"] is True
    trop = client.post("/api/bugs/completer", json={"id": rep["id"], "texte": "note 21"}).json()
    assert trop["ok"] is False and "20" in trop["error"]
    inconnu = client.post("/api/bugs/completer",
                          json={"id": "bg_19700101_000000_abcdef", "texte": "note"}).json()
    assert inconnu == {"ok": False, "error": "Rapport introuvable."}


def test_completer_exige_id_et_texte(client):
    """Identifiant ou texte manquant → refus, aucune écriture."""
    assert client.post("/api/bugs/completer", json={"texte": "note"}).json()["ok"] is False
    assert client.post("/api/bugs/completer", json={"id": "bg_x"}).json()["ok"] is False


def test_supprimer_un_seul_rapport(client):
    """Seul le rapport visé disparaît ; le total renvoyé suit."""
    premier = _signaler(client, description="à garder")["id"]
    second = _signaler(client, description="à supprimer")["id"]
    rep = client.post("/api/bugs/supprimer", json={"id": second}).json()
    assert rep == {"ok": True, "total": 1, "supprime": 1}
    restants = client.get("/api/bugs/liste").json()["rapports"]
    assert [r["id"] for r in restants] == [premier]


def test_supprimer_exige_un_identifiant(client):
    """Sans identifiant : refus explicite, la liste est inchangée."""
    _signaler(client)
    rep = client.post("/api/bugs/supprimer", json={}).json()
    assert rep["ok"] is False and "Identifiant" in rep["error"]
    assert len(client.get("/api/bugs/liste").json()["rapports"]) == 1


def test_vider_supprime_tout_sans_effacer_le_fichier(client, tmp_path):
    """La liste est remise à zéro, le fichier de stockage reste en place."""
    for index in range(3):
        _signaler(client, description=f"rapport {index}")
    assert client.post("/api/bugs/vider").json() == {"ok": True, "total": 0}
    assert client.get("/api/bugs/liste").json()["rapports"] == []
    assert (tmp_path / "rapports_bug.json").is_file()


def test_stockage_corrompu_ne_casse_rien(client, tmp_path):
    """Un fichier illisible rend une liste vide et reste réinscriptible."""
    (tmp_path / "rapports_bug.json").write_text("{ ceci n'est pas du json", encoding="utf-8")
    assert client.get("/api/bugs/liste").json() == {"ok": True, "rapports": []}
    assert _signaler(client)["ok"] is True
    assert len(client.get("/api/bugs/liste").json()["rapports"]) == 1


def test_page_servie_mais_dossier_data_masque(client):
    """Le dossier Rapport_bug est statique — sauf data/, qui n'est jamais servi."""
    assert client.get("/Rapport_bug/bugs.html").status_code == 200
    assert client.get("/Rapport_bug/js/bug-report.js").status_code == 200
    assert client.get("/Rapport_bug/data/rapports_bug.json").status_code == 404
