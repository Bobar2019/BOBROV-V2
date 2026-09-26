/**
 * BOBROV-V2 — Sub Simulator immersif · surface de l'eau et lumière.
 *
 * Portage fidèle de BOBROV-main (simulator3d.js, L3539-3933) :
 *   - surface Gerstner 6 vagues (VS/FS GLSL inchangés, écume + shoaling plage) ;
 *   - caustiques Voronoï animées (plan additif) ;
 *   - god rays volumétriques (éventail de plans texturés, balancement).
 * Adaptations minimales liées au monde plus grand :
 *   - le plan des caustiques se pose au niveau du lagon (lagoonFloorY), ce qui
 *     reproduit exactement l'ancien lorsque la fosse est désactivée (100 %) ;
 *   - la hauteur des god rays suit la profondeur du lagon (plafonnée à 60 m).
 */

import * as THREE from 'three';
import { CEIL_Y } from './env-defaults.js';
import { getWorldState, lagoonFloorY } from './env-terrain.js';

const state = {
    surfaceMesh: null,
    causticsMesh: null,
    godRaysGroup: null,
};

// ---------------------------------------------------------------------- //
// Shaders surface (Gerstner) — inchangés                                //
// ---------------------------------------------------------------------- //

const _SURFACE_VS = /* glsl */`
uniform float uTime;
uniform float uWaveHeight;
uniform float uBeachInnerDist;   // rayon intérieur zone plage (m)
uniform float uBeachOuterDist;   // rayon extérieur zone plage = WALL_POS (m)
uniform float uBeachBoost;       // multiplicateur amplitude sur la plage (2-4×)
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vElevation;
varying vec3 vViewDir;
varying float vBeachT;           // 0 = pleine mer, 1 = zone plage
#include <fog_pars_vertex>

// Vague Gerstner avec tangentes partielles pour normales analytiques
vec3 gerstner(vec2 pos, float amp, float freq, float speed, vec2 dir, float steepness, float t,
              out float dDx, out float dDz) {
    float phase = freq * dot(dir, pos) - speed * t;
    float s = sin(phase), c = cos(phase);
    float Q = steepness / (freq * amp * 4.0 + 0.001);
    float dx = Q * amp * dir.x * c;
    float dy = amp * s;
    float dz = Q * amp * dir.y * c;
    dDx = Q * dir.x * dir.x * (-s) + dir.x * c * steepness * 0.25;
    dDz = Q * dir.y * dir.y * (-s) + dir.y * c * steepness * 0.25;
    return vec3(dx, dy, dz);
}

void main() {
    vec3 p = position;
    float t = uTime;
    // ── Boost plage : amplification des vagues au-dessus de la zone plage (shoaling) ──
    float dist = length(p.xz);
    float beachRange = max(uBeachOuterDist - uBeachInnerDist, 0.01);
    float beachT = smoothstep(uBeachInnerDist, uBeachOuterDist, dist);
    float h = uWaveHeight * (1.0 + (uBeachBoost - 1.0) * beachT);
    // 6 vagues de fréquences/directions/amplitudes variées pour réalisme
    float d1, d2;
    vec3 w1 = gerstner(p.xz, h*0.45, 0.70, 1.10, normalize(vec2( 1.0,  0.3)), 0.55, t, d1, d2);
    vec3 w2 = gerstner(p.xz, h*0.30, 1.30, 0.85, normalize(vec2(-0.5,  1.0)), 0.45, t, d1, d2);
    vec3 w3 = gerstner(p.xz, h*0.18, 2.20, 1.40, normalize(vec2( 0.7, -0.6)), 0.35, t, d1, d2);
    vec3 w4 = gerstner(p.xz, h*0.10, 3.50, 1.80, normalize(vec2(-0.3, -0.8)), 0.25, t, d1, d2);
    vec3 w5 = gerstner(p.xz, h*0.06, 5.50, 2.20, normalize(vec2( 0.9,  0.5)), 0.15, t, d1, d2);
    vec3 w6 = gerstner(p.xz, h*0.03, 8.00, 2.80, normalize(vec2(-0.7,  0.4)), 0.10, t, d1, d2);
    p.x += w1.x + w2.x + w3.x + w4.x + w5.x + w6.x;
    p.y += w1.y + w2.y + w3.y + w4.y + w5.y + w6.y;
    p.z += w1.z + w2.z + w3.z + w4.z + w5.z + w6.z;
    // Élévation totale pour détection de crêtes (écume)
    float elevation = w1.y + w2.y + w3.y + w4.y + w5.y + w6.y;
    // Normale analytique par différences finies dans le vertex shader
    float eps = 0.15;
    vec3 pR = position + vec3(eps, 0.0, 0.0);
    vec3 pF = position + vec3(0.0, 0.0, eps);
    vec3 wR1 = gerstner(pR.xz, h*0.45, 0.70, 1.10, normalize(vec2( 1.0,  0.3)), 0.55, t, d1, d2);
    vec3 wR2 = gerstner(pR.xz, h*0.30, 1.30, 0.85, normalize(vec2(-0.5,  1.0)), 0.45, t, d1, d2);
    vec3 wR3 = gerstner(pR.xz, h*0.18, 2.20, 1.40, normalize(vec2( 0.7, -0.6)), 0.35, t, d1, d2);
    vec3 wR4 = gerstner(pR.xz, h*0.10, 3.50, 1.80, normalize(vec2(-0.3, -0.8)), 0.25, t, d1, d2);
    vec3 wR5 = gerstner(pR.xz, h*0.06, 5.50, 2.20, normalize(vec2( 0.9,  0.5)), 0.15, t, d1, d2);
    vec3 wR6 = gerstner(pR.xz, h*0.03, 8.00, 2.80, normalize(vec2(-0.7,  0.4)), 0.10, t, d1, d2);
    pR.x += wR1.x + wR2.x + wR3.x + wR4.x + wR5.x + wR6.x;
    pR.y += wR1.y + wR2.y + wR3.y + wR4.y + wR5.y + wR6.y;
    pR.z += wR1.z + wR2.z + wR3.z + wR4.z + wR5.z + wR6.z;
    vec3 wF1 = gerstner(pF.xz, h*0.45, 0.70, 1.10, normalize(vec2( 1.0,  0.3)), 0.55, t, d1, d2);
    vec3 wF2 = gerstner(pF.xz, h*0.30, 1.30, 0.85, normalize(vec2(-0.5,  1.0)), 0.45, t, d1, d2);
    vec3 wF3 = gerstner(pF.xz, h*0.18, 2.20, 1.40, normalize(vec2( 0.7, -0.6)), 0.35, t, d1, d2);
    vec3 wF4 = gerstner(pF.xz, h*0.10, 3.50, 1.80, normalize(vec2(-0.3, -0.8)), 0.25, t, d1, d2);
    vec3 wF5 = gerstner(pF.xz, h*0.06, 5.50, 2.20, normalize(vec2( 0.9,  0.5)), 0.15, t, d1, d2);
    vec3 wF6 = gerstner(pF.xz, h*0.03, 8.00, 2.80, normalize(vec2(-0.7,  0.4)), 0.10, t, d1, d2);
    pF.x += wF1.x + wF2.x + wF3.x + wF4.x + wF5.x + wF6.x;
    pF.y += wF1.y + wF2.y + wF3.y + wF4.y + wF5.y + wF6.y;
    pF.z += wF1.z + wF2.z + wF3.z + wF4.z + wF5.z + wF6.z;
    vec3 tangent = normalize(pR - p);
    vec3 bitangent = normalize(pF - p);
    vec3 n = normalize(cross(bitangent, tangent));
    // Écume : proportionnelle à l'élévation au-dessus du niveau moyen
    float waveMax = h * 1.1;
    vFoam = smoothstep(waveMax * 0.35, waveMax * 0.75, elevation);
    // Écume supplémentaire en zone plage (brassage continu)
    float beachChurn = sin(t * 2.5 + dist * 0.8) * 0.5 + 0.5;
    vFoam = max(vFoam, beachT * beachChurn * 0.6);
    vElevation = elevation;
    vBeachT = beachT;
    vWorldPos = (modelMatrix * vec4(p, 1.0)).xyz;
    vNormal = normalize(normalMatrix * n);
    vViewDir = cameraPosition - vWorldPos;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
}`;

