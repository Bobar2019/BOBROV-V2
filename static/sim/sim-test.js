/**
 * BOBROV-V2 — Sub Simulator · harnais de tests autonome.
 *
 * Exécuté à la demande depuis l'écran de simulation (bouton « Tests »).
 * Aucun accès réseau, aucun accès DOM. Chaque cas vérifie un invariant
 * du mixage, de la physique, du décor procédural ou des réglages par
 * rapport aux valeurs extraites du firmware (BOBROV-main/backend/
 * motor_mixer.py) et de l'ancien simulateur 3D.
 *
 * Deux niveaux : `runTests()` — 24 cas noyau, uniquement sim-mix.js et
 * sim-physics.js (fonctionnent sans vendor Three.js) ; `runTestsAsync()`
 * ajoute les groupes décor (bruit, terrain, zones de spawn dont fond/sol,
 * bancs — offsets et huit partagés), bornes de monde injectées, FSM
 * mammifère et fusion des réglages, via imports dynamiques (ignorés
 * proprement si le vendor Three.js est absent).
 */

import {
    mixDofToMotors, allocateMotorsToDof, axisGain, neutralDof,
} from './sim-mix.js';
import { SimPhysics, FIXED_DT_S } from './sim-physics.js';

const EPS = 1e-6;
const RAD = Math.PI / 180;

function assertClose(actual, expected, eps = EPS) {
    if (Math.abs(actual - expected) > eps) {
        throw new Error(`attendu ${expected}, obtenu ${actual.toFixed(6)}`);
    }
}

function assertTrue(condition, message) {
    if (!condition) throw new Error(message);
}

/** Fait tourner la physique en pas fixes en nourrissant la commande (anti-watchdog). */
function simulate(physics, seconds, dof, { feed = true } = {}) {
    const steps = Math.round(seconds / FIXED_DT_S);
    const feedEvery = Math.round(0.1 / FIXED_DT_S);
    for (let i = 0; i < steps; i++) {
        if (feed && i % feedEvery === 0) physics.setCommand(dof);
        physics.step(FIXED_DT_S);
    }
}

function armed() {
    const physics = new SimPhysics();
    physics.setDryRun(false);
    physics.setArmState(1);
    physics.setCommand(neutralDof());
    return physics;
}

