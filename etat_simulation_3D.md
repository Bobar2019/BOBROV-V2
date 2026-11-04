# État technique — simulateur 3D BOBROV-V2

> Document de contexte destiné à une autre IA. Il décrit **l'existant au 4 novembre 2026**, relevé par lecture du code (branche `chantier-v3`, commit `7523291`). Aucun fichier source n'a été modifié pour le produire.
>
> **À lire avant tout :** le simulateur n'est **pas** un projet Three.js. Le moteur est écrit maison, en **WebGPU / WGSL**, avec une API de mathématiques et de graphe de scène *compatible* three.js (`import * as THREE from '../engine/index.js'`). Le sous-simulateur Three.js historique (`static/sim/`) a été supprimé du dépôt. Le véhicule piloté est un **ROV**, pas le bateau de la démo d'origine.

---

## 1. Branche et versionnement

| Élément | Valeur |
|---|---|
| Branche active | `chantier-v3` |
| Suivi distant | `origin/chantier-v3` (à jour, arbre de travail propre) |
| Dernier commit | `7523291` — 2026-11-04 13:05 +0100 — « Simulateur Tidewater WebGPU, télémétrie réelle et rapports de bug » (392 fichiers, +77 857 / −70 502) |
| Dépôt distant | `git@github.com:Bobar2019/BOBROV-V2.git` |
| Autres branches distantes | `main` (`52faf81`), `Sub-Simulator_VISU3DV3_SURF3` (`9b020f4`) |

Le même dépôt git vit sur le Pi (`~/BOBROV-V2`, `bob@192.168.1.128`) et sur le Mac de développement ; la copie miroir est entretenue par `./sync.sh pull|push|status` (rsync). `config.json` et `deploy/tls/` sont **hors dépôt** (gitignore) : ce sont des données propres à chaque installation.

---

## 2. Architecture serveur

### Processus

- Entrée : `app/serve.py` (`python -m app.serve`), lancé par `run.sh` (qui exige `.venv/`), lui-même unité systemd `deploy/bob-rov.service` (`ExecStart=/home/bob/BOBROV-V2/run.sh`, `Restart=always`, `TimeoutStopSec=15`).
- Uvicorn sur **une seule instance FastAPI partagée** (`app/main.py : app`) par deux écouteurs ; la liaison série, la vidéo et les superviseurs sont des singletons de processus.
  - **HTTP** : `host`/`port` lus dans `config.json → network` (valeurs actuelles : `0.0.0.0`, `8080`), avec le `lifespan` (amorçage).
  - **HTTPS** : port `8443` (`BOBROV_TLS_PORT`), ouvert **seulement** si `deploy/tls/cert.pem` et `deploy/tls/key.pem` existent (`deploy/gen-cert.sh`), sans lifespan. Certificat auto-signé.
  - Raison du HTTPS : WebGPU n'est exposé qu'aux contextes sécurisés. Alternative documentée dans le cockpit : tunnel `ssh -L 8080:localhost:8080 bob@192.168.1.128` (`SIM_SSH_CMD` dans `static/app.js`).

### Routes

Routers inclus dans `app/main.py` : `api_system` (`/api/system/…`), `api_config` (`/api/config`), `api_rov`, `api_bugs` (`/api/bugs`), puis les routers vidéo, médiathèque, stéréo 3D et réseau.

Montages statiques, dans cet ordre (les routes `/api/…` restent prioritaires) :

1. `/Rapport_bug` → `Rapport_bug/` (`html=True`) ; le sous-dossier `data/` est refusé (404) par le montage `RapportBugStaticFiles`.
2. `/` → `static/` (`NoCacheStaticFiles`, `html=True`), avec `Cache-Control: no-cache` sur les 200 : revalidation obligatoire, jamais d'écran figé.

Conséquence directe : **le simulateur est servi par le montage statique**, à l'adresse `/sim_tidewater/index.html` (et `/sim_tidewater/`), par exemple :

- `http://192.168.1.128:8080/sim_tidewater/index.html`
- `https://192.168.1.128:8443/sim_tidewater/index.html` (contexte sécurisé, WebGPU disponible)

