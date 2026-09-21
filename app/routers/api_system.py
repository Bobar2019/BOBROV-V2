"""Routes système : état général du cockpit (footer SPA, diagnostics)."""
from __future__ import annotations

import time

from fastapi import APIRouter, Request

from app import __version__
from app.config import get_config

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/status", summary="État du cockpit")
async def system_status(request: Request) -> dict:
    """Version, uptime et résumé de la liaison série (complété aux étapes 3/4)."""
    data = get_config().get()
    started_at = getattr(request.app.state, "started_at", None)
    return {
        "status": "ok",
        "app": "BOBROV",
        "version": __version__,
        "uptime_s": round(time.time() - started_at, 1) if started_at else 0.0,
        "config_version": data["config_version"],
        "serial": {
            "port": data["serial"]["port"],
            "baud": data["serial"]["baud"],
            "connected": None,  # renseigné par le service série (étape 3)
        },
    }