const _SURFACE_FS = /* glsl */`
uniform vec3 uSunDir;
uniform float uTime;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vElevation;
varying vec3 vViewDir;
varying float vBeachT;
#include <fog_pars_fragment>

float fresnelSchlick(float cosTheta, float F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

vec3 skyColor(vec3 dir) {
    float y = max(dir.y, 0.0);
    vec3 zenith  = vec3(0.18, 0.38, 0.72);
    vec3 horizon = vec3(0.55, 0.72, 0.85);
    vec3 col = mix(horizon, zenith, pow(y, 0.5));
    float sunDot = max(dot(dir, uSunDir), 0.0);
    col += vec3(1.0, 0.85, 0.6) * pow(sunDot, 32.0) * 0.6;
    col += vec3(1.0, 0.95, 0.8) * pow(sunDot, 256.0) * 2.0;
    return col;
}

void main() {
    vec3 viewDir = normalize(vViewDir);
    vec3 N = normalize(vNormal);
    bool camAbove = cameraPosition.y > vWorldPos.y;
    vec3 nFace = camAbove ? N : -N;
    float NdotV = max(dot(nFace, viewDir), 0.0);
    float fresnel = fresnelSchlick(NdotV, 0.02);
    vec3 reflDir = reflect(-viewDir, nFace);
    vec3 reflCol = skyColor(reflDir);
    vec3 deepCol = vec3(0.01, 0.06, 0.12);
    vec3 shallowCol = vec3(0.04, 0.22, 0.32);
    float sss = pow(max(dot(viewDir, -uSunDir), 0.0), 4.0);
    sss *= smoothstep(-0.1, 0.3, vElevation);
    vec3 sssCol = vec3(0.05, 0.45, 0.35) * sss * 0.7;
    vec3 waterCol = mix(deepCol, shallowCol, 0.5 + 0.5 * vElevation);
    vec3 color;
    float baseAlpha;

    if (camAbove) {
        color = mix(waterCol, reflCol, fresnel) + sssCol;
        baseAlpha = mix(0.35, 0.92, fresnel);
    } else {
        float underFresnel = fresnelSchlick(NdotV, 0.30);
        vec3 underCol = mix(vec3(0.06, 0.28, 0.42), reflCol * 1.25, underFresnel);
        float sunUnder = pow(max(dot(N, uSunDir), 0.0), 6.0);
        underCol += vec3(0.45, 0.65, 0.75) * sunUnder;
        float beachSun = pow(max(dot(N, uSunDir), 0.0), 3.0) * vBeachT * 1.5;
        underCol += vec3(0.6, 0.85, 0.95) * beachSun;
        underCol = mix(underCol, vec3(0.15, 0.55, 0.65), vBeachT * 0.4);
        float underFoam = vFoam * (0.55 + vBeachT * 0.45);
        underCol = mix(underCol, vec3(0.85, 0.92, 0.96), underFoam);
        color = underCol;
        baseAlpha = mix(0.65, 0.95, underFresnel);
        baseAlpha = mix(baseAlpha, min(baseAlpha + 0.2, 0.98), vBeachT);
    }

    vec3 H = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(nFace, H), 0.0), 512.0) * 1.5;
    float spec2 = pow(max(dot(nFace, H), 0.0), 64.0) * 0.3;
    color += vec3(1.0, 0.95, 0.85) * (spec + spec2);
    if (camAbove) {
        vec3 foamCol = vec3(0.85, 0.92, 0.95);
        float foamAlpha = vFoam * 0.7;
        color = mix(color, foamCol, foamAlpha);
        baseAlpha = max(baseAlpha, foamAlpha);
    }
    gl_FragColor = vec4(color, baseAlpha);
    #include <fog_fragment>
}`;

