/**
 * BOBROV-V2 — Sub Simulator · entrées (module isolé).
 * Seul pont avec le système existant : les manettes de jeu, lues ici via la
 * Gamepad API, avec réutilisation — en lecture seule — des réglages du
 * cockpit (`/api/config` : zone morte, expo, fonctions assignées dans
 * « Paramètres → Manette »).
 *
 * Chaque fonction du catalogue est associée à un bouton ou à un axe, manette
 * par manette (clé `pad` = Gamepad.id) ; sans clé `pad`, l'association vaut
 * pour toutes les manettes. Les manettes connectées se cumulent, chacune avec
 * sa propre table de lecture ; la première manette garde le profil par défaut
 * ci-dessous pour les fonctions non associées ailleurs (convention de
 * pilotage) :
 *   stick gauche X → lacet (yaw)      stick gauche Y → avance (surge)
 *   stick droit  X → translation (sway)   stick droit Y → montée (heave)
 *
 * Les boutons par défaut reprennent les profils du ROV réel (BOBROV v1,
 * profiles/manette_profiles.json — profils « Standard » et « Plongée »)
 * pour retrouver les mêmes réflexes dans le simulateur et sur le vrai
 * sous-marin :
 *   △ armer · ○ dry-run · □ lumières · Options : E-Stop · Share : RAZ
 *   Croix (maintenue) : retour surface
 */

/** Mapping manette par défaut (id de fonction du catalogue → index Gamepad). */
export const DEFAULT_MAPPING = Object.freeze({
    axes: {
        yaw: { index: 0, invert: false },
        surge: { index: 1, invert: true },
        sway: { index: 2, invert: false },
        heave: { index: 3, invert: true },
    },
    buttons: { arm_toggle: 3, dryrun: 1, light: 2, estop: 9, reset: 8, surface: 0 },
    triggers: { roll_left: 6, roll_right: 7, pitch_up: 12, pitch_down: 13 },
});

/** Ordre des axes de déplacement du simulateur. */
const DOFS = ['surge', 'sway', 'heave', 'yaw', 'roll', 'pitch'];

/**
 * Rôles des fonctions du catalogue (« Paramètres → Manette », app.js) :
 * axe analogique de déplacement, bouton ±1 sur un axe, événement ponctuel
 * ou maintien. Les voies historiques du cockpit (voie1..6) et les noms
 * BOBROV v1 restent acceptés en lecture.
 */
const FUNCTION_ROLES = {
    surge: { kind: 'axis', dof: 'surge' },
    sway: { kind: 'axis', dof: 'sway' },
    heave: { kind: 'axis', dof: 'heave' },
    yaw: { kind: 'axis', dof: 'yaw' },
    roll: { kind: 'axis', dof: 'roll' },
    pitch: { kind: 'axis', dof: 'pitch' },
    yaw_left: { kind: 'dofButton', dof: 'yaw', sign: -1 },
    yaw_right: { kind: 'dofButton', dof: 'yaw', sign: 1 },
    roll_left: { kind: 'dofButton', dof: 'roll', sign: -1 },
    roll_right: { kind: 'dofButton', dof: 'roll', sign: 1 },
    pitch_up: { kind: 'dofButton', dof: 'pitch', sign: 1 },
    pitch_down: { kind: 'dofButton', dof: 'pitch', sign: -1 },
    arm_toggle: { kind: 'event', event: 'armToggle' },
    estop: { kind: 'event', event: 'estop' },
    dryrun: { kind: 'event', event: 'dryRunToggle' },
    light: { kind: 'event', event: 'lightToggle' },
    pause: { kind: 'event', event: 'pauseToggle' },
    reset: { kind: 'event', event: 'resetSession' },
    surface: { kind: 'hold', hold: 'surface' },
    // héritage : voies du cockpit et noms BOBROV v1 (profils manette)
    voie1: { kind: 'axis', dof: 'surge' },
    voie2: { kind: 'axis', dof: 'sway' },
    voie3: { kind: 'axis', dof: 'heave' },
    voie4: { kind: 'axis', dof: 'yaw' },
    voie5: { kind: 'axis', dof: 'roll' },
    voie6: { kind: 'axis', dof: 'pitch' },
    forward_backward: { kind: 'axis', dof: 'surge' },
    lateral: { kind: 'axis', dof: 'sway' },
    vertical: { kind: 'axis', dof: 'heave' },
    turn: { kind: 'axis', dof: 'yaw' },
    turn_left: { kind: 'dofButton', dof: 'yaw', sign: -1 },
    turn_right: { kind: 'dofButton', dof: 'yaw', sign: 1 },
    arm: { kind: 'event', event: 'armToggle' },
    emergency_stop: { kind: 'event', event: 'estop' },
    light_toggle: { kind: 'event', event: 'lightToggle' },
};