/** Construit les cas de test. Retourne [{name, pass, detail}]. */
export function runTests() {
    const results = [];
    const test = (name, fn) => {
        try {
            const detail = fn();
            results.push({ name, pass: true, detail: detail || 'OK' });
        } catch (error) {
            results.push({ name, pass: false, detail: String(error.message || error) });
        }
    };

    // --- Mixage : matrices exactes du firmware --------------------------

    test('Mixage — surge unitaire (M1..M4 = +0,707 / −0,707 / −0,707 / +0,707)', () => {
        const t = mixDofToMotors({ ...neutralDof(), surge: 1 });
        assertClose(t[1], +0.707);
        assertClose(t[2], -0.707);
        assertClose(t[3], -0.707);
        assertClose(t[4], +0.707);
        for (const id of [5, 6, 7, 8]) assertClose(t[id], 0);
        return 'matrice horizontale conforme';
    });

    test('Mixage — sway unitaire (M1..M4 = −0,707 / −0,707 / +0,707 / +0,707)', () => {
        const t = mixDofToMotors({ ...neutralDof(), sway: 1 });
        assertClose(t[1], -0.707);
        assertClose(t[2], -0.707);
        assertClose(t[3], +0.707);
        assertClose(t[4], +0.707);
        return 'translation droite conforme';
    });

    test('Mixage — yaw unitaire (M1 −1 · M2 +1 · M3 −1 · M4 +1)', () => {
        const t = mixDofToMotors({ ...neutralDof(), yaw: 1 });
        assertClose(t[1], -1);
        assertClose(t[2], +1);
        assertClose(t[3], -1);
        assertClose(t[4], +1);
        return 'lacet horaire conforme';
    });

    test('Mixage — heave unitaire (M5..M8 = +1)', () => {
        const t = mixDofToMotors({ ...neutralDof(), heave: 1 });
        for (const id of [5, 6, 7, 8]) assertClose(t[id], +1);
        return 'montée conforme';
    });

    test('Mixage — roll unitaire (M5 −1 · M6 −1 · M7 +1 · M8 +1)', () => {
        const t = mixDofToMotors({ ...neutralDof(), roll: 1 });
        assertClose(t[5], -1);
        assertClose(t[6], -1);
        assertClose(t[7], +1);
        assertClose(t[8], +1);
        return 'roulis conforme';
    });

    test('Mixage — pitch unitaire (M5 +1 · M6 −1 · M7 −1 · M8 +1)', () => {
        const t = mixDofToMotors({ ...neutralDof(), pitch: 1 });
        assertClose(t[5], +1);
        assertClose(t[6], -1);
        assertClose(t[7], -1);
        assertClose(t[8], +1);
        return 'tangage conforme';
    });

    test('Mixage — DOF nul → tous les moteurs à 0', () => {
        const t = mixDofToMotors(neutralDof());
        for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) assertClose(t[id], 0);
        return 'neutre exact';
    });

    test('Mixage — normalisation par groupe (surge + yaw saturés, ratios préservés)', () => {
        const saturation = {};
        const t = mixDofToMotors({ ...neutralDof(), surge: 1, yaw: -1 }, saturation);
        assertTrue(saturation.H === true, 'groupe horizontal non signalé saturé');
        // M1 brut : +0,707 + 1 = 1,707 → ramené à 1 ; M4 brut : 0,707 − 1 = −0,293
        assertClose(t[1], 1, 1e-9);
        assertClose(t[4], -0.293 / 1.707, 1e-9);
        for (const id of [1, 2, 3, 4]) {
            assertTrue(Math.abs(t[id]) <= 1 + EPS, `M${id} hors bornes (${t[id]})`);
        }
        return 'facteur 1/1,707 appliqué au groupe';
    });

    test('Mixage — allocation inverse = transposée (gain surge = 2)', () => {
        const t = mixDofToMotors({ ...neutralDof(), surge: 1 });
        const dof = allocateMotorsToDof(t);
        assertClose(dof.surge, 2, 1e-3);
        assertClose(dof.sway, 0, 1e-3);
        assertClose(dof.yaw, 0, 1e-3);
        return 'Σ coef² = 2 pour surge';
    });

    test('Mixage — gains d’axes (≈ 2 pour surge/sway, 4 pour yaw/heave/roll/pitch)', () => {
        // Les coefficients du firmware (0,707) sont la troncature de √2/2 :
        // le gain horizontal vaut donc 4 × 0,707² = 1,999396, pas 2 exactement.
        const gainH = 4 * 0.707 * 0.707;
        assertClose(axisGain('surge'), gainH, 1e-9);
        assertClose(axisGain('sway'), gainH, 1e-9);
        for (const axis of ['yaw', 'heave', 'roll', 'pitch']) {
            assertClose(axisGain(axis), 4, 1e-9);
        }
        return `surge/sway = ${gainH.toFixed(6)} (coefficients 0,707) · axes rotationnels = 4`;
    });

    // --- Physique -------------------------------------------------------

    test('Physique — neutre sans dérive horizontale (5 s)', () => {
        const physics = new SimPhysics();
        simulate(physics, 5, neutralDof());
        const s = physics.snapshot();
        assertClose(s.pos.x, 0, 1e-9);
        assertClose(s.pos.north, 0, 1e-9);
        assertClose(s.vel.u, 0, 1e-9);
        assertClose(s.vel.v, 0, 1e-9);
        return 'u = v = x = y = 0';
    });

    test('Physique — vitesse terminale surge ≈ 1,5 m/s', () => {
        const physics = armed();
        simulate(physics, 6, { ...neutralDof(), surge: 1 });
        const u = physics.snapshot().vel.u;
        assertTrue(u > 1.3 && u < 1.55, `u = ${u.toFixed(3)} m/s`);
        return `u = ${u.toFixed(3)} m/s`;
    });

    test('Physique — vitesse terminale heave ≈ 0,9 m/s', () => {
        const physics = armed();
        physics.reset({ depth: 12, armState: 1, dryRun: false });
        simulate(physics, 5, { ...neutralDof(), heave: -1 });
        const w = physics.snapshot().vel.w;
        assertTrue(w < -0.8 && w > -1.0, `w = ${w.toFixed(3)} m/s`);
        return `w = ${w.toFixed(3)} m/s`;
    });

    test('Physique — rampe hélice (τ = 80 ms)', () => {
        const physics = armed();
        physics.setCommand({ ...neutralDof(), surge: 1 });
        physics.step(FIXED_DT_S);
        const afterOne = physics.state.thrust[0];
        assertTrue(afterOne > 0 && afterOne < 0.06, `thrust après 1 pas = ${afterOne.toFixed(4)}`);
        simulate(physics, 0.6, { ...neutralDof(), surge: 1 });
        const after600ms = physics.state.thrust[0];
        assertTrue(after600ms > 0.68, `thrust après 600 ms = ${after600ms.toFixed(4)}`);
        return `1 pas : ${(afterOne * 100).toFixed(1)} % → 600 ms : ${(after600ms * 100).toFixed(1)} %`;
    });

    test('Physique — retour à plat passif (roulis initial 40°)', () => {
        const physics = new SimPhysics();
        physics.reset({ roll: 40 * RAD, armState: 1, dryRun: false });
        simulate(physics, 12, neutralDof());
        const rollDeg = Math.abs(physics.snapshot().att.rollDeg);
        assertTrue(rollDeg < 5, `roulis résiduel = ${rollDeg.toFixed(2)}°`);
        return `roulis résiduel ${rollDeg.toFixed(2)}°`;
    });

    test('Physique — dry-run : poussées neutralisées', () => {
        const physics = new SimPhysics();
        physics.setArmState(1);
        physics.setDryRun(true);
        simulate(physics, 3, { ...neutralDof(), surge: 1 });
        const s = physics.snapshot();
        assertTrue(Math.abs(s.vel.u) < 1e-3, `u = ${s.vel.u}`);
        for (const t of s.thrust) assertTrue(Math.abs(t) < 1e-6, `poussée non nulle (${t})`);
        return 'sorties à zéro malgré la commande';
    });

    test('Physique — désarmé : poussées neutralisées', () => {
        const physics = new SimPhysics();
        physics.setDryRun(false);
        physics.setArmState(0);
        simulate(physics, 3, { ...neutralDof(), surge: 1 });
        assertTrue(Math.abs(physics.snapshot().vel.u) < 1e-3, 'le ROV avance désarmé');
        return 'ARMÉ requis pour pousser';
    });

    test('Physique — watchdog 500 ms sans commande → neutres', () => {
        const physics = armed();
        simulate(physics, 1.2, { ...neutralDof(), surge: 1 });
        const before = physics.snapshot();
        // Plus aucune commande ne rafraîchit la liaison
        simulate(physics, 0.8, { ...neutralDof(), surge: 1 }, { feed: false });
        const after = physics.snapshot();
        assertTrue(after.flags.watchdog === true, 'watchdog non déclenché');
        assertTrue(after.counters.watchdogTrips >= 1, 'aucun trip comptabilisé');
        assertTrue(Math.abs(after.thrust[0]) < 0.2, `poussée maintenue (${after.thrust[0]})`);
        assertTrue(after.vel.u < before.vel.u, 'la vitesse ne décroît pas');
        return `liaison perdue après 500 ms (trip n°${after.counters.watchdogTrips})`;
    });

    test('Physique — E-Stop : propulsion coupée même armé', () => {
        const physics = armed();
        simulate(physics, 2, { ...neutralDof(), surge: 1 });
        physics.setArmState(2);
        const uBefore = physics.snapshot().vel.u;
        simulate(physics, 3, { ...neutralDof(), surge: 1 });
        const s = physics.snapshot();
        assertTrue(s.vel.u < uBefore, 'la vitesse ne décroît pas sous E-Stop');
        assertTrue(Math.abs(s.thrust[0]) < 0.02, `poussée E-Stop non nulle (${s.thrust[0]})`);
        return `E-Stop verrouillé (état ${s.flags.armState})`;
    });

    test('Physique — assistance retour surface (montée plafonnée)', () => {
        const physics = new SimPhysics();
        physics.reset({ depth: 10, armState: 1, dryRun: false });
        physics.setSurfaceAssist(true);
        simulate(physics, 40, neutralDof());
        const depth = physics.snapshot().pos.depth;
        assertTrue(depth < 1, `profondeur finale = ${depth.toFixed(2)} m`);
        return `remonté de 10 m → ${depth.toFixed(2)} m`;
    });

    test('Physique — flottabilité résiduelle : remontée passive lente', () => {
        const physics = new SimPhysics();
        physics.reset({ depth: 5, armState: 1, dryRun: false });
        simulate(physics, 30, neutralDof());
        const depth = physics.snapshot().pos.depth;
        assertTrue(depth < 5 && depth > 0.5, `profondeur = ${depth.toFixed(2)} m`);
        return `5 m → ${depth.toFixed(2)} m en 30 s (sans commande)`;
    });

    test('Physique — butée de fond (25 m) et de surface', () => {
        const physics = new SimPhysics();
        physics.reset({ depth: 24.5, armState: 1, dryRun: false });
        simulate(physics, 10, { ...neutralDof(), heave: -1 });
        const bottom = physics.snapshot();
        assertTrue(bottom.pos.depth <= 25 + EPS, `profondeur = ${bottom.pos.depth}`);
        assertTrue(bottom.vel.w >= -EPS, 'vitesse de descente non annulée au fond');
        physics.setCommand({ ...neutralDof(), heave: 1 });
        simulate(physics, 60, { ...neutralDof(), heave: 1 });
        const top = physics.snapshot();
        assertTrue(top.pos.depth <= EPS, `profondeur = ${top.pos.depth}`);
        assertTrue(top.vel.w <= EPS, 'le ROV sort de l’eau');
        return 'fond et surface respectés';
    });

    // --- Batterie -------------------------------------------------------

    test('Batterie — OCV 12,6 V (100 %) · 11,1 V (20 %) · 9,9 V (0 %)', () => {
        const physics = new SimPhysics();
        assertClose(physics.openCircuitVoltage(1.0), 12.6, 0.01);
        assertClose(physics.openCircuitVoltage(0.2), 11.1, 0.01);
        assertClose(physics.openCircuitVoltage(0.0), 9.9, 0.01);
        return 'courbe de décharge conforme';
    });

    test('Batterie — décharge sous charge, tension et SOC décroissants', () => {
        const physics = armed();
        simulate(physics, 5, neutralDof());
        const a = physics.snapshot();
        simulate(physics, 120, { ...neutralDof(), heave: 1 });
        const b = physics.snapshot();
        assertTrue(b.battery.soc < a.battery.soc, 'SOC non décroissant');
        assertTrue(b.battery.soc < 1.0, 'aucune consommation');
        assertTrue(b.battery.current > 0.35, 'courant total sous le repos');
        assertTrue(b.battery.voltage < b.battery.ocv, 'aucune chute ohmique');
        return `SOC ${(a.battery.soc * 100).toFixed(2)} % → ${(b.battery.soc * 100).toFixed(2)} % · V = ${b.battery.voltage.toFixed(2)} V · I = ${b.battery.current.toFixed(1)} A`;
    });

    return results;
}

