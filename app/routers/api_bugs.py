"""Routes des rapports de bug — portage Python de ``Rapport_bug/bugs.php``.

Le contrat est celui de ``Rapport_bug/Rapport_Bug.md`` §6.7 : les cinq routes
de la page de rapports, la même forme de réponse (``{ok: …}``) pour que le
JavaScript déjà écrit dans ``bugs.html`` soit réutilisé tel quel.

    GET  /api/bugs/liste       → {ok, rapports: [...]}
    POST /api/bugs/signaler    → description + contexte (JSON forgé par le client)
    POST /api/bugs/completer   → id + texte (complément horodaté, append-only)
    POST /api/bugs/supprimer   → id
    POST /api/bugs/vider       → tout supprimer

Stockage : ``Rapport_bug/data/rapports_bug.json`` — fichier SÉPARÉ des données
métier (un rapport corrompu ne casse rien). Le dossier ``data/`` n'est pas
servi par le montage statique (voir ``app/main.py``), comme le ``.htaccess``
du dossier d'origine.

Deux règles du §6.7 sont appliquées sans exception :

- **bornes** : description ≤ 4000 car., contexte ≤ 24 Ko (au-delà :
  ``{"tronque": true}``), 200 rapports max (les plus anciens éjectés), 20
  compléments par rapport ;
- **méfiance** : le contexte est du JSON arbitraire — il est reçu, borné,
  stocké tel quel et jamais interprété ici ; c'est la page qui l'affiche,
  intégralement échappé.

La session + CSRF du PHP d'origine n'ont pas d'équivalent ici : le cockpit
n'a pas d'authentification (``mot_de_passe`` vide dans ``rb_config.php``,
donc aucune protection côté PHP non plus). Le champ ``auth`` reste dans le
contrat — il vaut toujours faux — pour que la file hors-ligne de la page
continue de fonctionner sans modification.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time

from fastapi import APIRouter

from app.config import PROJECT_ROOT

log = logging.getLogger("bobrov.bugs")

router = APIRouter(prefix="/api/bugs", tags=["bugs"])

DATA_DIR = PROJECT_ROOT / "Rapport_bug" / "data"
STORE_PATH = DATA_DIR / "rapports_bug.json"

# Bornes du §6.7 — le client n'est pas digne de confiance.
MAX_RAPPORTS = 200
MAX_DESCRIPTION = 4000
MAX_CONTEXTE = 24000
MAX_COMPLEMENTS = 20
MAX_PAGE = 120
MAX_ID = 40
MAX_COMPLEMENT = 2000

# Une seule écriture à la fois : lecture + modification + remplacement du
# fichier doivent former un tout (l'équivalent du LOCK_EX de file_put_contents).
_LOCK = threading.Lock()

_TAGS = re.compile(r"<[^>]*>")


def _texte(valeur: object, maximum: int, defaut: str = "") -> str:
    """Texte nettoyé et BORNÉ : le rapport vient d'un navigateur.

    Aucun HTML n'est conservé (``strip_tags`` du PHP), la longueur est
    plafonnée et tout ce qui n'est pas du texte retombe sur ``defaut`` —
    jamais de conversion d'un tableau, qui sortirait du JSON valide.
    """
    if not isinstance(valeur, str):
        return defaut
    nettoye = _TAGS.sub("", valeur).strip()
    return nettoye[:maximum] if nettoye else defaut


def _contexte(brut: object) -> dict:
    """Contexte du rapport : JSON arbitraire, stocké tel quel mais borné.

    Accepté sous ses deux formes utiles — chaîne JSON (contrat du module
    d'origine) ou objet déjà décodé (envoi JSON de ``bugs.html``).
    Au-delà de 24 Ko, le contenu est remplacé par ``{"tronque": true}``.
    """
    if brut is None or brut == "":
        return {}
    if isinstance(brut, dict):
        if len(json.dumps(brut, ensure_ascii=False).encode("utf-8")) > MAX_CONTEXTE:
            return {"tronque": True}
        return brut
    if not isinstance(brut, str):
        return {}
    if len(brut.encode("utf-8")) > MAX_CONTEXTE:
        return {"tronque": True}
    try:
        contexte = json.loads(brut)
    except ValueError:
        return {}
    return contexte if isinstance(contexte, dict) else {}


def _lire() -> dict:
    """Contenu du fichier de stockage ; absent, illisible ou corrompu → vide."""
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"rapports": []}
    if not isinstance(data, dict) or not isinstance(data.get("rapports"), list):
        return {"rapports": []}
    return data


def _ecrire(data: dict) -> bool:
    """Écrit le fichier de façon atomique (temporaire + ``os.replace``).

    ``False`` si le disque refuse : la route répond alors ``ok: false`` avec
    un message explicite plutôt que de laisser croire à un enregistrement.
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        temporaire = STORE_PATH.with_name(STORE_PATH.name + ".tmp")
        temporaire.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temporaire, STORE_PATH)
        return True
    except OSError as exc:
        log.error("Rapports de bug : écriture impossible (%s)", exc)
        return False


