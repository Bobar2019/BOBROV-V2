/**
 * BOBROV-V2 — Sub Simulator immersif · orchestrateur de scène Three.js.
 *
 * Assemble les modules env-* en une scène complète et expose l'API utilisée
 * par sim.js (écran type cockpit) :
 *
 *   await initScene(container, settings)  → renderer + scène + caméras +
 *                                           monde + ROV GLB (bloquant)
 *   await loadDecor(settings)             → vie procédurale + faune GLB
 *   applySettings(settings, prev)         → application à chaud (eau, cam,
 *                                           LED, affichage, vie, faune,
 *                                           reconstruction monde si besoin)
 *   update(dt, time, pose, settings)      → pose ROV + animation du décor
 *   renderFrame(pipRect?)                 → rendu FPV (+ PIP extérieur)
 *   resize() / dispose() / accesseurs
 *
 * Conversion repère physique → Three : posThree = (x, −depth, −yN) ;
 * rotation du groupe ROV = (pitch, −cap − π/2, −roll) en ordre « YXZ »
 * (l'avant du modèle GLB pointe vers −X local, comme l'original).
 */

import * as THREE from 'three';
import { MODEL_LENGTH, QUALITY_PRESETS } from './env-defaults.js';
import { loadGLB, modelUrl, meshBoundingBox } from './env-assets.js';
import {
    applyWorldConfig, getWorldState, buildWalls, buildTerrain,
    updateTerrainBiomeUniforms,
} from './env-terrain.js';
import {
    initAtmosphere, registerEnvMat, applyFog, setAmbienceGrid,
    updateDepthAmbience, initProjectors, applyLed, disposeAtmosphere,
} from './env-atmosphere.js';
import {
    buildSurface, buildCaustics, buildGodRays, updateWaterAnim,
    setWaterLightFactor, applyWaterFlags, disposeWater, waterRefs,
} from './env-water.js';
import {
    createFpvCamera, createExteriorCamera, attachControls,
    configureCameras, recenterOnROV, setControlsEnabled, updateExteriorFollow,
    resizeCameras, cameras, disposeCameras,
} from './env-cameras.js';
import {
    buildAllLife, disposeLife, applyLifeState, setAlgaeUniforms, updateLife,
    refreshLifeZoning, setLifeDensity, lifeStats,
} from './env-life.js';
import { loadFauna, updateFauna, clearFauna, faunaStats } from './env-fauna.js';

const state = {
    container: null,
    scene: null,
    renderer: null,
    modelGroup: null,
    gridHelper: null,
    shadowGround: null,
    rovModel: null,
    settings: null,
    quality: null,
    initialized: false,
    _viewW: 0,
    _viewH: 0,
};

const _size = new THREE.Vector2();
const _boxCenter = new THREE.Vector3();

// ---------------------------------------------------------------------- //
// Initialisation                                                          //
// ---------------------------------------------------------------------- //

/**
 * Crée la scène complète : renderer, caméras, monde (terrain/surface) et
 * charge le modèle du ROV + projecteurs LED.
 * @param {HTMLElement} container élément qui reçoit le canvas
 * @param {object} settings réglages résolus (resolveSimulatorSettings)
 */
export async function initScene(container, settings) {
    dispose();   // idempotence : repartir d'une scène propre
    state.container = container;
    state.settings = settings;
    state.quality = QUALITY_PRESETS[settings.display.quality] || QUALITY_PRESETS.moyen;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // ── Scène + brouillard ──
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1020);
    scene.fog = new THREE.FogExp2(0x0b1020, 1.7 / Math.max(1, settings.world.visibility));

    // ── Renderer (ACES, ombres selon la qualité) ──
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(state.quality.pixelRatio, window.devicePixelRatio || 1));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = state.quality.shadows;
    // Perf (Raspberry Pi 5) : PCF simple plutôt que PCFSoft — échantillonnage
    // moins coûteux du shadow map, suffisant pour la scène sous-marine.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);

    state.scene = scene;
    state.renderer = renderer;

    // ── Groupe ROV (avant l'atmosphère : cible du soleil) ──
    const modelGroup = new THREE.Group();
    scene.add(modelGroup);
    state.modelGroup = modelGroup;

    // ── Atmosphère (PMREM + lumières + brouillard de couleur) ──
    initAtmosphere(scene, renderer, { modelGroup, quality: state.quality });

    // ── Caméras (FPV embarquée + extérieure PIP) ──
    const far = maxFar(settings);
    createFpvCamera(modelGroup, settings.cam.fov, width / Math.max(1, height), far);
    const ext = createExteriorCamera(renderer, far);
    attachControls(renderer, ext);
    setControlsEnabled(settings.cam.pip);

    // ── Monde (parois, terrain, eau, grille) ──
    buildWorld(settings);

    // ── Modèle ROV + projecteurs LED ──
    await loadRovModel(settings);

    state.initialized = true;
    resize();
}

