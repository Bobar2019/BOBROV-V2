/**
 * BOBROV-V2 — Sub Simulator · physique 6 axes à pas fixe.
 * Module isolé : aucune dépendance externe, aucune I/O, aucun état global.
 *
 * Modèle (v1 « 6 axes simplifiée », unités SI) :
 *   consignes DOF → mixage M1–M8 → rampe hélices → forces/couples
 *   → intégration à pas fixe 1/240 s → capteurs simulés.
 *
 * Repère :
 *   - u : vitesse d'avance (m/s)      v : vitesse latérale droite (m/s)
 *   - w : vitesse de montée (m/s)     p/q/r : taux roulis/tangage/lacet (rad/s)
 *   - heading : cap (rad, 0 = nord)   depth : immersion (m, 0 = surface)
 *   - x : est (m)                     yN : nord (m)
 *
 * Conventions d'actionneurs identiques au firmware (voir sim-mix.js).
 * États fidèles au protocole : armement 0/1/2 (2 = E-Stop verrouillé),
 * démarrage en dry-run (sorties neutralisées), watchdog 500 ms.
 *
 * Environnement injectable (`setEnvironment`) : surface fixe y = 0, murs
 * du bassin ±étendue/2 et plancher dynamique fourni par une sonde de
 * terrain (env-terrain.floorLimitAt via sim.js). Sans injection, la
 * physique retombe sur son plan d'eau v1 (pleine profondeur bornée),
 * ce qui garde les tests purs inchangés.
 */

import {
    HORIZONTAL_MATRIX, VERTICAL_MATRIX, HORIZONTAL_IDS, VERTICAL_IDS,
    mixDofToMotors, neutralDof, axisGain,
} from './sim-mix.js';

export const G = 9.81;
export const FIXED_DT_S = 1 / 240;
export const MAX_SUBSTEPS = 8;

/** Réglages par défaut — tous paramétrables (voir CDC §4.7, lot « Sub Simu »). */
export const PHYSICS_DEFAULTS = Object.freeze({
    // Actionneurs
    mass_kg: 12.0,
    thrust_max_n: 24.5,          // poussée d'un propulseur à plein régime
    arm_horizontal_m: 0.22,      // bras de levier M1–M4 (couple de lacet)
    arm_vertical_m: 0.28,        // bras de levier M5–M8 (couples roulis/tangage)
    thruster_tau_s: 0.08,        // rampe de montée en vitesse des hélices
    // Cibles de vitesse (calibrent la traînée quadratique)
    vmax_surge_mps: 1.5,
    vmax_sway_mps: 1.2,
    vmax_heave_mps: 0.9,
    wmax_yaw_dps: 80,
    wmax_roll_dps: 55,
    wmax_pitch_dps: 55,
    drag_linear_ratio: 0.06,     // terme linéaire (précision de trim à basse vitesse)
    // Inerties angulaires (kg·m², eau comprise)
    inertia_roll: 1.2,
    inertia_pitch: 1.2,
    inertia_yaw: 2.0,
    // Stabilité passive (métacentre) : recentre le ROV commandes au neutre
    stab_roll_nm_rad: 8.0,
    stab_pitch_nm_rad: 8.0,
    // Flottabilité résiduelle : > 0 = le ROV remonte lentement à vide
    residual_buoyancy_kg: 0.2,
    // Environnement de secours (sans sonde injectée : plan d'eau v1)
    floor_depth_m: 25.0,
    wall_limit_m: 20.0,
    // Sécurité
    watchdog_s: 0.5,
    surface_assist_target_m: 0.4,
    surface_assist_heave: 0.55,
    // Batterie 3S Li-ion
    battery_capacity_ah: 5.0,
    battery_r_int_ohm: 0.05,
    battery_idle_a: 0.35,
    battery_k_horizontal_a: 4.5,
    battery_k_vertical_a: 3.2,
    battery_v_full: 12.6,
    battery_v_knee: 11.1,        // coude de décharge (20 % restants)
    battery_v_empty: 9.9,
    battery_knee_soc: 0.2,
    // Capteurs
    water_temp_c: 18.0,
    pressure_atm_mbar: 1013.25,
    mbar_per_meter: 100.5,
});

const AXES_TRANSLATION = ['surge', 'sway', 'heave'];

/**
 * Dérive les gains de la physique depuis les réglages : efforts max par
 * axe (via les gains de mixage), coefficients de traînée quadratique et
 * linéaire calés sur les vitesses maximales cibles.
 */
