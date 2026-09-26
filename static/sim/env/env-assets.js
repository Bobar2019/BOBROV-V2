/**
 * BOBROV-V2 — Sub Simulator immersif · catalogue et cache de modèles GLB.
 *
 * Les modèles intégrés sont les copies des GLB de BOBROV-main
 * (`static/sim/assets/models/`) ; les modèles importés par l'utilisateur
 * vivent sous `static/sim/assets/importes/` (routeur api_sim_assets).
 * Le cache garantit un seul fetch par URL : les instances multiples sont
 * clonées via SkeletonUtils (voir env-fauna).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const MODELS_BASE = '/sim/assets/models/';
export const IMPORTS_BASE = '/sim/assets/importes/';

/** Liste de repli si le routeur assets n'est pas joignable. */
export const INTEGRATED_MODELS = Object.freeze([
    'bob_rov_3D.glb', 'projecteur.glb', 'bluefin_tuna.glb',
    'blue_whale_-_textured.glb', 'epave.glb', 'guppy.glb',
    'humpback_whale.glb', 'model_66a_-_atlantic_sturgeon.glb',
    'paracheirodon_innesi___tetra_neon.glb', 'sea_weed.glb', 'tortue.glb',
].map((file) => ({
    file,
    name: file.replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').trim(),
    url: MODELS_BASE + file,
    source: 'integrated',
})));

const cache = new Map();

/** URL d'un modèle selon sa source. */
export function modelUrl(file, source = 'integrated') {
    const base = source === 'imported' ? IMPORTS_BASE : MODELS_BASE;
    return base + encodeURIComponent(file);
}

/** Chargement GLB avec cache (une promesse par URL). */
export function loadGLB(url) {
    if (cache.has(url)) return cache.get(url);
    const promise = new Promise((resolve, reject) => {
        const loader = new GLTFLoader();
        loader.load(url, resolve, undefined, reject);
    });
    cache.set(url, promise);
    // Ne jamais mémoriser un échec : un GLB importé peut être corrigé.
    promise.catch(() => cache.delete(url));
    return promise;
}

/** Catalogue complet (intégrés + importés) via le routeur, repli statique. */
export async function fetchCatalog() {
    try {
        const resp = await fetch('/api/sim/assets/models');
        if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data.models) && data.models.length) return data.models;
        }
    } catch (err) {
        console.warn('[SubSim] catalogue assets indisponible, repli local', err);
    }
    return INTEGRATED_MODELS.map((m) => ({ ...m }));
}

/**
 * Bounding box « mesh-only » : ignore Bones, caméras, helpers, nulls
 * (copie fidèle de meshBoundingBox de BOBROV-main).
 */
export function meshBoundingBox(model) {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    let hasMesh = false;
    model.traverse((child) => {
        if (child.isMesh || child.isSkinnedMesh) {
            if (child.geometry) {
                child.geometry.computeBoundingBox();
                const meshBox = child.geometry.boundingBox.clone();
                meshBox.applyMatrix4(child.matrixWorld);
                box.union(meshBox);
                hasMesh = true;
            }
        }
    });
    if (!hasMesh) box.setFromObject(model);
    return box;
}

/** Prépare un clone pour le rendu immersif : ombres + anisotropie. */
export function prepareMeshes(root, { shadows = true, anisotropy = 1 } = {}) {
    root.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
            o.castShadow = shadows;
            o.frustumCulled = true;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => {
                if (m && m.map && anisotropy > 1) m.map.anisotropy = anisotropy;
            });
        }
    });
    return root;
}

/** Vide le cache (tests / libération mémoire). */
export function clearAssetCache() {
    cache.clear();
}
