"""Application FastAPI du cockpit BOBROV (Raspberry Pi 5 ↔ ESP32-S3).

Socle : squelette + configuration centralisée (config.json à la racine), liaison
série temps réel (thread dédié, étape 3), flux vidéo MJPEG des caméras
(étape 6) + médiathèque « Mes Vidéos » et gestion réseau/WiFi (nmcli). Les
briques suivantes s'enregistreront ici au fil des étapes : WebSockets
télémétrie/commandes (étape 4), zone simulateur (étape 10).
"""
from __future__ import annotations

import logging
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles

from app import __version__, network, stereo, video, videos
from app.config import PROJECT_ROOT, get_config
from app.routers import api_bugs, api_config, api_rov, api_system
from app.serial_link import get_serial_link

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
    videos.get_library().purge_partials()       # conversions/dépôts avortés par un arrêt brutal
    log.info("Interface HTTP : http://%s:%s (host/port lus dans config.json)",
             data["network"]["host"], data["network"]["port"])
    log.info("Liaison série : %s @ %d bauds — démarrage du service",
             data["serial"]["port"], data["serial"]["baud"])
    get_serial_link().start()
    video.get_video().start()
    log.info("Flux vidéo : cam1=%s · cam2=%s — superviseurs prêts (capture à la demande)",
             data["cameras"]["cam1"]["device"], data["cameras"]["cam2"]["device"])
    log.info("Enregistrement 3D : ffmpeg %s — gauche=%s · droite=%s (capture à la demande)",
             "détecté" if stereo.ffmpeg_available() else "ABSENT (fonction 3D indisponible)",
             data["cameras"]["stereo"]["left_device"], data["cameras"]["stereo"]["right_device"])
    # Tâches réseau du démarrage — priorité des liens (LAN/WiFi) et redirection
    # du port 80 pour http://<nom>.local — en tâche de fond pour ne pas
    # retarder le démarrage (nmcli + sudo peuvent prendre 1–2 s).
    threading.Thread(target=network.startup,
                     name="network-startup", daemon=True).start()
    yield
    stereo.get_stereo().shutdown()
    videos.get_proxy_jobs().shutdown()
    video.get_video().stop()
    get_serial_link().stop()
    log.info("BOBROV — arrêt propre")


class NoCacheStaticFiles(StaticFiles):
    """Fichiers du SPA toujours revalidés : un écran ne reste jamais démodé.

    Sans en-tête de cache, les navigateurs appliquent une fraîcheur
    heuristique et pouvaient rejouer un ancien app.js après une mise à jour.
    ``no-cache`` = stockage permis, revalidation obligatoire (ETag et
    Last-Modified de FileResponse → 304 si inchangé, 200 si modifié).
    """

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "no-cache"
        return response


class RapportBugStaticFiles(NoCacheStaticFiles):
    """Dossier ``Rapport_bug/`` : page de rapports + module 🐛, sans ``data/``.

    ``data/rapports_bug.json`` contient le texte libre des rapports : il doit
    rester inaccessible en HTTP, comme le protégeait le ``.htaccess`` du
    dossier d'origine. Seul ``app/routers/api_bugs.py`` y accède.
    """

    async def get_response(self, path: str, scope) -> Response:
        if path == "data" or path.startswith("data/"):
            raise HTTPException(status_code=404, detail="Not Found")
        return await super().get_response(path, scope)


app = FastAPI(title="BOBROV", version=__version__, lifespan=lifespan)

app.include_router(api_system.router)
app.include_router(api_config.router)
app.include_router(api_rov.router)
app.include_router(api_bugs.router)
app.include_router(video.router)
app.include_router(videos.router)
app.include_router(stereo.router)
app.include_router(network.router)

# Page de rapports de bug (Rapport_bug/bugs.html) et son module flottant 🐛.
# Monté AVANT le SPA « / » ci-dessous, sinon static/index.html répondrait
# à leur place ; le sous-dossier data/ est refusé par le montage lui-même.
app.mount("/Rapport_bug",
          RapportBugStaticFiles(directory=PROJECT_ROOT / "Rapport_bug", html=True),
          name="rapport_bug")

# SPA servie depuis static/ (index.html + style.css + app.js).
# Monté en dernier : les routes /api/... ci-dessus restent prioritaires.
# Revalidation systématique : une mise à jour du cockpit apparaît dès le
# premier rechargement, sans vider le cache du navigateur.
app.mount("/", NoCacheStaticFiles(directory=PROJECT_ROOT / "static", html=True), name="static")