export function deriveTuning(params) {
    const p = { ...PHYSICS_DEFAULTS, ...params };
    const gain = {};
    for (const axis of ['surge', 'sway', 'yaw', 'heave', 'roll', 'pitch']) {
        gain[axis] = axisGain(axis);
    }
    const fmax = {};
    for (const axis of AXES_TRANSLATION) fmax[axis] = p.thrust_max_n * gain[axis];
    const tmax = {
        yaw: p.thrust_max_n * gain.yaw * p.arm_horizontal_m,
        roll: p.thrust_max_n * gain.roll * p.arm_vertical_m,
        pitch: p.thrust_max_n * gain.pitch * p.arm_vertical_m,
    };
    const deg2rad = Math.PI / 180;
    const kq = {
        surge: fmax.surge / (p.vmax_surge_mps ** 2),
        sway: fmax.sway / (p.vmax_sway_mps ** 2),
        heave: fmax.heave / (p.vmax_heave_mps ** 2),
        yaw: tmax.yaw / ((p.wmax_yaw_dps * deg2rad) ** 2),
        roll: tmax.roll / ((p.wmax_roll_dps * deg2rad) ** 2),
        pitch: tmax.pitch / ((p.wmax_pitch_dps * deg2rad) ** 2),
    };
    const kl = {};
    for (const axis of Object.keys(kq)) kl[axis] = kq[axis] * p.drag_linear_ratio;
    return { p, gain, fmax, tmax, kq, kl };
}

export class SimPhysics {
    constructor(overrides = {}) {
        this.tuning = deriveTuning(overrides);
        this.p = this.tuning.p;
        this.setEnvironment();
        this.reset();
    }

    /**
     * Branche la physique sur le monde réel.
     * @param {{floorDepthAt?: (x: number, yN: number) => number, wallLimit?: number}} env
     *        floorDepthAt : profondeur maximale (m, > 0) à la verticale du
     *        point — sonde terrain ; wallLimit : demi-étendue du bassin (m).
     */
    setEnvironment(env = {}) {
        this.env = {
            floorDepthAt: typeof env.floorDepthAt === 'function'
                ? env.floorDepthAt
                : () => this.p.floor_depth_m,
            wallLimit: Number.isFinite(env.wallLimit) ? env.wallLimit : this.p.wall_limit_m,
        };
    }

    /** Réinitialise l'état complet. `init` permet de poser des conditions (tests). */
    reset(init = {}) {
        this.command = neutralDof();
        this.state = {
            t: 0,
            x: Number.isFinite(init.x) ? init.x : 0,
            yN: Number.isFinite(init.yN) ? init.yN : 0,
            depth: init.depth ?? 0,
            heading: init.heading ?? 0,
            roll: init.roll ?? 0,
            pitch: init.pitch ?? 0,
            u: 0, v: 0, w: 0,
            p: 0, q: 0, r: 0,
            thrust: new Array(8).fill(0),
            saturation: { H: false, V: false },
            armState: init.armState ?? 0,
            dryRun: init.dryRun ?? true,
            surfaceAssist: false,
            watchdogActive: false,
            sinceCmd: 0,
            watchdogTrips: 0,
            soc: init.soc ?? 1.0,
            current: { h: 0, v: 0, total: this.p.battery_idle_a },
            outputsOff: true,
        };
    }

    // ------------------------------------------------------------------ //
    // Entrées                                                             //
    // ------------------------------------------------------------------ //

    /** Consigne DOF (mixée ensuite). Met à jour la sentinelle watchdog. */
    setCommand(dof) {
        for (const axis of ['surge', 'sway', 'heave', 'yaw', 'roll', 'pitch']) {
            const value = Number(dof[axis]);
            this.command[axis] = Number.isFinite(value)
                ? Math.max(-1, Math.min(1, value))
                : 0;
        }
        this.state.sinceCmd = 0;
    }

    /** Armement : 0 = désarmé, 1 = armé, 2 = E-Stop verrouillé. */
    setArmState(value) {
        this.state.armState = (value === 1 || value === 2) ? value : 0;
    }

    setDryRun(active) {
        this.state.dryRun = !!active;
    }

    /** Assistance « retour surface » (simple, locale au simulateur) : montée plafonnée. */
    setSurfaceAssist(active) {
        this.state.surfaceAssist = !!active;
    }

    // ------------------------------------------------------------------ //
    // Intégration                                                         //
    // ------------------------------------------------------------------ //

