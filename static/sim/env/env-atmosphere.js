/**
 * BOBROV-V2 — Sub Simulator immersif · atmosphère sous-marine.
 *
 * Portage fidèle de BOBROV-main (simulator3d.js) : éclairage (ambiant +
 * soleil directionnel + contre-jour), brouillard exponentiel, extinction
 * solaire selon la profondeur (updateDepthAmbience), et projecteurs LED
 * (`projecteur.glb` + 2 SpotLights orientables avec tilt).
 *
 * Le facteur de lumière f (0 = noir abyssal) est retourné par
 * `updateDepthAmbience()` ; env-scene l'injecte dans env-water pour les
 * caustiques/god rays. Les matériaux « environnement » (dont
 * l'envMapIntensity suit f) s'enregistrent via registerEnvMat().
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CEIL_Y, MODEL_LENGTH } from './env-defaults.js';
import { loadGLB } from './env-assets.js';
import { reefDepth } from './env-terrain.js';

const LED_MAX_INTENSITY = 8000;

const _SURF_COL = new THREE.Color(0x0e3a55);
const _DEEP_COL = new THREE.Color(0x010409);
const _waterCol = new THREE.Color();

const state = {
    scene: null,
    renderer: null,
    sunDir: null,
    sunFill: null,
    sunAmbient: null,
    gridHelper: null,
    envMats: [],
    projGroup: null,
    projSpots: [],
    projModel: null,
    lastSunF: -1,
    lastEnvCount: -1,
    shadows: true,
};

/** Matériaux dont l'envMapIntensity suit l'extinction solaire. */
export function registerEnvMat(mat) {
    if (mat && !state.envMats.includes(mat)) state.envMats.push(mat);
}

/** Retire un matériau libéré du registre (reconstruction du décor). */
export function unregisterEnvMat(mat) {
    const i = state.envMats.indexOf(mat);
    if (i >= 0) state.envMats.splice(i, 1);
}

/** Réinitialise la liste (changement complet de décor). */
export function resetEnvMats() {
    state.envMats.length = 0;
    state.lastEnvCount = -1;
}

/** Crée l'éclairage de scène + environnement PBR (RoomEnvironment PMREM). */
export function initAtmosphere(scene, renderer, { modelGroup, quality }) {
    state.scene = scene;
    state.renderer = renderer;
    state.shadows = quality.shadows;

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    state.sunAmbient = new THREE.AmbientLight(0x4a5578, 0.5);
    scene.add(state.sunAmbient);

    const dir = new THREE.DirectionalLight(0xffffff, 1.8);
    state.sunDir = dir;
    dir.position.set(6, 12, 8);
    dir.castShadow = quality.shadows;
    if (quality.shadows) {
        dir.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
        dir.shadow.bias = -0.0004;
        dir.shadow.normalBias = 0.02;
        dir.shadow.radius = 4;
        dir.shadow.camera.near = 0.5; dir.shadow.camera.far = 80;
        dir.shadow.camera.left = -15; dir.shadow.camera.right = 15;
        dir.shadow.camera.top = 15; dir.shadow.camera.bottom = -15;
    }
    if (modelGroup) dir.target = modelGroup;
    scene.add(dir);

    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-6, 4, -8);
    scene.add(fill);
    state.sunFill = fill;
}

/** Applique la densité FogExp2 depuis la visibilité (m). */
export function applyFog(scene, visibility) {
    if (scene.fog) scene.fog.density = 1.7 / Math.max(1, visibility);
}

/** Grille de repère au fond (opacité pilotée par l'ambiance). */
export function setAmbienceGrid(gridHelper) {
    state.gridHelper = gridHelper;
}

/**
 * Extinction solaire selon la profondeur du ROV.
 * f = exp(-max(0, profondeur − REEF_DEPTH) / visibilité) — la visibilité
 * sert de profondeur d'atténuation (identique à l'original).
 * @returns {number} facteur f (0 = noir, 1 = pleine lumière)
 */
export function updateDepthAmbience(depthNow, visibility) {
    const rDepth = reefDepth();
    const sunFadeDepth = Math.max(5, visibility);
    const f = Math.exp(-Math.max(0, depthNow - rDepth) / sunFadeDepth);

    if (Math.abs(f - state.lastSunF) < 0.002 && state.envMats.length === state.lastEnvCount) {
        return f;
    }
    state.lastSunF = f;
    state.lastEnvCount = state.envMats.length;

    if (state.sunDir) state.sunDir.intensity = 1.8 * f;
    if (state.sunFill) state.sunFill.intensity = 0.5 * f;
    if (state.sunAmbient) state.sunAmbient.intensity = 0.5 * f;

    _waterCol.lerpColors(_DEEP_COL, _SURF_COL, f);
    if (state.scene) {
        if (state.scene.background && state.scene.background.isColor) {
            state.scene.background.copy(_waterCol);
        }
        if (state.scene.fog) state.scene.fog.color.copy(_waterCol);
    }
    for (const m of state.envMats) m.envMapIntensity = f;
    if (state.gridHelper) state.gridHelper.material.opacity = Math.max(0.05, f);
    return f;
}