// ---------------------------------------------------------------------- //
// Shaders caustiques (Voronoi léger) — inchangés                        //
// ---------------------------------------------------------------------- //

const _CAUSTICS_VS = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const _CAUSTICS_FS = /* glsl */`
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;

vec2 hash22(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

float voronoi(vec2 uv) {
    vec2 i = floor(uv), f = fract(uv);
    float d = 1.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 n = vec2(float(x), float(y));
            vec2 p = hash22(i + n);
            p = 0.5 + 0.5 * sin(uTime * 0.4 + 6.2831 * p);
            float dist = length(n + p - f);
            d = min(d, dist);
        }
    }
    return d;
}

void main() {
    vec2 uv = vUv * 12.0;
    float v1 = voronoi(uv);
    float v2 = voronoi(uv * 1.7 + 3.7);
    float caustic = smoothstep(0.0, 0.08, abs(v1 - v2));
    caustic = 1.0 - caustic;
    float brightness = caustic * uIntensity;
    vec3 color = vec3(0.6, 0.85, 1.0) * brightness * 2.5;
    float alpha = brightness * 0.6;
    gl_FragColor = vec4(color, alpha);
}`;

// ---------------------------------------------------------------------- //
// Construction / mise à jour                                              //
// ---------------------------------------------------------------------- //

