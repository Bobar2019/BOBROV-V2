/**
 * BOBROV-V2 — Sub Simulator immersif · point d'entrée du module isolé.
 *
 * Principe d'isolation : tout le module vit sous /sim/ (aucune ligne
 * modifiée dans app.js, app/*.py ni style.css). Le seul contact avec
 * l'existant est : (1) les lignes additives d'index.html (importmap +
 * module), (2) la lecture Gamepad API + GET /api/config, (3) le bouton
 * « Réglages » qui déclenche un clic programmatique sur le bouton existant
 * #btn-sim-open-config (navigation app.js inchangée).
 *
 * Écran type cockpit : barre de commandes (badges + actions), scène 3D
 * plein cadre en vue FPV (caméra avant du ROV) avec tag de flux
 * « CAM AV · VIRTUELLE », instruments incrustés (sim-view.js), PIP extérieur
 * optionnel. La physique 6 axes à pas fixe 1/240 s reste la source de
 * vérité ; env-scene.js ne fait que la représenter.
 */

import { SimPhysics, FIXED_DT_S, MAX_SUBSTEPS } from './sim-physics.js';
import { SimInput, KEYBOARD_HELP, formatPadId } from './sim-input.js';
import { SimView } from './sim-view.js';
import { MOTORS } from './sim-mix.js';
import { resolveSimulatorSettings } from './env/env-defaults.js';
// Panneau Paramètres → Sub Simu : import d'effet de bord, le module
// s'auto-initialise sur #section-sim-config (aucun import Three.js, la
// page reste fonctionnelle sans le vendor).
import './sim-config-ui.js';

const SECTION_ID = 'section-simulator';
const RENDER_MS_30 = 33;        // rendu de la scène à ~30 im/s
const RENDER_MS_60 = 16;        // option 60 im/s (page de configuration)
const IDLE_RENDER_MS = 400;     // animation au ralenti quand la simulation est en pause

// --------------------------------------------------------------------- //
// Gabarit de l'écran                                                     //
// --------------------------------------------------------------------- //

const thrusterRows = () => MOTORS.map((motor, index) => `
    <div class="sim-thr-row">
        <span class="sim-thr-name" title="${motor.label}">M${motor.id}</span>
        <span class="sim-thr-track"><span class="sim-thr-fill" data-sim-thr-fill="${index}"></span></span>
        <span class="sim-thr-val" data-sim-thr-val="${index}">0 %</span>
    </div>`).join('');

const keyboardRows = () => KEYBOARD_HELP.map(([keys, label]) => `
    <li><kbd>${keys}</kbd><span>${label}</span></li>`).join('');

const chip = (key, id, value) => `
    <span class="sim-chip"><span class="sim-chip-key">${key}</span><b id="${id}">${value}</b></span>`;

