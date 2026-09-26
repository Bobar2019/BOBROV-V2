/**
 * BOBROV-V2 — Sub Simulator immersif · terrain « Blue Hole ».
 *
 * Portage fidèle de BOBROV-main (simulator3d.js, L403-927) : bruit,
 * topographie par zones %, maillage terrain à couleurs biomes, parois
 * rocheuses 45°, dispersion de la vie récifale. Les globals diveState /
 * WALL_POS / FLOOR_Y / terrainMesh deviennent un état de module privé,
 * piloté par `applyWorldConfig()`.
 *
 * Extension « fosse » (héritée des réglages abyssDepth/abyssRadius de
 * l'ancienne page CONFIG SCÈNE 3D) :
 *   - pitDepthPct (défaut 15 %) : profondeur du lagon (plaine hors fosse)
 *     en % de la profondeur du monde → 15 % = lagon à −45 m pour un monde
 *     de 300 m ; 100 % = fond plat à FLOOR_Y (comportement d'origine) ;
 *   - pitRadiusPct (défaut 45 %) : rayon de la fosse en % de la demi-étendue.
 * Les zones plage/récif sont proportionnelles à la profondeur DU LAGON :
 * à pitDepthPct = 100 %, le terrain reproduit exactement l'ancien code.
 */

import * as THREE from 'three';
import { CEIL_Y, HULL_CLEARANCE, WORLD_DEFAULTS, mergeDeep } from './env-defaults.js';
import { fbm2, mulberry32, makeRockTexture, makeRockNormalMap } from './env-noise.js';

/** Constante d'origine : rayon d'exclusion autour du ROV pour les spawns. */
const LIFE_SPAWN_GUARD = 2.0;

// ---------------------------------------------------------------------- //
// État du monde (équivalent diveState + WALL_POS / FLOOR_Y / REEF_DEPTH)  //
// ---------------------------------------------------------------------- //

const state = {
    world: { ...WORLD_DEFAULTS },
    floorY: -WORLD_DEFAULTS.depth,
    wallPos: WORLD_DEFAULTS.extent / 2,
    wallLimit: WORLD_DEFAULTS.extent / 2 - 0.5,
    wallsGroup: null,
    terrainMesh: null,
    biomeUniforms: null,
    wallTex: null,
    wallNrm: null,
    wallMat: null,
};

/** Applique une configuration monde (fusionnée avec les défauts). */
export function applyWorldConfig(worldCfg) {
    state.world = mergeDeep({ ...WORLD_DEFAULTS }, worldCfg || {});
    state.floorY = -state.world.depth;
    state.wallPos = Math.max(10, state.world.extent / 2);
    state.wallLimit = state.wallPos - 0.5;
    return getWorldState();
}

/** Lecture seule de l'état dérivé (bornes physiques, mesh terrain…). */
export function getWorldState() {
    return {
        world: state.world,
        floorY: state.floorY,
        wallPos: state.wallPos,
        wallLimit: state.wallLimit,
        reefDepth: reefDepth(),
        lagoonY: lagoonFloorY(),
        pitRadius: pitRadiusWorld(),
        terrainBuilt: !!state.terrainMesh,
    };
}

/** Bornes physiques seules — consommées par sim-physics via sim.js. */
export function worldBounds() {
    return { floorY: state.floorY, wallLimit: state.wallLimit, ceilY: CEIL_Y };
}

// ---------------------------------------------------------------------- //
// Topographie dérivée                                                     //
// ---------------------------------------------------------------------- //

/** Profondeur de la plaine du lagon (m, positif) = depth × pitDepthPct / 100. */
export function lagoonDepth() { return state.world.depth * state.world.pitDepthPct / 100; }

/** Profondeur absolue du bas de la plage (m, positif). */
export function beachBottomDepth() { return lagoonDepth() * state.world.beachDepthPct / 100; }

/** Profondeur absolue du bas du récif (m, positif). */
export function reefBottomDepth() {
    return lagoonDepth() * (state.world.beachDepthPct + state.world.reefDepthPct) / 100;
}