/** Aide clavier affichée dans l'écran de simulation. */
export const KEYBOARD_HELP = Object.freeze([
    ['Z / S', 'Avancer / reculer (surge)'],
    ['Q / D', 'Lacet gauche / droite (yaw)'],
    ['A / E', 'Translation gauche / droite (sway)'],
    ['W / X', 'Monter / plonger (heave)'],
    ['← / →', 'Roulis (roll)'],
    ['↑ / ↓', 'Tangage (pitch)'],
    ['Maj + A', 'Armer / désarmer'],
    ['Maj + D', 'Basculer le dry-run'],
    ['Espace', 'E-Stop (ré-appuyer pour réarmer)'],
    ['R (maintenu)', 'Retour surface'],
    ['P', 'Pause / reprise'],
]);

const AXIS_KEYS = {
    surge: ['s', 'z'],                // S = reculer (−), Z = avancer (+)
    yaw: ['q', 'd'],                  // Q = lacet gauche (−), D = lacet droite (+)
    sway: ['a', 'e'],                 // A = translation gauche (−), E = droite (+)
    heave: ['x', 'w'],                // X = plonger (−), W = monter (+)
    roll: ['arrowleft', 'arrowright'],
    pitch: ['arrowdown', 'arrowup'],
};

const KEY_RAMP_TAU_S = 0.09;

/** Sources d'une action : `sources` (courant) ou `source` (format hérité). */
function actionSources(action) {
    if (Array.isArray(action.sources)) return action.sources;
    return action.source ? [action.source] : [];
}

function normaliseHeadTracker(raw) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: !!cfg.enabled,
        deviceId: typeof cfg.device_id === 'string' ? cfg.device_id : '',
        mode: cfg.mode === 'always' ? 'always' : 'hold',
        routes: Array.isArray(cfg.routes) ? cfg.routes : [],
    };
}

function isBobBlAr(pad, configuredId) {
    if (!pad || !pad.id) return false;
    return configuredId ? pad.id === configuredId : pad.id.toUpperCase().includes('BOB BL AR');
}

function sourceIsActive(pad, source) {
    if (!pad || !source || (source.pad && source.pad !== pad.id)) return false;
    if (source.type === 'button') {
        const button = pad.buttons[source.index];
        return !!(button && (button.pressed || button.value > 0.5));
    }
    return Math.abs(pad.axes[source.index] || 0) > 0.7;
}

/** Fusionne une table d'associations dans la table effective (copies). */
function mergeInto(target, extra) {
    if (!extra) return;
    for (const [dof, map] of Object.entries(extra.axes)) target.axes[dof] = { ...map };
    for (const entry of extra.dofButtons) target.dofButtons.push({ ...entry });
    for (const entry of extra.events) target.events.push({ ...entry });
    for (const entry of extra.holds) target.holds.push({ ...entry });
}

export class SimInput {
    constructor() {
        this.deadzone = 0.08;
        this.expo = 1.5;
        this.tables = new Map();        // id de manette ('' = toutes) → associations lues
        this.defaultsOff = new Set();   // fonctions associées : leur défaut ne s'applique plus
        this.headTracker = normaliseHeadTracker(null);
        this.actions = [];              // actions brutes, utilisées par le bouton d'engagement BOB BL AR
        this.assigned = 0;              // associations lues dans config.json
        this.mappedAxes = 0;            // dont axes de déplacement
        this.source = 'default';
        this.active = false;
        this.keys = new Set();
        this.shiftDown = false;
        this.ramped = { surge: 0, yaw: 0, sway: 0, heave: 0, roll: 0, pitch: 0 };
        this.prevButtons = new Map();   // clé « manette|index » → appuyé au pas précédent
        this.pending = {
            armToggle: false, estop: false, dryRunToggle: false,
            lightToggle: false, pauseToggle: false, resetSession: false,
        };
        this.lastReadMs = 0;
        this.padId = null;
        this._padTables = new Map();    // id de manette → table effective (fusionnée)
        this._onKeyDown = (e) => this.handleKey(e, true);
        this._onKeyUp = (e) => this.handleKey(e, false);
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
    }