const TEMPLATE = `
<div class="sim-toolbar">
    <div class="sim-badges" role="status" aria-live="polite">
        <span id="sim-badge-run" class="badge sim-badge-off">EN PAUSE</span>
        <span id="sim-badge-arm" class="badge sim-badge-off">DÉSARMÉ</span>
        <span id="sim-badge-dry" class="badge sim-badge-warn">DRY-RUN</span>
        <span id="sim-badge-wd" class="badge sim-badge-danger" hidden>WATCHDOG · LIAISON PERDUE</span>
        <span id="sim-badge-sat" class="badge sim-badge-warn" hidden>MIXAGE SATURÉ</span>
        <span id="sim-badge-pad" class="badge sim-badge-off">MANETTE NON DÉTECTÉE</span>
    </div>
    <div class="sim-actions">
        <button id="sim-btn-run" class="btn btn-primary" type="button">Démarrer</button>
        <button id="sim-btn-reset" class="btn btn-ghost" type="button">RAZ</button>
        <button id="sim-btn-light" class="btn btn-ghost" type="button" aria-pressed="false">Lumière</button>
        <button id="sim-btn-config" class="btn btn-ghost" type="button">Réglages</button>
        <button id="sim-btn-full" class="btn btn-ghost" type="button">Plein écran</button>
        <button id="sim-btn-tests" class="btn btn-ghost" type="button">Tests</button>
    </div>
</div>
<div class="sim-stage" id="sim-stage">
    <div class="sim-scene-wrap" id="sim-scene-wrap">
        <div class="sim-canvas-holder" id="sim-canvas-holder"></div>
        <div class="sim-boot" id="sim-boot">
            <div class="sim-boot-inner">
                <div class="sim-boot-spinner"></div>
                <p id="sim-boot-text">Préparation du simulateur…</p>
            </div>
        </div>
        <span class="sim-feed-tag">CAM AV · VIRTUELLE</span>
        <div class="sim-hold" id="sim-hold" hidden>
            <span id="sim-hold-text"></span>
            <button class="btn btn-primary" id="sim-hold-action" type="button">Activer les sorties</button>
        </div>
        <div class="sim-hud" aria-hidden="true">
            <div class="sim-hud-el sim-hud-heading"><canvas id="sim-hud-heading"></canvas></div>
            <div class="sim-hud-el sim-hud-horizon"><canvas id="sim-hud-horizon"></canvas></div>
            <div class="sim-hud-el sim-hud-depth"><canvas id="sim-hud-depth-tape"></canvas></div>
            <div class="sim-hud-el sim-hud-gauges">
                <div class="sim-thr-grid">${thrusterRows()}</div>
            </div>
            <div class="sim-hud-el sim-hud-status">
                ${chip('T', 'sim-val-time', '00:00')}
                ${chip('im/s', 'sim-val-fps', '—')}
                ${chip('Cap', 'sim-val-heading', '—')}
                ${chip('R/T', 'sim-val-rp', '—')}
                ${chip('Batt', 'sim-val-voltage', '—')}
                ${chip('SOC', 'sim-val-soc', '—')}
                ${chip('A hor', 'sim-val-current-h', '—')}
                ${chip('A vert', 'sim-val-current-v', '—')}
            </div>
            <div class="sim-hud-el sim-hud-map"><canvas id="sim-map"></canvas></div>
        </div>
        <div class="sim-pip-frame" id="sim-pip-frame" hidden>
            <span class="sim-feed-tag sim-feed-tag-pip">CAM EXT · SUIVI ROV</span>
        </div>
    </div>
</div>
<details class="sim-help">
    <summary>Aide clavier & manette</summary>
    <div class="sim-help-grid">
        <div>
            <h4>Clavier</h4>
            <ul class="sim-help-list">${keyboardRows()}</ul>
        </div>
        <div>
            <h4>Manette</h4>
            <ul class="sim-help-plain">
                <li>Stick gauche : lacet (X) · avance (Y)</li>
                <li>Stick droit : translation (X) · montée (Y)</li>
                <li>△ armer · ○ dry-run · □ lumières · Options : E-Stop · Share : RAZ · Croix (maintenue) : retour surface</li>
                <li>Gâchettes L2 / R2 : roulis · croix haut/bas : tangage</li>
                <li>Pilotage : Démarrer, couper le dry-run puis armer — sinon les sorties restent coupées</li>
                <li>Manette non standard : Paramètres → Manette → Voie 1 avance · 2 translation · 3 montée · 4 lacet · 5 roulis · 6 tangage</li>
            </ul>
        </div>
    </div>
    <p class="hint" id="sim-input-info">Zone morte et courbe des axes : valeurs du cockpit (lecture seule).</p>
</details>
<div id="sim-tests-panel" class="sim-tests" hidden></div>
`;

// --------------------------------------------------------------------- //
// Application                                                            //
// --------------------------------------------------------------------- //

class SimulatorApp {
    constructor(section) {
        this.section = section;
        this.physics = new SimPhysics();
        this.input = new SimInput();
        this.refs = this.mount(section);
        this.view = new SimView(this.viewRefs(this.refs));

        this.running = false;
        this.visible = false;
        this.lightOn = false;
        this.acc = 0;
        this.lastTs = 0;
        this.lastRender = 0;
        this.idleLast = 0;
        this.uiDt = 1 / 30;
        this.fps = 0;
        this.timeSec = 0;

        this.settings = null;
        this.sceneApi = null;
        this.terrainApi = null;
        this.sceneReady = false;

        this.loop = this.loop.bind(this);
        this.bind();
        this.observeVisibility();
        this.observeResize();
        this.renderNow();
        this.updateRunButton();
        this.updateLightButton();

        this.refreshInput().then(() => this.renderNow());

        this.initAsync();
        requestAnimationFrame(this.loop);
    }

