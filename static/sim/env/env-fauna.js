/**
 * BOBROV-V2 — Sub Simulator immersif · faune & flore GLB.
 *
 * Portage fidèle de BOBROV-main (simulator3d.js) :
 *   - `loadScene3DConfig` → `loadFauna()` : échelle (real_size_m + boost
 *     minimum 30 %), recentrage géométrique (flore : base au sol),
 *     détection de heading par moyenne pondérée des normales avant/arrière,
 *     placement par zones (`positionInZone`), animations GLB
 *     (AnimationMixer créé sur le clone), trajectoire en huit (`path8`),
 *     machine à états mammifère (surface/plongeon/descente/profondeur/
 *     remontée) ;
 *   - `updateSceneObjects` → `updateFauna()` : LOD par visibilité,
 *     throttling P2 (accumulateur `_accDt`), IA fuir/curieux, huit
 *     lemniscate + wobble de nage, clamp radial de l'anneau récif (P1),
 *     confinement `clampToBasin` par zone.
 *
 * Adaptations (documentées) :
 *   - pas de logs de debug par frame (diagnostic via `faunaStats()`),
 *     seuls les avertissements de chargement sont émis ;
 *   - la collecte de sommets pour la détection de heading est sautée quand
 *     la détection est ignorée (skipHeading) : mêmes résultats, charge de
 *     chargement fortement réduite pour les petits objets statiques ;
 *   - `count` = 0 conserve un objet vide (l'ancien forçait 1 via `||`),
 *     ce qui rend la quantité « 0 » du panneau de configuration effective ;
 *   - zones revues : `fond` = plancher du lagon hors fosse (couronne
 *     [fosse ×1,15, bord compact]), `sol` = flore ancrée au relief
 *     (`terrainMeshHeightAt` + 0,05 m), `recif` = anneau récifal ;
 *   - bancs (`school`) : les poissons d'un même objet partagent un huit
 *     (`p.cx/p.cz/rx/rz/phase/dir/angle`) et nagent en nuage (offsets en
 *     spirale de Fibonacci, `schoolOffsets`) ; à l'approche du ROV ils
 *     accélèrent sur la trajectoire et le nuage gonfle (`panic`) au lieu
 *     de fuir individuellement — rendu « banc vivant » type jeu vidéo.
 *
 * Les clones SkeletonUtils partagent géométries et matériaux avec le GLB
 * en cache (env-assets) : la libération ne dispose donc jamais les
 * géométries des instances (elles appartiennent au cache).
 */

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CEIL_Y } from './env-defaults.js';
import { loadGLB, modelUrl, meshBoundingBox } from './env-assets.js';
import {
    compactHalfW, fondZoneRadius, reefRingRadii, reefBottomDepth,
    terrainMeshHeightAt, getWorldState, pitRadiusWorld,
} from './env-terrain.js';

/** Rayon minimum autour de l'origine où aucun objet ne peut apparaître (m). */
export const SPAWN_GUARD_RADIUS = 5.0;

const VALID_BEHAVIORS = ['fuir', 'curieux', 'neant', 'static', 'nageant'];

// ---------------------------------------------------------------------- //
// État module                                                             //
// ---------------------------------------------------------------------- //

const state = {
    scene: null,
    objects: [],
    mixers: [],
    frame: 0,
    loadToken: 0,
    loading: false,
};

// Temps partagés (évite les allocations dans la boucle)
const _tmpV1 = new THREE.Vector3();
const _tmpV2 = new THREE.Vector3();
const _tmpQ1 = new THREE.Quaternion();
const _tmpQ2 = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _xAxis = new THREE.Vector3(1, 0, 0);

// ---------------------------------------------------------------------- //
// Placement par zones (positionInZone)                                    //
// ---------------------------------------------------------------------- //

