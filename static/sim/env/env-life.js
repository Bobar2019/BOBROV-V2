/**
 * BOBROV-V2 — Sub Simulator immersif · vie procédurale sous-marine.
 *
 * Portage fidèle de BOBROV-main (simulator3d.js, L1352-1824) :
 *   - algues ondulantes (InstancedMesh + shader uTime/uSway) ;
 *   - coraux & anémones (4 espèces fusionnées, palettes) ;
 *   - poissons de récif (8 bancs, errance + fuite ROV + retour home) ;
 *   - créatures abyssales bioluminescentes (corps émissif + points lumineux) ;
 *   - brochets abyssaux (patrouille circulaire + prédation).
 *
 * Les globals envState/scene/posWorld deviennent des paramètres ; les
 * comportements et les RNG (seeds 1337 / 9100+t / 4242 / 7788 / 6060)
 * restent identiques. `densityFactor` (presets qualité) module les
 * capacités de construction — les règles de jeu ne changent pas.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './env-noise.js';
import { CEIL_Y } from './env-defaults.js';
import {
    compactHalfW, floorLimitAt, terrainMeshHeightAt, terrainNormalAt,
    reefBottomDepth, reefDepth, reefPlateauArea, reefBoundingSphere,
    scatterReefClusters, randomFloorPoint, randomReefPoint,
    fondZoneRadius, getWorldState,
} from './env-terrain.js';
import { registerEnvMat, unregisterEnvMat } from './env-atmosphere.js';

const ALGAE_MAX_TUFTS = 500, ALGAE_BLADES = 5, FISH_MAX = 500;
const FISH_SCARE_DIST = 2.2, FISH_SCHOOLS = 8, LIFE_SPAWN_GUARD = 2.0;
const CORAL_CAP = [500, 400, 500, 1400];
const ABYSS_MAX = 36;
const PIKE_COUNT = 3;

// ---------------------------------------------------------------------- //
// État module                                                             //
// ---------------------------------------------------------------------- //

const state = {
    scene: null,
    density: 1,
    algaeMesh: null,
    coralMeshes: null,
    fishMesh: null,
    abyssMesh: null,
    abyssGlowMesh: null,
    pikeGroup: null,
    pikeMat: null,
    reefsVisible: true,
    abyssVisible: false,
};

const algaeUniforms = { uTime: { value: 0 }, uSway: { value: 0.5 } };
const algaeData = [];
const coralData = [[], [], [], []];
const fishData = [];
const abyssData = [];
const pikeData = [];

const _lifeM4 = new THREE.Matrix4();
const _lifeQ = new THREE.Quaternion();
const _lifeQ2 = new THREE.Quaternion();
const _lifeV = new THREE.Vector3();
const _lifeScl = new THREE.Vector3();
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _Z_AXIS = new THREE.Vector3(0, 0, 1);
const _steer = new THREE.Vector3();
const _fleeV = new THREE.Vector3();
const _pikeTarget = new THREE.Vector3();

function paintGeometry(geo, hex) {
    const c = new THREE.Color(hex);
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
}

// ---------------------------------------------------------------------- //
// Algues ondulantes                                                       //
// ---------------------------------------------------------------------- //

function buildAlgae(lifeCfg) {
    if (state.algaeMesh) {
        state.scene.remove(state.algaeMesh);
        state.algaeMesh.geometry.dispose();
        unregisterEnvMat(state.algaeMesh.material);
        state.algaeMesh.material.dispose();
        state.algaeMesh = null;
    }
    algaeData.length = 0;
    const geo = new THREE.PlaneGeometry(0.09, 1, 1, 6);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({
        color: 0x2e8b4f, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
    });
    registerEnvMat(mat);
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = algaeUniforms.uTime;
        shader.uniforms.uSway = algaeUniforms.uSway;
        shader.vertexShader = 'uniform float uTime;\nuniform float uSway;\n' +
            shader.vertexShader.replace('#include <begin_vertex>', `
                #include <begin_vertex>
                {
                    float hFrac = clamp(position.y, 0.0, 1.0);
                    float ph = 0.0;
                    #ifdef USE_INSTANCING
                        ph = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 2.3;
                    #endif
                    float w = uTime * (0.8 + uSway * 2.4) + ph;
                    float sw = sin(w) * uSway * 0.45 * hFrac * hFrac;
                    transformed.x += sw;
                    transformed.z += 0.6 * sw * sin(w * 0.63 + 1.7);
                }`);
    };
    const tufts = Math.max(50, Math.round(ALGAE_MAX_TUFTS * state.density));
    const rng = mulberry32(1337);
    const wallPos = reefBoundingSphere().radius;   // garde-fou de build
    const clusterR = Math.max(1.5, wallPos * 0.16);
    const algaeMesh = new THREE.InstancedMesh(geo, mat, tufts * ALGAE_BLADES);
    algaeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    geo.boundingSphere = reefBoundingSphere();
    algaeMesh.frustumCulled = true;
    const cTint = new THREE.Color();
    let idx = 0;
    const centers = scatterReefClusters(rng, tufts, 0.6, clusterR);
    for (let t = 0; t < tufts; t++) {
        const p = centers[t];
        for (let b = 0; b < ALGAE_BLADES; b++) {
            const a = rng() * Math.PI * 2;
            const r = rng() * 0.28;
            algaeData.push({
                x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r,
                ry: rng() * Math.PI * 2, h: 0.5 + rng() * 1.0,
            });
            cTint.setHSL(0.30 + rng() * 0.10, 0.55, 0.28 + rng() * 0.14);
            algaeMesh.setColorAt(idx++, cTint);
        }
    }
    state.scene.add(algaeMesh);
    state.algaeMesh = algaeMesh;
    state.algaeMesh.userData.lenFactor = lifeCfg.algaeLen;
    updateAlgaeAnchors();
}

function updateAlgaeAnchors() {
    if (!state.algaeMesh) return;
    const len = state.algaeMesh.userData.lenFactor || 1;
    for (let i = 0; i < algaeData.length; i++) {
        const d = algaeData[i];
        const y = terrainMeshHeightAt(d.x, d.z);
        _lifeQ.setFromAxisAngle(_Y_AXIS, d.ry);
        _lifeM4.compose(_lifeV.set(d.x, y - 0.02, d.z), _lifeQ, _lifeScl.set(1, d.h * len, 1));
        state.algaeMesh.setMatrixAt(i, _lifeM4);
    }
    state.algaeMesh.instanceMatrix.needsUpdate = true;
    updateCoralAnchors();
}

// ---------------------------------------------------------------------- //
// Coraux & anémones (4 espèces)                                           //
// ---------------------------------------------------------------------- //

function buildCoralGeometries() {
    const branches = [];
    for (let i = 0; i < 6; i++) {
        const g = new THREE.ConeGeometry(0.022 + (i % 3) * 0.008, 0.34 + (i % 4) * 0.11, 5);
        g.translate(0, 0.17 + (i % 4) * 0.055, 0);
        g.rotateZ((i / 6) * 1.5 - 0.75); g.rotateY(i * 2.4);
        branches.push(g);
    }
    const dome = new THREE.SphereGeometry(0.17, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    const parts = [new THREE.CylinderGeometry(0.07, 0.095, 0.08, 7)];
    parts[0].translate(0, 0.04, 0);
    for (let i = 0; i < 8; i++) {
        const t = new THREE.ConeGeometry(0.016, 0.17, 4);
        t.translate(0, 0.16, 0); t.rotateX(0.55); t.rotateY((i / 8) * Math.PI * 2);
        parts.push(t);
    }
    const carpet = new THREE.SphereGeometry(0.22, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2);
    carpet.scale(1, 0.13, 1);
    return [mergeGeometries(branches), dome, mergeGeometries(parts), carpet];
}

function buildCorals() {
    if (state.coralMeshes) {
        state.coralMeshes.forEach((m) => {
            state.scene.remove(m); m.geometry.dispose();
            unregisterEnvMat(m.material); m.material.dispose();
        });
        state.coralMeshes = null;
    }
    coralData.forEach((a) => { a.length = 0; });
    const geos = buildCoralGeometries();
    const palettes = [
        [0xff4f3a, 0xff8c1a, 0xd94fff, 0x58ff6e],
        [0xb05cff, 0xff7a4d, 0x39d98a, 0xffc93a],
        [0x3ae0c2, 0xff5ca8, 0x8f6bff, 0x7dff3d],
        [0xc94f6d, 0x6f9f46, 0xcf7a3a, 0x7d54c0, 0x3f9e86],
    ];
    const cTint = new THREE.Color();
    const wallPos = reefBoundingSphere().radius;
    state.coralMeshes = geos.map((geo, t) => {
        geo.computeVertexNormals();
        geo.boundingSphere = reefBoundingSphere();
        const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.0, flatShading: true });
        registerEnvMat(mat);
        const cap = Math.max(25, Math.round(CORAL_CAP[t] * state.density));
        const mesh = new THREE.InstancedMesh(geo, mat, cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = true;
        const rng = mulberry32(9100 + t * 37);
        const clusterR = (t === 3) ? Math.max(2, wallPos * 0.22) : Math.max(1.2, wallPos * 0.12);
        const pts = scatterReefClusters(rng, cap, 0.6, clusterR);
        for (let i = 0; i < cap; i++) {
            const p = pts[i];
            const s = (t === 3) ? 0.6 + rng() * 1.4 : 0.7 + rng() * 1.5;
            coralData[t].push({ x: p.x, z: p.z, ry: rng() * Math.PI * 2, s });
            cTint.setHex(palettes[t][i % palettes[t].length])
                .offsetHSL((rng() - 0.5) * 0.06, 0, (rng() - 0.5) * 0.12);
            mesh.setColorAt(i, cTint);
        }
        state.scene.add(mesh);
        return mesh;
    });
    updateCoralAnchors();
}

function updateCoralAnchors() {
    if (!state.coralMeshes) return;
    state.coralMeshes.forEach((mesh, t) => {
        for (let i = 0; i < coralData[t].length; i++) {
            const d = coralData[t][i];
            const y = terrainMeshHeightAt(d.x, d.z);
            const onReef = y > -reefDepth() - 1.5;
            if (onReef) {
                const nrm = terrainNormalAt(d.x, d.z);
                _lifeQ.setFromUnitVectors(_Y_AXIS, nrm);
                _lifeQ2.setFromAxisAngle(_Y_AXIS, d.ry);
                _lifeQ.multiply(_lifeQ2);
                _lifeM4.compose(_lifeV.set(d.x, y - 0.02, d.z), _lifeQ, _lifeScl.setScalar(d.s));
            } else {
                _lifeQ.setFromAxisAngle(_Y_AXIS, d.ry);
                _lifeM4.compose(_lifeV.set(d.x, y - 0.01, d.z), _lifeQ, _lifeScl.setScalar(0.0001));
            }
            mesh.setMatrixAt(i, _lifeM4);
        }
        mesh.instanceMatrix.needsUpdate = true;
    });
}

// ---------------------------------------------------------------------- //
// Poissons de récif (bancs + effarouchement)                              //
// ---------------------------------------------------------------------- //

function buildFishGeometry() {
    const body = new THREE.SphereGeometry(0.055, 6, 5);
    body.scale(0.55, 0.85, 1.8); paintGeometry(body, 0xffffff);
    const tail = new THREE.ConeGeometry(0.045, 0.09, 4);
    tail.rotateX(Math.PI / 2); tail.scale(0.35, 1, 1); tail.translate(0, 0, -0.12);
    paintGeometry(tail, 0xdff0f2);
    const dorsal = new THREE.ConeGeometry(0.03, 0.05, 3);
    dorsal.scale(0.3, 1, 1.6); dorsal.translate(0, 0.056, -0.01);
    paintGeometry(dorsal, 0xdff0f2);
    const finL = new THREE.ConeGeometry(0.022, 0.05, 3);
    finL.rotateZ(Math.PI / 2); finL.scale(1, 0.25, 1.4); finL.translate(0.036, -0.008, 0.03);
    paintGeometry(finL, 0xdff0f2);
    const finR = new THREE.ConeGeometry(0.022, 0.05, 3);
    finR.rotateZ(-Math.PI / 2); finR.scale(1, 0.25, 1.4); finR.translate(-0.036, -0.008, 0.03);
    paintGeometry(finR, 0xdff0f2);
    const eyeL = new THREE.SphereGeometry(0.011, 5, 4);
    eyeL.translate(0.026, 0.016, 0.074); paintGeometry(eyeL, 0x0c1013);
    const eyeR = new THREE.SphereGeometry(0.011, 5, 4);
    eyeR.translate(-0.026, 0.016, 0.074); paintGeometry(eyeR, 0x0c1013);
    const merged = mergeGeometries([body, tail, dorsal, finL, finR, eyeL, eyeR]);
    merged.computeVertexNormals();
    return merged;
}

function buildFish() {
    if (state.fishMesh) {
        state.scene.remove(state.fishMesh);
        state.fishMesh.geometry.dispose();
        unregisterEnvMat(state.fishMesh.material);
        state.fishMesh.material.dispose();
        state.fishMesh = null;
    }
    fishData.length = 0;
    const mat = new THREE.MeshStandardMaterial({
        roughness: 0.6, metalness: 0.1, flatShading: true, vertexColors: true,
    });
    registerEnvMat(mat);
    const fishMesh = new THREE.InstancedMesh(buildFishGeometry(), mat, FISH_MAX);
    fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    fishMesh.frustumCulled = false;
    const rng = mulberry32(4242);
    const palette = [0x6b8fa3, 0x8fa5a0, 0xb8a882, 0x7a9b8e, 0x5e8ea6, 0x9a8b78];
    const cTint = new THREE.Color();
    const homes = [];
    for (let s = 0; s < FISH_SCHOOLS; s++) {
        const hp = randomReefPoint(rng, 1.2);
        const hy = terrainMeshHeightAt(hp.x, hp.z);
        // Bande de nage du banc : [plancher local + 0,6 m, 1 m sous la
        // surface]. Bornes ORDONNÉES — les mondes peu profonds donnaient
        // min > max et plaquaient tous les poissons en surface.
        const yLo = hy + 0.6;
        const yHi = Math.max(yLo, CEIL_Y - 1.0);
        homes.push(new THREE.Vector3(hp.x, yLo + rng() * (yHi - yLo), hp.z));
    }
    for (let i = 0; i < FISH_MAX; i++) {
        const schoolHome = homes[i % FISH_SCHOOLS];
        const a = rng() * Math.PI * 2;
        fishData.push({
            pos: schoolHome.clone().add(_lifeV.set((rng() - 0.5) * 3.4, (rng() - 0.5) * 2.2, (rng() - 0.5) * 3.4)),
            dir: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            wander: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            timer: rng() * 3, phase: rng() * Math.PI * 2,
            size: 0.75 + rng() * 0.6, flee: 0, home: schoolHome,
        });
        cTint.setHex(palette[i % palette.length]).offsetHSL((rng() - 0.5) * 0.04, -0.12, (rng() - 0.5) * 0.06);
        fishMesh.setColorAt(i, cTint);
        const fi = fishData[i];
        _lifeQ.setFromUnitVectors(_Z_AXIS, fi.dir);
        _lifeM4.compose(fi.pos, _lifeQ, _lifeScl.setScalar(fi.size));
        fishMesh.setMatrixAt(i, _lifeM4);
    }
    fishMesh.instanceMatrix.needsUpdate = true;
    state.scene.add(fishMesh);
    state.fishMesh = fishMesh;
}

function updateFishStep(dt, time, rovPos, lifeCfg) {
    if (!state.fishMesh || !state.fishMesh.visible) return;
    const activity = lifeCfg.fishSpeed;
    const n = Math.min(state.fishMesh.count, fishData.length);
    for (let i = 0; i < n; i++) {
        const f = fishData[i];
        f.timer -= dt * (0.5 + activity * 0.5);
        if (f.timer <= 0) {
            f.timer = 2 + Math.random() * 3;
            const a = Math.random() * Math.PI * 2;
            f.wander.set(Math.cos(a), (Math.random() - 0.5) * 0.5, Math.sin(a)).normalize();
        }
        _steer.copy(f.wander);
        if (f.pos.x > compactHalfW() - 1.5) _steer.x -= (f.pos.x - (compactHalfW() - 1.5));
        if (f.pos.x < -compactHalfW() + 1.5) _steer.x += ((-compactHalfW() + 1.5) - f.pos.x);
        if (f.pos.z > compactHalfW() - 1.5) _steer.z -= (f.pos.z - (compactHalfW() - 1.5));
        if (f.pos.z < -compactHalfW() + 1.5) _steer.z += ((-compactHalfW() + 1.5) - f.pos.z);
        const floorLim = floorLimitAt(f.pos.x, f.pos.z) + 0.35;
        if (f.pos.y < floorLim) _steer.y += (floorLim - f.pos.y) * 2.0;
        if (f.pos.y > CEIL_Y - 1.0) _steer.y -= (f.pos.y - (CEIL_Y - 1.0)) * 2.0;
        // Garde-fou de plongée relatif au foyer : les poissons restent dans
        // la colonne d'eau de leur banc, au-dessus du récif.
        const diveLim = f.home.y - 1.5;
        if (f.pos.y < diveLim) _steer.y += (diveLim - f.pos.y) * 1.5;
        const dHome = f.pos.distanceTo(f.home);
        if (dHome > 2.5) {
            _fleeV.copy(f.home).sub(f.pos).normalize();
            _steer.addScaledVector(_fleeV, Math.min(1.4, (dHome - 2.5) * 0.35));
        }
        const dRov = f.pos.distanceTo(rovPos);
        if (dRov < FISH_SCARE_DIST) {
            _fleeV.copy(f.pos).sub(rovPos).normalize().multiplyScalar(3.0 * (1 - dRov / FISH_SCARE_DIST) + 1.0);
            _steer.add(_fleeV);
            f.flee = Math.min(1, f.flee + dt * 4);
        } else {
            f.flee = Math.max(0, f.flee - dt * 0.8);
        }
        _steer.normalize();
        f.dir.lerp(_steer, Math.min(1, dt * (1.5 + activity + f.flee * 4))).normalize();
        f.dir.y = THREE.MathUtils.clamp(f.dir.y, -0.4, 0.4);
        const speed = 0.35 * f.size * activity * (1 + f.flee * 0.6);
        f.pos.addScaledVector(f.dir, speed * dt);
        _lifeQ.setFromUnitVectors(_Z_AXIS, f.dir);
        const wig = Math.sin(time * (6 + activity * 4 + f.flee * 6) + f.phase) * 0.18;
        _lifeQ2.setFromAxisAngle(_Y_AXIS, wig);
        _lifeQ.multiply(_lifeQ2);
        _lifeM4.compose(f.pos, _lifeQ, _lifeScl.setScalar(f.size));
        state.fishMesh.setMatrixAt(i, _lifeM4);
    }
    state.fishMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------- //
// Créatures abyssales bioluminescentes                                    //
// ---------------------------------------------------------------------- //

function buildAbyss() {
    if (state.abyssMesh) {
        state.scene.remove(state.abyssMesh); state.scene.remove(state.abyssGlowMesh);
        state.abyssMesh.geometry.dispose(); state.abyssMesh.material.dispose();
        state.abyssGlowMesh.geometry.dispose(); state.abyssGlowMesh.material.dispose();
        state.abyssMesh = null; state.abyssGlowMesh = null;
    }
    abyssData.length = 0;
    const cap = Math.max(6, Math.round(ABYSS_MAX * state.density));
    const body = new THREE.SphereGeometry(0.05, 6, 5);
    body.scale(0.4, 0.5, 2.6);
    const tail = new THREE.ConeGeometry(0.03, 0.1, 4);
    tail.rotateX(Math.PI / 2); tail.scale(0.3, 1, 1); tail.translate(0, 0, -0.16);
    const geo = mergeGeometries([body, tail]); geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
        roughness: 0.7, metalness: 0.05, flatShading: true,
        emissive: 0x06222e, emissiveIntensity: 0.8,
    });
    const abyssMesh = new THREE.InstancedMesh(geo, mat, cap);
    abyssMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    abyssMesh.frustumCulled = false;
    const dots = [];
    for (let i = 0; i < 4; i++) {
        const d = new THREE.SphereGeometry(0.008, 4, 3);
        d.translate((i % 2 ? 1 : -1) * 0.018, 0.012, -0.09 + i * 0.06);
        dots.push(d);
    }
    const abyssGlowMesh = new THREE.InstancedMesh(mergeGeometries(dots),
        new THREE.MeshBasicMaterial({ color: 0x54f2d6 }), cap);
    abyssGlowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    abyssGlowMesh.frustumCulled = false;
    const rng = mulberry32(7788);
    const cTint = new THREE.Color();
    for (let i = 0; i < cap; i++) {
        const p = randomFloorPoint(rng, 1.5);
        const a = rng() * Math.PI * 2;
        const yMin = getWorldState().floorY + 1.0;
        const yMax = Math.min(-reefDepth() - 4, CEIL_Y - 2);
        abyssData.push({
            pos: new THREE.Vector3(p.x, yMin + rng() * Math.max(1, yMax - yMin), p.z),
            dir: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            wander: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            timer: rng() * 4, phase: rng() * Math.PI * 2, size: 0.8 + rng() * 0.8,
        });
        cTint.setHSL(0.45 + rng() * 0.15, 0.7, 0.10 + rng() * 0.08);
        abyssMesh.setColorAt(i, cTint);
        const ai = abyssData[i];
        _lifeQ.setFromUnitVectors(_Z_AXIS, ai.dir);
        _lifeM4.compose(ai.pos, _lifeQ, _lifeScl.setScalar(ai.size));
        abyssMesh.setMatrixAt(i, _lifeM4);
        abyssGlowMesh.setMatrixAt(i, _lifeM4);
    }
    abyssMesh.instanceMatrix.needsUpdate = true;
    abyssGlowMesh.instanceMatrix.needsUpdate = true;
    state.scene.add(abyssMesh); state.scene.add(abyssGlowMesh);
    state.abyssMesh = abyssMesh;
    state.abyssGlowMesh = abyssGlowMesh;
}

function updateAbyssStep(dt, time) {
    if (!state.abyssMesh || !state.abyssMesh.visible) return;
    const n = Math.min(state.abyssMesh.count, abyssData.length);
    const yTop = Math.min(-reefDepth() - 3, CEIL_Y - 2);
    for (let i = 0; i < n; i++) {
        const f = abyssData[i];
        f.timer -= dt;
        if (f.timer <= 0) {
            f.timer = 3 + Math.random() * 4;
            const a = Math.random() * Math.PI * 2;
            f.wander.set(Math.cos(a), (Math.random() - 0.5) * 0.4, Math.sin(a)).normalize();
        }
        _steer.copy(f.wander);
        if (f.pos.x > compactHalfW() - 2) _steer.x -= (f.pos.x - (compactHalfW() - 2));
        if (f.pos.x < -compactHalfW() + 2) _steer.x += ((-compactHalfW() + 2) - f.pos.x);
        if (f.pos.z > compactHalfW() - 2) _steer.z -= (f.pos.z - (compactHalfW() - 2));
        if (f.pos.z < -compactHalfW() + 2) _steer.z += ((-compactHalfW() + 2) - f.pos.z);
        const floorLim = floorLimitAt(f.pos.x, f.pos.z) + 0.5;
        if (f.pos.y < floorLim) _steer.y += (floorLim - f.pos.y) * 2.0;
        if (f.pos.y > yTop) _steer.y -= (f.pos.y - yTop) * 1.5;
        _steer.normalize();
        f.dir.lerp(_steer, Math.min(1, dt * 0.8)).normalize();
        f.pos.addScaledVector(f.dir, 0.12 * f.size * dt);
        _lifeQ.setFromUnitVectors(_Z_AXIS, f.dir);
        _lifeQ2.setFromAxisAngle(_Y_AXIS, Math.sin(time * 2.5 + f.phase) * 0.22);
        _lifeQ.multiply(_lifeQ2);
        _lifeM4.compose(f.pos, _lifeQ, _lifeScl.setScalar(f.size));
        state.abyssMesh.setMatrixAt(i, _lifeM4);
        state.abyssGlowMesh.setMatrixAt(i, _lifeM4);
    }
    state.abyssMesh.instanceMatrix.needsUpdate = true;
    state.abyssGlowMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------- //
// Brochets abyssaux géants                                                //
// ---------------------------------------------------------------------- //

function buildPikeMesh() {
    const g = new THREE.Group();
    if (!state.pikeMat) {
        state.pikeMat = new THREE.MeshStandardMaterial({
            color: 0x22352a, roughness: 0.85, metalness: 0.05, flatShading: true,
        });
        registerEnvMat(state.pikeMat);
    }
    const mat = state.pikeMat;
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 9, 7), mat);
    body.scale.set(0.85, 0.75, 5.6); g.add(body);
    const jawGeo = new THREE.ConeGeometry(0.055, 0.22, 6);
    jawGeo.rotateX(Math.PI / 2); jawGeo.scale(1, 0.45, 1);
    const jawUp = new THREE.Mesh(jawGeo, mat); jawUp.position.set(0, 0.03, 0.5); jawUp.rotation.x = -0.18;
    const jawLo = new THREE.Mesh(jawGeo.clone(), mat); jawLo.position.set(0, -0.035, 0.49); jawLo.rotation.x = 0.30;
    g.add(jawUp, jawLo);
    const tailGeo = new THREE.ConeGeometry(0.09, 0.16, 4);
    tailGeo.rotateX(-Math.PI / 2); tailGeo.scale(0.25, 1.6, 1);
    g.add(new THREE.Mesh(tailGeo, mat).translateZ(-0.56));
    const dorsGeo = new THREE.ConeGeometry(0.06, 0.1, 3);
    dorsGeo.scale(0.25, 1, 1.5);
    const dors = new THREE.Mesh(dorsGeo, mat); dors.position.set(0, 0.08, -0.28); g.add(dors);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x8cff5e });
    const eyeGeo = new THREE.SphereGeometry(0.016, 6, 5);
    const eL = new THREE.Mesh(eyeGeo, eyeMat); eL.position.set(0.055, 0.035, 0.34);
    const eR = new THREE.Mesh(eyeGeo, eyeMat); eR.position.set(-0.055, 0.035, 0.34);
    g.add(eL, eR);
    return g;
}

function buildPikes() {
    if (state.pikeGroup) {
        state.scene.remove(state.pikeGroup);
        state.pikeGroup.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
        state.pikeGroup = null;
    }
    pikeData.length = 0;
    const group = new THREE.Group();
    const rng = mulberry32(6060);
    const floorY = getWorldState().floorY;
    const patrolR = Math.max(3, fondZoneRadius() * 0.7);
    for (let i = 0; i < PIKE_COUNT; i++) {
        const g = buildPikeMesh();
        const angle = rng() * Math.PI * 2;
        const y = floorY + 3 + rng() * 6;
        g.position.set(Math.cos(angle) * patrolR, y, Math.sin(angle) * patrolR);
        pikeData.push({ group: g, angle, y, dir: new THREE.Vector3(0, 0, 1), speed: 0.35 + rng() * 0.15 });
        group.add(g);
    }
    state.scene.add(group);
    state.pikeGroup = group;
}

function updatePikesStep(dt, rovPos) {
    if (!state.pikeGroup || !state.pikeGroup.visible) return;
    const patrolR = Math.max(3, fondZoneRadius() * 0.7);
    const floorY = getWorldState().floorY;
    for (const p of pikeData) {
        const g = p.group;
        p.angle += dt * (p.speed / patrolR);
        _pikeTarget.set(Math.cos(p.angle) * patrolR, p.y + Math.sin(p.angle * 3.1) * 1.5, Math.sin(p.angle) * patrolR);
        if (rovPos.y < -reefBottomDepth() && g.position.distanceTo(rovPos) < 18) {
            _pikeTarget.copy(rovPos); _pikeTarget.y = Math.max(_pikeTarget.y - 0.4, floorY + 1);
        }
        _lifeV.copy(_pikeTarget).sub(g.position);
        const d = _lifeV.length();
        if (d > 0.05) {
            _lifeV.normalize();
            p.dir.lerp(_lifeV, Math.min(1, dt * 0.5)).normalize();
            g.position.addScaledVector(p.dir, Math.min(p.speed, d) * dt);
        }
        const fl = floorLimitAt(g.position.x, g.position.z) + 0.6;
        if (g.position.y < fl) g.position.y = fl;
        _lifeQ.setFromUnitVectors(_Z_AXIS, p.dir);
        g.quaternion.slerp(_lifeQ, Math.min(1, dt * 1.2));
    }
}

// ---------------------------------------------------------------------- //
// Zonage récif/abysses (hystérésis) & orchestration                       //
// ---------------------------------------------------------------------- //

export function refreshLifeZoning(rovPos, lifeCfg) {
    const depth = Math.max(0, -rovPos.y);
    const rDepth = reefDepth();
    if (state.reefsVisible && depth > rDepth + 30) state.reefsVisible = false;
    else if (!state.reefsVisible && depth < rDepth + 22) state.reefsVisible = true;
    if (!state.abyssVisible && depth > rDepth + 2) state.abyssVisible = true;
    else if (state.abyssVisible && depth < rDepth - 4) state.abyssVisible = false;
    if (state.algaeMesh) state.algaeMesh.visible = state.reefsVisible && lifeCfg.algae;
    if (state.fishMesh) state.fishMesh.visible = state.reefsVisible && lifeCfg.fish;
    if (state.coralMeshes) state.coralMeshes.forEach((m) => { m.visible = state.reefsVisible && lifeCfg.corals; });
    if (state.abyssMesh) {
        state.abyssMesh.visible = state.abyssVisible && lifeCfg.abyssCreatures;
        state.abyssGlowMesh.visible = state.abyssMesh.visible;
    }
    if (state.pikeGroup) state.pikeGroup.visible = state.abyssVisible && lifeCfg.pikes;
}

/** (Re)construit toute la vie procédurale. Le terrain doit être prêt. */
export function buildAllLife(scene, { lifeCfg, density = 1 }) {
    state.scene = scene;
    state.density = density;
    if (state.pikeMat) unregisterEnvMat(state.pikeMat);
    state.pikeMat = null;   // matériau partagé reconstruit proprement
    buildAlgae(lifeCfg);
    buildCorals();
    buildFish();
    buildAbyss();
    buildPikes();
    if (state.fishMesh) state.fishMesh.count = Math.min(FISH_MAX, Math.max(0, Math.round(lifeCfg.fishCount)));
    state.reefsVisible = true;
    state.abyssVisible = false;
}

