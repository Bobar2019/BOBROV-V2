"""Application FastAPI du cockpit BOBROV (Raspberry Pi 5 ↔ ESP32-S3).

Étape 1 : squelette + configuration centralisée (config.json à la racine).
Les briques suivantes s'enregistreront ici au fil des étapes : liaison série
(étape 3), WebSockets télémétrie/commandes (étape 4), flux vidéo (étape 6),
simulateur (étape 10).
"""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.config import PROJECT_ROOT, get_config
from app.routers import api_config, api_system

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s : %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("bobrov.main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Amorçage du cockpit : la configuration d'abord, les services ensuite."""
    data = get_config().load()
    _app.state.started_at = time.time()
    log.info("BOBROV %s — démarrage du socle", __version__)
    log.info("Interface HTTP : http://%s:%s (host/port lus dans config.json)",
             data["network"]["host"], data["network"]["port"])
    log.info("Liaison série prévue : %s @ %d bauds — service ajouté à l'étape 3",
             data["serial"]["port"], data["serial"]["baud"])
    yield
    log.info("BOBROV — arrêt propre")


app = FastAPI(title="BOBROV", version=__version__, lifespan=lifespan)

app.include_router(api_system.router)
app.include_router(api_config.router)

# SPA (étape 7) servie depuis static/ — placeholder à l'étape 1.
# Monté en dernier : les routes /api/... ci-dessus restent prioritaires.
app.mount("/", StaticFiles(directory=PROJECT_ROOT / "static", html=True), name="static")
