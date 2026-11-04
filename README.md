# BOBROV-V2

BOBROV-V2 est le cockpit embarqué de **cockpit-lite-rov**, destiné au pilotage d'un sous-marin ROV depuis un Raspberry Pi 5 sous Raspberry Pi OS Lite. Il fournit une interface web locale de pilotage, la liaison série vers le contrôleur de vol ESP32-S3, les flux caméra, la télémétrie et un simulateur 3D isolé.

> Le cockpit est conçu pour un réseau local. Les réglages matériels restent spécifiques à chaque installation et ne sont pas versionnés.

## Fonctionnalités

- Cockpit web temps réel : vidéo principale, PIP, disposition configurable et HUD Canvas/OSD à faible latence.
- Flux MJPEG V4L2 natifs, capture photo et enregistrement WebM depuis le navigateur.
- Gestion multi-manettes via la Web Gamepad API, associations persistées par `Gamepad.id`.
- Liaison série robuste avec l'ESP32-S3 : commandes, télémétrie et reconnexion automatique.
- Gestion réseau locale, médiathèque vidéo et maintenance du service depuis l'interface.
- Sub Simulator : simulateur 3D **Tidewater** (moteur de rendu WebGPU maison, licence MIT) servi en page autonome sous `/sim_tidewater/`.
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

Le dossier `static/sim_tidewater/` contient le Sub Simulator : le jeu 3D **Tidewater** (île, océan, bateau et pêche) récupéré de <https://github.com/dgreenheck/tidewater> et servi tel quel. Le projet d'origine est un jeu WebGPU écrit en modules ES natifs (moteur maison, sans Three.js ni dépendance npm) : seuls les chemins d'assets ont été rendus relatifs à la page. La page du SPA charge le jeu dans une iframe à la demande, pour isoler son contexte GPU, clavier et audio. Crédits et licence MIT : Paramètres → Sub Simu.

### Accès HTTPS (port 8443) et WebGPU

Le cockpit est servi en HTTP sur `config.json → network.port` (8080). Un second écouteur **HTTPS auto-signé sur le port 8443** est démarré par le même processus (`app/serve.py`) dès que le certificat existe :

```bash
./deploy/gen-cert.sh                # une fois : deploy/tls/{cert,key}.pem, valable 10 ans
sudo systemctl restart bob-rov
```

Ouvrez ensuite `https://<ip-du-pi>:8443` et acceptez l'avertissement de certificat une fois par appareil. Le certificat couvre `bobrov.local`, `localhost`, `127.0.0.1` et les adresses du Pi au moment de sa génération : relancez `gen-cert.sh` si l'adresse change.

Ce port n'est pas décoratif : les navigateurs n'exposent **WebGPU** — donc le simulateur Tidewater — qu'aux contextes sécurisés (`https:`, `localhost`, `127.0.0.1`). En HTTP simple sur l'IP du Pi, `navigator.gpu` est absent et le jeu répond « WebGPU is not available in this browser ». Repli sans certificat, par tunnel SSH :

```bash
ssh -L 8080:localhost:8080 bob@192.168.1.128   # puis http://localhost:8080
```

Le port 8080 reste servi à l'identique. Les deux écouteurs partagent la même instance d'application, car la liaison série, la vidéo et les superviseurs sont des singletons de processus qu'un second uvicorn ouvrirait deux fois.

### Matériel

- **Raspberry Pi 5** : héberge le service web et les périphériques V4L2.
- **ESP32-S3** : contrôleur de vol relié en série ; il porte les capteurs de pression et IMU, puis remonte leurs données au cockpit par le protocole série.
- **Caméras** : périphériques V4L2 configurables, relayés en MJPEG.
- **BOB BL AR** : head-tracker BLE HID basé sur ESP32-C6 et MPU-9250, exposé au navigateur comme `Gamepad`.

## Head-tracker BOB BL AR

Le tracker est volontairement indépendant de toute destination matérielle. Sa configuration se trouve dans **Paramètres → Manette → Head-tracker BOB BL AR**.

1. Cliquez sur `Définir le bouton magique`, puis appuyez sur le bouton choisi de la manette principale, par exemple L2.
2. Sur une action analogique de la table (par exemple *Roulis*), cliquez `Assigner tête`.
3. Maintenez le bouton magique : le cockpit envoie la tare, attend que le tracker se stabilise, puis capture automatiquement le premier axe qui bouge lorsque vous faites le geste de tête.

À chaque front montant du bouton d'engagement, le cockpit envoie au BOB BL AR un Output Report HID de tare. Il privilégie `vibrationActuator.playEffect('dual-rumble', ...)` lorsqu'il est exposé par le navigateur, puis bascule automatiquement vers WebHID si ce canal Gamepad n'est pas disponible.

Le repli WebHID écrit directement le Report ID `1` avec la charge utile `FF FF 64 00` : deux magnitudes non nulles et une durée de 100 ms little-endian. Cliquez une fois sur `Associer BOB BL AR (WebHID)` dans la carte Manette pour donner l'autorisation au navigateur ; les tares suivantes sont ensuite automatiques depuis le bouton magique.

> WebHID exige Chromium/Chrome récent dans un **contexte sécurisé** : `https://…` ou `http://localhost`. Une page ouverte par HTTP sur une adresse LAN ne peut pas demander cette autorisation : utilisez `https://<ip-du-pi>:8443` (voir « Accès HTTPS ») ou un tunnel SSH vers `http://localhost:8080`.

Sur Raspberry Pi OS/Linux, installez aussi la règle udev fournie puis reconnectez le BOB BL AR :

```bash
sudo install -m 0644 deploy/99-bob-bl-ar-hid.rules /etc/udev/rules.d/99-bob-bl-ar-hid.rules
sudo usermod -aG plugdev bob
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=hidraw
```

Fermez et rouvrez la session de l'utilisateur qui exécute Chromium après l'ajout au groupe. Un anti-rebond frontend de 250 ms complète celui du firmware. En pilotage, le maintien du bouton magique active uniquement les gestes déjà capturés ; chaque axe routé expose une consigne normalisée entre `-1.0` et `+1.0`, sans imposer de caméra, pan/tilt ou voie matérielle. La consigne est publiée dans `window.BOBROV_HEAD_TRACKER_INPUT` et via l'événement `bobrov:head-tracker-input`.

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
static/              SPA cockpit, HUD Canvas et simulateur Tidewater
tests/               Tests automatisés Python
deploy/              Unité systemd, règle udev WebHID et script de certificat TLS
videos/.gitkeep      Répertoire de médias local, vide dans Git
logs/.gitkeep        Répertoire de logs local, vide dans Git
run.sh               Lance Uvicorn depuis l'environnement virtuel
requirements.txt     Dépendances Python
```

## Données locales exclues de Git

Les environnements virtuels, caches Python, configurations d'installation, journaux et médias enregistrés sont exclus par `.gitignore`. Ne publiez pas `config.json`, les captures de caméra ni les enregistrements WebM produits en opération.