/** Profondeur du sommet du récif = bas de la plage (compat « REEF_DEPTH »). */
export function reefDepth() { return beachBottomDepth(); }

/** Y de la plaine du lagon (négatif). */
export function lagoonFloorY() { return state.floorY * state.world.pitDepthPct / 100; }

/** Rayon de la fosse en mètres. */
export function pitRadiusWorld() { return state.wallPos * state.world.pitRadiusPct / 100; }

/** Rayon de la zone fond/plaine depuis le centre (m). */
export function fondZoneRadius() {
    return state.wallPos * Math.max(0, 100 - state.world.beachExtent - state.world.reefExtent) / 100;
}

/** Rayons intérieur/extérieur de l'anneau récif (source unique de vérité). */
export function reefRingRadii() {
    const beachFrac = state.world.beachExtent / 100;
    const reefFrac = state.world.reefExtent / 100;
    return {
        innerR: state.wallPos * Math.max(0, 1.0 - beachFrac - reefFrac),
        outerR: state.wallPos * (1.0 - beachFrac),
    };
}

/** Nombre de segments du maillage terrain (identique à l'origine). */
export function terrainSegs() {
    return THREE.MathUtils.clamp(Math.round((state.wallPos * 2) / 1.4), 128, 320);
}

/** Demi-largeur effective de la « zone compacte » (0 % = bassin, 100 % = 10 m). */
export function compactHalfW() {
    const pct = state.world.compactZone / 100;
    return THREE.MathUtils.lerp(state.wallLimit, 10, pct);
}

function smooth01(t) { return t * t * (3 - 2 * t); }

/**
 * Hauteur du relief : Blue Hole (plage → récif → plaine du lagon → fosse).
 * Copie de l'algorithme d'origine, généralisée par la fosse (voir en-tête).
 */
export function terrainHeightAt(x, z) {
    const dist = Math.hypot(x, z);
    const distPct = dist / state.wallPos;   // 0 = centre, 1 = bord

    const beachFrac = state.world.beachExtent / 100;
    const reefFrac = state.world.reefExtent / 100;
    const beachInner = 1.0 - beachFrac;
    const reefInner = Math.max(0, beachInner - reefFrac);

    const surfaceY = CEIL_Y - 0.5;
    const lagonY = lagoonFloorY();
    const beachBotY = -beachBottomDepth();
    const reefBotY = -reefBottomDepth();
    const floorY = state.floorY;

    const reefNoise = state.world.relief
        ? (Math.pow(fbm2(x * 0.35 + 7.3, z * 0.35 + 3.1), 1.4) * 0.30
            + fbm2(x * 1.1 + 19.7, z * 1.1 + 5.9) * 0.22
            + fbm2(x * 3.2 + 41.0, z * 3.2 + 13.7) * 0.08)
            * state.world.reliefAmp
        : 0;

    // Bassin trop peu profond : pas de zones distinctes → pente simple
    if (state.world.depth < 3) {
        const t = THREE.MathUtils.smoothstep(distPct, 0, 1);
        return floorY + (surfaceY - floorY) * t;
    }

    let computedY;

    if (distPct >= beachInner) {
        // ── PLAGE : pente douce de beachBotY → surfaceY ──
        const t = THREE.MathUtils.smoothstep(distPct, beachInner, 1.0);
        const s = smooth01(t);
        computedY = beachBotY + (surfaceY - beachBotY) * s;
        const sandBlend = 1.0 - THREE.MathUtils.smoothstep(distPct, beachInner, beachInner + (1.0 - beachInner) * 0.4);
        computedY += reefNoise * sandBlend * 0.5;
    } else if (distPct >= reefInner) {
        // ── RÉCIF : pente de reefBotY → beachBotY + relief ──
        const t = THREE.MathUtils.smoothstep(distPct, reefInner, beachInner);
        const s = smooth01(t);
        computedY = reefBotY + (beachBotY - reefBotY) * s + reefNoise;
    } else {
        // ── FOND : plaine du lagon avec montée vers le récif ──
        const floorVar = state.world.relief
            ? fbm2(x * 0.06 + 3.7, z * 0.06 + 8.2) * Math.min(state.world.depth * 0.03, 3)
            : 0;
        if (reefInner > 0.01) {
            const t = THREE.MathUtils.smoothstep(distPct, 0, reefInner);
            const s = smooth01(t);
            computedY = lagonY + floorVar + (reefBotY - lagonY) * s;
            const reefProximity = THREE.MathUtils.smoothstep(distPct, reefInner * 0.5, reefInner);
            computedY += reefNoise * reefProximity;
        } else {
            computedY = lagonY + floorVar;
        }
        // ── FOSSE : creusement central de la plaine vers FLOOR_Y ──
        const pitPct = state.world.pitRadiusPct / 100;
        if (floorY < lagonY - 0.5 && pitPct > 0.001) {
            const edge = Math.min(pitPct + Math.max(0.04, pitPct * 0.35), Math.max(reefInner, pitPct + 0.01));
            const tPit = THREE.MathUtils.smoothstep(distPct, pitPct, edge);
            const sPit = smooth01(tPit);
            computedY = floorY + (computedY - floorY) * sPit;
        }
    }

    return Math.max(computedY, floorY);
}