Le cockpit est servi à la racine (`static/index.html`) et charge le jeu **dans une iframe** (`SIM_URL = '/sim_tidewater/index.html'`, `#sim-frame`), à la demande, avec rechargement forcé par `?t=<timestamp>`, plein écran et contrôle de compatibilité (`navigator.gpu.requestAdapter` testé avant de lancer). Aucun module du jeu n'est importé par le SPA.

### Routes consommées par le simulateur

| Route | Usage dans le jeu | Détail |
|---|---|---|
| `GET /api/config` | `src/ui/RovTelemetry.js` et `src/net/RealTelemetry.js` | Mise en page du HUD (`cockpit.hud.elements`, `cockpit.overlay`) et sens des axes de la scène (`simulator.real.invert`). Relecture ≤ 1 fois/s, et à chaque retour à l'écran ; hors backend, valeurs de repli. |
| `POST /api/config` | `RealTelemetry.saveInvert()` | Patch partiel, fusion profonde. Valeur non booléenne → **422**. |
| `GET /api/system/telemetry` | `RealTelemetry._poll()` | Trame 0x02 décodée : `{live, telemetry:{quat, age_s, …}}`. `live` = trame de moins de 1,5 s côté API. |

Il n'existe **aucune route dédiée aux assets 3D** : l'ancienne `app/routers/api_sim_assets.py` (`/api/sim/assets`, upload GLB) a été supprimée au commit courant. Les `.glb` sont servis tels quels par le montage statique.

---

## 3. Structure des fichiers 3D

### Page, styles, code

```
static/sim_tidewater/
├── index.html                    page d'entrée (charge ./src/main.js, ui.css, telemetry.css, loader, keyart)
├── ui/keyart.jpg, keyart-720.jpg images de chargement
├── src/
│   ├── main.js                   bootstrap : UI + App, loader, overlay de départ, ?bench
│   ├── App.js                    orchestration : init de la scène, boucle _frame(), ROV, caméras, touches
│   ├── core/                     Input, Engine, SceneRenderer, Bench, Profiler, Globals, CDLOD, DebugViews
│   ├── engine/                   moteur maison : gpu/ (GPU, Compute, Shader, Texture, Uniforms), math/,
│   │                             scene/, geometry/, loaders/GLTFLoader.js, constants.js
│   ├── player/                   RovController.js, RovCameras.js, Player.js (marcheur/nageur), FlyCamera.js
│   ├── world/                    RovModel.js, Terrain*, Reef/, Vegetation/, Village/, wildlife/, marine/, Fish, …
│   ├── ocean/                    OceanFFT, WaterSurface, WaterMaterial, WaterQuery, ShoreWaves, ShoreSim,
│   │                             SurfFoam, Caustics, Breakers, SeaDetail, RefractionPass, UnderwaterLighting
│   ├── sky/, post/, materials/   ciel/atmosphère, PostFX/GTAO/MotionBlur/TemporalUpscale/Underwater, matériaux
│   ├── fx/                       Spray.js, MarineSnow.js, AirMotes.js
│   ├── ui/                       ui.css, telemetry.css, UI.js (panneau/rail/aide), AppUI.js (onglets),
│   │                             RovTelemetry.js (HUD embarqué), telemetryDraw.js (peintres), RovMenu.js (clic droit)
│   ├── net/                      RealTelemetry.js (télémétrie du ROV réel)
│   ├── audio/, util/
├── models/                       modèles 3D du jeu (servis sous /sim_tidewater/models/)
├── textures/, clouds/, audio/
├── LICENSE, CREDITS.md           licences et crédits tiers
```

Ancien emplacement supprimé : `static/sim/` (simulateur Three.js : `sim.js`, `sim-view.js`, `vendor/three.module.js`, `assets/models/*.glb`). Ne plus s'y référer.

### Modèles `.glb`

**Modèles réellement chargés par le véhicule** (`src/world/RovModel.js`, base = `document.baseURI + 'models/'`, donc `/sim_tidewater/models/`) :

| Fichier | Taille | Rôle |
|---|---|---|
| `static/sim_tidewater/models/bob_rov_3D.glb` | 1,8 Mo | Châssis work-class (export Onshape), échelle ×3 → ~1,3 m de long |
| `static/sim_tidewater/models/projecteur.glb` | 260 Ko | Deux têtes de projecteur montées sur l'avant du châssis |