// ---------------------------------------------------------------------- //
// Projecteurs LED (projecteur.glb + 2 SpotLights)                         //
// ---------------------------------------------------------------------- //

/** SpotLight de projecteur : blanc bleuté, cône 26°, portée 60 m. */
function makeProjectorSpot(x, y, z, zTargetPinch) {
    const s = new THREE.SpotLight(0xdff2ff, 0, 60, THREE.MathUtils.degToRad(26), 0.45, 1.6);
    // Perf (Raspberry Pi 5) : les projecteurs n'éclairent pas les ombres —
    // deux passes de shadow map 1024² en moins par frame ; l'ombre solaire
    // et la lumière des spots suffisent au rendu.
    s.castShadow = false;
    s.position.set(x - 0.01, y, z);
    s.target.position.set(x - 3.0, y - 0.35, zTargetPinch);
    state.projGroup.add(s);
    state.projGroup.add(s.target);
    s.target.updateMatrixWorld(true);
    return s;
}

/**
 * Monte le groupe pivot des projecteurs sur le ROV et charge le GLB.
 * @param {THREE.Group} modelGroup groupe du ROV
 * @param {{url: string}} opts
 */
export function initProjectors(modelGroup, { url }) {
    disposeProjectors();
    state.projGroup = new THREE.Group();
    modelGroup.add(state.projGroup);
    const px = -(MODEL_LENGTH / 2);   // avant visuel du ROV = -X
    state.projSpots = [
        makeProjectorSpot(px, 0.06, +0.09, +0.03),
        makeProjectorSpot(px, 0.06, -0.09, -0.03),
    ];
    state.projModel = null;

    loadGLB(url).then((gltf) => {
        if (!state.projGroup) return;   // décor démonté entre-temps
        const proj = gltf.scene;
        proj.traverse((o) => {
            if (o.isMesh) {
                o.castShadow = state.shadows;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => { if (m) registerEnvMat(m); });
            }
        });
        state.projGroup.add(proj);
        state.projModel = proj;
        fitSpotsToProjector(proj);
    }).catch((err) => {
        console.warn('[SubSim] projecteur.glb indisponible — faisceaux seuls :', err);
    });
}

/** Ajuste les SpotLights aux positions réelles des optiques du GLB. */
export function fitSpotsToProjector(proj) {
    if (!state.projGroup) return;
    proj.updateMatrixWorld(true);
    state.projGroup.updateMatrixWorld(true);
    const worldBox = new THREE.Box3().setFromObject(proj);
    if (worldBox.isEmpty()) return;
    const invMatrix = new THREE.Matrix4().copy(state.projGroup.matrixWorld).invert();
    const localMin = worldBox.min.clone().applyMatrix4(invMatrix);
    const localMax = worldBox.max.clone().applyMatrix4(invMatrix);
    const bMin = new THREE.Vector3(
        Math.min(localMin.x, localMax.x),
        Math.min(localMin.y, localMax.y),
        Math.min(localMin.z, localMax.z));
    const bMax = new THREE.Vector3(
        Math.max(localMin.x, localMax.x),
        Math.max(localMin.y, localMax.y),
        Math.max(localMin.z, localMax.z));
    const cy = (bMin.y + bMax.y) / 2;
    const zSpan = bMax.z - bMin.z;
    const front = bMin.x - 0.04;
    const podZ = Math.max(0.04, zSpan * 0.28);
    state.projSpots.forEach((s, i) => {
        const side = i === 0 ? 1 : -1;
        s.position.set(front, cy, side * podZ);
        s.target.position.set(front - 3.0, cy - 0.35, side * podZ * 0.25);
        s.target.updateMatrixWorld(true);
    });
}

/** Applique l'état LED : intensité des spots + tilt du groupe pivot. */
export function applyLed(ledCfg) {
    const cd = ledCfg.on ? LED_MAX_INTENSITY * (ledCfg.intensity / 100) : 0;
    state.projSpots.forEach((s) => { s.intensity = cd; });
    if (state.projGroup) {
        state.projGroup.rotation.z = THREE.MathUtils.degToRad(ledCfg.tilt);
    }
    if (state.projModel) state.projModel.visible = true;
}

/** Intensité actuelle des spots (cd) — utile aux tests/UI. */
export function ledPower(ledCfg) {
    return ledCfg.on ? LED_MAX_INTENSITY * (ledCfg.intensity / 100) : 0;
}

/** Libère les projecteurs (spots + GLB). */
export function disposeProjectors() {
    if (state.projGroup) {
        state.projSpots.forEach((s) => {
            if (s.target) s.target.removeFromParent();
            s.dispose();
        });
        state.projGroup.removeFromParent();
    }
    if (state.projModel) {
        state.projModel.traverse((o) => {
            if (o.isMesh && o.geometry) o.geometry.dispose();
            if (o.isMesh && o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => unregisterEnvMat(m));
            }
        });
    }
    state.projGroup = null;
    state.projSpots = [];
    state.projModel = null;
}

/** Arrête et nettoie l'atmosphère (scène disposée ailleurs). */
export function disposeAtmosphere() {
    disposeProjectors();
    state.envMats.length = 0;
}