/** Distance de clipping lointain (identique à applyBasinSize d'origine). */
function maxFar(settings) {
    return Math.max(100, settings.world.depth * 2.5, settings.world.extent * 1.8);
}

// ---------------------------------------------------------------------- //
// Monde (terrain + surface + grille)                                      //
// ---------------------------------------------------------------------- //

/**
 * (Re)construit le monde statique : terrain, parois, surface, caustiques,
 * god rays, grille de repère et sol d'ombre. Idempotent.
 */
export function buildWorld(settings) {
    const scene = state.scene;
    const renderer = state.renderer;
    if (!scene || !renderer) return;

    applyWorldConfig(settings.world);
    const w = getWorldState();

    // Caméras : FOV + far adaptés au monde
    const far = maxFar(settings);
    configureCameras({ fov: settings.cam.fov, far, aspect: currentAspect() });

    // Grille de repère au fond du monde (cellules 1/5/10 m)
    if (state.gridHelper) {
        scene.remove(state.gridHelper);
        state.gridHelper.geometry.dispose();
        state.gridHelper.material.dispose();
        state.gridHelper = null;
    }
    const ext = w.wallPos * 2;
    const cell = ext <= 120 ? 1 : (ext <= 400 ? 5 : 10);
    const grid = new THREE.GridHelper(ext, Math.max(2, Math.round(ext / cell)), 0x35d0ba, 0x24304d);
    grid.position.y = w.floorY;
    grid.material.transparent = true;
    scene.add(grid);
    state.gridHelper = grid;
    setAmbienceGrid(grid);

    // Sol d'ombre (reçoit les ombres à la profondeur du fond)
    if (!state.shadowGround) {
        state.shadowGround = new THREE.Mesh(
            new THREE.PlaneGeometry(20, 20),
            new THREE.ShadowMaterial({ opacity: 0.35 }),
        );
        state.shadowGround.rotation.x = -Math.PI / 2;
        state.shadowGround.receiveShadow = true;
        scene.add(state.shadowGround);
    }
    const s = ext / 20;
    state.shadowGround.scale.set(s, s, 1);
    state.shadowGround.position.y = w.floorY;

    // Parois rocheuses + terrain « Blue Hole » (matériaux enregistrés)
    const aniso = renderer.capabilities.getMaxAnisotropy();
    buildWalls(scene, { anisotropy: aniso, registerMat: registerEnvMat });
    buildTerrain(scene, { registerMat: registerEnvMat });
    updateTerrainBiomeUniforms();

    // Surface, caustiques, god rays
    buildSurface(scene, settings.water);
    buildCaustics(scene, settings.water);
    buildGodRays(scene, settings.water);

    applyFog(scene, settings.world.visibility);
}

/** (Re)construit la vie procédurale (algues, coraux, poissons, abysses). */
export function reloadLife(settings) {
    const scene = state.scene;
    if (!scene) return;
    disposeLife(scene);
    setLifeDensity(state.quality.density);
    buildAllLife(scene, { lifeCfg: settings.life, density: state.quality.density });
    applyLifeState(settings.life);
}

/** (Re)charge la faune & flore GLB décrites par settings.scene.objects. */
export async function reloadFauna(settings) {
    const scene = state.scene;
    if (!scene) return null;
    return loadFauna(scene, {
        objects: settings.scene.objects || [],
        shadows: state.quality.shadows,
    });
}

/** Vie + faune : appelé après initScene (terrain construit). */
export async function loadDecor(settings) {
    reloadLife(settings);
    return reloadFauna(settings);
}

// ---------------------------------------------------------------------- //
// Modèle ROV + projecteurs                                                //
// ---------------------------------------------------------------------- //

async function loadRovModel(settings) {
    try {
        const gltf = await loadGLB(modelUrl('bob_rov_3D.glb'));
        if (!state.modelGroup) return;   // scène démontée entre-temps
        const model = gltf.scene;
        const box = meshBoundingBox(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = MODEL_LENGTH / maxDim;
        model.scale.setScalar(scale);
        const scaledBox = meshBoundingBox(model);
        scaledBox.getCenter(_boxCenter);
        model.position.sub(_boxCenter);

        const maxAniso = state.renderer.capabilities.getMaxAnisotropy();
        model.traverse((o) => {
            if (o.isMesh) {
                o.castShadow = true;
                o.receiveShadow = true;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => {
                    if (!m) return;
                    if (m.map) { m.map.anisotropy = maxAniso; m.map.needsUpdate = true; }
                    m.needsUpdate = true;
                    registerEnvMat(m);
                });
            }
        });
        state.modelGroup.add(model);
        state.rovModel = model;

        // Projecteurs LED (projecteur.glb + 2 spots) montés sur le groupe ROV
        initProjectors(state.modelGroup, { url: modelUrl('projecteur.glb') });
        applyLed(settings.led);
    } catch (err) {
        console.error('[SubSim] échec de chargement du ROV :', err);
    }
}

