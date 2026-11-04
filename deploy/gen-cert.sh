#!/usr/bin/env bash
# BOBROV — certificat auto-signé du cockpit (port HTTPS 8443).
#
# Pourquoi : les navigateurs n'exposent WebGPU qu'aux contextes sécurisés.
# En HTTP simple sur l'IP du Pi, le simulateur Tidewater refuse de démarrer
# (« WebGPU is not available in this browser »). Servi en HTTPS, il fonctionne
# sur n'importe quel appareil du réseau, après acceptation du certificat.
#
# Usage : ./deploy/gen-cert.sh [IP ou hôte supplémentaire ...]
# Le certificat couvre bobrov.local, localhost, 127.0.0.1 et toutes les
# adresses IP courantes de la machine ; ajoutez-en au besoin en argument.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/deploy/tls"
mkdir -p "$DIR"

# SAN = noms sous lesquels le Pi est joint ; le navigateur refuse un
# certificat dont le SAN ne couvre pas l'adresse tapée.
SAN="DNS:bobrov.local,DNS:localhost,IP:127.0.0.1"
for addr in $(hostname -I 2>/dev/null || true) "$@"; do
    if [[ "$addr" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        SAN="$SAN,IP:$addr"
    fi
done

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
    -subj "/CN=bobrov.local" -addext "subjectAltName=$SAN"
chmod 600 "$DIR/key.pem"

echo "[BOBROV] Certificat écrit dans $DIR (10 ans)"
echo "[BOBROV] Noms couverts : $SAN"
echo "[BOBROV] Redémarrez le service : sudo systemctl restart bob-rov"
echo "[BOBROV] Puis ouvrez https://<ip-du-pi>:8443 et acceptez le certificat une fois"