    /** Un pas de simulation à pas fixe (dt = 1/240 s par défaut). */
    step(dt = FIXED_DT_S) {
        const s = this.state;
        const p = this.p;
        const tn = this.tuning;

        // 1) Liaison de commande — watchdog 500 ms
        s.sinceCmd += dt;
        const linkLost = s.sinceCmd > p.watchdog_s;
        if (linkLost && !s.watchdogActive) {
            s.watchdogActive = true;
            s.watchdogTrips += 1;
        } else if (!linkLost) {
            s.watchdogActive = false;
        }
        const outputsOff = s.dryRun || s.armState !== 1 || linkLost;
        s.outputsOff = outputsOff;

        // 2) Consignes DOF effectives (+ assistance retour surface)
        const dof = outputsOff ? neutralDof() : { ...this.command };
        if (!outputsOff && s.surfaceAssist
            && s.depth > p.surface_assist_target_m
            && dof.heave < p.surface_assist_heave) {
            dof.heave = p.surface_assist_heave;
        }

        // 3) Mixage M1–M8 + normalisation par groupe
        const target = mixDofToMotors(dof, s.saturation);

        // 4) Rampe hélices (premier ordre, τ = 80 ms)
        const alpha = 1 - Math.exp(-dt / p.thruster_tau_s);
        for (let i = 0; i < 8; i++) {
            s.thrust[i] += (target[i + 1] - s.thrust[i]) * alpha;
        }

        // 5) Efforts résultants (repère corps)
        let fSurge = 0, fSway = 0, tYaw = 0;
        for (const id of HORIZONTAL_IDS) {
            const t = s.thrust[id - 1];
            const row = HORIZONTAL_MATRIX[id];
            fSurge += row.surge * t;
            fSway += row.sway * t;
            tYaw += row.yaw * t;
        }
        fSurge *= p.thrust_max_n;
        fSway *= p.thrust_max_n;
        tYaw *= p.thrust_max_n * p.arm_horizontal_m;
        let fHeave = 0, tRoll = 0, tPitch = 0;
        for (const id of VERTICAL_IDS) {
            const t = s.thrust[id - 1];
            const row = VERTICAL_MATRIX[id];
            fHeave += row.heave * t;
            tRoll += row.roll * t;
            tPitch += row.pitch * t;
        }
        fHeave *= p.thrust_max_n;
        tRoll *= p.thrust_max_n * p.arm_vertical_m;
        tPitch *= p.thrust_max_n * p.arm_vertical_m;

        // 6) Dynamique translation (traînée quadratique + linéaire)
        const buoyancy = p.residual_buoyancy_kg * G;
        s.u += ((fSurge - drag(tn, 'surge', s.u)) / p.mass_kg) * dt;
        s.v += ((fSway - drag(tn, 'sway', s.v)) / p.mass_kg) * dt;
        s.w += ((fHeave + buoyancy - drag(tn, 'heave', s.w)) / p.mass_kg) * dt;

        // 7) Dynamique rotation (amortissement + rappel de stabilité passive)
        s.p += ((tRoll - drag(tn, 'roll', s.p)
            - p.stab_roll_nm_rad * Math.sin(s.roll)) / p.inertia_roll) * dt;
        s.q += ((tPitch - drag(tn, 'pitch', s.q)
            - p.stab_pitch_nm_rad * Math.sin(s.pitch)) / p.inertia_pitch) * dt;
        s.r += ((tYaw - drag(tn, 'yaw', s.r)) / p.inertia_yaw) * dt;

        // 8) Attitude (butées ±90° — protection contre les singularités d'Euler)
        s.roll = clampAngle(s.roll + s.p * dt, () => { s.p = 0; });
        s.pitch = clampAngle(s.pitch + s.q * dt, () => { s.q = 0; });
        s.heading = wrapAngle(s.heading + s.r * dt);

        // 9) Cinématique position (vitesses corps → monde via le cap)
        const cosH = Math.cos(s.heading);
        const sinH = Math.sin(s.heading);
        s.x += (s.u * sinH + s.v * cosH) * dt;
        s.yN += (s.u * cosH - s.v * sinH) * dt;
        s.depth -= s.w * dt;

        // 10) Environnement : surface (y = 0), fond (sonde terrain), parois
        if (s.depth <= 0) {
            s.depth = 0;
            if (s.w > 0) s.w = 0;
        }
        const floorDepth = this.env.floorDepthAt(s.x, s.yN);
        if (Number.isFinite(floorDepth) && floorDepth > 0 && s.depth >= floorDepth) {
            s.depth = floorDepth;
            if (s.w < 0) s.w = 0;
        }
        const wallLimit = this.env.wallLimit;
        if (Math.abs(s.x) >= wallLimit) {
            s.x = Math.sign(s.x) * wallLimit;
            s.u *= 0.5;
            s.v *= 0.5;
        }
        if (Math.abs(s.yN) >= wallLimit) {
            s.yN = Math.sign(s.yN) * wallLimit;
            s.u *= 0.5;
            s.v *= 0.5;
        }

        // 11) Batterie : courants, SOC, tension sous charge
        let iH = 0, iV = 0;
        for (const id of HORIZONTAL_IDS) iH += Math.abs(s.thrust[id - 1]);
        for (const id of VERTICAL_IDS) iV += Math.abs(s.thrust[id - 1]);
        iH *= p.battery_k_horizontal_a;
        iV *= p.battery_k_vertical_a;
        const iTotal = p.battery_idle_a + iH + iV;
        s.current = { h: iH, v: iV, total: iTotal };
        s.soc = Math.max(0, s.soc - (iTotal * dt) / (3600 * p.battery_capacity_ah));

        s.t += dt;
    }