// ===================================================================== //
// Extensions « décor immersif »                                          //
// ===================================================================== //

/**
 * Harnais complet : les 24 cas noyau puis les groupes étendus (bruit
 * procédural, terrain, bornes de monde injectées, FSM mammifère, zones
 * de spawn, fusion des réglages). Les modules de décor importent
 * Three.js via l'importmap : s'il est absent, ils sont ignorés
 * proprement (un cas d'information est ajouté en fin de liste).
 */
export async function runTestsAsync() {
    const results = runTests();
    let mods;
    try {
        mods = await loadEnvModules();
    } catch (error) {
        results.push({
            name: 'Extensions décor (bruit, terrain, bornes, FSM, zones, réglages)',
            pass: true,
            detail: `non exécutées — vendor Three.js requis (${String(error.message || error)})`,
        });
        return results;
    }
    runEnvTests(results, mods);
    return results;
}

async function loadEnvModules() {
    const [noise, terrain, fauna, defaults] = await Promise.all([
        import('./env/env-noise.js'),
        import('./env/env-terrain.js'),
        import('./env/env-fauna.js'),
        import('./env/env-defaults.js'),
    ]);
    return { noise, terrain, fauna, defaults };
}

/** Monde de test isolé : 200 m × 200 m, fosse 15 %/45 % à −100 m. */
const TEST_WORLD = Object.freeze({
    extent: 200, depth: 100, relief: true, reliefAmp: 1,
    pitDepthPct: 15, pitRadiusPct: 45, beachExtent: 10, reefExtent: 20,
    compactZone: 0, walls: true,
});