**Autres modèles du jeu** : `static/sim_tidewater/models/props/`, `characters/` (`joe.glb`, `marta.glb`), `debris/` (bois flotté photoscanné, lambis…), `whale/` (baleine + textures).

**Bibliothèque à la racine du dépôt** — `models/` (`bob_rov_3D.glb`, `projecteur.glb`, `surface2.jpg`, `scene/*.glb` : guppy, thon, tortue, esturgeon, baleine bleue, épave, herbier, néon) — contient des copies **identiques** (md5 vérifié pour le ROV et le projecteur) mais **n'est servie par aucune route** actuellement : vestige de l'ancienne API de bibliothèque/upload. Ne pas la supposer accessible en HTTP.

---

## 4. Moteur 3D et logique

### Moteur

- **WebGPU**, singleton `GPU` (`src/engine/gpu/GPU.js`) : `navigator.gpu.requestAdapter({powerPreference:'high-performance'})`, `canvas.getContext('webgpu')`, format de canevas préféré, un `GPUCommandEncoder` par image (`GPU.beginFrame()` / `GPU.submit()`).
- API compatible three.js : `src/engine/index.js` réexporte `math/`, `scene/`, `geometry/` et des constantes (`FrontSide`, `BackSide`…). Chargement glTF par `src/engine/loaders/GLTFLoader.js`.
- Rendu : `core/SceneRenderer.js` (rendu scène + masque d'eau + `CDLOD` pour la grille océan), post-traitement maison (`post/`), ombres (`engine/render/Shadows.js` + CSM).
- Aucun `importmap`, aucun `vendor/three.module.js`, aucune dépendance CDN JS. Si `navigator.gpu` manque, `GPU` lève « WebGPU is not available in this browser ».

### Modèle affiché

**Le ROV**, et lui seul comme véhicule pilotable.

- `RovModel.load()` charge `bob_rov_3D.glb` + `projecteur.glb`, fusionne les primitives (attributs/normales cuits dans le repère du groupe), puis **retire les groupes de montage** : le groupe `ROV` ne porte plus que les maillages fusionnés.
- Repère : le GLB est en repère CAO (+X coque, +Y haut, +Z travers) ; les nœuds sont tournés de −90° autour de Y pour retrouver le **repère véhicule** du moteur : **+Z avant, +Y haut, +X bâbord** (le même que l'ancien bateau).
- Ancrages : `eye = (0, box.max.y + 0,02, box.max.z − 0,24)` (caméra embarquée) ; `floatDraft = clamp(hauteur × 0,32 ; 0,05 … 0,30) m` ; `lampAnchors` (centres des deux optiques de `projecteur.glb`, relevés **avant** la fusion, en repère du groupe) ; `lightsOn` + `setLights(on)` (`lensMaterial.emissiveIntensity = 8|0` seulement — les faisceaux sont les spots décrits ci-dessous).
- **Le bateau d'origine a été retiré** : plus aucun maillage de coque, et le paysage sonore laisse ses sources « bateau » parquées (`boat: { active: false, rpm: 0, speed: 0, position: NO_BOAT_POS }`). Seuls subsistent le ponton, le village, la faune et les débris.

### Éclairage embarqué (projecteurs)

`projecteur.glb` sort du **même assemblage Onshape** que le châssis : il est déjà géométriquement aligné, aucune rotation à appliquer au maillage. Ce qui manquait, c'était la lumière dynamique (les lentilles seules étaient émissives, sans rien éclairer).

- **`SpotLight` maison** (`materials/LocalLights.js`) : le moteur WebGPU n'a aucune classe `THREE.SpotLight` / `PointLight`. La classe `SpotLight` de `LocalLights.js` en reprend l'API (`position`, `target`, `intensity`, `distance`, `angle`, `penumbra`, `switchTo()`), et le pool CPU la convertit à chaque frame en slot d'uniforme (`pos`/`col`/`dir`) que lit le hook WGSL `hookLocalLights()`.
- **Ancrage** : une source par entrée de `model.lampAnchors` (les deux optiques), montée par `spot.mount(rovGroup, ancre, cible)` ; la cible est l'ancre translatée de **+60 m sur l'axe +Z local** (avant du ROV). Le faisceau suit donc le cap et le tangage, sans toucher au mesh.
- **Réglages** (`PROJECTOR`) : `angle = Math.PI / 6` (demi-angle façon three.js → cône de 60°, `cosOuter ≈ 0,866`), `penumbra = 0,4` (`cosInner = cos 18°`), `intensity = 150`, `distance = 60 m`, couleur `0xdfeaff`.
- **Allumage** : `switchTo(() => model.lightsOn)` — les spots suivent exactement la touche `L` / le bouton `sim_light` qui commande `setLights()`.
- **Priorité dans le pool** : les sources `nightOnly = false` (les projecteurs) sont packées **en premier**, à pleine puissance, de jour comme de nuit ; les lampes du village (verrou nocturne `G.night`) ne prennent que les slots restants et subissent un `smooth()` de coupure pour ne pas apparaître d'un coup.
- **Réception sur le terrain** : `MeshShader` injecte `hookModules()` dans tout matériau éclairé et le terrain (`Terrain.js`, `standard()` + `TERRAIN_SURFACE`) passe par `shadeSurface()` → `hookLocalLights()` : le faisceau s'imprime physiquement sur le fond (profil Lambert en `LOCAL_LIGHTS_CHEAP`), puis l'absorption de l'eau le rougit/éteint (le rouge disparaît en ~5 m, d'où une tache bleu-vert en profondeur).
- **Contrôle mesuré** (scène gelée, paires off/on sur le même fond) : de jour **+1,0 %** de luminance moyenne, écart max **+142** ; de nuit **+13,6 %**, **8,9 %** des pixels éclaircis, maximum pile dans l'axe du cône — le spot se lit comme une tache sur le sable, plus seulement comme des lentilles brillantes.

### Physique du ROV (cinématique)

`src/player/RovController.js` — pas de corps rigide : le ROV est quasi neutre, les propulseurs écrivent directement la pose (`group.position` / `group.quaternion`, Euler `'YXZ'`).

- Paramètres : `maxSpeed = 2,6 m/s`, `diveSpeed = 1,1 m/s`, `turnRate = 0,9 rad/s`, `maxDepth = 40 m`.
- Entrées lissées : manette de poussée/lacet `1 − e^(−6·dt)`, vertical `1 − e^(−4·dt)` ; la vitesse converge vers la consigne à `1,7 s⁻¹` (inertie/traînée) ; autorité de barre `0,35 + 0,65·clamp(|throttle| + 0,35, 0, 1)`.
- **Profondeur** : `depth` intégrée par la poussée verticale (`depth -= vertical · diveSpeed · dt`) quand le pilote est aux commandes ; **relâché, le ROV remonte seul à 0,6 m/s** et `depth` est bornée à `[0, min(maxDepth, floor)]` avec `floor = max(0, waterH − ground − draft − 0,35)` (garde le châssis au-dessus du fond).
- **Tenue de surface (verrouillage)** : la hauteur d'eau sous le ROV vient d'une requête GPU (`WaterQuery`, slot `'rov'`, un point sous la coque), donc bruitée et rafraîchie par paquets. Elle est lissée par un **ressort critique ω = 7 rad/s** (`surface`, `surfaceVel`), avec recollage immédiat si l'écart dépasse 1,5 m (téléportation). `meanLevel` suit le niveau moyen de la mer (constante de temps 0,6 s⁻¹ à flot, 0,1 s⁻¹ plongé : une coque plongée est une plateforme stable).
- **Effacement de la houle** : `ride = clamp(1 − depth / 0,5, 0, 1)` → la houle porte le ROV à flot et disparaît dans les 50 premiers centimètres de plongée. `level = meanLevel + (surface − meanLevel)·ride`, puis `position.y = level − floatDraft − depth`. `level` est exposé aux instruments embarqués.
- **Assiette** : tangage `−vertical·10° + vitesse·0,6°`, roulis `−steer·6°`, lissés à 2,5 s⁻¹ (nez piqueur à la descente, gîte dans le virage).
- **Pose externe (ROV réel)** : `setExternalAttitude(attitude|null)` ; le mélange passe par `_extWeight` (rampe 5 s⁻¹). Au premier handover le cap est aligné sur celui de la télémétrie (`_yawOffset = π`, décalage du compas du simulateur), ensuite il est suivi en delta pour ne pas défaire un virage fait aux touches. La reprise par le clavier est décidée **côté télémétrie** : à plat (< 5° de roulis/tangage) et immobile (< 2°/s) pendant 0,5 s.

### Sillage

**Il n'y a pas de sillage dynamique aujourd'hui.** `WaterSurface.wake` reste `null` en permanence (aucune affectation dans tout le dépôt) : les branches WGSL `wakeDisplacement()` / `wakeFragment()` existent dans `ocean/WaterSurface.js` et `ocean/WaterQuery.js`, mais sont compilées hors du shader tant qu'aucun producteur de sillage n'est branché. Aucun module `WakeSim` n'existe.

Ce qui tourne réellement sur l'eau : `OceanFFT` (houle spectrale), `ShoreWaves` (déferlantes près du rivage), `ShoreSim` (humidité du sable, écume), `SurfFoam`, `Caustics`, `SeaDetail`, réfraction, éclairage sous-marin. `fx/Spray.js` est instancié mais n'est plus alimenté que par la faune (`reef.setSpray`) : plus d'embruns de proue, le bateau étant retiré.

---

## 5. Caméras et UI

### Caméras

| Caméra | Implémentation | Accès |
|---|---|---|
| **Caméra Libre** (défaut à bord) | `FlyCamera`, vol libre autour de la coque ; pose d'entrée `RovCameras.freePose()` : 4,2 m devant, +1,15 m, cadrée sur le ROV | `F`, menu contextuel, `?fly` au chargement |
| **Caméra Interne** (FPV) | `RovCameras` mode `'internal'` : position = `model.eye` appliqué à `group.matrixWorld`, orientation = quaternion du châssis × rotation π (la caméra regarde −Z) ; visée souris ±2,1 rad en lacet, −1,0…+0,9 rad en tangage, recentrage doux (0,6 s⁻¹) quand la souris dort | `F`, menu « Plonger (Vue Interne) » |
| **Caméra de suivi** (Chase Cam) | `RovCameras` mode `'chase'`. À l'activation l'offset local de l'œil est latché — `inverse(group.matrixWorld) × camera.matrixWorld`, donc la pose que la caméra libre occupait à cet instant, vue dans les axes du châssis — puis chaque frame `group.matrixWorld × offset` : ni amorti ni retard, un boulon et pas un ressort. Roulis, tangage et houle du cadre passent donc tels quels dans la vue | bouton `sim_cam_chase` de la manette (second appui = Caméra Libre) |
| **Marcheur / nageur** | `Player.js`, première personne : capsule sur terrain et colliders, nage quand la profondeur dépasse 1,35 m, retour debout à 1,1 m | état par défaut hors ROV ; `E` près du ROV pour embarquer |
| **Caméra libre hors ROV** | `FlyCamera` puis retour au marcheur à la position de la caméra (`dropPlayerAtCamera`) | `F` |

La caméra du moteur n'est jamais re-parentée : les rigs écrivent directement sa pose (les requêtes d'eau et la chaîne de post-traitement lisent sa position monde).