/** (Re)construit la surface Gerstner (rien si vagues désactivées). */
export function buildSurface(scene, waterCfg) {
    if (state.surfaceMesh) {
        scene.remove(state.surfaceMesh);
        state.surfaceMesh.geometry.dispose();
        state.surfaceMesh.material.dispose();
        state.surfaceMesh = null;
    }
    if (!waterCfg.waves) return null;

    const w = getWorldState();
    const size = Math.max(w.wallPos * 2.8, -w.floorY * 3.5, 120);
    const segs = THREE.MathUtils.clamp(Math.round(size / 0.75), 128, 320);
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const sunDirection = new THREE.Vector3(6, 12, 8).normalize();

    const beachFrac = w.world.beachExtent / 100;
    const beachInnerDist = w.wallPos * (1.0 - beachFrac);
    const beachDepthFrac = w.world.beachDepthPct / 100;
    const beachBoost = 1.0 + 3.0 * beachDepthFrac;

    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uWaveHeight: { value: waterCfg.waveHeight },
            uBeachInnerDist: { value: beachInnerDist },
            uBeachOuterDist: { value: w.wallPos },
            uBeachBoost: { value: beachBoost },
            uSunDir: { value: sunDirection },
            ...THREE.UniformsLib.fog,
        },
        vertexShader: _SURFACE_VS,
        fragmentShader: _SURFACE_FS,
        transparent: true,
        depthWrite: false,   // ne masque pas la scène vue de dessous
        side: THREE.DoubleSide,
        fog: true,
    });
    state.surfaceMesh = new THREE.Mesh(geo, mat);
    state.surfaceMesh.position.y = CEIL_Y;
    state.surfaceMesh.renderOrder = 100;
    scene.add(state.surfaceMesh);
    return state.surfaceMesh;
}

/** (Re)construit le plan de caustiques au niveau du lagon. */
export function buildCaustics(scene, waterCfg) {
    if (state.causticsMesh) {
        scene.remove(state.causticsMesh);
        state.causticsMesh.geometry.dispose();
        state.causticsMesh.material.dispose();
        state.causticsMesh = null;
    }
    if (!waterCfg.caustics) return null;
    const w = getWorldState();
    const size = w.wallPos * 2;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uIntensity: { value: waterCfg.causticsIntensity },
        },
        vertexShader: _CAUSTICS_VS,
        fragmentShader: _CAUSTICS_FS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    state.causticsMesh = new THREE.Mesh(geo, mat);
    state.causticsMesh.position.y = lagoonFloorY() + 0.05;
    state.causticsMesh.renderOrder = 50;
    scene.add(state.causticsMesh);
    return state.causticsMesh;
}