/** Libère toute la vie (changement complet de décor / dispose). */
export function disposeLife(scene) {
    if (state.algaeMesh) { scene.remove(state.algaeMesh); state.algaeMesh.geometry.dispose(); unregisterEnvMat(state.algaeMesh.material); state.algaeMesh.material.dispose(); state.algaeMesh = null; }
    if (state.coralMeshes) { state.coralMeshes.forEach((m) => { scene.remove(m); m.geometry.dispose(); unregisterEnvMat(m.material); m.material.dispose(); }); state.coralMeshes = null; }
    if (state.fishMesh) { scene.remove(state.fishMesh); state.fishMesh.geometry.dispose(); unregisterEnvMat(state.fishMesh.material); state.fishMesh.material.dispose(); state.fishMesh = null; }
    if (state.abyssMesh) {
        scene.remove(state.abyssMesh); scene.remove(state.abyssGlowMesh);
        state.abyssMesh.geometry.dispose(); state.abyssMesh.material.dispose();
        state.abyssGlowMesh.geometry.dispose(); state.abyssGlowMesh.material.dispose();
        state.abyssMesh = null; state.abyssGlowMesh = null;
    }
    if (state.pikeGroup) {
        scene.remove(state.pikeGroup);
        state.pikeGroup.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
        state.pikeGroup = null;
    }
    if (state.pikeMat) { unregisterEnvMat(state.pikeMat); state.pikeMat = null; }
    algaeData.length = 0; fishData.length = 0; abyssData.length = 0; pikeData.length = 0;
    coralData.forEach((a) => { a.length = 0; });
}