Seule la caméra de suivi est **solidaire** : elle prend la pose du châssis sans filtrage. C'est aussi la seule vue hors caméra interne où le pilotage reste au ROV — entrer en `'chase'` remet `freeCam` à `false`, donc `App._frame()` repasse par `_readRovInput()` et `rovCtl.update()` (touches `W`/`A`/`S`/`D`/`Space`/`C` et bloc `input.gamepad`). Le latch est pris sur la pose de la caméra libre, que `FlyCamera.setPose()` écrit de façon synchrone : l'appui depuis le ponton comme depuis la caméra interne part donc de la même prise de vue `freePose()` (4,2 m devant, +1,15 m, cadrée sur le ROV).

**Mode photo** (`P`) : géré par `UI.setPhotoMode()`, il masque le chrome de l'interface. `onPhotoMode` n'est branché sur rien : aucun changement de caméra, de focale ou de post-traitement.

### HUD / télémétrie

- `src/ui/RovTelemetry.js` construit l'overlay (`#hud-layer` > `[data-hud]` > canvas) avec **le balisage et les feuilles du cockpit** (`telemetry.css` reprend `style.css`) ; les peintres sont partagés avec le cockpit : `src/ui/telemetryDraw.js` (`DRAW[id](ctx, style, w, h, frame)`).
- Neuf instruments (`HUD_ORDER`) : `horizon`, `heading`, `depth`, `temperature`, `gauges`, `grip`, `voltage`, `motor_v`, `motor_h`. `arm_mode` et `aux` ne sont pas dessinés (aucun état équivalent à bord).
- **Visibilité** : uniquement en **Caméra Interne** (`AppUI.update()` → `ui.setTelemetry({visible: internal})`) ; masqué hors ROV ou en caméra libre.
- **Mise en page** : lue dans `config.json` (`cockpit.hud.elements` : x, y, w, h, opacity, color, weight, font, max ; `cockpit.overlay[ id ] === false` masque l'instrument), avec `DEFAULT_LAYOUT` en repli (le ruban de cap y est une encoche plus bas que dans le cockpit : les notifications occupent le haut de l'écran). Les dégagements (rail de réglages, bloc d'état) passent par `data-right` / `data-top`.
- **Valeurs** : profondeur = niveau − tirant d'eau − Y du maillage ; tangage/roulis/cap relus dans le quaternion de la pose (ordre `'YXZ'`, tangage retourné vers la convention « nez haut ») ; cap dans le repère du compas du simulateur ; PWM, tensions, température et pince sont **déduits des commandes** (pas de capteurs sur le châssis d'essai).
- Badge de liaison en haut d'écran (`ui.setLink({state, driving, ageS})`) : « Directe » / « Perdue » / « Hors ligne », et qui tient la pose (télémétrie, clavier à plat, simulée).