/** (Re)construit l'éventail de god rays sous la surface. */
export function buildGodRays(scene, waterCfg) {
    if (state.godRaysGroup) {
        scene.remove(state.godRaysGroup);
        state.godRaysGroup.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
        state.godRaysGroup = null;
    }
    if (!waterCfg.godrays) return null;
    const w = getWorldState();
    state.godRaysGroup = new THREE.Group();
    const rayCount = 20;
    const rayHeight = Math.min(60, Math.max(30, -lagoonFloorY() * 1.3));

    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(64, 256);
    for (let y = 0; y < 256; y++) {
        const vy = y / 255;
        const vAlpha = Math.pow(1.0 - vy, 1.4);
        for (let x = 0; x < 64; x++) {
            const vx = (x - 31.5) / 31.5;
            const radial = Math.pow(Math.max(0, 1.0 - vx * vx), 1.2);
            const a = vAlpha * radial;
            const i = (y * 64 + x) * 4;
            img.data[i] = 200;
            img.data[i + 1] = 225;
            img.data[i + 2] = 255;
            img.data[i + 3] = Math.round(a * 90);
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;

    for (let i = 0; i < rayCount; i++) {
        const t = i / (rayCount - 1);
        const angle = (t - 0.5) * Math.PI * 0.9;
        const dist = 2 + Math.pow(Math.abs(t - 0.5), 0.7) * (w.wallPos * 0.45);
        const rayWidth = 0.8 + Math.pow(Math.abs(t - 0.5), 0.5) * 1.6;
        const geo = new THREE.PlaneGeometry(rayWidth, rayHeight);
        const mat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            opacity: waterCfg.godraysIntensity * 0.55,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(
            Math.sin(angle) * dist,
            CEIL_Y - rayHeight / 2,
            -Math.cos(angle) * dist * 0.6
        );
        mesh.lookAt(0, CEIL_Y + 2, 0);
        mesh.rotation.z = (Math.random() - 0.5) * 0.08;
        mesh.userData.baseX = mesh.position.x;
        mesh.userData.baseZ = mesh.position.z;
        mesh.userData.phase = Math.random() * Math.PI * 2;
        state.godRaysGroup.add(mesh);
    }
    scene.add(state.godRaysGroup);
    return state.godRaysGroup;
}

/** Avance les uniforms de la surface et balance les god rays. */
export function updateWaterAnim(time, waterCfg) {
    if (state.surfaceMesh && state.surfaceMesh.material.uniforms) {
        state.surfaceMesh.material.uniforms.uTime.value = time * waterCfg.waveSpeed;
        state.surfaceMesh.material.uniforms.uWaveHeight.value = waterCfg.waveHeight;
    }
    if (state.causticsMesh && state.causticsMesh.visible && state.causticsMesh.material.uniforms) {
        state.causticsMesh.material.uniforms.uTime.value = time;
    }
    if (state.godRaysGroup && state.godRaysGroup.visible) {
        state.godRaysGroup.children.forEach((r) => {
            const ph = time * 0.25 + r.userData.phase;
            r.position.x = r.userData.baseX + Math.sin(ph) * 0.25;
            r.position.z = r.userData.baseZ + Math.cos(ph * 0.7) * 0.15;
        });
    }
}

/**
 * Applique le facteur de lumière solaire f (0 = noir abyssal) :
 * visibilité et intensité des caustiques et god rays, comme l'original.
 */
export function setWaterLightFactor(f, waterCfg) {
    if (state.causticsMesh) {
        state.causticsMesh.visible = waterCfg.caustics && f > 0.02;
        if (state.causticsMesh.material.uniforms) {
            state.causticsMesh.material.uniforms.uIntensity.value = waterCfg.causticsIntensity * f;
        }
    }
    if (state.godRaysGroup) {
        state.godRaysGroup.visible = waterCfg.godrays && f > 0.05;
        state.godRaysGroup.traverse((o) => {
            if (o.isMesh) o.material.opacity = waterCfg.godraysIntensity * 0.6 * f;
        });
    }
}

/** Applique l'état actif/inactif de base (vagues, caustiques, godrays). */
export function applyWaterFlags(waterCfg) {
    if (state.surfaceMesh) state.surfaceMesh.visible = !!waterCfg.waves;
    if (state.causticsMesh) state.causticsMesh.visible = !!waterCfg.caustics;
    if (state.godRaysGroup) state.godRaysGroup.visible = !!waterCfg.godrays;
}

/** Libère toutes les ressources eau. */
export function disposeWater(scene) {
    if (state.surfaceMesh) {
        scene.remove(state.surfaceMesh);
        state.surfaceMesh.geometry.dispose();
        state.surfaceMesh.material.dispose();
        state.surfaceMesh = null;
    }
    if (state.causticsMesh) {
        scene.remove(state.causticsMesh);
        state.causticsMesh.geometry.dispose();
        state.causticsMesh.material.dispose();
        state.causticsMesh = null;
    }
    if (state.godRaysGroup) {
        scene.remove(state.godRaysGroup);
        state.godRaysGroup.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
        state.godRaysGroup = null;
    }
}

/** Références internes (ambiance de profondeur). */
export function waterRefs() {
    return { surfaceMesh: state.surfaceMesh, causticsMesh: state.causticsMesh, godRaysGroup: state.godRaysGroup };
}
