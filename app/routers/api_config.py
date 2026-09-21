"""Routes de configuration : lecture complète et mise à jour partielle."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.config import ConfigError, get_config

router = APIRouter(prefix="/api/config", tags=["config"])


@router.get("", summary="Configuration complète")
async def read_config() -> dict:
    """Retourne config.json tel que chargé (défauts fusionnés)."""
    return get_config().get()


@router.post("", summary="Mise à jour partielle")
async def update_config(patch: dict) -> dict:
    """Fusionne un patch partiel dans config.json.

    Exemple de corps : {"interface": {"theme": "light"}} — les clés absentes
    conservent leur valeur courante ; un patch invalide est rejeté (422),
    sans aucune écriture sur disque.
    """
    try:
        updated = get_config().update(patch)
    except ConfigError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "ok", "config": updated}
