"""Routes de pilotage du ROV : armement et type d'autopilot (firmware BOB-CONTROL).

Le champ ``mode`` de la trame descendante est un masque d'assistances
superposables (PROTOCOLE_RPI5.md §4, v1.4.0+) :
0x01 auto roulis/tangage · 0x02 tenue de profondeur · 0x04 auto cap ·
0x08 retour surface (prioritaire) — ``0x00`` = passif (manuel direct).

Ce masque ne suffit pas à faire tourner les propulseurs : le firmware
n'applique les voies 0-7 et les assistances que sur les trames **armées**
(§6.2). ``arm_state`` 0 force les canaux 0-7 au neutre (1500 µs) et fait
ignorer le mode, 1 applique les 16 voies et le masque, 2 = E-Stop (toutes
les sorties à la position de sécurité, priorité absolue).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.serial_link import get_serial_link

log = logging.getLogger("bobrov.rov")

router = APIRouter(prefix="/api/rov", tags=["rov"])

ARM_LABELS = {0: "désarmé", 1: "armé", 2: "E-Stop"}


@router.get("/arm", summary="État d'armement courant")
async def read_arm() -> dict:
    """``arm_state`` commandé au ROV : 0 désarmé, 1 armé, 2 E-Stop."""
    arm_state = get_serial_link().get_status()["command"]["arm_state"]
    return {"status": "ok", "arm_state": arm_state}


@router.post("/arm", summary="Armer, désarmer ou déclencher l'E-Stop")
async def set_arm(payload: dict) -> dict:
    """Remplace l'état d'armement envoyé au ROV (émission immédiate).

    Corps : ``{"arm_state": 0|1|2}``. C'est lui qui autorise le firmware à
    appliquer les voies de propulsion 0-7 et le masque d'assistances (§6.2).
    """
    raw = payload.get("arm_state")
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise HTTPException(status_code=422, detail="arm_state : 0, 1 ou 2 attendu")
    try:
        get_serial_link().set_command(arm_state=raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    log.info("Armement : %s commandé depuis le cockpit", ARM_LABELS[raw])
    return {"status": "ok", "arm_state": raw}


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