    /** Masque les cartes « en construction » et installe l'écran du module. */
    mount(section) {
        for (const card of section.querySelectorAll(':scope > .card')) {
            card.style.display = 'none';
            card.setAttribute('data-sim-hidden', '1');
        }
        const subtitle = section.querySelector('.page-sub');
        if (subtitle) {
            subtitle.textContent = "Cockpit virtuel : immersion 3D à la place des caméras, monde 1 km × 1 km × 300 m, "
                + "physique 6 axes du firmware. Aucune donnée n'est envoyée au ROV ni enregistrée.";
        }
        const shell = document.createElement('div');
        shell.className = 'sim-shell';
        shell.innerHTML = TEMPLATE;
        section.appendChild(shell);
        const byId = (id) => shell.querySelector(`#${id}`);
        return {
            section,
            shell,
            stage: byId('sim-stage'),
            sceneWrap: byId('sim-scene-wrap'),
            holder: byId('sim-canvas-holder'),
            boot: byId('sim-boot'),
            bootText: byId('sim-boot-text'),
            pipFrame: byId('sim-pip-frame'),
            hold: byId('sim-hold'),
            holdText: byId('sim-hold-text'),
            holdAction: byId('sim-hold-action'),
            horizon: byId('sim-hud-horizon'),
            heading: byId('sim-hud-heading'),
            depthTape: byId('sim-hud-depth-tape'),
            map: byId('sim-map'),
            btnRun: byId('sim-btn-run'),
            btnReset: byId('sim-btn-reset'),
            btnLight: byId('sim-btn-light'),
            btnConfig: byId('sim-btn-config'),
            btnFull: byId('sim-btn-full'),
            btnTests: byId('sim-btn-tests'),
            testsPanel: byId('sim-tests-panel'),
            inputInfo: byId('sim-input-info'),
            dom: {
                valTime: byId('sim-val-time'),
                valFps: byId('sim-val-fps'),
                valHeading: byId('sim-val-heading'),
                valRollPitch: byId('sim-val-rp'),
                valVoltage: byId('sim-val-voltage'),
                valSoc: byId('sim-val-soc'),
                valCurrentH: byId('sim-val-current-h'),
                valCurrentV: byId('sim-val-current-v'),
                badges: {
                    run: byId('sim-badge-run'),
                    arm: byId('sim-badge-arm'),
                    dry: byId('sim-badge-dry'),
                    wd: byId('sim-badge-wd'),
                    saturation: byId('sim-badge-sat'),
                    pad: byId('sim-badge-pad'),
                },
                thrustRows: MOTORS.map((motor, index) => ({
                    fill: shell.querySelector(`[data-sim-thr-fill="${index}"]`),
                    valueEl: shell.querySelector(`[data-sim-thr-val="${index}"]`),
                })),
            },
        };
    }

    viewRefs(refs) {
        return {
            horizon: refs.horizon,
            heading: refs.heading,
            depthTape: refs.depthTape,
            minimap: refs.map,
            hold: refs.hold,
            holdText: refs.holdText,
            holdAction: refs.holdAction,
            dom: refs.dom,
        };
    }

    bind() {
        this.refs.btnRun.addEventListener('click', () => this.toggleRunning());
        this.refs.btnReset.addEventListener('click', () => this.resetSession());
        this.refs.btnLight.addEventListener('click', () => this.toggleLight());
        this.refs.btnConfig.addEventListener('click', () => this.openConfig());
        this.refs.btnFull.addEventListener('click', () => this.toggleFullscreen());
        this.refs.btnTests.addEventListener('click', () => this.toggleTests());
        // Bandeau « sorties coupées » : déblocage en un clic (dry-run → armement).
        this.refs.holdAction.addEventListener('click', () => this.fixOutputs());
        this._onFullscreenChange = () => this.onFullscreenChange();
        document.addEventListener('fullscreenchange', this._onFullscreenChange);
        // La page Paramètres → Sub Simu notifie ses enregistrements :
        // l'écran recharge et applique les réglages à chaud.
        this._onConfigSaved = () => this.refreshSettings();
        window.addEventListener('sim-config-saved', this._onConfigSaved);
    }