// ---------------------------------------------------------------------- //
// Application à chaud des réglages                                        //
// ---------------------------------------------------------------------- //

/**
 * Applique des réglages après sauvegarde de la page de configuration.
 * Reconstruit le monde / la vie / la faune uniquement si nécessaire.
 * @param {object} settings nouveaux réglages résolus
 * @param {object} [prev] réglages précédents (pour le diff)
 * @returns {Promise<void>}
 */
export async function applySettings(settings, prev) {
    if (!state.initialized) return;
    const scene = state.scene;

    // Qualité d'affichage (preset) : pixelRatio + ombres + rafraîchissement
    const quality = QUALITY_PRESETS[settings.display.quality] || QUALITY_PRESETS.moyen;
    const qualityChanged = !state.quality || quality !== state.quality;
    state.quality = quality;
    if (qualityChanged) {
        state.renderer.setPixelRatio(Math.min(quality.pixelRatio, window.devicePixelRatio || 1));
        state.renderer.shadowMap.enabled = quality.shadows;
        state.renderer.shadowMap.needsUpdate = true;
        scene.traverse((o) => {
            const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
            mats.forEach((m) => { if (m) m.needsUpdate = true; });
        });
    }

    // Monde : reconstruction structurelle si le monde change (hors brouillard)
    const structural = (w) => JSON.stringify({
        extent: w.extent, depth: w.depth, relief: w.relief, reliefAmp: w.reliefAmp,
        beachExtent: w.beachExtent, beachDepthPct: w.beachDepthPct,
        reefExtent: w.reefExtent, reefDepthPct: w.reefDepthPct,
        pitDepthPct: w.pitDepthPct, pitRadiusPct: w.pitRadiusPct,
        compactZone: w.compactZone, walls: w.walls, wallTiling: w.wallTiling,
    });
    const worldChanged = !prev || structural(settings.world) !== structural(prev.world);
    if (worldChanged) {
        buildWorld(settings);
    } else if (!prev || settings.world.visibility !== prev.world.visibility) {
        applyFog(scene, settings.world.visibility);
    }

    // Eau : reconstruire les éléments manquants quand on les réactive
    const refs = waterRefs();
    if (settings.water.waves && !refs.surfaceMesh) buildSurface(scene, settings.water);
    if (settings.water.caustics && !refs.causticsMesh) buildCaustics(scene, settings.water);
    if (settings.water.godrays && !refs.godRaysGroup) buildGodRays(scene, settings.water);
    applyWaterFlags(settings.water);

    // Vie procédurale : recale les ancres, applique bascules/longueurs
    const lifeChanged = !prev || JSON.stringify(settings.life) !== JSON.stringify(prev.life);
    const lifeDensityChanged = !prev
        || settings.life.algaeDensity !== prev.life.algaeDensity
        || settings.life.reefDensity !== prev.life.reefDensity
        || settings.life.abyssDensity !== prev.life.abyssDensity;
    if (worldChanged || lifeDensityChanged) {
        reloadLife(settings);
    } else if (lifeChanged) {
        applyLifeState(settings.life);
        refreshLifeZoning(state.modelGroup ? state.modelGroup.position : new THREE.Vector3(), settings.life);
    }

    // Faune & flore GLB
    const faunaChanged = !prev || JSON.stringify(settings.scene.objects) !== JSON.stringify(prev.scene.objects);
    if (worldChanged || faunaChanged) {
        await reloadFauna(settings);
    }

    // Caméra + LED
    configureCameras({ fov: settings.cam.fov, far: maxFar(settings), aspect: currentAspect() });
    setControlsEnabled(settings.cam.pip);
    applyLed(settings.led);

    state.settings = settings;
}

// ---------------------------------------------------------------------- //
// Boucle : mise à jour + rendu                                            //
// ---------------------------------------------------------------------- //

/**
 * Met à jour le décor d'une frame (appelé par la boucle de sim.js).
 * @param {number} dt pas de temps écoulé (s)
 * @param {number} time temps cumulé (s)
 * @param {{x:number, yN:number, depth:number, heading:number, pitch:number, roll:number}} pose
 * @param {object} settings réglages actifs
 */
