#!/usr/bin/env bash
# BOBROV-V2 — Sub Simulator : téléchargement unique de Three.js 0.160.0 (vendorisé).
#
# À lancer UNE SEULE FOIS (Internet requis), depuis n'importe où :
#     bash /home/bob/BOBROV-V2/static/sim/vendor/fetch_three.sh
#
# Ensuite, le simulateur fonctionne hors-ligne : tout est servi localement
# par le cockpit (aucun CDN au runtime). Même version que l'ancien simulateur
# BOBROV-main (importmap 0.160.0), pour une fidélité d'algorithmes totale.
set -euo pipefail
cd "$(dirname "$0")"

BASE="https://cdn.jsdelivr.net/npm/three@0.160.0"

echo "→ three.module.js"
curl -fL --retry 3 -o three.module.js "$BASE/build/three.module.js"

mkdir -p addons/loaders addons/controls addons/environments addons/utils
echo "→ addons/loaders/GLTFLoader.js"
curl -fL --retry 3 -o addons/loaders/GLTFLoader.js "$BASE/examples/jsm/loaders/GLTFLoader.js"
echo "→ addons/controls/OrbitControls.js"
curl -fL --retry 3 -o addons/controls/OrbitControls.js "$BASE/examples/jsm/controls/OrbitControls.js"
echo "→ addons/environments/RoomEnvironment.js"
curl -fL --retry 3 -o addons/environments/RoomEnvironment.js "$BASE/examples/jsm/environments/RoomEnvironment.js"
echo "→ addons/utils/SkeletonUtils.js"
curl -fL --retry 3 -o addons/utils/SkeletonUtils.js "$BASE/examples/jsm/utils/SkeletonUtils.js"
echo "→ addons/utils/BufferGeometryUtils.js"
curl -fL --retry 3 -o addons/utils/BufferGeometryUtils.js "$BASE/examples/jsm/utils/BufferGeometryUtils.js"

echo
echo "Fichiers installés :"
ls -la three.module.js addons/loaders addons/controls addons/environments addons/utils