    /** Active/désactive la capture clavier (section visible et simulation lancée). */
    setActive(active) {
        this.active = !!active;
        if (!this.active) this.keys.clear();
    }

    /**
     * Lit la configuration du cockpit en lecture seule : zone morte, expo,
     * et fonctions associées aux deux manettes dans « Paramètres → Manette ».
     * Non bloquant ; en cas d'échec, les défauts internes s'appliquent.
     */
    async loadConfig() {
        try {
            const response = await fetch('/api/config', { cache: 'no-store' });
            if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
            const config = await response.json();
            this.applyConfig(config);
            return { ok: true, source: this.source };
        } catch (error) {
            return { ok: false, reason: String(error) };
        }
    }

    applyConfig(config) {
        const input = config && config.input ? config.input : {};
        const deadzone = Number(input.deadzone);
        const expo = Number(input.expo);
        if (Number.isFinite(deadzone) && deadzone >= 0 && deadzone < 1) this.deadzone = deadzone;
        if (Number.isFinite(expo) && expo >= 0.1 && expo <= 5) this.expo = expo;

        this.tables = new Map();
        this.defaultsOff = new Set();
        this._padTables.clear();
        this.assigned = 0;
        this.mappedAxes = 0;
        const actions = input.gamepad && Array.isArray(input.gamepad.actions)
            ? input.gamepad.actions : [];
        this.actions = actions;
        this.headTracker = normaliseHeadTracker(input.head_tracker);
        for (const action of actions) {
            const role = action ? FUNCTION_ROLES[action.id] : null;
            if (!role) continue;
            for (const source of actionSources(action)) {
                if (!source || !Number.isInteger(source.index) || source.index < 0) continue;
                const type = source.type === 'axis' ? 'axis' : 'button';
                const table = this.tableForAssignment(source.pad);
                let applied = false;
                if (role.kind === 'axis' && type === 'axis') {
                    table.axes[role.dof] = { index: source.index, invert: !!source.invert };
                    this.mappedAxes += 1;
                    applied = true;
                } else if (role.kind === 'axis' && type === 'button') {
                    table.dofButtons.push({
                        dof: role.dof, sign: source.invert ? -1 : 1, index: source.index,
                    });
                    applied = true;
                } else if (role.kind === 'dofButton' && type === 'button') {
                    table.dofButtons.push({
                        dof: role.dof, sign: role.sign * (source.invert ? -1 : 1), index: source.index,
                    });
                    applied = true;
                } else if (role.kind === 'event' && type === 'button') {
                    table.events.push({ event: role.event, index: source.index });
                    applied = true;
                } else if (role.kind === 'hold' && type === 'button') {
                    table.holds.push({ hold: role.hold, index: source.index });
                    applied = true;
                }
                if (applied) {
                    // la fonction est associée : son profil par défaut se retire
                    this.defaultsOff.add(role.kind === 'axis' ? role.dof : action.id);
                    this.assigned += 1;
                }
            }
        }
        this.source = this.assigned > 0 ? 'cockpit' : 'default';
    }

    /** Table d'associations d'une clé de manette (`''` = toutes), créée à la demande. */
    tableForAssignment(padKey) {
        const key = typeof padKey === 'string' ? padKey : '';
        if (!this.tables.has(key)) {
            this.tables.set(key, { axes: {}, dofButtons: [], events: [], holds: [] });
        }
        return this.tables.get(key);
    }