/** Plancher de pilotage : terrain (+ garde de coque) ou FLOOR_Y si relief off. */
export function floorLimitAt(x, z) {
    const base = state.world.relief ? terrainHeightAt(x, z) : state.floorY;
    return Math.min(base + HULL_CLEARANCE, CEIL_Y - 0.3);
}

/** Hauteur du relief telle que RENDUE par le maillage (bilinéaire). */
export function terrainMeshHeightAt(x, z) {
    if (!state.world.relief || !state.terrainMesh) return state.floorY;
    const half = state.wallPos;
    const segs = terrainSegs();
    const step = (half * 2) / segs;
    const gx = THREE.MathUtils.clamp((x + half) / step, 0, segs - 1e-4);
    const gz = THREE.MathUtils.clamp((z + half) / step, 0, segs - 1e-4);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const x0 = -half + ix * step, x1 = x0 + step;
    const z0 = -half + iz * step, z1 = z0 + step;
    const h00 = terrainHeightAt(x0, z0), h10 = terrainHeightAt(x1, z0);
    const h01 = terrainHeightAt(x0, z1), h11 = terrainHeightAt(x1, z1);
    return (h00 + (h10 - h00) * fx) * (1 - fz) + (h01 + (h11 - h01) * fx) * fz;
}

const _terrNrm = new THREE.Vector3();

/** Normale du terrain (différences finies, pas 0,75 m). */
export function terrainNormalAt(x, z) {
    if (!state.world.relief || !state.terrainMesh) return _terrNrm.set(0, 1, 0);
    const e = 0.75;
    const hL = terrainHeightAt(x - e, z), hR = terrainHeightAt(x + e, z);
    const hD = terrainHeightAt(x, z - e), hU = terrainHeightAt(x, z + e);
    return _terrNrm.set(hL - hR, 2 * e, hD - hU).normalize();
}

// ---------------------------------------------------------------------- //
// Dispersion de la vie récifale                                           //
// ---------------------------------------------------------------------- //

/** Point aléatoire sur le plancher (hors rayon de garde autour de l'origine). */
export function randomFloorPoint(rng, margin) {
    let x, z;
    const lim = compactHalfW() - margin;
    do {
        x = (rng() * 2 - 1) * lim;
        z = (rng() * 2 - 1) * lim;
    } while (Math.hypot(x, z) < LIFE_SPAWN_GUARD);
    return { x, z };
}

/** Point aléatoire sur le plateau récifal (repli : plancher). */
export function randomReefPoint(rng, margin) {
    for (let k = 0; k < 24; k++) {
        const p = randomFloorPoint(rng, margin);
        if (!state.world.relief) return p;
        if (terrainHeightAt(p.x, p.z) > -reefBottomDepth() - 1.5) return p;
    }
    return randomFloorPoint(rng, margin);
}