/** Recale algues + coraux après un changement de terrain. */
export function updateLifeAnchors() {
    updateAlgaeAnchors();
}

/** Applique les bascules (visibilité, longueur algues, nombre de poissons). */
export function applyLifeState(lifeCfg) {
    if (state.algaeMesh) state.algaeMesh.userData.lenFactor = lifeCfg.algaeLen;
    if (state.algaeMesh) updateAlgaeAnchors();
    if (state.fishMesh) state.fishMesh.count = Math.min(FISH_MAX, Math.max(0, Math.round(lifeCfg.fishCount)));
}

/** Uniforms du shader algues (temps + courant). */
export function setAlgaeUniforms(time, current) {
    algaeUniforms.uTime.value = time;
    algaeUniforms.uSway.value = current;
}

/** Mise à jour par frame : poissons, abysse, brochets. */
export function updateLife(dt, time, { rovPos, lifeCfg }) {
    updateFishStep(dt, time, rovPos, lifeCfg);
    updateAbyssStep(dt, time);
    updatePikesStep(dt, rovPos);
}

/** Densité de la vie (preset qualité). */
export function setLifeDensity(density) {
    state.density = density;
}

/** Statistiques pour la page de configuration. */
export function lifeStats() {
    return {
        algaeInstances: state.algaeMesh ? state.algaeMesh.count : 0,
        coralInstances: state.coralMeshes ? state.coralMeshes.reduce((n, m) => n + m.count, 0) : 0,
        fishCount: state.fishMesh ? state.fishMesh.count : 0,
        abyssCount: state.abyssMesh ? state.abyssMesh.count : 0,
        pikeCount: pikeData.length,
        spawnGuard: LIFE_SPAWN_GUARD,
        plateauArea: reefPlateauArea(),
    };
}