    /**
     * Table effective d'une manette : profil par défaut (première manette),
     * écrasé par les associations communes puis par celles de la manette.
     */
    tableForPad(pad, useDefault) {
        const cacheKey = pad.id + (useDefault ? '|d' : '');
        const cached = this._padTables.get(cacheKey);
        if (cached) return cached;
        const table = { axes: {}, dofButtons: [], events: [], holds: [] };
        if (useDefault) {
            for (const dof of DOFS) {
                if (this.defaultsOff.has(dof)) continue;      // fonction déjà associée ailleurs
                const map = DEFAULT_MAPPING.axes[dof];
                if (map) table.axes[dof] = { index: map.index, invert: map.invert };
            }
            for (const [id, index] of Object.entries(DEFAULT_MAPPING.buttons)) {
                if (this.defaultsOff.has(id)) continue;
                const role = FUNCTION_ROLES[id];
                if (!role) continue;
                if (role.kind === 'event') table.events.push({ event: role.event, index });
                else if (role.kind === 'hold') table.holds.push({ hold: role.hold, index });
            }
            for (const [id, index] of Object.entries(DEFAULT_MAPPING.triggers)) {
                if (this.defaultsOff.has(id)) continue;
                const role = FUNCTION_ROLES[id];
                if (role && role.kind === 'dofButton') {
                    table.dofButtons.push({ dof: role.dof, sign: role.sign, index });
                }
            }
        }
        mergeInto(table, this.tables.get(''));
        mergeInto(table, this.tables.get(pad.id));
        this._padTables.set(cacheKey, table);
        return table;
    }