/** Aire approximative du plateau récifal (hors fosse). */
export function reefPlateauArea() {
    const R = Math.max(1, state.wallLimit);
    const rPit = (state.floorY < -reefDepth() - 1) ? Math.min(R, pitRadiusWorld()) : 0;
    return Math.max(1, Math.PI * (R * R - rPit * rPit));
}

/** Compte plafonné par la densité (identique à l'origine). */
export function reefCount(perM2, cap, densFactor) {
    return Math.min(cap, Math.max(0, Math.round(reefPlateauArea() * perM2 * densFactor)));
}

/** Sphère englobante de la vie récifale (frustum culling par mesh). */
export function reefBoundingSphere() {
    return new THREE.Sphere(
        new THREE.Vector3(0, (CEIL_Y + state.floorY) * 0.5, 0),
        Math.hypot(state.wallPos, Math.abs(state.floorY)) + 5);
}

/** Amas de points autour de centres récifaux (algues, coraux). */
export function scatterReefClusters(rng, cap, margin, clusterR) {
    const K = Math.max(6, Math.round(cap / 25));
    const centers = [];
    for (let k = 0; k < K; k++) centers.push(randomReefPoint(rng, margin + clusterR));
    const lim = state.wallLimit - margin;
    const pts = [];
    for (let i = 0; i < cap; i++) {
        const c = centers[(rng() * K) | 0];
        const a = rng() * Math.PI * 2;
        const r = Math.pow(rng(), 0.6) * clusterR;
        pts.push({
            x: THREE.MathUtils.clamp(c.x + Math.cos(a) * r, -lim, lim),
            z: THREE.MathUtils.clamp(c.z + Math.sin(a) * r, -lim, lim),
        });
    }
    return pts;
}

// ---------------------------------------------------------------------- //
// Parois rocheuses 45° (buildWalls)                                       //
// ---------------------------------------------------------------------- //

/**
 * (Re)construit les 4 parois inclinées 45° avec relief irrégulier.
 * @param {THREE.Scene} scene
 * @param {{anisotropy?: number, registerMat?: (m: THREE.Material) => void}} ctx
 */
export function buildWalls(scene, ctx = {}) {
    if (state.wallsGroup) {
        scene.remove(state.wallsGroup);
        state.wallsGroup.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
        state.wallsGroup = null;
    }
    if (!state.world.walls) return;

    const anisotropy = ctx.anisotropy || 1;
    if (!state.wallTex) state.wallTex = makeRockTexture(anisotropy);
    if (!state.wallNrm) state.wallNrm = makeRockNormalMap();
    if (!state.wallMat) {
        state.wallMat = new THREE.MeshStandardMaterial({
            map: state.wallTex, normalMap: state.wallNrm, normalScale: new THREE.Vector2(1.8, 1.8),
            roughness: 0.95, metalness: 0.0,
        });
        if (ctx.registerMat) ctx.registerMat(state.wallMat);
    }

    const h = CEIL_Y - state.floorY;
    const wallW = state.wallPos * 2;
    const halfH = h / 2;
    const offset = halfH * Math.SQRT1_2; // évasement 45°
    state.wallsGroup = new THREE.Group();

    [
        { x: 0, z: -(state.wallPos - offset), rx: -Math.PI / 4, ry: 0, rz: 0 },
        { x: 0, z: (state.wallPos - offset), rx: Math.PI / 4, ry: Math.PI, rz: 0 },
        { x: -(state.wallPos - offset), z: 0, rx: 0, ry: Math.PI / 2, rz: -Math.PI / 4 },
        { x: (state.wallPos - offset), z: 0, rx: 0, ry: -Math.PI / 2, rz: Math.PI / 4 },
    ].forEach((d) => {
        const segs = 48;
        const geo = new THREE.PlaneGeometry(wallW, h, segs, Math.round(segs * h / wallW));
        const pos = geo.attributes.position;
        const dispAmp = 0.55;
        for (let i = 0; i < pos.count; i++) {
            const lx = pos.getX(i), ly = pos.getY(i);
            const d1 = (fbm2(lx * 0.25 + 11, ly * 0.25 + 23) - 0.5) * dispAmp;
            const d2 = (fbm2(lx * 0.7 + 47, ly * 0.7 + 31) - 0.5) * dispAmp * 0.5;
            const d3 = (fbm2(lx * 1.8 + 91, ly * 1.8 + 63) - 0.5) * dispAmp * 0.15;
            pos.setZ(i, d1 + d2 + d3);
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, state.wallMat);
        m.position.set(d.x, state.floorY + halfH, d.z);
        m.rotation.set(d.rx, d.ry, d.rz);
        m.receiveShadow = true;
        state.wallsGroup.add(m);
    });

    const rep = Math.max(2, Math.round(wallW / 3.3));
    const repV = Math.max(2, Math.round(h / 3.3));
    if (state.wallTex) state.wallTex.repeat.set(rep, repV);
    if (state.wallNrm) state.wallNrm.repeat.set(rep, repV);

    scene.add(state.wallsGroup);
}