    // ------------------------------------------------------------------ //
    // Sorties                                                             //
    // ------------------------------------------------------------------ //

    /** Tension à vide du pack (décharge linéaire par morceaux). */
    openCircuitVoltage(soc = this.state.soc) {
        const p = this.p;
        if (soc >= p.battery_knee_soc) {
            const k = (soc - p.battery_knee_soc) / (1 - p.battery_knee_soc);
            return p.battery_v_knee + k * (p.battery_v_full - p.battery_v_knee);
        }
        return p.battery_v_empty + (soc / p.battery_knee_soc) * (p.battery_v_knee - p.battery_v_empty);
    }

    /** Instantané complet pour la vue et le harnais de tests. */
    snapshot() {
        const s = this.state;
        const p = this.p;
        const rad2deg = 180 / Math.PI;
        const ocv = this.openCircuitVoltage();
        const voltage = ocv - p.battery_r_int_ohm * s.current.total;
        return {
            t: s.t,
            pos: { x: s.x, north: s.yN, depth: s.depth },
            att: {
                heading: s.heading, roll: s.roll, pitch: s.pitch,
                headingDeg: (s.heading * rad2deg + 360) % 360,
                rollDeg: s.roll * rad2deg,
                pitchDeg: s.pitch * rad2deg,
            },
            vel: {
                u: s.u, v: s.v, w: s.w,
                p: s.p * rad2deg, q: s.q * rad2deg, r: s.r * rad2deg,
            },
            thrust: s.thrust.slice(),
            saturation: { ...s.saturation },
            flags: {
                armState: s.armState,
                dryRun: s.dryRun,
                watchdog: s.watchdogActive,
                surfaceAssist: s.surfaceAssist,
                outputsOff: s.outputsOff,
            },
            battery: {
                soc: s.soc,
                ocv,
                voltage,
                current: s.current.total,
                currentH: s.current.h,
                currentV: s.current.v,
                low: voltage < p.battery_knee,
            },
            sensors: {
                depthM: s.depth,
                pressureMbar: p.pressure_atm_mbar + s.depth * p.mbar_per_meter,
                tempC: p.water_temp_c,
            },
            counters: { watchdogTrips: s.watchdogTrips },
        };
    }
}

/** Traînée opposée au mouvement : (kq·|v| + kl)·v. */
function drag(tuning, axis, vel) {
    const kq = tuning.kq[axis] ?? 0;
    const kl = tuning.kl[axis] ?? 0;
    return (kq * Math.abs(vel) + kl) * vel;
}

/** Borne un angle à ±90° ; `onClamp` est appelé si la butée est atteinte. */
function clampAngle(angle, onClamp) {
    const limit = Math.PI / 2;
    if (angle > limit) {
        onClamp();
        return limit;
    }
    if (angle < -limit) {
        onClamp();
        return -limit;
    }
    return angle;
}

/** Ramène un angle dans [−π, +π]. */
function wrapAngle(angle) {
    const twoPi = Math.PI * 2;
    let a = angle % twoPi;
    if (a > Math.PI) a -= twoPi;
    if (a < -Math.PI) a += twoPi;
    return a;
}
