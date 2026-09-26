# BOBROV-V2

BOBROV-V2 est le cockpit embarqué de **cockpit-lite-rov**, destiné au pilotage d'un sous-marin ROV depuis un Raspberry Pi 5 sous Raspberry Pi OS Lite. Il fournit une interface web locale de pilotage, la liaison série vers le contrôleur de vol ESP32-S3, les flux caméra, la télémétrie et un simulateur 3D isolé.

> Le cockpit est conçu pour un réseau local. Les réglages matériels restent spécifiques à chaque installation et ne sont pas versionnés.

## Fonctionnalités

- Cockpit web temps réel : vidéo principale, PIP, disposition configurable et HUD Canvas/OSD à faible latence.
- Flux MJPEG V4L2 natifs, capture photo et enregistrement WebM depuis le navigateur.
- Gestion multi-manettes via la Web Gamepad API, associations persistées par `Gamepad.id`.
- Liaison série robuste avec l'ESP32-S3 : commandes, télémétrie et reconnexion automatique.
- Gestion réseau locale, médiathèque vidéo et maintenance du service depuis l'interface.
- Sub Simulator : physique ROV six axes et rendu 3D Three.js, intégrés sans dépendance CDN au runtime.
- Support du head-tracker BLE HID **BOB BL AR**.

## Architecture

### Backend

Le backend repose sur Python **3.11 ou supérieur** (validé également avec des versions plus récentes), FastAPI et Uvicorn.

- `app/main.py` initialise les services, expose les routeurs `/api/*` et sert le SPA depuis `static/`.
- La documentation interactive FastAPI est disponible sur `http://<pi>:8080/docs`.
- `app/config.py` gère `config.json` : valeurs par défaut, validation stricte, fusion des clés manquantes et écriture atomique.
- `app/serial_link.py` communique avec l'ESP32-S3 sur `/dev/serial0` (921600 bauds par défaut) dans un thread dédié.
- `app/video.py` expose les caméras V4L2 en MJPEG sans réencodage intermédiaire.
- `app/network.py`, `app/videos.py` et `app/routers/` regroupent les API réseau, médiathèque, configuration, système et assets du simulateur.

La télémétrie est actuellement consultée par API HTTP (`/api/system/telemetry`). Les WebSockets font partie de l'évolution prévue mais ne sont pas encore un transport applicatif actif : le README ne les présente donc pas comme disponibles.

### Frontend

Le frontend est une SPA HTML/CSS/JavaScript natif, sans framework. `static/app.js` gère le cockpit, les caméras, le HUD Canvas, les enregistrements, les paramètres et les manettes.

Le dossier `static/sim/` contient le Sub Simulator : moteur physique six degrés de liberté, mixage des propulseurs, scène 3D Three.js et harnais de tests autonome. Three.js est fourni localement dans les assets du projet.

### Matériel

- **Raspberry Pi 5** : héberge le service web et les périphériques V4L2.
- **ESP32-S3** : contrôleur de vol relié en série ; il porte les capteurs de pression et IMU, puis remonte leurs données au cockpit par le protocole série.
- **Caméras** : périphériques V4L2 configurables, relayés en MJPEG.
- **BOB BL AR** : head-tracker BLE HID basé sur ESP32-C6 et MPU-9250, exposé au navigateur comme `Gamepad`.

## Head-tracker BOB BL AR

Le tracker est volontairement indépendant de toute destination matérielle. Sa configuration se trouve dans **Paramètres → Manette → Head-tracker BOB BL AR**.

1. Dans la table des fonctions, associez `Activer / recentrer le head-tracker BOB BL AR` à un bouton de la manette principale.
2. Activez le routage, choisissez le périphérique BOB BL AR et le mode : bouton maintenu ou toujours actif.
3. Ajoutez un ou plusieurs routages `axe BOB → action analogique` et, si nécessaire, inversez l'axe.

À chaque front montant du bouton d'engagement, le cockpit envoie au BOB BL AR :

```js
vibrationActuator.playEffect('dual-rumble', {
  duration: 100,
  strongMagnitude: 1.0,
  weakMagnitude: 1.0,
})
```

Cet Output Report HID déclenche la tare matérielle du tracker. Un anti-rebond frontend de 250 ms complète celui du firmware. Pendant l'activation, chaque axe routé expose une consigne normalisée entre `-1.0` et `+1.0`, sans imposer de caméra, pan/tilt ou voie matérielle. La consigne est publiée dans `window.BOBROV_HEAD_TRACKER_INPUT` et via l'événement `bobrov:head-tracker-input`; le Sub Simulator consomme également ce routage.

La disponibilité de `vibrationActuator` dépend du navigateur et de la pile HID de l'OS. Chrome ou Edge sont recommandés. Si cette API n'est pas exposée, la tare haptique est signalée comme indisponible sans empêcher le reste du routage.

## Installation

### Prérequis système

Sur Raspberry Pi OS Lite :

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-dev build-essential \
  libgl1-mesa-glx libglib2.0-0 libatlas-base-dev v4l-utils
```

Cloner le dépôt, puis installer les dépendances Python :

```bash
git clone https://github.com/Bobar2019/BOBROV-V2.git /home/bob/BOBROV-V2
cd /home/bob/BOBROV-V2
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

Au premier lancement, `config.json` est automatiquement créé à partir des valeurs de `app/config.py`. Il contient les chemins matériels, le réseau, les caméras, le HUD et les associations de manettes : il est local et ignoré par Git.

Démarrage manuel :

```bash
./run.sh
```

Le service écoute par défaut sur le port `8080`. Ouvrez ensuite `http://<adresse-du-pi>:8080/` et la documentation API sur `/docs`.

### Service systemd

Le fichier versionné `deploy/bob-rov.service` est la source de vérité du service : il démarre `run.sh` avec `Type=simple`, l'utilisateur `bob`, le répertoire `/home/bob/BOBROV-V2` et un redémarrage automatique.

```bash
sudo install -m 0644 deploy/bob-rov.service /etc/systemd/system/bob-rov.service
sudo systemctl daemon-reload
sudo systemctl enable --now bob-rov.service
sudo systemctl status bob-rov.service
```

Les journaux de service sont accessibles avec :

```bash
journalctl -u bob-rov.service -f
```

Le répertoire `logs/` est réservé aux journaux locaux optionnels et reste présent dans Git grâce à `logs/.gitkeep`; ses fichiers de log sont ignorés.

## Tests

Les tests Python couvrent la configuration, le protocole, la liaison série, les API, le réseau, la vidéo et la médiathèque.

```bash
.venv/bin/pytest -q
```

Le harnais du simulateur est disponible depuis son interface. Les essais de rendu, de caméras et de périphériques physiques doivent être réalisés sur le poste connecté au ROV.

## Arborescence

```text
app/                 Backend FastAPI, configuration, série, vidéo et routeurs
static/              SPA cockpit, HUD Canvas et Sub Simulator Three.js
tests/               Tests automatisés Python
deploy/              Unité systemd versionnée
videos/.gitkeep      Répertoire de médias local, vide dans Git
logs/.gitkeep        Répertoire de logs local, vide dans Git
run.sh               Lance Uvicorn depuis l'environnement virtuel
requirements.txt     Dépendances Python
```

## Données locales exclues de Git

Les environnements virtuels, caches Python, configurations d'installation, journaux et médias enregistrés sont exclus par `.gitignore`. Ne publiez pas `config.json`, les captures de caméra ni les enregistrements WebM produits en opération.
