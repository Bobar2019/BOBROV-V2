#!/usr/bin/env bash
# BOBROV — lancement du cockpit.
# Host et port sont lus depuis config.json (section "network"), qui est
# généré depuis les défauts s'il n'existe pas encore.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/uvicorn ]]; then
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
exec .venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT"