**HUD du simulateur** (hors cockpit, `src/ui/UI.js`) — bas-gauche et bord gauche, libellés en anglais comme le reste de cette couche :

- **Caméra Libre et Caméra de suivi** (à bord) : un seul bloc `.tw-boat` = barre de poussée, compas, et la **lecture d'altitude/profondeur** (`.tw-alt`) qui a remplacé la jauge « knots / rpm % » (arc SVG, aiguille et libellés supprimés avec elle). Sous la surface le pavé passe en `.is-deep` et prend la teinte de l'eau. « À bord » s'entend ici `rovCams.mode !== 'internal'` : le mode suivi garde le bloc complet, et son titre d'état s'écrit « ROV · Caméra de suivi ».
- **Caméra libre hors ROV** : le même bloc, réduit à la seule lecture (`.is-solo` masque la poussée et le compas ; il n'y a plus de jauge de vitesse du tout).
- Valeur : distance verticale entre la **caméra** et la surface (`app.cameraWaterHeight`, lue sur GPU à la position de l'œil), **lissée à 6 s⁻¹ pour l'affichage seulement** (le read-back saute de quelques centimètres) ; `altitude = |y − surface|`, `deep = y < surface` → « Altitude » dans l'air, « Depth » sous l'eau. Ce n'est pas la profondeur du ROV : celle-ci reste la sonde `.tw-depth` à gauche, alimentée par `rovCtl.depth`.
- **Pas de `backdrop-filter` sur ce bloc** : il porte bien `tw-glass` pour le fond, la bordure et l'ombre, mais `.tw-boat` neutralise le flou et remonte son fond à 82 % d'opacité. Un `backdrop-filter` posé sur la vue 3D oblige le compositeur à relire le canvas sous le panneau **à chaque frame**, et ce coût suit la surface floutée : les petites pastilles du HUD (`.tw-stats`, `.tw-mode`) passent inaperçues, ce panneau-ci non — sur le Pi il valait la moitié du frame rate (78 → 24 fps dès qu'il est apparu en « Free camera »).

### Menu contextuel (clic droit)

`src/ui/RovMenu.js`.

- `contextmenu` capturé sur `window` (phase capture) ; le menu natif est déjà neutralisé par `Input` sur le canvas.
- Sélection par `Raycaster` du moteur, **exact au triangle**, contre `rov.model.group` (NDC calculés depuis `getBoundingClientRect`, donc indépendants du zoom CSS). Pas de touche → le menu se ferme.
- Panneau HTML positionné au curseur, en-tête « ROV · bob_rov_3D », entrées :

| Entrée | Raccourci | Effet |
|---|---|---|
| Plonger (Vue Interne) | `C` | `setRovCamera('internal')` (embarque si nécessaire) |
| Caméra Libre | `F` | `setRovCamera('free')` |
| Sortir du ROV | `E` | affiché seulement si le ROV est piloté |
| Projecteurs : on / off | `L` | `toggleRovLights()` |

- Fermeture : clic hors menu (`pointerdown`) ou `Échap`.

### Autres éléments d'interface

- Rail droit + panneau de réglages (`H`) : onglets **Ocean, Shore, Sky, Camera, Effects, Performance** ; dossier **« ROV réel »** dans Camera (« Suivre le ROV réel », Liaison, Dernière trame, Commande, et les trois interrupteurs « Inverser le roulis / le tangage / le cap » persistés dans `simulator.real.invert`).
- `F1` (ou `?`) : feuille des contrôles ; `Échap` ferme menu/aide ; `T` heure du jour ; `M` son ; `P` mode photo ; loader avec vignette `keyart` et pourcentage.

---

## 6. Contrôles

### Clavier / souris (simulateur)

Lecture des touches : `src/core/Input.js` (Set de `code`, `hit()` = une fois par appui, pointer lock, `contextmenu` neutralisé), consommation dans `App._frame()` et `App._readRovInput()`.

| Touche | Effet |
|---|---|
| `W` / `S` | poussée avant (0,7) / arrière (−0,7) ; `Shift` + `W` = pleine poussée (1,0) |
| `A` / `D` | lacet bâbord / tribord |
| `C` ou `Ctrl` (gauche/droit) | **plonger** (poussée verticale négative) |
| `Space` | **remonter** (poussée verticale positive) |
| `E` | embarquer (à portée du ROV) / sortir du ROV |
| `F` | basculer Caméra Libre ↔ Caméra Interne (hors ROV : caméra libre ↔ marcheur) |
| `L` | **projecteurs du ROV** (à bord) ; lampe torche du pilote (à pied) — le bouton `sim_light` fait la même chose depuis n'importe quelle caméra |
| `H` | panneau de réglages ; `F1`/`?` aide ; `P` mode photo ; `Échap` fermer |
| `T` | heure du jour ; `M` son on/off |
| Souris | clic = capture du pointeur ; visée (pointer lock ou bouton maintenu) ; molette cumulée dans `Input.wheel` |

À pied, le marcheur/nageur reprend les mêmes touches de plongée (`C`, `Space`) et `W` pour nager ; regarder vers le bas + `W` fait plonger.

La manette est lue par deux blocs distincts de `config.json` (voir ci-dessous) ; `F1`/`?` affiche la ligne correspondante dans l'aide du jeu.

### Manette

Depuis `chantier-v3.6`, le simulateur lit **deux blocs indépendants** de `config.json`, tous deux servis par `GET /api/config` :

| Bloc | Ce qu'il commande | Édité dans |
|---|---|---|
| `input.gamepad` | le maillage du ROV : poussée, lacet, plongée/remontée | Paramètres › Manette, cadre « Fonctions des manettes » |
| `input.sim_gamepad` | la scène 3D : vol libre de la caméra, vues, projecteurs | Paramètres › Manette, cadre « Contrôle Simulateur 3D » |

`src/core/Input.js` tient donc deux jeux de lecture (`this.pad`, `this.simPad`) bâtis par la même fabrique : mêmes `sources` `{type: 'axis'|'button', index, invert, pad?}`, mêmes filtres (la clé `pad` est comparée au `Gamepad.id`, le BOB BL AR est écarté via `input.head_tracker.device_id`), même courbe (`input.deadzone` 0,08 puis `input.expo` 1,5, seuil « poussé » 0,7). `pollPads()` les remplit tous les deux une fois par frame (rappel de `/api/config` toutes les 3 s tant qu'il n'a pas répondu) ; `padCommand()` / `padHit()` ne lisent que le bloc cockpit, `simCommand()` / `simHit()` que le bloc simulateur. `endFrame()` vide les fronts montants des deux. Les six voies historiques sont traduites à l'identique : `voie1` = surge, `voie2` = sway, `voie3` = heave, `voie4` = yaw, `voie5` = roll, `voie6` = pitch.

Côté ROV (`App._readRovInput()`) : `surge` → poussée avant/arrière, `yaw` (ou `yaw_left`/`yaw_right`) → lacet, `heave` (+ `surface` maintenu = pleine remontée) → plongée/remontée. `sway`, `roll` et `pitch` sont lus mais sans effet : `RovController` n'a ni commande latérale ni attitude directe. Priorité : la manette a le dernier mot sur un axe qu'elle dévie, le clavier garde les axes au repos ; signes des voies du ROV (surge + = avant, heave + = remonter, yaw + = tribord, le cadre comptant le lacet à l'inverse).

Côté scène (`FlyCamera.update()` et `App._frame`) : `surge` / `sway` / `heave` translatent la caméra libre dans son propre repère (comme `W` / `D` / `E`), `yaw` / `pitch` la visent à 1,6 rad/s pleine déflexion (le combo souris garde sa sensibilité de 0,0022 rad/pixel ; les deux se cumulent). Une touche reste à pleine vitesse, la somme touches + sticks ne dépasse jamais la vitesse pleine (8 m/s, ×6 avec `Shift`). Quatre boutons : `sim_cam_free` (comme `F`), `sim_view_internal` (embarque et passe à la caméra interne, comme le menu clic droit › Plonger), `sim_cam_chase` (`App.toggleChaseCam()` : latch de la vue courante sur le châssis, embarque si nécessaire, rend le pilotage au ROV ; un second appui rend la caméra libre), `sim_light` (projecteurs du ROV, depuis n'importe quelle caméra, là où `L` ne les allume qu'à bord).

Par défaut, `input.sim_gamepad` est **semé une seule fois** par `app/config.py` (`_seed_sim_gamepad`, appelée depuis `_migrate`) : les axes de déplacement du cockpit (`surge`, `sway`, `heave`, `yaw`, `pitch`) y sont recopiés avec leurs `invert` et leur clé `pad` ; `pitch` et les quatre commandes de vue restent vides, à assigner. Dès que le bloc existe dans le fichier il n'est plus réaligné : les deux cadres évoluent ensuite séparément, et `app/config.py` valide chacun avec les mêmes règles (`_validate_pad_block`).

Le simulateur ne réécrit jamais `config.json` : le mapping s'édite dans le cockpit (Paramètres › Manette) et la scène relit les blocs à son chargement — recharger l'onglet Simulateur après une modification.

---

## 7. Points à ne pas supposer (pièges pour la suite)

1. **Pas de Three.js** dans le simulateur : `THREE` est l'alias local de `src/engine/index.js` (WebGPU). Les fichiers `static/sim/vendor/*` ont été supprimés.
2. **Le bateau n'existe plus** : le véhicule est le ROV (`bob_rov_3D.glb` + `projecteur.glb`), pilotable en cinématique.
3. **Pas de sillage** : `WaterSurface.wake` est null, les fonctions WGSL de wake sont dormantes ; tout ajout de sillage suppose d'écrire un producteur et de l'affecter.
4. **Les modèles de `models/` (racine) ne sont pas servis** : seul `static/` est monté. Les modèles du jeu vivent dans `static/sim_tidewater/models/`.
5. **Le simulateur ne lit dans `config.json` que** `cockpit.hud.*`, `simulator.real.invert`, `input.gamepad` (bloc du ROV) et `input.sim_gamepad` (bloc de la scène), avec `input.deadzone`, `input.expo` et `input.head_tracker.device_id` ; les autres blocs `simulator.*` (world, water, physics, life, scene) ne sont pas consommés par le code actuel.
6. **Deux réglages distincts du sens des axes** : `cockpit.hud.invert` (HUD du cockpit sur la vidéo) et `simulator.real.invert` (pose de la scène 3D, interrupteurs « ROV réel »). Ils sont volontairement découplés.
7. **WebGPU = contexte sécurisé** : en HTTP distant le jeu ne démarre pas ; utiliser `https://<pi>:8443` ou un tunnel SSH.
8. **`config.json` est hors dépôt** : ne pas le réécrire depuis un fichier local périmé (un `sync.sh push` l'envoie tel quel et écraserait les réglages du pilote).
9. **Pas de `THREE.Light`** : l'éclairage local passe par le pool de 8 sources de `materials/LocalLights.js` (`SceneLighting.set('localLights', …)`), et non par des objets `Light` three.js. Ajouter une lumière = ajouter une entrée au pool, pas un nœud à la scène ; au-delà de 8 sources, les moins prioritaires n'ont pas de slot cette frame.