/** Pseudo-groupe Three.js minimal pour positionInZone (position + rotation.y). */
function fakeGroup() {
    return {
        position: {
            x: 0, y: 0, z: 0,
            set(x, y, z) { this.x = x; this.y = y; this.z = z; },
        },
        rotation: { y: 0 },
    };
}

function runEnvTests(results, { noise, terrain, fauna, defaults }) {
    const test = (name, fn) => {
        try {
            const detail = fn();
            results.push({ name, pass: true, detail: detail || 'OK' });
        } catch (error) {
            results.push({ name, pass: false, detail: String(error.message || error) });
        }
    };
    const close = (actual, expected, eps = 1e-9) => assertClose(actual, expected, eps);

    // --- Bruit procédural ----------------------------------------------

    test('Bruit — mulberry32 déterministe (même graine ⇒ même suite, ∈ [0,1[)', () => {
        const a = noise.mulberry32(1234);
        const b = noise.mulberry32(1234);
        for (let i = 0; i < 5; i++) close(a(), b(), 0);
        assertTrue(noise.mulberry32(9876)() !== noise.mulberry32(1234)(),
            'graines différentes ⇒ même tirage');
        const v = noise.mulberry32(42)();
        assertTrue(v >= 0 && v < 1, `tirage hors [0,1[ (${v})`);
        return 'suite reproductible';
    });

    test('Bruit — noise2/fbm2 déterministes, bornés [0,1], continus', () => {
        close(noise.noise2(3.7, -12.4), noise.noise2(3.7, -12.4), 0);
        close(noise.fbm2(3.7, -12.4), noise.fbm2(3.7, -12.4), 0);
        for (let i = 0; i < 60; i++) {
            const v = noise.fbm2(i * 1.37 - 20, Math.sin(i * 0.7) * 9);
            assertTrue(v >= 0 && v <= 1, `fbm2 hors bornes (${v})`);
        }
        const jump = Math.abs(noise.fbm2(3.71, -12.4) - noise.fbm2(3.7, -12.4));
        assertTrue(jump < 0.1, `discontinuité fbm2 (${jump})`);
        assertTrue(noise.hash2(3, 7) === noise.hash2(3, 7), 'hash2 instable');
        return 'déterminisme + bornes [0,1] + continuité vérifiés';
    });

    // --- Terrain, zones : monde de test appliqué puis restauré ----------
    // (l'écran live partage l'état du module : restauration synchrone
    //  dans le finally, aucune frame rendue entre les deux).

    const savedWorld = JSON.parse(JSON.stringify(terrain.getWorldState().world));
    try {
        terrain.applyWorldConfig(TEST_WORLD);

        test('Terrain — fosse creusée au centre, plaine du lagon à pitDepthPct', () => {
            close(terrain.terrainHeightAt(0, 0), -100, 1e-9);
            const y50 = terrain.terrainHeightAt(50, 0);      // flanc de fosse
            const y65 = terrain.terrainHeightAt(65, 0);      // plaine du lagon
            assertTrue(y50 > -95 && y50 < -78, `flanc y(50 m) = ${y50.toFixed(2)}`);
            assertTrue(y65 > -6 && y65 < 0.5, `plaine y(65 m) = ${y65.toFixed(2)}`);
            assertTrue(y50 < y65, 'le flanc ne remonte pas vers la plaine');
            close(terrain.lagoonFloorY(), -15, 1e-9);
            close(terrain.pitRadiusWorld(), 45, 1e-9);
            return `centre −100 m · flanc ${y50.toFixed(1)} m · plaine ${y65.toFixed(1)} m`;
        });

        test('Terrain — plage et récif remontent vers la surface au bord', () => {
            const yReef = terrain.terrainHeightAt(80, 0);      // anneau récif
            const yBeach = terrain.terrainHeightAt(99.9, 0);   // plage au bord
            assertTrue(yReef > -5 && yReef < -1, `récif y(80 m) = ${yReef.toFixed(2)}`);
            assertTrue(yBeach > -1 && yBeach < 0, `plage y(99,9 m) = ${yBeach.toFixed(2)}`);
            return `récif ${yReef.toFixed(2)} m → plage ${yBeach.toFixed(2)} m (surface −0,5 m)`;
        });

        test('Terrain — bornes monde et plancher de pilotage (garde de coque)', () => {
            const wb = terrain.worldBounds();
            close(wb.floorY, -100, 1e-9);
            close(wb.wallLimit, 99.5, 1e-9);
            close(wb.ceilY, 0, 1e-9);
            close(terrain.floorLimitAt(0, 0), -100 + 0.25, 1e-9);
            terrain.applyWorldConfig({ ...TEST_WORLD, relief: false });
            close(terrain.floorLimitAt(65, 0), -100 + 0.25, 1e-9);
            terrain.applyWorldConfig(TEST_WORLD);
            const withRelief = terrain.floorLimitAt(65, 0);
            assertTrue(withRelief > -6 && withRelief < 0, `sonde relief = ${withRelief.toFixed(2)}`);
            return `murs ±99,5 m · plancher plat −99,75 m → relief ${withRelief.toFixed(2)} m (65 m)`;
        });

        test('Zones — pleine eau biaisée vers la surface', () => {
            const group = fakeGroup();
            const obj = { zone: 'pleine_eau', type: 'faune' };
            const N = 400;
            let sum = 0;
            for (let i = 0; i < N; i++) {
                fauna.positionInZone(group, obj);
                const y = group.position.y;
                assertTrue(y <= -20 + 1e-9 && y > -97 - 1e-9,
                    `y hors colonne d'eau (${y.toFixed(2)})`);
                sum += y;
            }
            const mean = sum / N;
            assertTrue(mean > -52, `moyenne non biaisée (${mean.toFixed(2)} m)`);
            return `moyenne ${mean.toFixed(1)} m (colonne −20 → −97 m, biais surface)`;
        });

        test('Zones — abysse confiné dans la fosse, surface au plafond', () => {
            const group = fakeGroup();
            const abyssR = terrain.fondZoneRadius() * 0.85;
            for (let i = 0; i < 200; i++) {
                fauna.positionInZone(group, { zone: 'abysse', type: 'faune' });
                const d = Math.hypot(group.position.x, group.position.z);
                assertTrue(d <= abyssR + 1e-9, `abysse hors fosse (${d.toFixed(1)} m > ${abyssR.toFixed(1)})`);
            }
            for (let i = 0; i < 200; i++) {
                fauna.positionInZone(group, { zone: 'surface', type: 'faune' });
                const y = group.position.y;
                assertTrue(y >= -5 - 1e-9 && y <= -2 + 1e-9, `surface hors bandeau (${y.toFixed(2)})`);
            }
            return `abysse ≤ ${abyssR.toFixed(0)} m du centre · surface entre −2 et −5 m`;
        });

        test('Zones — fond : plancher du lagon hors fosse, collé au sol', () => {
            const group = fakeGroup();
            const pitR = terrain.pitRadiusWorld();
            const halfW = terrain.compactHalfW();
            const N = 300;
            let sumR = 0, minDy = Infinity, maxDy = -Infinity;
            for (let i = 0; i < N; i++) {
                fauna.positionInZone(group, { zone: 'fond', type: 'faune' });
                const { x, y, z } = group.position;
                const dist = Math.hypot(x, z);
                assertTrue(dist >= pitR * 1.15 - 1e-9, `fond dans la fosse (${dist.toFixed(1)} m)`);
                assertTrue(dist <= halfW + 1e-9, `fond hors bassin (${dist.toFixed(1)} m)`);
                const dy = y - terrain.terrainMeshHeightAt(x, z);
                assertTrue(dy >= 0.3 - 1e-9 && dy <= 2.7 + 1e-9,
                    `hauteur hors bande (dy = ${dy.toFixed(2)} m)`);
                sumR += dist;
                minDy = Math.min(minDy, dy);
                maxDy = Math.max(maxDy, dy);
            }
            // Flore posée au fond : exactement 5 cm au-dessus du plancher local.
            fauna.positionInZone(group, { zone: 'fond', type: 'flore' });
            close(group.position.y - terrain.terrainMeshHeightAt(group.position.x, group.position.z), 0.05, 1e-9);
            return `${N} tirages · rayon moyen ${(sumR / N).toFixed(1)} m (fosse ${pitR.toFixed(0)} m) · ${minDy.toFixed(2)}–${maxDy.toFixed(2)} m au-dessus du plancher`;
        });

        test('Zones — flore au sol : ancrée au relief (terrain + 5 cm), hors fosse', () => {
            const group = fakeGroup();
            const pitR = terrain.pitRadiusWorld();
            const N = 300;
            let minY = Infinity, maxY = -Infinity;
            for (let i = 0; i < N; i++) {
                fauna.positionInZone(group, { zone: 'sol', type: 'flore' });
                const { x, y, z } = group.position;
                const dist = Math.hypot(x, z);
                assertTrue(dist >= pitR * 1.05 - 1e-9, `flore dans la fosse (${dist.toFixed(1)} m)`);
                close(y, terrain.terrainMeshHeightAt(x, z) + 0.05, 1e-9);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
            assertTrue(maxY - minY > 5, `relief non suivi (amplitude ${(maxY - minY).toFixed(1)} m)`);
            return `${N} plants ancrés · altitudes ${minY.toFixed(1)} → ${maxY.toFixed(1)} m (relief suivi)`;
        });

        test('Bancs — nuage d’offsets centré, borné par l’enveloppe, déterministe', () => {
            const spread = 4;
            const offsets = fauna.schoolOffsets(24, spread, () => 0.5);
            close(offsets.length, 24, 0);
            let sx = 0, sz = 0, maxR = 0;
            for (const o of offsets) {
                const r = Math.hypot(o.x, o.z);
                assertTrue(r <= spread + 1e-9, `offset hors enveloppe (${r.toFixed(2)} > ${spread})`);
                close(o.y, 0, 1e-9);
                sx += o.x; sz += o.z;
                maxR = Math.max(maxR, r);
            }
            close(sx / offsets.length, 0, 1e-9);
            close(sz / offsets.length, 0, 1e-9);
            assertTrue(maxR > spread * 0.8, `nuage trop resserré (${maxR.toFixed(2)} m)`);
            const again = fauna.schoolOffsets(24, spread, () => 0.5);
            for (let i = 0; i < offsets.length; i++) {
                close(again[i].x, offsets[i].x, 0);
                close(again[i].z, offsets[i].z, 0);
            }
            const single = fauna.schoolOffsets(1, spread, () => 0.5);
            close(Math.hypot(single[0].x, single[0].z), 0, 1e-9);
            for (const o of fauna.schoolOffsets(6, 0.01, () => 0.5)) {
                assertTrue(Math.hypot(o.x, o.z) <= 0.1 + 1e-9, 'garde de spread minimal absente');
            }
            return `24 compagnons · enveloppe ${maxR.toFixed(2)} m (spread ${spread}) · barycentre recentré`;
        });

        test('Bancs — huit partagé : parcours fermé, borné, croisant son centre', () => {
            const cx = 12, cz = -7, rx = 8, rz = 5;
            const p0 = fauna.lemniscatePoint(cx, cz, rx, rz, 0);
            close(p0.x, cx + rx, 1e-9);
            close(p0.z, cz, 1e-9);
            close(fauna.lemniscatePoint(cx, cz, rx, rz, Math.PI).x, cx - rx, 1e-9);
            const mid = fauna.lemniscatePoint(cx, cz, rx, rz, Math.PI / 2);
            close(mid.x, cx, 1e-9);
            close(mid.z, cz, 1e-9);
            for (let i = 0; i < 200; i++) {
                const t = (i / 200) * Math.PI * 2;
                const p = fauna.lemniscatePoint(cx, cz, rx, rz, t);
                assertTrue(Math.abs(p.x - cx) <= rx + 1e-9, `débordement X (${(p.x - cx).toFixed(2)} m)`);
                // max |sinT·cosT / (1 + sin²T)| = 1/√8 (atteint pour sin²T = 1/3).
                assertTrue(Math.abs(p.z - cz) <= rz / Math.sqrt(8) + 1e-9,
                    `débordement Z (${(p.z - cz).toFixed(2)} m)`);
            }
            const wrap = fauna.lemniscatePoint(cx, cz, rx, rz, Math.PI * 2 + 0.37);
            const base = fauna.lemniscatePoint(cx, cz, rx, rz, 0.37);
            close(wrap.x, base.x, 1e-9);
            close(wrap.z, base.z, 1e-9);
            return `huit ±${rx} m × ±${(rz / Math.sqrt(8)).toFixed(2)} m · croise son centre en T = π/2`;
        });
    } finally {
        terrain.applyWorldConfig(savedWorld);
    }

    // --- Bornes de monde dynamiques (physique, instances locales) -------

    test('Physique — bornes injectées : fond 6 m, murs ±4 m, surface 0', () => {
        const physics = new SimPhysics();
        physics.setEnvironment({ floorDepthAt: () => 6, wallLimit: 4 });
        physics.setDryRun(false);
        physics.setArmState(1);

        physics.reset({ depth: 2, armState: 1, dryRun: false });
        simulate(physics, 20, { ...neutralDof(), heave: -1 });
        const bottom = physics.snapshot();
        close(bottom.pos.depth, 6, 1e-9);
        assertTrue(bottom.vel.w >= -EPS, `descente non annulée au fond (${bottom.vel.w})`);

        simulate(physics, 25, { ...neutralDof(), surge: 1 });
        close(physics.snapshot().pos.x, 4, 1e-9);

        physics.reset({ depth: 2, armState: 1, dryRun: false });
        simulate(physics, 12, { ...neutralDof(), heave: 1 });
        close(physics.snapshot().pos.depth, 0, 1e-9);
        return 'sonde de fond, parois et surface respectées';
    });

    // --- FSM mammifère ---------------------------------------------------

    test('FSM mammifère — cycle complet surface → … → surface', () => {
        const rand = () => 0.5;
        let m = { state: 'surface', timer: 0, y: -2, targetY: -2, floorY: -20 };
        const seen = [];
        for (let guard = 0; guard < 30; guard++) {
            if (seen[seen.length - 1] !== m.state) seen.push(m.state);
            if (seen.length > 1 && m.state === 'surface') break;
            const tr = fauna.mammalFsmNext(m.state,
                { timer: m.timer, y: m.y, targetY: m.targetY, floorY: m.floorY }, rand);
            if (tr) {
                m = { ...m, ...tr };
                if (tr.timer == null) {
                    // Les durées de phase (surfDur / profDur) viennent de l'appelant
                    m.timer = tr.state === 'profondeur' ? 5 : (tr.state === 'surface' ? 8 : m.timer);
                }
            } else {
                m.timer = 0;        // le temps s'écoule…
                m.y = m.targetY;    // …et la cible de la phase est rejointe
            }
        }
        assertTrue(seen.length === 6, `cycle incomplet (${seen.join(' → ')})`);
        assertTrue(seen[0] === 'surface' && seen[5] === 'surface', `cycle : ${seen.join(' → ')}`);
        assertTrue(new Set(seen.slice(0, 5)).size === 5, `états manquants (${seen.join(' → ')})`);
        return seen.join(' → ');
    });

    test('FSM mammifère — tirages et garde-fous des transitions', () => {
        const f = fauna.mammalFsmNext;
        const p = (over) => ({ timer: 0, y: -2, targetY: -2, floorY: -20, ...over });

        // surface : rien tant que le séjour court, sinon plongeon (timer / assiette)
        assertTrue(f('surface', p({ timer: 3 }), () => 0.5) === null, 'plongeon prématuré');
        assertTrue(f('surface', p({ y: -8 }), () => 0.5) === null, 'plongeon sous la cote');
        const dive = f('surface', p(), () => 0.5);
        assertTrue(dive.state === 'plongeon', 'état de plongeon manquant');
        close(dive.timer, 4, 1e-9);
        close(dive.pitchTarget, -0.95, 1e-9);

        // plongeon : cible dans la moitié supérieure de la colonne d'eau
        const down = f('plongeon', p(), () => 0.5);
        assertTrue(down.state === 'descente', 'état de descente manquant');
        close(down.targetY, -11, 1e-9);
        assertTrue(f('plongeon', p(), () => 0.999).targetY < -14, 'cible de descente trop haute');

        // descente : cible atteinte ou plancher ⇒ profondeur, sinon null
        assertTrue(f('descente', p({ y: -10.1, targetY: -10 }), () => 0.5).state === 'profondeur',
            'palier non détecté');
        assertTrue(f('descente', p({ y: -19.8, targetY: -30 }), () => 0.5).state === 'profondeur',
            'plancher non détecté');
        assertTrue(f('descente', p({ y: -5, targetY: -10 }), () => 0.5) === null,
            'transition en pleine eau');

        // profondeur : remontée biaisée vers la surface (rand < 0,6)
        const up = f('profondeur', p({ y: -12 }), () => 0.3);
        assertTrue(up.state === 'remontee', 'état de remontée manquant');
        close(up.targetY, -20 * (0.05 + 0.3 * 0.15), 1e-9);
        assertTrue(f('profondeur', p({ y: -12 }), () => 0.9).targetY < up.targetY,
            'cible profonde non distincte');

        // remontée : surface rejointe, sinon null
        assertTrue(f('remontee', p({ y: -2.2, targetY: -2 }), () => 0.5).state === 'surface',
            'surface non rejointe');
        assertTrue(f('remontee', p({ y: -8, targetY: -2 }), () => 0.5) === null, 'surface trop précoce');
        return 'transitions, tirages et garde-fous conformes';
    });

    // --- Fusion des réglages persistés -----------------------------------

    test('Réglages — fusion partielle : seules les clés fournies écrasent les défauts', () => {
        const base = defaults.resolveSimulatorSettings(null);
        const merged = defaults.resolveSimulatorSettings({
            world: { depth: 42 }, physics: { mass_kg: 15.5 },
        });
        close(merged.world.depth, 42, 0);
        close(merged.world.extent, base.world.extent, 0);
        close(merged.physics.mass_kg, 15.5, 0);
        close(merged.physics.thrust_max_n, base.physics.thrust_max_n, 0);
        close(merged.cam.fov, base.cam.fov, 0);
        close(merged.scene.objects.length, base.scene.objects.length, 0);
        return `profondeur ${merged.world.depth} m · masse ${merged.physics.mass_kg} kg · défauts préservés`;
    });

    test('Réglages — liste d’objets remplacée en bloc, liste vide → défauts', () => {
        const base = defaults.resolveSimulatorSettings(null);
        const custom = defaults.resolveSimulatorSettings({
            scene: { objects: [{ name: 'Essai', model: 'guppy.glb', count: 3 }] },
        });
        assertTrue(custom.scene.objects.length === 1 && custom.scene.objects[0].name === 'Essai',
            'liste personnalisée non respectée');
        const empty = defaults.resolveSimulatorSettings({ scene: { objects: [] } });
        close(empty.scene.objects.length, base.scene.objects.length, 0);
        return `${base.scene.objects.length} défauts · 1 objet personnalisé · vide → défauts`;
    });
}