export function positionInZone(group, obj) {
    const zone = obj.zone || 'pleine_eau';
    const halfW = compactHalfW() * 0.92;
    const SURF_MARGIN = 1.5;
    const abyssR = fondZoneRadius();

    const ring = reefRingRadii();
    const beachInnerR = ring.outerR;
    const beachOuterR = getWorldState().wallPos;
    const reefInnerR = ring.innerR;
    const reefOuterR = beachInnerR;

    let x = 0, z = 0, y = 0;

    switch (zone) {

        // ── RÉCIF : entre reefInnerR et reefOuterR, hors fosse ──
        case 'recif': {
            for (let attempt = 0; attempt < 40; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = reefInnerR + Math.random() * (reefOuterR - reefInnerR);
                x = Math.cos(angle) * dist;
                z = Math.sin(angle) * dist;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS && Math.hypot(x, z) > abyssR * 1.15) break;
            }
            const floorY = terrainMeshHeightAt(x, z);
            if (obj.type === 'flore') {
                y = floorY + 0.05;
            } else if (obj.type === 'objet') {
                y = floorY + 0.2;
            } else {
                const reefDepth = Math.abs(floorY - CEIL_Y);
                const maxYAbove = Math.min(15, reefDepth * 0.7);
                y = floorY + 0.5 + Math.random() * maxYAbove;
            }
            break;
        }

        // ── FOND : plancher du lagon hors fosse (plaine + plateau récifal) ──
        case 'fond': {
            const pitR = pitRadiusWorld();
            const rMin = pitR * 1.15;
            const rMax = Math.max(rMin + 2, halfW);
            for (let attempt = 0; attempt < 30; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = rMin + Math.random() * (rMax - rMin);
                x = Math.cos(angle) * dist;
                z = Math.sin(angle) * dist;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            const floorY = terrainMeshHeightAt(x, z);
            y = (obj.type === 'flore') ? floorY + 0.05 : floorY + 0.3 + Math.random() * 2.4;
            break;
        }

        // ── SOL (flore) : ancrée au terrain et suivant le relief, hors fosse ──
        case 'sol': {
            const pitR = pitRadiusWorld();
            const rMin = pitR * 1.05;
            const rMax = Math.max(rMin + 2, halfW);
            for (let attempt = 0; attempt < 30; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = rMin + Math.random() * (rMax - rMin);
                x = Math.cos(angle) * dist;
                z = Math.sin(angle) * dist;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            y = terrainMeshHeightAt(x, z) + 0.05;
            break;
        }

        // ── PLAGE : entre beachInnerR et beachOuterR ──
        case 'plage': {
            for (let attempt = 0; attempt < 40; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = beachInnerR + Math.random() * (beachOuterR - beachInnerR);
                x = Math.cos(angle) * dist;
                z = Math.sin(angle) * dist;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            const floorY = terrainMeshHeightAt(x, z);
            if (obj.type === 'flore') {
                y = floorY + 0.05;
            } else {
                const topY = Math.max(floorY + 0.5, CEIL_Y - 1.5);
                const botY = floorY + 0.2;
                y = botY + Math.random() * Math.max(0.3, topY - botY);
            }
            break;
        }

        // ── ABYSSE : exclusivement dans la fosse (rayon < abyssR) ──
        case 'abysse': {
            const maxR = abyssR * 0.85;
            for (let attempt = 0; attempt < 40; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.random() * maxR;
                x = Math.cos(angle) * dist;
                z = Math.sin(angle) * dist;
                break;
            }
            const floorY = terrainMeshHeightAt(x, z);
            if (obj.type === 'flore') {
                y = floorY + 0.05;
            } else {
                y = floorY + 0.2 + Math.random() * 2.0;
            }
            break;
        }

        // ── SURFACE : juste sous la surface ──
        case 'surface':
            for (let attempt = 0; attempt < 30; attempt++) {
                x = (Math.random() * 2 - 1) * halfW;
                z = (Math.random() * 2 - 1) * halfW;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            y = CEIL_Y - 2 - Math.random() * 3;
            break;

        // ── PLEINE EAU : colonne d'eau, biaisée vers les faibles profondeurs ──
        case 'pleine_eau': {
            for (let attempt = 0; attempt < 30; attempt++) {
                x = (Math.random() * 2 - 1) * halfW;
                z = (Math.random() * 2 - 1) * halfW;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            const depth = -getWorldState().floorY;
            const shallow = Math.min(depth * 0.35, 20);
            const deep = depth - 3;
            const biased = Math.random() * Math.random();
            y = -(shallow + biased * (deep - shallow));
            break;
        }

        // ── MULTI_COUCHE (défaut) : surface → bas du récif, hors fosse ──
        default: {
            for (let attempt = 0; attempt < 30; attempt++) {
                x = (Math.random() * 2 - 1) * halfW;
                z = (Math.random() * 2 - 1) * halfW;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            const yMax = CEIL_Y - SURF_MARGIN;
            const yMin = -reefBottomDepth();
            y = yMin + Math.random() * (yMax - yMin);
            break;
        }
    }
    group.position.set(x, y, z);
    group.rotation.y = Math.random() * Math.PI * 2;
}

// ---------------------------------------------------------------------- //
// Confinement par zone (clampToBasin)                                     //
// ---------------------------------------------------------------------- //

function clampToBasin(pos, zone) {
    const lim = compactHalfW() * 0.9;
    const SURF_MARGIN = 1.5;
    const abyssR = fondZoneRadius();

    const ring = reefRingRadii();
    const beachInnerR = ring.outerR;
    const beachOuterR = getWorldState().wallPos;
    const reefInnerR = ring.innerR;
    const reefOuterR = beachInnerR;

    // ── Contraintes X/Z par zone ──
    switch (zone) {
        case 'abysse': {
            const dist = Math.hypot(pos.x, pos.z);
            const maxR = abyssR * 0.90;
            if (dist > maxR && dist > 0.01) {
                const scale = maxR / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        case 'plage': {
            const dist = Math.hypot(pos.x, pos.z);
            if (dist < beachInnerR && dist > 0.01) {
                const scale = beachInnerR / dist;
                pos.x *= scale;
                pos.z *= scale;
            } else if (dist > beachOuterR * 0.98) {
                const scale = (beachOuterR * 0.98) / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        case 'recif': {
            const dist = Math.hypot(pos.x, pos.z);
            if (dist < reefInnerR && dist > 0.01) {
                const scale = reefInnerR / dist;
                pos.x *= scale;
                pos.z *= scale;
            } else if (dist > reefOuterR) {
                const scale = reefOuterR / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        case 'fond': {
            // Plancher du lagon hors fosse : [fosse+1.15, bord compact −10 %].
            const pitR = pitRadiusWorld();
            const minR = pitR * 1.05;
            const maxR = Math.max(minR * 1.2, compactHalfW() * 0.9);
            const dist = Math.hypot(pos.x, pos.z);
            if (dist < minR && dist > 0.01) {
                const scale = minR / dist;
                pos.x *= scale;
                pos.z *= scale;
            } else if (dist > maxR) {
                const scale = maxR / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        case 'sol': {
            // Flore ancrée : du bord de la fosse au bord compact du monde.
            const pitR = pitRadiusWorld();
            const minR = pitR * 1.02;
            const maxR = Math.max(minR * 1.2, compactHalfW() * 0.94);
            const dist = Math.hypot(pos.x, pos.z);
            if (dist < minR && dist > 0.01) {
                const scale = minR / dist;
                pos.x *= scale;
                pos.z *= scale;
            } else if (dist > maxR) {
                const scale = maxR / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        default:
            pos.x = THREE.MathUtils.clamp(pos.x, -lim, lim);
            pos.z = THREE.MathUtils.clamp(pos.z, -lim, lim);
    }

    // ── Contraintes Y par zone ──
    switch (zone) {
        case 'surface':
            pos.y = THREE.MathUtils.clamp(pos.y, CEIL_Y - 8, CEIL_Y - SURF_MARGIN);
            break;
        case 'recif': {
            const floorY = terrainMeshHeightAt(pos.x, pos.z);
            const maxY = floorY + 16;
            pos.y = THREE.MathUtils.clamp(pos.y, floorY - 0.5, maxY);
            break;
        }
        case 'sol': {
            // Flore : strictement plaquée au relief (petite tolérance).
            const floorY = terrainMeshHeightAt(pos.x, pos.z);
            pos.y = THREE.MathUtils.clamp(pos.y, floorY - 0.5, floorY + 4);
            break;
        }
        case 'plage': {
            const floorY = terrainMeshHeightAt(pos.x, pos.z);
            pos.y = THREE.MathUtils.clamp(pos.y, floorY - 0.5, floorY + 4);
            break;
        }
        case 'abysse': {
            const floorY = terrainMeshHeightAt(pos.x, pos.z);
            pos.y = THREE.MathUtils.clamp(pos.y, floorY - 0.5, floorY + 4);
            break;
        }
        case 'fond': {
            const floorY = terrainMeshHeightAt(pos.x, pos.z);
            pos.y = THREE.MathUtils.clamp(pos.y, floorY - 0.5, floorY + 6);
            break;
        }
        case 'pleine_eau':
            pos.y = THREE.MathUtils.clamp(pos.y, getWorldState().floorY * 0.9, CEIL_Y - SURF_MARGIN);
            break;
        case 'multi_couches': {
            const yMin = -reefBottomDepth();
            const yMax = CEIL_Y - SURF_MARGIN;
            pos.y = THREE.MathUtils.clamp(pos.y, yMin, yMax);
            const dist = Math.hypot(pos.x, pos.z);
            if (dist < abyssR * 0.95 && dist > 0.01) {
                const pushR = abyssR * 1.05;
                const scale = pushR / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        default:
            pos.y = THREE.MathUtils.clamp(pos.y, getWorldState().floorY + 1, CEIL_Y - SURF_MARGIN);
    }
}

// ---------------------------------------------------------------------- //
// Bancs (school)                                                          //
// ---------------------------------------------------------------------- //

/** Angle d'or (≈ 137,5°) — pas de la spirale de Fibonacci des bancs. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Nuage d'offsets d'un banc (fonction pure, exposée aux tests) : spirale de
 * Fibonacci recentrée — les compagnons restent groupés autour du centre du
 * huit sans se superposer, quel que soit le nombre d'instances.
 *
 * @param {number} count nombre d'instances du banc (≥ 1)
 * @param {number} spread rayon du nuage (m)
 * @param {() => number} [rand] tirage uniforme [0,1) (injectable en test)
 * @returns {Array<{x:number, y:number, z:number}>} offsets centrés sur (0,0,0)
 */
export function schoolOffsets(count, spread, rand = Math.random) {
    const n = Math.max(1, Math.round(count));
    const r = Math.max(0.1, spread);
    const offsets = [];
    let meanX = 0, meanZ = 0;
    for (let i = 0; i < n; i++) {
        const radius = r * Math.sqrt((i + 0.5) / n);
        const angle = i * GOLDEN_ANGLE;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        const y = (rand() - 0.5) * r * 0.45;
        offsets.push({ x, y, z });
        meanX += x;
        meanZ += z;
    }
    // Recentrage : barycentre du nuage = centre du banc (compacité maximale).
    meanX /= n;
    meanZ /= n;
    for (const o of offsets) { o.x -= meanX; o.z -= meanZ; }
    return offsets;
}

/**
 * Ramène le centre d'un huit dans les bornes radiales de sa zone :
 *   - `recif` : anneau récifal (comme la P1 d'origine) ;
 *   - `fond`  : couronne hors fosse (centre ≥ bord de fosse + extension) ;
 * les autres zones sont bornées par le clamp carré final.
 * @returns {{cx:number, cz:number}} centre éventuellement replacé
 */
function clampEightCenter(zone, cx, cz, maxExt) {
    let rMin = 0, rMax = Infinity;
    if (zone === 'recif') {
        const ring = reefRingRadii();
        rMin = Math.min(ring.innerR + maxExt, (ring.innerR + ring.outerR) / 2);
        rMax = Math.max(rMin, ring.outerR - maxExt);
    } else if (zone === 'fond') {
        rMin = pitRadiusWorld() * 1.05 + maxExt;
        rMax = Math.max(rMin, compactHalfW() * 0.88 - maxExt);
    } else {
        return { cx, cz };
    }
    const r = Math.hypot(cx, cz);
    if (r > 0.01 && (r < rMin || r > rMax)) {
        const rTarget = THREE.MathUtils.clamp(r, rMin, rMax);
        cx *= rTarget / r;
        cz *= rTarget / r;
    }
    return { cx, cz };
}

// ---------------------------------------------------------------------- //
// Machine à états mammifère — décision pure (testable sans WebGL)         //
// ---------------------------------------------------------------------- //

/**
 * Décision de transition du cycle de plongée mammifère :
 * surface → plongeon → descente → profondeur → remontée → surface.
 * Fonction pure (aucune lecture de scène) : raccordée aux cas de la
 * machine à états d'`updateFauna()` et exposée au harnais de tests ;
 * `rand` est injectable pour rendre les tirages déterministes.
 *
 * @param {string} state état courant
 * @param {{timer:number, y:number, targetY:number, floorY:number}} p
 *        timer : temps restant de la phase ; y : altitude du corps ;
 *        targetY : cible de profondeur de la phase ; floorY : plancher.
 * @param {() => number} rand tirage uniforme [0, 1)
 * @returns {?{state:string, timer?:number, targetY?:number, pitchTarget?:number}}
 */
export function mammalFsmNext(state, { timer, y, targetY, floorY }, rand = Math.random) {
    const usableRange = floorY - CEIL_Y;   // négatif
    switch (state) {
        case 'surface':
            if (y >= CEIL_Y - 6 && timer <= 0) {
                return { state: 'plongeon', timer: 3 + rand() * 2, pitchTarget: -0.8 - rand() * 0.3 };
            }
            return null;
        case 'plongeon':
            if (timer <= 0) {
                return { state: 'descente', targetY: CEIL_Y + usableRange * (0.3 + rand() * 0.5) };
            }
            return null;
        case 'descente':
            if (y <= floorY + 0.3 || Math.abs(targetY - y) <= 0.5) {
                return { state: 'profondeur' };
            }
            return null;
        case 'profondeur':
            if (timer <= 0) {
                const t = rand() < 0.6 ? 0.05 + rand() * 0.15 : 0.25 + rand() * 0.35;
                return { state: 'remontee', targetY: CEIL_Y + usableRange * t };
            }
            return null;
        case 'remontee':
            if (Math.abs(targetY - y) <= 0.5) {
                return { state: 'surface' };
            }
            return null;
        default:
            return null;
    }
}

/** Contexte FSM d'un mammifère vivant (helper interne d'updateFauna). */
function mammalCtx(obj, m) {
    return { timer: m.timer, y: obj.group.position.y, targetY: m.targetY, floorY: m.floorY };
}

/** Applique la transition due, s'il y en a une (helper interne). */
function mammalApply(m, obj, stateName) {
    const tr = mammalFsmNext(stateName, mammalCtx(obj, m));
    if (!tr) return false;
    m.state = tr.state;
    if (tr.timer != null) m.timer = tr.timer;
    if (tr.targetY != null) m.targetY = tr.targetY;
    if (tr.pitchTarget != null) m.pitchTarget = tr.pitchTarget;
    return true;
}

// ---------------------------------------------------------------------- //
// Détection de heading (moyenne pondérée des normales avant/arrière)      //
// ---------------------------------------------------------------------- //

function detectHeadingOffset(modelClone, cloneBox, obj) {
    const cloneSize = cloneBox.getSize(_tmpV1);
    const realSize = obj.real_size_m || 0.5;
    const isMamifere = obj.type === 'mamifere';
    const isFauneNageante = obj.type === 'faune' && obj.behavior !== 'static';
    const skipHeading = !isMamifere && !(realSize >= 5 || isFauneNageante);
    if (skipHeading) return 0;

    modelClone.updateMatrixWorld(true);
    const wm = modelClone.matrixWorld;
    const nmat = new THREE.Matrix3().getNormalMatrix(wm);
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const verts = [];
    const norms = [];
    let vPx = 0, vNx = 0;
    modelClone.traverse((child) => {
        if ((child.isMesh || child.isSkinnedMesh) && child.geometry) {
            const pos = child.geometry.attributes.position;
            const norm = child.geometry.attributes.normal;
            if (!pos) return;
            for (let vi = 0; vi < pos.count; vi++) {
                v.fromBufferAttribute(pos, vi).applyMatrix4(wm);
                if (v.x > 0.01) vPx++; else if (v.x < -0.01) vNx++;
                verts.push(v.z);
                if (norm) {
                    n.fromBufferAttribute(norm, vi).applyMatrix3(nmat).normalize();
                    norms.push(n.z);
                } else {
                    norms.push(0);
                }
            }
        }
    });

    let headingOffset = 0;
    const centerZ = (cloneBox.max.z + cloneBox.min.z) / 2;
    let frontSum = 0, frontCount = 0;
    let backSum = 0, backCount = 0;
    for (let i = 0; i < verts.length; i++) {
        if (verts[i] > centerZ) { frontSum += norms[i]; frontCount++; }
        else { backSum += norms[i]; backCount++; }
    }
    const frontAvg = frontCount > 0 ? frontSum / frontCount : 0;
    const backAvg = backCount > 0 ? backSum / backCount : 0;

    if (cloneSize.x > cloneSize.z * 1.2) {
        headingOffset = (vPx > vNx) ? -Math.PI / 2 : Math.PI / 2;
    } else if (cloneSize.z > cloneSize.x * 1.2) {
        if (frontAvg < -0.05 && backAvg > 0.05) {
            headingOffset = Math.PI;
        } else if (frontAvg > 0.05 && backAvg < -0.05) {
            headingOffset = 0; // déjà face +Z → OK
        } else if (frontAvg < -0.05) {
            headingOffset = Math.PI;
        } else if (backAvg > 0.05) {
            headingOffset = Math.PI;
        }
    }
    return headingOffset;
}

// ---------------------------------------------------------------------- //
// Chargement (loadScene3DConfig)                                          //
// ---------------------------------------------------------------------- //

/** Contexte partagé entre instances d'un même modèle (calculé une fois). */
function modelContext(gltf, cfg) {
    const box = meshBoundingBox(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    let baseScale = (cfg.real_size_m || 0.2) / maxDim;
    // Échelle minimum garantie : protège les GLB aux unités internes
    // très petites (mm, cm) — le modèle fait au moins 30 % de sa taille réelle.
    const minRenderedSize = (cfg.real_size_m || 0.2) * 0.3;
    if (baseScale * maxDim < minRenderedSize) {
        baseScale = minRenderedSize / maxDim;
    }
    return { gltf, baseScale, size };
}

/**
 * (Re)charge la faune & flore GLB décrite par `objects`.
 * @param {THREE.Scene} scene
 * @param {{objects: object[], shadows?: boolean}} opts
 * @returns {Promise<{instances:number, mixers:number, failed:number}>}
 */
export async function loadFauna(scene, { objects = [], shadows = true } = {}) {
    clearFauna();
    state.scene = scene;
    const token = ++state.loadToken;
    state.loading = true;

    let failed = 0;

    for (const cfg of objects) {
        if (token !== state.loadToken) break;                 // rechargement plus récent
        if (cfg.enabled === false) continue;
        const count = Math.max(0, Math.round(cfg.count || 0));
        if (count === 0) continue;

        const source = cfg.source === 'imported' ? 'imported' : 'integrated';
        const url = cfg.url || modelUrl(cfg.model, source);

        let gltf;
        try {
            gltf = await loadGLB(url);
        } catch (err) {
            failed++;
            console.warn(`[SubSim] modèle introuvable « ${cfg.model} » (${url}) — objet ignoré`, err?.message || err);
            continue;
        }
        if (token !== state.loadToken) break;

        if (!VALID_BEHAVIORS.includes(cfg.behavior)) {
            console.warn(`[SubSim] « ${cfg.name} » : behavior="${cfg.behavior}" inconnu ` +
                `(valides : ${VALID_BEHAVIORS.join(', ')}), repli « neant »`);
        }

        const ctx = modelContext(gltf, cfg);
        const realSize = cfg.real_size_m || 0.5;
        const sizeCat = Math.min(2.5, Math.max(1, Math.cbrt(realSize / 0.5)));
        const isMamifere = cfg.type === 'mamifere';

        // ── Géométrie de trajectoire : anneau récif / couronne fond / bassin ──
        const basinHalf = compactHalfW();
        const isReefZone = !isMamifere && cfg.zone === 'recif';
        const ring = reefRingRadii();
        const ringGap = Math.max(1, (ring.outerR - ring.innerR) / 2 - 1);
        const fondBand = Math.max(2, compactHalfW() * 0.88 - pitRadiusWorld() * 1.08);
        const maxPathR = isReefZone
            ? Math.min(basinHalf * 0.65, ringGap)
            : (cfg.zone === 'fond'
                ? Math.min(basinHalf * 0.65, fondBand * 0.5)
                : basinHalf * 0.65);

        // ── Banc (school) : huit partagé + nuage d'offsets ──
        // Un banc nage en formation : le centre du huit, sa phase, son
        // orientation et son sens sont communs à toutes les instances ;
        // seuls les offsets (spirale de Fibonacci) et l'ondulation
        // verticale diffèrent → rendu « banc vivant ».
        const schooling = !!cfg.school && !isMamifere && cfg.type === 'faune' && count > 1;
        let school = null;
        if (schooling) {
            const probe = new THREE.Object3D();
            positionInZone(probe, cfg);
            const spread = Math.min(7, (0.5 + Math.sqrt(realSize) * 1.1) * (1 + Math.min(1, count / 40)));
            const r8 = Math.min(maxPathR, Math.max(2.5, spread * 2.2));
            const center = clampEightCenter(cfg.zone, probe.position.x, probe.position.z, r8 + spread + 1);
            school = {
                cx: center.cx,
                cz: center.cz,
                baseY: probe.position.y,
                rx: r8,
                rz: r8 * (0.8 + Math.random() * 0.4),
                phase: Math.random() * Math.PI * 2,
                angle: Math.random() * Math.PI * 2,
                dir: Math.random() > 0.5 ? 1 : -1,
                spread,
                offsets: schoolOffsets(count, spread),
            };
        }

        for (let i = 0; i < count; i++) {
            if (token !== state.loadToken) break;
            try {
                const instanceGroup = new THREE.Group();
                // SkeletonUtils.clone() préserve squelettes et skinned meshes
                const modelClone = SkeletonUtils.clone(gltf.scene);
                const rScale = ctx.baseScale * ((cfg.scale_min || 0.8)
                    + Math.random() * ((cfg.scale_max || 1.2) - (cfg.scale_min || 0.8)));
                modelClone.scale.setScalar(rScale);

                // Recentrage : centre géométrique, sauf flore (base au sol)
                const cloneBox = meshBoundingBox(modelClone);
                const cloneCenter = cloneBox.getCenter(new THREE.Vector3());
                if (cfg.type === 'flore') {
                    modelClone.position.x -= cloneCenter.x;
                    modelClone.position.z -= cloneCenter.z;
                    modelClone.position.y -= cloneBox.min.y;
                } else {
                    modelClone.position.sub(cloneCenter);
                }

                // Correction heading : aligner le modèle face +Z
                const headingOffset = detectHeadingOffset(modelClone, cloneBox, cfg);
                if (headingOffset !== 0) {
                    modelClone.rotation.y = headingOffset;
                    if (i === 0) {
                        console.log(`[SubSim] ${cfg.name}: heading corrigé de ${(headingOffset * 180 / Math.PI).toFixed(0)}°`);
                    }
                }
                instanceGroup.add(modelClone);
                positionInZone(instanceGroup, cfg);

                // Banc : chaque instance naît sur le huit partagé (aucun saut
                // visible au premier pas d'animation), décalée de son offset.
                const o = school ? school.offsets[i] : null;
                if (o) {
                    const sT8 = school.phase;
                    const sSin = Math.sin(sT8), sCos = Math.cos(sT8);
                    const sDen = 1 + sSin * sSin;
                    const sLocalX = school.rx * sCos / sDen;
                    const sLocalZ = school.rz * sSin * sCos / sDen;
                    const sA = school.angle;
                    instanceGroup.position.set(
                        school.cx + sLocalX * Math.cos(sA) - sLocalZ * Math.sin(sA) + o.x,
                        school.baseY + o.y,
                        school.cz + sLocalX * Math.sin(sA) + sLocalZ * Math.cos(sA) + o.z,
                    );
                }

                // Animations GLB — mixer créé sur le clone (pas l'original),
                // sauf behavior="static" qui bloque l'animation incluse.
                const skipAnim = cfg.behavior === 'static';
                const hasAnims = gltf.animations && gltf.animations.length > 0;
                if (hasAnims && !skipAnim) {
                    const mixer = new THREE.AnimationMixer(modelClone);
                    mixer._group = instanceGroup;   // tag pour skip LOD
                    gltf.animations.forEach((clip) => {
                        const action = mixer.clipAction(clip);
                        action.play();
                    });
                    state.mixers.push(mixer);
                }

                // ── Trajectoire en huit (∞) — orientation randomisée ──
                const pathRx = school ? school.rx : (isMamifere
                    ? Math.min(15 + Math.random() * 15, maxPathR)
                    : Math.min((3 + Math.random() * 6) * Math.sqrt(realSize), maxPathR));
                const pathRz = school ? school.rz : (isMamifere
                    ? Math.min(15 + Math.random() * 15, maxPathR)
                    : Math.min((3 + Math.random() * 6) * Math.sqrt(realSize), maxPathR));

                const speedRatio = Math.max(0.1, cfg.speed || 1);
                let linearSpeed = isMamifere ? 1.5
                    : Math.max(0.3, Math.sqrt(realSize) * 0.5) * speedRatio;
                linearSpeed = THREE.MathUtils.clamp(linearSpeed, 0.2, 8);

                let cx, cz;
                let pathAngle, pathPhase, pathDir;
                if (school) {
                    // Banc : huit commun — centre, phase, orientation et sens
                    // partagés (la formation se déplace comme un seul corps).
                    cx = school.cx;
                    cz = school.cz;
                    pathAngle = school.angle;
                    pathPhase = school.phase;
                    pathDir = school.dir;
                } else {
                    // Jitter du centre : casse l'effet « ring » dans une zone étroite
                    const jitterR = (2 + Math.random() * 4) * Math.sqrt(realSize);
                    const jitterAngle = Math.random() * Math.PI * 2;
                    cx = instanceGroup.position.x + Math.cos(jitterAngle) * jitterR;
                    cz = instanceGroup.position.z + Math.sin(jitterAngle) * jitterR;
                    // P1 : en zone récif, clamper le centre RADIALEMENT dans l'anneau
                    if (isReefZone) {
                        const c = clampEightCenter('recif', cx, cz, Math.max(pathRx, pathRz) + 1);
                        cx = c.cx;
                        cz = c.cz;
                    }
                    pathAngle = Math.random() * Math.PI * 2;
                    pathPhase = Math.random() * Math.PI * 2;
                    pathDir = Math.random() > 0.5 ? 1 : -1;
                }

                const objData = {
                    config: cfg, group: instanceGroup,
                    velocity: new THREE.Vector3(),
                    targetYaw: Math.random() * Math.PI * 2,
                    changeTimer: Math.random() * 5,
                    baseY: instanceGroup.position.y,
                    sizeCat,
                    headingOffset,
                    schooled: !!school,
                    schoolSpread: school ? school.spread : 0,
                    panic: 0,
                    path8: {
                        cx, cz, rx: pathRx, rz: pathRz,
                        phase: pathPhase,
                        dir: pathDir,
                        yAmp: (0.3 + Math.random() * 0.7) * Math.sqrt(realSize),
                        linSpeed: linearSpeed,
                        angle: pathAngle,
                        cosA: 0, sinA: 0,
                        ox: o ? o.x : 0,
                        oz: o ? o.z : 0,
                    },
                };
                objData.path8.cosA = Math.cos(objData.path8.angle);
                objData.path8.sinA = Math.sin(objData.path8.angle);

                // ── Mammifère : machine à états (spawn près de la surface) ──
                if (isMamifere) {
                    const bodyHalfLen = realSize * 0.5 * (cfg.scale_max || 1.2);
                    const bodyMargin = Math.max(5, bodyHalfLen * 0.9 + 2);
                    const spawnY = CEIL_Y - 5;
                    instanceGroup.position.y = spawnY;
                    objData.baseY = spawnY;
                    objData.path8.cy = spawnY;
                    objData.mammal = {
                        state: 'surface',
                        timer: 3 + Math.random() * 5,
                        targetY: CEIL_Y - 4,
                        pitch: 0,
                        pitchTarget: 0,
                        surfDur: 8 + Math.random() * 12,
                        profDur: 15 + Math.random() * 25,
                        diveSpeed: 1.5,
                        bodyMargin,
                        floorY: getWorldState().floorY + bodyMargin,
                        origRx: objData.path8.rx,
                        origRz: objData.path8.rz,
                    };
                }

                state.objects.push(objData);
                instanceGroup.traverse((child) => {
                    if (child.isMesh || child.isSkinnedMesh) child.frustumCulled = true;
                });
                if (shadows) {
                    instanceGroup.traverse((child) => {
                        if (child.isMesh || child.isSkinnedMesh) child.castShadow = true;
                    });
                }
                scene.add(instanceGroup);
            } catch (err) {
                console.warn(`[SubSim] échec d'instanciation « ${cfg.name} » :`, err);
            }
        }
    }

    state.loading = false;
    if (state.scene) state.frame = 0;
    console.log(`[SubSim] faune : ${state.objects.length} instances, ${state.mixers.length} mixers` +
        (failed ? `, ${failed} modèle(s) indisponible(s)` : ''));
    return { instances: state.objects.length, mixers: state.mixers.length, failed };
}

/** Libère toutes les instances GLB (les GLB en cache restent partagés). */
export function clearFauna() {
    state.loadToken++;
    for (const obj of state.objects) {
        if (obj.group) obj.group.removeFromParent();
    }
    for (const mixer of state.mixers) {
        mixer.stopAllAction();
        mixer._group = null;
    }
    state.objects.length = 0;
    state.mixers.length = 0;
    state.loading = false;
}

// ---------------------------------------------------------------------- //
// Mise à jour par frame (updateSceneObjects)                              //
// ---------------------------------------------------------------------- //

/**
 * @param {number} rawDt dt brut de la frame (s)
 * @param {{rovPos: THREE.Vector3, visibility: number, time: number}} opts
 */
export function updateFauna(rawDt, { rovPos, visibility, time = 0 }) {
    if (!state.objects.length) return;

    // ── LOD : distance max = visibilité de l'eau ──
    const maxRenderDist = Math.max(5, visibility);
    const maxRenderDistSq = maxRenderDist * maxRenderDist;

    state.frame++;
    const frame = state.frame;
    const rovX = rovPos.x, rovZ = rovPos.z;
    const reefRing = reefRingRadii();

    // ── Animations GLB — uniquement pour les objets visibles ──
    for (let i = 0; i < state.mixers.length; i++) {
        const m = state.mixers[i];
        if (m._group && !m._group.visible) continue;
        m.update(rawDt);
    }

    state.objects.forEach((obj, idx) => {
        // ── P2 : dt effectif (restitue le dt des frames sautées par throttling) ──
        let dt = Math.min(rawDt + (obj._accDt || 0), 0.25);
        obj._accDt = 0;
        const cfg = obj.config;
        const objType = cfg.type || 'faune';
        let kinematic = cfg.kinematic || 'fixe';
        if (objType === 'flore') kinematic = 'ancre_ondule';
        if (objType === 'objet') kinematic = 'fixe';
        if (objType === 'mamifere') kinematic = 'nageant';
        if (kinematic === 'fixe' && (cfg.behavior === 'nageant' || cfg.behavior === 'fuir' || cfg.behavior === 'curieux')) {
            kinematic = 'nageant';
        }

        // ── LOD : culling par distance (la cinématique continue hors vue) ──
        if (obj.group) {
            const pos = obj.group.position;
            const dx = pos.x - rovX;
            const dz = pos.z - rovZ;
            const distSq = dx * dx + dz * dz;

            if (distSq > maxRenderDistSq) {
                obj.group.visible = false;
            } else {
                obj.group.visible = true;
                const dist = Math.sqrt(distSq);
                let throttleMod = 0;
                if (dist > maxRenderDist * 0.75) throttleMod = 5;
                else if (dist > maxRenderDist * 0.5) throttleMod = 3;
                if (throttleMod && (frame + idx) % throttleMod !== 0) {
                    obj._accDt = Math.min((obj._accDt || 0) + dt, 0.5);
                    return;
                }
            }
        }

        const sizeCat = obj.sizeCat || 1;
        const speed = THREE.MathUtils.clamp(((cfg.speed || 1) * 0.5) / Math.pow(sizeCat, 0.25), 0.2, 8);
        const behavior = cfg.behavior || 'neant';
        if (behavior === 'static') return;
        const turnSpeed = cfg.turn_speed || 0.5;

        if (kinematic === 'fixe') return;

        // ── IA à l'approche du ROV (seuil proportionnel à la taille) ──
        const isMamifere = obj.mammal != null;
        const iaThreshold = isMamifere ? 24 * sizeCat : 8 * sizeCat;
        const distRov = obj.group.position.distanceTo(rovPos);
        let currentSpeed = speed;
        let iaOverride = false;

        if (distRov < iaThreshold) {
            if (behavior === 'fuir') {
                currentSpeed = speed * 3;
                if (!obj.schooled) {
                    _tmpV1.copy(obj.group.position).sub(rovPos).normalize();
                    obj.targetYaw = Math.atan2(_tmpV1.x, _tmpV1.z);
                    iaOverride = true;
                }
            } else if (behavior === 'curieux') {
                currentSpeed = speed * 1.3;
                if (!obj.schooled) {
                    _tmpV1.copy(rovPos).sub(obj.group.position).normalize();
                    obj.targetYaw = Math.atan2(_tmpV1.x, _tmpV1.z);
                    iaOverride = true;
                }
            }
        }

        // Banc paniqué : le nuage gonfle (les poissons accélèrent sur la
        // trajectoire sans la quitter) puis se resserre quand le ROV part.
        if (obj.schooled) {
            const panicTarget = (distRov < iaThreshold &&
                (behavior === 'fuir' || behavior === 'curieux')) ? 1 : 0;
            obj.panic = THREE.MathUtils.lerp(obj.panic || 0, panicTarget, Math.min(1, dt * 1.2));
        }

        if (kinematic === 'nageant') {
            const p = obj.path8;

            // ═════════════════════════════════════════════════════════
            //  MAMMIFÈRE — cycle surface/plongeon/descente/profondeur/remontée
            // ═════════════════════════════════════════════════════════
            if (obj.mammal) {
                const m = obj.mammal;
                m.timer -= dt;
                // Plancher sécurisé + rayon du huit recalculés dynamiquement
                m.floorY = getWorldState().floorY + m.bodyMargin;
                const dynMaxR = compactHalfW() * 0.65;
                p.rx = Math.min(m.origRx, dynMaxR);
                p.rz = Math.min(m.origRz, dynMaxR);

                if (iaOverride) {
                    // Déplacement direct vers la cible (fuir/curieux)
                    const lerpF = Math.min(0.12 / sizeCat, turnSpeed * 0.08 / sizeCat * dt * 60);
                    let diff = obj.targetYaw - obj.group.rotation.y;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    obj.group.rotation.y += diff * lerpF;
                    _tmpV2.set(0, 0, 1).applyQuaternion(_tmpQ1.setFromAxisAngle(_yAxis, obj.group.rotation.y));
                    obj.group.position.addScaledVector(_tmpV2, currentSpeed * dt);
                    p.cx = obj.group.position.x;
                    p.cz = obj.group.position.z;
                    m.pitch = THREE.MathUtils.lerp(m.pitch, 0, Math.min(1, dt * 2));
                    obj.group.quaternion.copy(_tmpQ1.setFromAxisAngle(_yAxis, obj.group.rotation.y))
                        .multiply(_tmpQ2.setFromAxisAngle(_xAxis, m.pitch));
                    // Synchroniser l'état avec la profondeur actuelle
                    if (obj.group.position.y > CEIL_Y - 6) {
                        if (m.state !== 'surface' && m.state !== 'plongeon') {
                            m.state = 'surface';
                            m.timer = m.surfDur;
                        }
                    } else {
                        if (m.state !== 'profondeur' && m.state !== 'descente') {
                            m.state = 'profondeur';
                            m.timer = m.profDur;
                        }
                    }
                } else {
                    // ── Machine à états ──
                    switch (m.state) {

                        case 'surface':
                            m.pitchTarget = 0;
                            if (obj.group.position.y < CEIL_Y - 6) {
                                obj.group.position.y += m.diveSpeed * dt;
                                m.timer = Math.max(m.timer, m.surfDur * 0.5);
                            } else {
                                p.phase += currentSpeed * dt * (1.5 / sizeCat) * p.dir;
                                const t8 = p.phase;
                                const sinT = Math.sin(t8), cosT = Math.cos(t8);
                                const denom = 1 + sinT * sinT;
                                const newX = p.cx + p.rx * cosT / denom;
                                const newZ = p.cz + p.rz * sinT * cosT / denom;
                                const dx = newX - obj.group.position.x;
                                const dz = newZ - obj.group.position.z;
                                if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
                                    const tangentYaw = Math.atan2(dx, dz);
                                    const lerpF = Math.min(0.15 / sizeCat, turnSpeed * 0.1 / sizeCat * dt * 60);
                                    let diff = tangentYaw - obj.group.rotation.y;
                                    while (diff > Math.PI) diff -= Math.PI * 2;
                                    while (diff < -Math.PI) diff += Math.PI * 2;
                                    obj.group.rotation.y += diff * lerpF;
                                }
                                obj.group.position.x = newX;
                                obj.group.position.z = newZ;
                                obj.group.position.y = (CEIL_Y - 4) + Math.sin(t8 * 2) * 0.3;
                                mammalApply(m, obj, 'surface');
                            }
                            break;

                        case 'plongeon':
                            m.pitch = THREE.MathUtils.lerp(m.pitch, m.pitchTarget, Math.min(1, dt * 0.6));
                            _tmpV2.set(0, 0, 1).applyQuaternion(_tmpQ1.setFromAxisAngle(_yAxis, obj.group.rotation.y));
                            obj.group.position.addScaledVector(_tmpV2, speed * 0.2 * dt);
                            obj.group.position.y = THREE.MathUtils.lerp(obj.group.position.y, CEIL_Y - 3, Math.min(1, dt * 0.5));
                            mammalApply(m, obj, 'plongeon');
                            break;

                        case 'descente': {
                            if (mammalApply(m, obj, 'descente')) {
                                // Cible atteinte (ou plancher) : palier de croisière
                                m.pitchTarget = 0;
                                m.timer = m.profDur;
                                p.cx = obj.group.position.x;
                                p.cz = obj.group.position.z;
                                p.phase = Math.random() * Math.PI * 2;
                                obj.baseY = obj.group.position.y;
                            } else {
                                const diff = m.targetY - obj.group.position.y;
                                obj.group.position.y += Math.sign(diff) * m.diveSpeed * dt;
                                const steepness = Math.min(1, Math.abs(diff) / 10);
                                m.pitchTarget = -0.15 - steepness * 0.55;
                            }
                            _tmpV2.set(0, 0, 1).applyQuaternion(_tmpQ1.setFromAxisAngle(_yAxis, obj.group.rotation.y));
                            obj.group.position.addScaledVector(_tmpV2, speed * 0.3 * dt);
                            m.pitch = THREE.MathUtils.lerp(m.pitch, m.pitchTarget, Math.min(1, dt * 1.5));
                            break;
                        }

                        case 'profondeur':
                            m.pitchTarget = 0;
                            p.phase += currentSpeed * dt * (1.5 / sizeCat) * p.dir;
                            {
                                const t8 = p.phase;
                                const sinT = Math.sin(t8), cosT = Math.cos(t8);
                                const denom = 1 + sinT * sinT;
                                const newX = p.cx + p.rx * cosT / denom;
                                const newZ = p.cz + p.rz * sinT * cosT / denom;
                                const dx = newX - obj.group.position.x;
                                const dz = newZ - obj.group.position.z;
                                if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
                                    const tangentYaw = Math.atan2(dx, dz);
                                    const lerpF = Math.min(0.15 / sizeCat, turnSpeed * 0.1 / sizeCat * dt * 60);
                                    let diff = tangentYaw - obj.group.rotation.y;
                                    while (diff > Math.PI) diff -= Math.PI * 2;
                                    while (diff < -Math.PI) diff += Math.PI * 2;
                                    obj.group.rotation.y += diff * lerpF;
                                }
                                obj.group.position.x = newX;
                                obj.group.position.z = newZ;
                                const bY = obj.baseY != null ? obj.baseY : obj.group.position.y;
                                obj.group.position.y = bY + Math.sin(t8 * 2) * p.yAmp;
                                obj.baseY = bY;
                            }
                            mammalApply(m, obj, 'profondeur');
                            break;

                        case 'remontee': {
                            if (mammalApply(m, obj, 'remontee')) {
                                // Surface rejointe : reprise du huit en surface
                                m.pitchTarget = 0;
                                m.timer = m.surfDur;
                                p.cx = obj.group.position.x;
                                p.cz = obj.group.position.z;
                                p.phase = Math.random() * Math.PI * 2;
                                obj.baseY = obj.group.position.y;
                            } else {
                                const diff = m.targetY - obj.group.position.y;
                                obj.group.position.y += Math.sign(diff) * m.diveSpeed * dt;
                                const steepness = Math.min(1, Math.abs(diff) / 10);
                                m.pitchTarget = 0.1 + steepness * 0.5;
                            }
                            _tmpV2.set(0, 0, 1).applyQuaternion(_tmpQ1.setFromAxisAngle(_yAxis, obj.group.rotation.y));
                            obj.group.position.addScaledVector(_tmpV2, speed * 0.3 * dt);
                            m.pitch = THREE.MathUtils.lerp(m.pitch, m.pitchTarget, Math.min(1, dt * 1.5));
                            break;
                        }
                    }

                    // Orientation yaw + pitch (quaternion composé, tangage correct)
                    obj.group.quaternion.copy(_tmpQ1.setFromAxisAngle(_yAxis, obj.group.rotation.y))
                        .multiply(_tmpQ2.setFromAxisAngle(_xAxis, m.pitch));
                }

                // Limites du bassin + plancher mammifère
                clampToBasin(obj.group.position, obj.config.zone);
                if (obj.group.position.y < m.floorY) {
                    obj.group.position.y = m.floorY;
                }
                const lim = compactHalfW() * 0.85;
                p.cx = THREE.MathUtils.clamp(p.cx, -lim, lim);
                p.cz = THREE.MathUtils.clamp(p.cz, -lim, lim);

            // ═════════════════════════════════════════════════════════
            //  NAGEANT CLASSIQUE (trajectoire en huit)
            // ═════════════════════════════════════════════════════════
            } else {
                const avgR = (p.rx + p.rz) * 0.5 || 1;
                const desiredLinSpeed = (p.linSpeed || 1) * (currentSpeed / speed);
                p.phase += (desiredLinSpeed / avgR) * dt * p.dir;

                if (iaOverride) {
                    // Poissons (forward=-Z) : +π au yaw cible, sauf modèle
                    // réaligné face +Z par la détection de heading.
                    const isFish = (cfg.type !== 'mamifere') && !(obj.headingOffset || 0);
                    const iaYaw = isFish ? obj.targetYaw + Math.PI : obj.targetYaw;
                    _tmpQ1.setFromAxisAngle(_yAxis, iaYaw);
                    const slerpFactor = Math.min(0.12 / sizeCat, turnSpeed * 0.08 / sizeCat * dt * 60);
                    obj.group.quaternion.slerp(_tmpQ1, slerpFactor);
                    const fwdDir = isFish ? -1 : 1;
                    _tmpV2.set(0, 0, fwdDir).applyQuaternion(obj.group.quaternion);
                    obj.group.position.addScaledVector(_tmpV2, currentSpeed * dt);
                    p.cx = obj.group.position.x;
                    p.cz = obj.group.position.z;
                    const iaWag = 0.15 / Math.pow(sizeCat, 0.5);
                    const iaPhase = time * currentSpeed * 8 + idx * 1.7;
                    _tmpQ2.setFromEuler(new THREE.Euler(0, Math.sin(iaPhase) * iaWag, 0, 'YXZ'));
                    obj.group.quaternion.multiply(_tmpQ2);
                } else {
                    // ── Lemniscate avec rotation aléatoire du chemin ──
                    const t8 = p.phase;
                    const sinT = Math.sin(t8), cosT = Math.cos(t8);
                    const denom = 1 + sinT * sinT;
                    const localX = p.rx * cosT / denom;
                    const localZ = p.rz * sinT * cosT / denom;
                    const cA = p.cosA || 1, sA = p.sinA || 0;
                    const newX = p.cx + localX * cA - localZ * sA;
                    const newZ = p.cz + localX * sA + localZ * cA;
                    const dx = newX - obj.group.position.x;
                    const dz = newZ - obj.group.position.z;
                    // P4 : signe fwd cohérent avec la détection de heading
                    const fwd = (cfg.type === 'mamifere' || (obj.headingOffset || 0) !== 0) ? 1 : -1;
                    const tangentYaw = Math.atan2(dx * fwd, dz * fwd);
                    const slerpFactor = Math.min(0.18 / sizeCat, turnSpeed * 0.12 / sizeCat * dt * 60);
                    _tmpQ1.setFromAxisAngle(_yAxis, tangentYaw);
                    obj.group.quaternion.slerp(_tmpQ1, slerpFactor);
                    // Offset de banc éventuel (nuage qui gonfle en panique).
                    const oScale = 1 + (obj.panic || 0) * 1.8;
                    obj.group.position.x = newX + p.ox * oScale;
                    obj.group.position.z = newZ + p.oz * oScale;
                    const baseY = obj.baseY != null ? obj.baseY : obj.group.position.y;
                    obj.group.position.y = baseY + Math.sin(t8 * 2) * p.yAmp;
                    obj.baseY = baseY;
                    // Wobble de nage : oscillation queue (yaw) + roulis corps
                    const wobbleFreq = (p.linSpeed || 1) / avgR * 6;
                    const wobblePhase = t8 * wobbleFreq;
                    const wagAmp = 0.12 / Math.pow(sizeCat, 0.5);
                    const rollAmp = 0.06 / Math.pow(sizeCat, 0.5);
                    _tmpQ2.setFromEuler(new THREE.Euler(
                        0, Math.sin(wobblePhase) * wagAmp, Math.sin(wobblePhase * 0.7) * rollAmp, 'YXZ'));
                    obj.group.quaternion.multiply(_tmpQ2);
                }

                // Limites du bassin
                clampToBasin(obj.group.position, obj.config.zone);
                // Clamp radial du centre du huit — récif : anneau récifal ;
                // fond : couronne hors fosse ; autres zones : bornes carrées.
                const zone = obj.config.zone;
                if (zone === 'recif' || zone === 'fond') {
                    const capR = zone === 'recif'
                        ? Math.max(1, (reefRing.outerR - reefRing.innerR) / 2 - 1)
                        : Math.max(2, (compactHalfW() * 0.88 - pitRadiusWorld() * 1.08) * 0.5);
                    p.rx = Math.min(p.rx, capR);
                    p.rz = Math.min(p.rz, capR);
                    const maxExt = Math.max(p.rx, p.rz) + 1 + (obj.schoolSpread || 0);
                    const c = clampEightCenter(zone, p.cx, p.cz, maxExt);
                    p.cx = c.cx;
                    p.cz = c.cz;
                } else {
                    const lim = compactHalfW() * 0.8;
                    p.cx = THREE.MathUtils.clamp(p.cx, -lim, lim);
                    p.cz = THREE.MathUtils.clamp(p.cz, -lim, lim);
                }
            }

        // --- Mode cinématique : ancre_ondule (flore) ---
        } else if (kinematic === 'ancre_ondule') {
            const baseY = obj.baseY != null ? obj.baseY : obj.group.position.y;
            const sway = (cfg.speed || 1) * 0.02;
            obj.group.position.y = baseY + Math.sin(time * 1.2 + obj.group.position.x) * sway;
            obj.group.rotation.z = Math.sin(time * 0.8 + obj.group.position.z) * 0.08;
        }
    });
}

// ---------------------------------------------------------------------- //
// Diagnostic                                                              //
// ---------------------------------------------------------------------- //

/** Statistiques faune (page de configuration / tests). */
export function faunaStats() {
    const byType = {};
    for (const obj of state.objects) {
        const t = obj.config.type || 'faune';
        byType[t] = (byType[t] || 0) + 1;
    }
    let visible = 0;
    for (const obj of state.objects) if (obj.group && obj.group.visible) visible++;
    return {
        instances: state.objects.length,
        mixers: state.mixers.length,
        visible,
        byType,
        loading: state.loading,
    };
}

/** Bornes de progression d'un huit pour les tests (pure function export). */
export function lemniscatePoint(cx, cz, rx, rz, phase) {
    const sinT = Math.sin(phase), cosT = Math.cos(phase);
    const denom = 1 + sinT * sinT;
    return { x: cx + rx * cosT / denom, z: cz + rz * sinT * cosT / denom };
}