    handleKey(event, down) {
        if (!this.active) return;
        const target = event.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
            || target.tagName === 'SELECT' || target.isContentEditable)) {
            return;
        }
        const key = (event.key || '').toLowerCase();
        if (!key) return;
        if (key === 'shift') {
            this.shiftDown = down;
            return;
        }
        const used = ['z', 's', 'q', 'd', 'a', 'e', 'w', 'x', 'r', 'p', ' ',
            'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key);
        if (!used) return;
        event.preventDefault();
        if (down) {
            if (key === ' ') {
                if (!event.repeat) this.pending.estop = true;
            } else if (key === 'p') {
                if (!event.repeat) this.pending.pauseToggle = true;
            } else if (event.shiftKey && key === 'a') {
                if (!event.repeat) this.pending.armToggle = true;
            } else if (event.shiftKey && key === 'd') {
                if (!event.repeat) this.pending.dryRunToggle = true;
            } else {
                this.keys.add(key);
            }
        } else {
            this.keys.delete(key);
        }
    }

    /** Lit clavier + manettes et renvoie consignes, événements et état des liaisons. */
    read(nowMs = performance.now()) {
        const dt = this.lastReadMs ? Math.min(0.2, (nowMs - this.lastReadMs) / 1000) : 0;
        this.lastReadMs = nowMs;

        // --- Clavier : cibles puis lissage (prise en main douce) -------------
        const alpha = 1 - Math.exp(-dt / KEY_RAMP_TAU_S);
        for (const axis of Object.keys(AXIS_KEYS)) {
            const [neg, pos] = AXIS_KEYS[axis];
            let target = 0;
            if (this.keys.has(pos)) target += 1;
            if (this.keys.has(neg)) target -= 1;
            this.ramped[axis] += (target - this.ramped[axis]) * alpha;
            if (Math.abs(this.ramped[axis]) < 0.001) this.ramped[axis] = target;
        }
        const kb = { ...this.ramped };

        // --- Manettes : toutes connectées, chacune avec sa table de lecture --
        const pads = this.connectedPads();
        const padDof = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };
        const holds = { surface: this.keys.has('r') };
        this.padId = pads.length ? pads[0].id : null;
        pads.forEach((pad, order) => {
            const table = this.tableForPad(pad, order === 0);
            for (const dof of DOFS) {
                const map = table.axes[dof];
                if (!map) continue;
                const raw = pad.axes[map.index];
                if (!Number.isFinite(raw)) continue;
                padDof[dof] += shapeAxis(map.invert ? -raw : raw, this.deadzone, this.expo);
            }
            for (const entry of table.dofButtons) {
                const button = pad.buttons[entry.index];
                if (!button) continue;
                if (button.pressed || button.value > 0.5) {
                    padDof[entry.dof] += entry.sign * Math.max(button.value, 0.5);
                }
            }
            for (const entry of table.events) this.pollButton(pad, entry.index, entry.event);
            for (const entry of table.holds) {
                const button = pad.buttons[entry.index];
                if (button && button.pressed) holds[entry.hold] = true;
            }
        });
        // Le BOB BL AR remplace la consigne de l'action ciblée tant que son
        // routage est actif : il ne se cumule pas avec le joystick principal.
        const headDof = this.readHeadTracker(pads);
        for (const [dof, value] of Object.entries(headDof)) padDof[dof] = value;
        for (const dof of DOFS) padDof[dof] = Math.max(-1, Math.min(1, padDof[dof]));

        // --- Fusion clavier + manettes ---------------------------------------
        const keyConflict = this.shiftDown;
        const dof = {};
        for (const axis of DOFS) {
            let value = kb[axis] + padDof[axis];
            if (keyConflict && (axis === 'sway' || axis === 'yaw')) value = padDof[axis];
            dof[axis] = Math.max(-1, Math.min(1, value));
        }

        const events = { ...this.pending };
        this.pending = {
            armToggle: false, estop: false, dryRunToggle: false,
            lightToggle: false, pauseToggle: false, resetSession: false,
        };
        const keyboardActive = this.keys.has('z') || this.keys.has('s') || this.keys.has('q')
            || this.keys.has('d') || this.keys.has('a') || this.keys.has('e')
            || this.keys.has('w') || this.keys.has('x') || this.keys.has('r')
            || this.keys.has('arrowup') || this.keys.has('arrowdown')
            || this.keys.has('arrowleft') || this.keys.has('arrowright');
        return {
            dof,
            events,
            holds,
            meta: {
                padId: this.padId,
                padConnected: pads.length > 0,
                keyboardActive,
                source: this.source,
                deadzone: this.deadzone,
                expo: this.expo,
            },
        };
    }

    /** Front montant d'un bouton de manette → événement ponctuel. */
    pollButton(pad, index, eventName) {
        const button = pad.buttons[index];
        const now = !!(button && (button.pressed || button.value > 0.5));
        const key = pad.id + '|' + index;
        const was = this.prevButtons.get(key) || false;
        this.prevButtons.set(key, now);
        if (now && !was) this.pending[eventName] = true;
    }

    /** Consignes BOB BL AR, normalisées puis mises en forme comme un axe normal. */
    readHeadTracker(pads) {
        const cfg = this.headTracker;
        if (!cfg.enabled) return {};
        const tracker = pads.find((pad) => isBobBlAr(pad, cfg.deviceId));
        if (!tracker) return {};
        const engage = this.actions.find((action) => action && action.id === 'head_tracker_engage');
        const active = cfg.mode === 'always' || !!(engage && pads.some((pad) =>
            actionSources(engage).some((source) => sourceIsActive(pad, source))));
        if (!active) return {};
        const out = {};
        for (const route of cfg.routes) {
            const role = route && FUNCTION_ROLES[route.action];
            if (!role || role.kind !== 'axis') continue;
            const raw = tracker.axes[Number(route.axis)] || 0;
            const value = shapeAxis(route.invert ? -raw : raw, this.deadzone, this.expo);
            out[role.dof] = Math.max(-1, Math.min(1, (out[role.dof] || 0) + value));
        }
        return out;
    }

    connectedPads() {
        if (!navigator.getGamepads) return [];
        const pads = [];
        for (const pad of navigator.getGamepads()) {
            if (pad && pad.connected !== false) pads.push(pad);
        }
        return pads;
    }

    pickGamepad() {
        const pads = this.connectedPads();
        return pads.length ? pads[0] : null;
    }

    /** Relit l'identité de la manette connectée (badge) sans consommer les axes. */
    refreshPad() {
        const pad = this.pickGamepad();
        this.padId = pad ? pad.id : null;
        return this.padId;
    }

    /** Remet à zéro les états transitoires (RAZ de session). */
    resetTransients() {
        this.keys.clear();
        for (const axis of Object.keys(this.ramped)) this.ramped[axis] = 0;
        this.prevButtons = new Map();
        this.pending = {
            armToggle: false, estop: false, dryRunToggle: false,
            lightToggle: false, pauseToggle: false, resetSession: false,
        };
    }

    dispose() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
    }
}

/** Zone morte + courbe exponentielle, signe conservé. */
export function shapeAxis(value, deadzone, expo) {
    const abs = Math.abs(value);
    if (abs <= deadzone) return 0;
    const norm = Math.min(1, (abs - deadzone) / (1 - deadzone));
    const shaped = Math.pow(norm, expo);
    return value < 0 ? -shaped : shaped;
}

/** Raccourcit l'identifiant d'une manette pour l'affichage. */
export function formatPadId(id) {
    if (!id) return null;
    const short = id.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return short.length > 42 ? `${short.slice(0, 40)}…` : short;
}