// ---------------------------------------------------------------------- //
// Maillage terrain (buildTerrain + biomes vertex colors)                  //
// ---------------------------------------------------------------------- //

/**
 * (Re)construit le maillage terrain complet.
 * @param {THREE.Scene} scene
 * @param {{registerMat?: Function, onGeometryUpdated?: Function}} ctx
 */
export function buildTerrain(scene, ctx = {}) {
    if (state.terrainMesh) {
        scene.remove(state.terrainMesh);
        state.terrainMesh.geometry.dispose();
        state.terrainMesh.material.dispose();
        state.terrainMesh = null;
    }
    if (!state.world.relief) return null;

    const segs = terrainSegs();
    const geo = new THREE.PlaneGeometry(state.wallPos * 2, state.wallPos * 2, segs, segs);
    geo.rotateX(-Math.PI / 2);

    state.biomeUniforms = {
        uBeachMax: -beachBottomDepth(),
        uReefMax: -reefBottomDepth(),
        uAbyssMin: state.floorY * 0.85,
        uBlend: Math.max(state.world.depth * 0.03, 0.5),
        colorSand: new THREE.Color(0xc8b18a),
        colorReef: new THREE.Color(0x3a4f47),
        colorAbyss: new THREE.Color(0x09131d),
    };

    const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.95, metalness: 0.0, flatShading: false,
    });
    mat.envMapIntensity = 0.2;

    state.terrainMesh = new THREE.Mesh(geo, mat);
    state.terrainMesh.receiveShadow = true;
    updateTerrainGeometry(ctx.onGeometryUpdated);
    scene.add(state.terrainMesh);
    if (ctx.registerMat) ctx.registerMat(mat);
    return state.terrainMesh;
}

/** Met à jour les seuils de biomes et recalcule les couleurs vertex. */
export function updateTerrainBiomeUniforms() {
    if (!state.biomeUniforms) return;
    state.biomeUniforms.uBeachMax = -beachBottomDepth();
    state.biomeUniforms.uReefMax = -reefBottomDepth();
    state.biomeUniforms.uAbyssMin = state.floorY * 0.85;
    state.biomeUniforms.uBlend = Math.max(state.world.depth * 0.03, 0.5);
    computeTerrainVertexColors();
}