    observeVisibility() {
        this.observer = new IntersectionObserver((entries) => {
            let changed = false;
            for (const entry of entries) {
                if (entry.isIntersecting !== this.visible) changed = true;
                this.visible = entry.isIntersecting;
            }
            this.input.setActive(this.running && this.visible);
            if (changed && this.visible) {
                this.refreshSettings();
                this.resizeScene();
                this.renderNow();
            }
            if (!this.visible) this.input.resetTransients();
        }, { threshold: 0.05 });
        this.observer.observe(this.refs.section);
    }

    observeResize() {
        this.resizeObserver = new ResizeObserver(() => {
            this.resizeScene();
            this.renderNow();
        });
        this.resizeObserver.observe(this.refs.sceneWrap);
    }

    // -------------------------------------------------------------- //
    // Réglages (config.json → resolveSimulatorSettings)              //
    // -------------------------------------------------------------- //

    async loadSettings() {
        try {
            const response = await fetch('/api/config', { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const config = await response.json();
            return resolveSimulatorSettings(config && config.simulator ? config.simulator : null);
        } catch (error) {
            console.warn('[SubSim] réglages indisponibles, défauts appliqués :', error);
            return resolveSimulatorSettings(null);
        }
    }

    /** Recharge les réglages (retour sur l'écran après la page de configuration). */
    async refreshSettings() {
        this.refreshInput();   // le mapping manette a pu changer (Paramètres → Manette)
        const next = await this.loadSettings();
        if (!this.settings) {
            this.settings = next;
            return;
        }
        const key = (s) => JSON.stringify([s.world, s.water, s.led, s.cam, s.display, s.life, s.scene]);
        if (key(next) === key(this.settings)) return;
        const prev = this.settings;
        this.settings = next;
        this.lightOn = !!next.led.on;
        this.updateLightButton();
        this.refs.pipFrame.hidden = !next.cam.pip;
        if (JSON.stringify(next.physics) !== JSON.stringify(prev.physics)) {
            this.physics = new SimPhysics(next.physics);
            this.installPhysicsEnvironment();
            this.physics.reset(this.initialSpawn());
        }
        if (this.sceneReady && this.sceneApi) {
            try {
                await this.sceneApi.applySettings(next, prev);
            } catch (error) {
                console.error('[SubSim] application des réglages :', error);
            }
        }
        this.installPhysicsEnvironment();
    }

    /**
     * Relit les réglages manette du cockpit — zone morte, expo et fonctions
     * associées dans Paramètres → Manette (les deux manettes se cumulent,
     * le profil par défaut reste actif sur la première sans association) —
     * et rafraîchit le texte d'aide. À rappeler au retour sur l'écran :
     * les associations peuvent avoir changé.
     */
    async refreshInput() {
        const result = await this.input.loadConfig();
        this.configResult = result;
        const info = this.refs.inputInfo;
        if (info) {
            const mapped = this.input.assigned || 0;
            const src = this.input.source === 'cockpit'
                ? `manettes du cockpit (${mapped} fonction${mapped > 1 ? 's' : ''} assignée${mapped > 1 ? 's' : ''})`
                : 'mapping par défaut — assignez vos fonctions dans Paramètres → Manette';
            info.textContent = `Zone morte ${this.input.deadzone} · expo ${this.input.expo} · ${src}`
                + (result && result.ok ? '' : ' (config indisponible, valeurs par défaut)');
        }
        return result;
    }

    /**
     * Branche la physique sur le monde réel : murs du bassin et sonde de
     * terrain (plancher de pilotage = relief rendu + garde de coque).
     * La sonde lit l'état vivant d'env-terrain à chaque pas.
     */
    installPhysicsEnvironment() {
        if (!this.terrainApi) return;
        const bounds = this.terrainApi.worldBounds();
        this.physics.setEnvironment({
            wallLimit: bounds.wallLimit,
            floorDepthAt: (x, yN) => Math.max(0.3, -this.terrainApi.floorLimitAt(x, -yN)),
        });
    }

    /**
     * Pose de départ « en pleine lumière ».
     *
     * L'original démarrait à ~30 m dans un bassin de 30 m (visibilité 25 m),
     * toujours à portée de la lumière du jour. Ici le monde descend jusqu'à
     * 300 m : l'extinction solaire (exp(−(profondeur−récif)/visibilité)) rend
     * un départ à mi-profondeur noir (facteur ≈ 0,01 à 150 m). Le ROV part
     * donc au-dessus de la couronne de récif — fond peu profond, décor et
     * poissons visibles — avec 3 m de garde au-dessus du fond local.
     * @returns {{x:number, yN:number, depth:number}} conditions initiales
     */
    initialSpawn() {
        const world = this.settings ? this.settings.world : null;
        const cap = world ? Math.min(world.depth / 2, 12) : 0;
        const spawn = { x: 0, yN: 0, depth: cap };
        if (!world || !this.terrainApi) return spawn;   // avant initScene : centre + cap
        try {
            const ring = this.terrainApi.reefRingRadii();
            const radius = (ring.innerR + ring.outerR) / 2;
            const bounds = this.terrainApi.worldBounds();
            if (Number.isFinite(radius) && radius > 10 && radius < bounds.wallLimit) {
                const floorDepth = Math.max(0.3, -this.terrainApi.floorLimitAt(radius, 0));
                spawn.x = radius;
                spawn.depth = Math.min(cap, Math.max(1.2, floorDepth - 3));
            }
        } catch (error) {
            console.warn('[SubSim] spawn : calcul du récif indisponible :', error);
        }
        return spawn;
    }

    // -------------------------------------------------------------- //
    // Initialisation de la scène 3D                                  //
    // -------------------------------------------------------------- //

    async initAsync() {
        this.settings = await this.loadSettings();
        this.physics = new SimPhysics(this.settings.physics);
        this.physics.reset(this.initialSpawn());   // départ en zone éclairée (avant la 3D : centre + cap)
        this.lightOn = !!this.settings.led.on;
        this.updateLightButton();
        this.refs.pipFrame.hidden = !this.settings.cam.pip;
        this.renderNow();

        let api;
        try {
            [api, this.terrainApi] = await Promise.all([
                import('./env/env-scene.js'),
                import('./env/env-terrain.js'),
            ]);
        } catch (error) {
            console.warn('[SubSim] modules 3D indisponibles :', error);
            this.setBoot(
                'Three.js n’est pas encore installé.<br>'
                + 'Lancer une fois dans un terminal :<br>'
                + '<code>bash /home/bob/BOBROV-V2/static/sim/vendor/fetch_three.sh</code><br>'
                + 'puis recharger cette page (Ctrl+Shift+R).',
                'error',
            );
            return;
        }
        this.sceneApi = api;
        try {
            this.setBoot('Construction du monde 3D…');
            await api.initScene(this.refs.holder, this.settings);
            this.installPhysicsEnvironment();
            this.physics.reset(this.initialSpawn());   // terrain calibré : spawn réel au-dessus du récif
            this.setBoot('Chargement du décor (modèles GLB)…');
            await api.loadDecor(this.settings);
            this.sceneReady = true;
            this.refs.pipFrame.hidden = !this.settings.cam.pip;
            this.setBoot(null);
            this.resizeScene();
            this.renderNow();
        } catch (error) {
            console.error('[SubSim] échec d’initialisation de la scène :', error);
            this.setBoot(`Échec de la scène 3D : ${escapeHtml(String(error && error.message ? error.message : error))}`, 'error');
        }
    }

    /** Bandeau de démarrage (chargement) ou d'erreur (contenu interne sûr). */
    setBoot(text, kind = 'load') {
        const { boot, bootText } = this.refs;
        if (!boot) return;
        if (!text) {
            boot.hidden = true;
            return;
        }
        boot.hidden = false;
        boot.classList.toggle('sim-boot-error', kind === 'error');
        bootText.innerHTML = text;   // textes constants du module (jamais de saisie utilisateur brute)
    }

    // -------------------------------------------------------------- //
    // Commandes de l'écran                                           //
    // -------------------------------------------------------------- //

    toggleRunning() {
        this.running = !this.running;
        this.acc = 0;
        this.lastTs = 0;
        this.input.setActive(this.running && this.visible);
        this.updateRunButton();
        this.renderNow();
    }

    updateRunButton() {
        this.refs.btnRun.textContent = this.running ? 'Pause' : 'Démarrer';
    }

    toggleLight() {
        this.lightOn = !this.lightOn;
        this.updateLightButton();
        if (this.sceneReady && this.sceneApi && this.settings) {
            const prev = this.settings;
            const next = { ...prev, led: { ...prev.led, on: this.lightOn } };
            this.settings = next;
            this.sceneApi.applySettings(next, prev).catch((error) => {
                console.error('[SubSim] application LED :', error);
            });
        }
        this.renderNow();
    }

    updateLightButton() {
        this.refs.btnLight.classList.toggle('sim-btn-on', this.lightOn);
        this.refs.btnLight.setAttribute('aria-pressed', this.lightOn ? 'true' : 'false');
    }

    /** Navigation app.js inchangée : clic programmatique sur le bouton existant. */
    openConfig() {
        const button = document.getElementById('btn-sim-open-config');
        if (button) button.click();
    }

    toggleFullscreen() {
        const stage = this.refs.stage;
        if (document.fullscreenElement === stage) {
            document.exitFullscreen();
        } else {
            stage.requestFullscreen().catch(() => {});
        }
    }

    onFullscreenChange() {
        const full = document.fullscreenElement === this.refs.stage;
        this.refs.btnFull.textContent = full ? 'Quitter plein écran' : 'Plein écran';
        window.setTimeout(() => {
            this.resizeScene();
            this.renderNow();
        }, 120);
    }

    resetSession() {
        this.physics.reset(this.initialSpawn());
        this.input.resetTransients();
        this.view.resetTrace();
        this.acc = 0;
        this.lastTs = 0;
        this.renderNow();
    }

    applyEvents(events) {
        if (events.resetSession) {
            this.resetSession();   // bouton Share : RAZ de session (comme le v1)
        }
        const arm = this.physics.state.armState;
        if (events.armToggle && arm !== 2) {
            this.physics.setArmState(arm === 1 ? 0 : 1);
        }
        if (events.estop) {
            this.physics.setArmState(arm === 2 ? 0 : 2);
        }
        if (events.dryRunToggle) {
            this.physics.setDryRun(!this.physics.state.dryRun);
        }
        if (events.lightToggle) {
            this.toggleLight();
        }
        if (events.pauseToggle) {
            this.toggleRunning();
        }
    }

    /**
     * Débloque les sorties en un clic (bouton du bandeau d'alerte) : coupe le
     * dry-run, acquitte l'E-Stop puis arme. Sans cela la physique neutralise
     * toute consigne (fidèle au firmware : dry-run ou désarmé = sorties OFF).
     */
    fixOutputs() {
        if (this.physics.state.dryRun) this.physics.setDryRun(false);
        if (this.physics.state.armState === 2) this.physics.setArmState(0);
        if (this.physics.state.armState !== 1) this.physics.setArmState(1);
        this.renderNow();
    }

    // -------------------------------------------------------------- //
    // Boucle : physique 1/240 s → scène 3D → instruments              //
    // -------------------------------------------------------------- //

    pose() {
        const s = this.physics.state;
        return {
            x: s.x, yN: s.yN, depth: s.depth,
            heading: s.heading, roll: s.roll, pitch: s.pitch,
        };
    }

    uiState() {
        const w = this.settings ? this.settings.world : null;
        return {
            running: this.running,
            lightOn: this.lightOn,
            padId: formatPadId(this.input.padId),
            dt: this.uiDt,
            fps: this.fps,
            world: w ? {
                extent: w.extent,
                depth: w.depth,
                beachExtent: w.beachExtent,
                reefExtent: w.reefExtent,
                pitRadiusPct: w.pitRadiusPct,
            } : null,
        };
    }

    /** Rectangle du PIP dans le repère du canvas (pixels CSS), ou null. */
    pipRect() {
        const frame = this.refs.pipFrame;
        if (!frame || frame.hidden || !this.settings || !this.settings.cam.pip) return null;
        const wrap = this.refs.sceneWrap.getBoundingClientRect();
        const rect = frame.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return null;
        return {
            x: rect.left - wrap.left,
            y: rect.top - wrap.top,
            width: rect.width,
            height: rect.height,
        };
    }

    resizeScene() {
        if (this.sceneReady && this.sceneApi) this.sceneApi.resize();
    }

    /** Rendu complet : pose → scène 3D (FPV + PIP) → instruments. */
    renderNow(dt = 0) {
        const snapshot = this.physics.snapshot();
        if (this.sceneReady && this.sceneApi) {
            this.sceneApi.update(dt, this.timeSec, this.pose(), this.settings);
            this.sceneApi.renderFrame(this.pipRect());
        }
        this.view.render(snapshot, this.uiState());
    }

    loop(ts) {
        requestAnimationFrame(this.loop);
        if (!this.lastTs) this.lastTs = ts;
        let dt = (ts - this.lastTs) / 1000;
        this.lastTs = ts;
        if (!Number.isFinite(dt) || dt <= 0) dt = 0;
        dt = Math.min(dt, 0.1);
        this.timeSec = ts / 1000;

        if (this.running && this.visible) {
            const command = this.input.read(ts);
            this.applyEvents(command.events);
            this.physics.setSurfaceAssist(command.holds.surface);
            this.physics.setCommand(command.dof);

            this.acc += dt;
            let steps = 0;
            while (this.acc >= FIXED_DT_S && steps < MAX_SUBSTEPS) {
                this.physics.step(FIXED_DT_S);
                this.acc -= FIXED_DT_S;
                steps += 1;
            }
            if (steps >= MAX_SUBSTEPS) this.acc = 0;

            const interval = this.settings && this.settings.display.fps60 ? RENDER_MS_60 : RENDER_MS_30;
            if (ts - this.lastRender >= interval) {
                this.uiDt = Math.max(0.005, Math.min(0.1, (ts - this.lastRender) / 1000));
                this.lastRender = ts;
                const inst = 1 / this.uiDt;
                this.fps = this.fps ? this.fps * 0.85 + inst * 0.15 : inst;
                this.renderNow(this.uiDt);
            }
        } else if (this.visible) {
            // En pause : le badge manette suit l'état du branchement…
            this.input.refreshPad();
            if (this.sceneReady && ts - this.idleLast >= IDLE_RENDER_MS) {
                // …et la scène reste vivante au ralenti (eau, faune légère).
                this.idleLast = ts;
                this.renderNow(dt);
            }
        }
    }

    // -------------------------------------------------------------- //
    // Harnais de tests                                               //
    // -------------------------------------------------------------- //

    async toggleTests() {
        const panel = this.refs.testsPanel;
        if (!panel.hidden) {
            panel.hidden = true;
            return;
        }
        let results;
        try {
            const mod = await import('./sim-test.js');
            results = mod.runTestsAsync ? await mod.runTestsAsync() : mod.runTests();
        } catch (error) {
            panel.innerHTML = `
                <div class="sim-tests-head">
                    <b>Harnais de tests indisponible</b>
                    <button id="sim-tests-close" class="btn btn-ghost" type="button">Fermer</button>
                </div>
                <p class="hint">${escapeHtml(String(error && error.message ? error.message : error))}</p>`;
            panel.hidden = false;
            panel.querySelector('#sim-tests-close').addEventListener('click', () => {
                panel.hidden = true;
            });
            return;
        }
        const passed = results.filter((item) => item.pass).length;
        const rows = results.map((item) => `
            <li class="sim-test-${item.pass ? 'ok' : 'fail'}">
                <span class="sim-test-mark">${item.pass ? '✓' : '✗'}</span>
                <span class="sim-test-name">${escapeHtml(item.name)}</span>
                <span class="sim-test-detail">${escapeHtml(item.detail)}</span>
            </li>`).join('');
        panel.innerHTML = `
            <div class="sim-tests-head">
                <b>Harnais de tests — ${passed}/${results.length} réussis</b>
                <button id="sim-tests-close" class="btn btn-ghost" type="button">Fermer</button>
            </div>
            <ul class="sim-tests-list">${rows}</ul>`;
        panel.hidden = false;
        panel.querySelector('#sim-tests-close').addEventListener('click', () => {
            panel.hidden = true;
        });
    }
}

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function boot() {
    const section = document.getElementById(SECTION_ID);
    if (!section) return;
    // eslint-disable-next-line no-new
    new SimulatorApp(section);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