export function update(dt, time, pose, settings) {
    if (!state.initialized || !state.modelGroup) return;

    // Pose du ROV : physique (x, yN, depth) → Three (x, −depth, −yN)
    state.modelGroup.position.set(pose.x, -pose.depth, -pose.yN);
    state.modelGroup.rotation.set(pose.pitch, -pose.heading - Math.PI / 2, -pose.roll, 'YXZ');
    const rovPos = state.modelGroup.position;

    // Faune GLB (LOD + IA + mammifères) puis vie procédurale
    updateFauna(dt, { rovPos, visibility: settings.world.visibility, time });
    setAlgaeUniforms(time, settings.water.current);
    updateLife(dt, time, { rovPos, lifeCfg: settings.life });
    refreshLifeZoning(rovPos, settings.life);

    // Eau (shaders) + ambiance de profondeur
    updateWaterAnim(time, settings.water);
    const depthNow = Math.max(0, -rovPos.y);
    const f = updateDepthAmbience(depthNow, settings.world.visibility);
    setWaterLightFactor(f, settings.water);
}

/**
 * Rend une frame : vue FPV plein cadre, puis PIP extérieur si demandé.
 * @param {{x:number, y:number, width:number, height:number}|null} pipRect
 *        rectangle du PIP en pixels CSS (origine haut-gauche), ou null.
 */
export function renderFrame(pipRect = null) {
    if (!state.initialized) return;
    const cams = cameras();
    const renderer = state.renderer;

    renderer.setViewport(0, 0, state._viewW, state._viewH);
    renderer.setScissorTest(false);
    renderer.render(state.scene, cams.fpv);

    if (pipRect && cams.exterior && pipRect.width > 8 && pipRect.height > 8) {
        updateExteriorFollow(state.modelGroup.position);
        // WebGL : origine en bas à gauche → convertir l'ordonnée
        const y = state._viewH - pipRect.y - pipRect.height;
        renderer.setViewport(pipRect.x, y, pipRect.width, pipRect.height);
        renderer.setScissor(pipRect.x, y, pipRect.width, pipRect.height);
        renderer.setScissorTest(true);
        renderer.render(state.scene, cams.exterior);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, state._viewW, state._viewH);
    }
}

/** Recentre la caméra extérieure (PIP) derrière le ROV. */
export function recenterExterior() {
    if (state.modelGroup) recenterOnROV(state.modelGroup.position);
}

// ---------------------------------------------------------------------- //
// Resize / dispose / accesseurs                                           //
// ---------------------------------------------------------------------- //

export function resize() {
    if (!state.renderer || !state.container) return;
    const width = state.container.clientWidth || window.innerWidth;
    const height = state.container.clientHeight || window.innerHeight;
    if (width === state._viewW && height === state._viewH) return;
    state._viewW = width;
    state._viewH = height;
    state.renderer.setSize(width, height, false);
    state.renderer.domElement.style.width = '100%';
    state.renderer.domElement.style.height = '100%';
    resizeCameras(width, height);
}

export function dispose() {
    if (!state.scene) return;
    clearFauna();
    disposeLife(state.scene);
    disposeWater(state.scene);
    disposeCameras(state.modelGroup);
    disposeAtmosphere();
    if (state.modelGroup && state.scene) state.scene.remove(state.modelGroup);
    if (state.gridHelper) {
        state.scene.remove(state.gridHelper);
        state.gridHelper.geometry.dispose();
        state.gridHelper.material.dispose();
    }
    if (state.shadowGround) {
        state.scene.remove(state.shadowGround);
        state.shadowGround.geometry.dispose();
        state.shadowGround.material.dispose();
    }
    if (state.renderer) {
        state.renderer.dispose();
        state.renderer.domElement.remove();
    }
    state.scene = null;
    state.renderer = null;
    state.modelGroup = null;
    state.gridHelper = null;
    state.shadowGround = null;
    state.rovModel = null;
    state.initialized = false;
    state.settings = null;
    state._viewW = 0;
    state._viewH = 0;
}

function currentAspect() {
    const size = state.renderer ? state.renderer.getSize(_size) : { x: 16, y: 9 };
    return size.x / Math.max(1, size.y);
}

export function getRenderer() { return state.renderer; }
export function getScene() { return state.scene; }
export function getModelGroup() { return state.modelGroup; }
export function getRovPosition() { return state.modelGroup ? state.modelGroup.position : null; }
export function isReady() { return state.initialized; }

/** Statistiques décor (page de configuration). */
export function decorStats() {
    return {
        life: lifeStats(),
        fauna: faunaStats(),
        world: getWorldState(),
    };
}
