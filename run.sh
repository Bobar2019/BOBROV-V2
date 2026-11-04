#!/usr/bin/env bash
# BOBROV — lancement du cockpit.
# Host et port sont lus depuis config.json (section "network"), qui est
# généré depuis les défauts s'il n'existe pas encore. Un second écouteur
# HTTPS auto-signé (port 8443) est ajouté si deploy/tls/cert.pem existe :
# WebGPU, et donc le simulateur Tidewater, exige un contexte sécurisé.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/python ]]; then
    echo "[BOBROV] ERREUR : environnement virtuel absent ou incomplet."
    echo "[BOBROV] Exécutez d'abord :"
    echo "         python3 -m venv .venv"
    echo "         .venv/bin/pip install -r requirements.txt"
    exit 1
fi

CONFIG_LINE="$(.venv/bin/python - <<'PY'
from app.config import get_config
net = get_config().load()["network"]
print(net["host"], net["port"])
PY
)"
read -r HOST PORT <<< "$CONFIG_LINE"

echo "[BOBROV] Écoute sur http://${HOST}:${PORT} — Ctrl+C pour arrêter"
if [[ -f deploy/tls/cert.pem && -f deploy/tls/key.pem ]]; then
    echo "[BOBROV] Écoute aussi sur https://<ip-du-pi>:8443 (certificat auto-signé, contexte sécurisé)"
else
    echo "[BOBROV] HTTPS inactif — deploy/gen-cert.sh active le simulateur WebGPU à distance"
fi
# app.serve démarre les deux écouteurs dans le même processus : la liaison
# série et la vidéo sont des singletons, un second uvicorn les ouvrirait deux fois.
exec .venv/bin/python -m app.serve
