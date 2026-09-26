/**
 * BOBROV-V2 — Sub Simulator immersif · bruit procédural & textures.
 *
 * Portage fidèle de BOBROV-main (simulator3d.js) : mulberry32, hash2,
 * noise2, fbm2 et les quatre textures canvas 512² (roche, sable, limon
 * abyssal, normal map rocheux). Algorithmes conservés à l'identique —
 * seuls les globals (renderer) deviennent des paramètres.
 */

import * as THREE from 'three';

/** Générateur pseudo-aléatoire déterministe (seed 32 bits → [0, 1[). */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Hash 2D entier → [0, 1] (bruit valeur). */
export function hash2(ix, iz) {
    let h = (ix * 374761393 + iz * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Bruit de valeur lissé (smoothstep) — signature identique à l'origine. */
export function noise2(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz), b = hash2(ix + 1, iz);
    const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** FBM 3 octaves (0.55 / 0.30 / 0.15) — utilisé par terrain et textures. */
export function fbm2(x, z) {
    return 0.55 * noise2(x, z) + 0.30 * noise2(x * 2.1, z * 2.1) + 0.15 * noise2(x * 4.3, z * 4.3);
}

// ---------------------------------------------------------------------- //
// Textures procédurales (canvas 512²)                                     //
// ---------------------------------------------------------------------- //

/** Réglages communs : wrapping répété + sRGB + anisotropie du renderer. */
function finishTexture(tex, anisotropy) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    if (anisotropy) tex.anisotropy = anisotropy;
    return tex;
}

/** Roche naturelle (terre / gris / mousse) pour parois et récif. */
export function makeRockTexture(anisotropy = 1) {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n1 = fbm2(x * 0.045, y * 0.045);
            const n2 = fbm2(x * 0.18 + 41, y * 0.18 + 17);
            const detail = fbm2(x * 0.4 + 83, y * 0.4 + 57);
            const n = n1 * 0.55 + n2 * 0.3 + detail * 0.15;
            const v = 35 + n * 85;
            const i = (y * size + x) * 4;
            img.data[i] = v * (0.90 + n1 * 0.18);
            img.data[i + 1] = v * (0.85 + n2 * 0.10);
            img.data[i + 2] = v * (0.72 + detail * 0.14);
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return finishTexture(new THREE.CanvasTexture(cv), anisotropy);
}

/** Sable blanc des plages peu profondes. */
export function makeSandTexture(anisotropy = 1) {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n1 = fbm2(x * 0.06 + 5.3, y * 0.06 + 8.1);
            const n2 = fbm2(x * 0.25 + 12, y * 0.25 + 7);
            const grain = fbm2(x * 0.8 + 33, y * 0.8 + 11);
            const n = n1 * 0.4 + n2 * 0.35 + grain * 0.25;
            const v = 180 + n * 55;
            const i = (y * size + x) * 4;
            img.data[i] = Math.min(255, v * 1.02);
            img.data[i + 1] = Math.min(255, v * 0.96);
            img.data[i + 2] = Math.min(255, v * 0.78);
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return finishTexture(new THREE.CanvasTexture(cv), anisotropy);
}

/** Limon sombre bleuté des fonds abyssaux. */
export function makeAbyssTexture(anisotropy = 1) {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n1 = fbm2(x * 0.04 + 20, y * 0.04 + 40);
            const n2 = fbm2(x * 0.15 + 60, y * 0.15 + 30);
            const n = n1 * 0.6 + n2 * 0.4;
            const v = 20 + n * 35;
            const i = (y * size + x) * 4;
            img.data[i] = v * 0.7;
            img.data[i + 1] = v * 0.85;
            img.data[i + 2] = v * 1.1;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return finishTexture(new THREE.CanvasTexture(cv), anisotropy);
}

/** Normal map rocheux dérivé du fbm (différences finies, force 3.0). */
export function makeRockNormalMap() {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const str = 3.0;
    const sc = 0.06;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const hL = fbm2((x - 1) * sc, y * sc);
            const hR = fbm2((x + 1) * sc, y * sc);
            const hU = fbm2(x * sc, (y - 1) * sc);
            const hD = fbm2(x * sc, (y + 1) * sc);
            let nx = (hL - hR) * str;
            let ny = (hU - hD) * str;
            let nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            nx /= len; ny /= len; nz /= len;
            const i = (y * size + x) * 4;
            img.data[i] = (nx * 0.5 + 0.5) * 255;
            img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
            img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
}
