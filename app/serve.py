"""Point d'entrée du socle : HTTP (config.json) + HTTPS auto-signé optionnel.

WebGPU — et donc le simulateur Tidewater — n'est exposé par les navigateurs
qu'aux contextes sécurisés (HTTPS, localhost ou 127.0.0.1). Le port HTTP
historique reste servi tel quel ; le port HTTPS n'est ouvert que si
``deploy/tls/cert.pem`` et ``key.pem`` existent (voir ``deploy/gen-cert.sh``).

Les deux écouteurs partagent la **même** instance d'application : la liaison
série, la vidéo et les superviseurs sont des singletons de processus, un
second processus uvicorn les ouvrirait deux fois. Seul le premier serveur
exécute le ``lifespan`` ; le second s'en passe et réutilise l'état déjà posé.
"""

import asyncio
import logging
import os
import pathlib

import uvicorn

from app.config import PROJECT_ROOT, get_config
from app.main import app

log = logging.getLogger("bobrov.serve")

TLS_DIR = pathlib.Path(PROJECT_ROOT) / "deploy" / "tls"
TLS_CERT = pathlib.Path(os.environ.get("BOBROV_TLS_CERT", TLS_DIR / "cert.pem"))
TLS_KEY = pathlib.Path(os.environ.get("BOBROV_TLS_KEY", TLS_DIR / "key.pem"))
TLS_PORT = int(os.environ.get("BOBROV_TLS_PORT", "8443"))


def _server(host: str, port: int, **extra) -> uvicorn.Server:
    """Un serveur uvicorn sur l'application partagée."""
    # --timeout-graceful-shutdown : les flux MJPEG ouverts (clients navigateur)
    # sont coupés après 3 s au lieu de faire attendre systemd (voir aussi
    # TimeoutStopSec dans deploy/bob-rov.service).
    return uvicorn.Server(uvicorn.Config(
        app, host=host, port=port, timeout_graceful_shutdown=3, **extra))


def build_servers(data: dict) -> list[uvicorn.Server]:
    """Écouteurs à démarrer : HTTP seul, ou HTTP + HTTPS si le certificat existe."""
    net = data["network"]
    host, port = net["host"], int(net["port"])
    servers = [_server(host, port, lifespan="on")]
    if TLS_CERT.is_file() and TLS_KEY.is_file():
        servers.append(_server(host, TLS_PORT, lifespan="off",
                               ssl_certfile=str(TLS_CERT), ssl_keyfile=str(TLS_KEY)))
        where = "toutes interfaces" if host in ("0.0.0.0", "::") else host
        log.info("HTTPS auto-signé : port %d (%s) — contexte sécurisé, WebGPU disponible",
                 TLS_PORT, where)
    else:
        log.info("HTTPS inactif : %s absent — lancez deploy/gen-cert.sh "
                 "pour rendre WebGPU disponible à distance", TLS_CERT)
    return servers


async def _run() -> None:
    servers = build_servers(get_config().load())
    tasks = [asyncio.create_task(server.serve()) for server in servers]
    # Un signal ne ferme qu'un seul serveur (uvicorn installe ses gestionnaires
    # par instance) : dès que l'un s'arrête, on demande l'arrêt des autres.
    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for server in servers:
        server.should_exit = True
    await asyncio.gather(*tasks, return_exceptions=True)


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