/** Recalcule la géométrie (hauteurs), les normales et les couleurs biomes. */
export function updateTerrainGeometry(onGeometryUpdated) {
    if (!state.terrainMesh) return;
    const pos = state.terrainMesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        pos.setY(i, terrainHeightAt(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    state.terrainMesh.geometry.computeVertexNormals();
    computeTerrainVertexColors();
    if (onGeometryUpdated) onGeometryUpdated();
}

/** Couleurs par vertex selon l'altitude (sable → roche → limon abyssal). */
export function computeTerrainVertexColors() {
    if (!state.terrainMesh || !state.biomeUniforms) return;
    const geo = state.terrainMesh.geometry;
    const pos = geo.attributes.position;
    const count = pos.count;
    const colors = new Float32Array(count * 3);
    const _c = new THREE.Color();
    const _rock = new THREE.Color();

    const beachMax = state.biomeUniforms.uBeachMax;
    const reefMax = state.biomeUniforms.uReefMax;
    const halfB = Math.max(state.biomeUniforms.uBlend, 0.1) * 0.5;
    const cSand = state.biomeUniforms.colorSand;
    const cReef = state.biomeUniforms.colorReef;
    const cAbyss = state.biomeUniforms.colorAbyss;

    const rockColors = [
        new THREE.Color(0x4a5549), new THREE.Color(0x5c5346), new THREE.Color(0x3d4a42),
        new THREE.Color(0x524d3e), new THREE.Color(0x3a4035),
    ];

    for (let i = 0; i < count; i++) {
        const y = pos.getY(i);
        const px = pos.getX(i);
        const pz = pos.getZ(i);

        const tReef = THREE.MathUtils.smoothstep(y, reefMax - halfB, reefMax + halfB);
        const tBeach = THREE.MathUtils.smoothstep(y, beachMax - halfB, beachMax + halfB);

        _c.copy(cAbyss).lerp(cReef, tReef);
        _c.lerp(cSand, tBeach);

        const rockInfluence = (1.0 - tBeach) * tReef;
        if (rockInfluence > 0.01) {
            const rockNoise = fbm2(px * 0.25 + 5.0, pz * 0.25 + 11.0);
            const rockIdx = Math.floor(rockNoise * rockColors.length) % rockColors.length;
            _rock.copy(rockColors[rockIdx]);
            _c.lerp(_rock, rockInfluence * 0.6);
            const rockDetail = fbm2(px * 1.5 + 30.0, pz * 1.5 + 22.0);
            _c.multiplyScalar(0.85 + rockDetail * 0.3);
        }

        if (tBeach > 0.5) {
            const sandNoise = fbm2(px * 0.8 + 2.0, pz * 0.8 + 6.0);
            _c.r += (sandNoise - 0.5) * 0.04;
            _c.g += (sandNoise - 0.5) * 0.03;
            _c.b += (sandNoise - 0.5) * 0.02;
        }

        const noise = Math.sin(px * 0.7) * Math.cos(pz * 0.9) * 0.015;
        colors[i * 3] = THREE.MathUtils.clamp(_c.r + noise, 0, 1);
        colors[i * 3 + 1] = THREE.MathUtils.clamp(_c.g + noise, 0, 1);
        colors[i * 3 + 2] = THREE.MathUtils.clamp(_c.b + noise * 0.5, 0, 1);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Reconstruit uniquement la géométrie (changement de taille de bassin). */
export function rebuildTerrainGeometry(ctx = {}) {
    if (!state.terrainMesh) return;
    state.terrainMesh.geometry.dispose();
    const segs = terrainSegs();
    const geo = new THREE.PlaneGeometry(state.wallPos * 2, state.wallPos * 2, segs, segs);
    geo.rotateX(-Math.PI / 2);
    state.terrainMesh.geometry = geo;
    updateTerrainGeometry(ctx.onGeometryUpdated);
}

// ---------------------------------------------------------------------- //
// Outils déterministe pour tests (sans WebGL)                             //
// ---------------------------------------------------------------------- //

/**
 * Échantillonne le terrain sur une grille (tests harnais) sans toucher
 * au maillage : bornes plateaux/fosse, déterminisme du bruit.
 */
export function sampleTerrainProfile(radiusPctList = [0, 10, 45, 60, 70, 85, 95]) {
    return radiusPctList.map((pct) => {
        const r = state.wallPos * pct / 100;
        return { pct, y: terrainHeightAt(r, 0) };
    });
}

export { mulberry32 };