def _identifiant() -> str:
    """``bg_20261103_120354_c5fe0c`` — horodatage lisible + 3 octets d'aléa."""
    return f"bg_{time.strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(3)}"


@router.get("/liste", summary="Rapports enregistrés")
async def list_bugs() -> dict:
    """Liste complète, le plus récent d'abord (ordre d'écriture du fichier)."""
    with _LOCK:
        return {"ok": True, "rapports": _lire()["rapports"]}


@router.post("/signaler", summary="Enregistrer un rapport de bug")
async def report_bug(payload: dict) -> dict:
    """Corps : ``{"description": "…", "contexte": {...} | "{...}"}``.

    La description est obligatoire (le contexte, non : un rapport peut être
    une simple phrase). Les rapports les plus anciens sont éjectés au-delà de
    200 pour que le fichier ne grossisse pas indéfiniment.
    """
    description = _texte(payload.get("description"), MAX_DESCRIPTION)
    if not description:
        return {"ok": False, "error": "La description du bug est vide."}
    contexte = _contexte(payload.get("contexte"))
    rapport = {
        "id": _identifiant(),
        "ts": int(time.time()),
        "page": _texte(contexte.get("page"), MAX_PAGE),
        "description": description,
        "contexte": contexte,
    }
    with _LOCK:
        data = _lire()
        data["rapports"].insert(0, rapport)
        del data["rapports"][MAX_RAPPORTS:]
        if not _ecrire(data):
            return {
                "ok": False,
                "error": "Écriture du rapport impossible (permissions du dossier data/).",
            }
        total = len(data["rapports"])
    log.info("Rapport de bug %s enregistré (%s)", rapport["id"], rapport["page"] or "page inconnue")
    return {"ok": True, "id": rapport["id"], "total": total}


@router.post("/completer", summary="Ajouter un complément à un rapport")
async def complete_bug(payload: dict) -> dict:
    """Corps : ``{"id": "bg_…", "texte": "…"}``.

    Append-only : le rapport d'origine n'est jamais réécrit, le complément est
    ajouté horodaté à la suite (20 maximum).
    """
    identifiant = _texte(payload.get("id"), MAX_ID)
    texte = _texte(payload.get("texte"), MAX_COMPLEMENT)
    if not identifiant or not texte:
        return {"ok": False, "error": "Rapport ou complément manquant."}
    with _LOCK:
        data = _lire()
        for rapport in data["rapports"]:
            if not isinstance(rapport, dict) or rapport.get("id") != identifiant:
                continue
            complements = rapport.get("complements")
            complements = complements if isinstance(complements, list) else []
            if len(complements) >= MAX_COMPLEMENTS:
                return {
                    "ok": False,
                    "error": f"Maximum {MAX_COMPLEMENTS} compléments par rapport.",
                }
            complements.append({"ts": int(time.time()), "texte": texte})
            rapport["complements"] = complements
            if not _ecrire(data):
                return {"ok": False, "error": "Écriture impossible (permissions)."}
            log.info("Complément ajouté au rapport %s", identifiant)
            return {"ok": True}
        return {"ok": False, "error": "Rapport introuvable."}


@router.post("/supprimer", summary="Supprimer un rapport")
async def delete_bug(payload: dict) -> dict:
    """Corps : ``{"id": "bg_…"}`` — la suppression est définitive."""
    identifiant = _texte(payload.get("id"), MAX_ID)
    if not identifiant:
        return {"ok": False, "error": "Identifiant de rapport manquant."}
    with _LOCK:
        data = _lire()
        avant = len(data["rapports"])
        data["rapports"] = [
            rapport
            for rapport in data["rapports"]
            if not isinstance(rapport, dict) or rapport.get("id") != identifiant
        ]
        if not _ecrire(data):
            return {"ok": False, "error": "Suppression impossible (permissions)."}
        total = len(data["rapports"])
    supprime = avant - total
    log.info("Rapport de bug %s supprimé", identifiant)
    return {"ok": True, "total": total, "supprime": supprime}


@router.post("/vider", summary="Supprimer tous les rapports")
async def clear_bugs() -> dict:
    """Remet le fichier de stockage à une liste vide (sans le supprimer)."""
    with _LOCK:
        if not _ecrire({"rapports": []}):
            return {"ok": False, "error": "Suppression impossible (permissions)."}
    log.info("Rapports de bug : liste vidée")
    return {"ok": True, "total": 0}
