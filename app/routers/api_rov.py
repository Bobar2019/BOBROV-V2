"""Routes de pilotage du ROV : type d'autopilot du firmware BOB-CONTROL.

Le champ ``mode`` de la trame descendante est un masque d'assistances
superposables (PROTOCOLE_RPI5.md §4, v1.4.0+) :
0x01 auto roulis/tangage · 0x02 tenue de profondeur · 0x04 auto cap ·
0x08 retour surface (prioritaire) — ``0x00`` = passif (manuel direct).
Le firmware n'applique le masque que sur les trames armées (§6.2).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.serial_link import get_serial_link

log = logging.getLogger("bobrov.rov")

router = APIRouter(prefix="/api/rov", tags=["rov"])


@router.get("/autopilot", summary="Type d'autopilot courant")
async def read_autopilot() -> dict:
    """Masque d'assistances actuellement commandé au ROV (0 = passif)."""
    mode = get_serial_link().get_status()["command"]["mode"]
    return {"status": "ok", "mode": mode}


@router.post("/autopilot", summary="Choisir le type d'autopilot")
async def set_autopilot(payload: dict) -> dict:
    """Remplace le masque d'assistances envoyé au ROV (émission immédiate).

    Corps : ``{"mode": 0..15}`` — les bits se superposent : 0x01 auto R/T,
    0x02 tenue de profondeur, 0x04 auto cap, 0x08 retour surface ; 0 = passif.
    """
    raw = payload.get("mode")
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise HTTPException(status_code=422, detail="mode : entier 0–15 attendu")
    try:
        get_serial_link().set_command(mode=raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    log.info("Autopilote : masque 0x%02X commandé depuis le cockpit", raw)
    return {"status": "ok", "mode": raw}
