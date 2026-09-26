/**
 * BOBROV-V2 — Sub Simulator immersif · caméras.
 *
 * Deux caméras comme l'original :
 *   - caméra FPV : embarquée à l'avant du ROV (FOV réglable, 80° par défaut),
 *     montée en enfant du groupe ROV → suit position ET attitude ;
 *   - caméra extérieure : orbite autour du ROV (OrbitControls avec damping),
 *     utilisée uniquement par le PIP optionnel (désactivé par défaut).
 *
 * Repère du monde : x = est, y = −profondeur, z = −nord. L'avant du modèle
 * ROV pointe vers −X en local (identique à BOBROV-main) ; le groupe ROV est
 * donc tourné de (−90° − cap) autour de Y par env-scene.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MODEL_LENGTH } from './env-defaults.js';

const state = {
    fpvCamera: null,
    extCamera: null,
    controls: null,
    followROV: true,
};

/** Caméra FPV embarquée (enfant du groupe ROV). */
export function createFpvCamera(modelGroup, fov, aspect, far) {
    const cam = new THREE.PerspectiveCamera(fov, aspect, 0.01, far);
    cam.position.set(-(MODEL_LENGTH / 2 + 0.02), 0.05, 0);
    cam.rotation.y = Math.PI / 2;   // regarde vers −X local = avant du ROV
    modelGroup.add(cam);
    state.fpvCamera = cam;
    return cam;
}

/** Caméra extérieure + OrbitControls (vue PIP). */
export function createExteriorCamera(renderer, far) {
    const cam = new THREE.PerspectiveCamera(55, renderer.domElement.clientWidth / renderer.domElement.clientHeight, 0.05, far);
    cam.position.set(3, 3, 5);
    state.extCamera = cam;
    return cam;
}

/** Branche les OrbitControls sur le DOM du renderer (vue extérieure). */
export function attachControls(renderer, extCamera) {
    const controls = new OrbitControls(extCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxDistance = 120;
    controls.minDistance = 0.4;
    controls.enabled = false;   // désactivés tant que le PIP est fermé
    state.controls = controls;
    state.followROV = true;
    return controls;
}

/** Ajuste les FOV et le far des deux caméras (monde / réglages). */
export function configureCameras({ fov, far, aspect }) {
    if (state.fpvCamera) {
        if (fov) state.fpvCamera.fov = fov;
        state.fpvCamera.far = far;
        state.fpvCamera.aspect = aspect;
        state.fpvCamera.updateProjectionMatrix();
    }
    if (state.extCamera) {
        state.extCamera.far = far;
        state.extCamera.aspect = aspect;
        state.extCamera.updateProjectionMatrix();
    }
    if (state.controls) {
        state.controls.maxDistance = Math.max(25, far * 0.6);
    }
}

/** Recentre la caméra extérieure derrière/au-dessus du ROV (comme l'original). */
export function recenterOnROV(rovPos) {
    if (!state.extCamera || !state.controls) return;
    const offset = new THREE.Vector3(2.5, 2.0, 3.5);
    state.controls.target.copy(rovPos);
    state.extCamera.position.copy(rovPos.clone().add(offset));
    state.controls.update();
    state.followROV = true;
}

/** Active/désactive les contrôles extérieurs (PIP ouvert/fermé). */
export function setControlsEnabled(enabled) {
    if (state.controls) state.controls.enabled = !!enabled;
}

/** Met à jour le suivi de la caméra extérieure (appelé à chaque rendu PIP). */
export function updateExteriorFollow(rovPos) {
    if (!state.controls) return;
    if (state.followROV) state.controls.target.lerp(rovPos, 0.08);
    state.controls.update();
}

/** Applique l'aspect aux caméras (resize du canvas). */
export function resizeCameras(width, height) {
    const aspect = width / Math.max(1, height);
    if (state.fpvCamera) {
        state.fpvCamera.aspect = aspect;
        state.fpvCamera.updateProjectionMatrix();
    }
    if (state.extCamera) {
        state.extCamera.aspect = aspect;
        state.extCamera.updateProjectionMatrix();
    }
}

/** Accès direct. */
export function cameras() {
    return {
        fpv: state.fpvCamera,
        exterior: state.extCamera,
        controls: state.controls,
        isFollowing: () => state.followROV,
    };
}

/** Détache les caméras du groupe ROV. */
export function disposeCameras(modelGroup) {
    if (state.fpvCamera && modelGroup) modelGroup.remove(state.fpvCamera);
    if (state.controls) state.controls.dispose();
    state.fpvCamera = null;
    state.extCamera = null;
    state.controls = null;
}
