/**
 * BOBROV-V2 — Sub Simulator immersif · valeurs par défaut du monde et du décor.
 *
 * Module pur (aucun import Three.js) : ces constantes et structures décrivent
 * la forme des réglages persistés dans config.json (section `simulator`)
 * et servent de socle à la fusion avec les valeurs enregistrées.
 *
 * Adapté de BOBROV-main (scene_3d_config.json + diveState/envState d'origine) :
 *   - monde 1 km × 1 km × 300 m, relief activé, visibilité 30 m ;
 *   - fosse « Blue Hole » 15 % / 45 % (profondeur lagon % monde, rayon % bassin) ;
 *   - plage 10 % / 12 %, récif 20 % / 20 %, zone compacte 0 %, courant 0,03 ;
 *   - vagues + caustiques + god rays activés ;
 *   - faune/flore : mêmes objets que l'ancien simulateur (modèles GLB copiés
 *     dans static/sim/assets/models/).
 *
 * Sémantique « fosse » (héritée des réglages abyssDepth/abyssRadius de
 * l'ancienne page CONFIG SCÈNE 3D, SUB_SIMULATOR.md §6.2) :
 *   - pitDepthPct = profondeur du lagon (plaine hors fosse) en % de la
 *     profondeur du monde ; 100 % = fond plat à −depth (comportement
 *     d'origine), 15 % = lagon à −45 m avec fosse centrale à −300 m ;
 *   - pitRadiusPct = rayon de la fosse en % de la demi-étendue du monde.
 */

/** Longueur de référence du ROV (m) — sert d'échelle au modèle GLB. */
export const MODEL_LENGTH = 0.4;

/** Plan d'eau : y = 0 dans le repère monde du simulateur. */
export const CEIL_Y = 0.0;

/** Garde de coque : marge entre le plancher de pilotage et le terrain (m). */
export const HULL_CLEARANCE = 0.25;

/** Réglages monde — réplique exacte de l'ancien monde + extensions requises. */
export const WORLD_DEFAULTS = Object.freeze({
    extent: 1000,        // largeur du bassin (m) — cube 1 km × 1 km
    depth: 300,          // profondeur maximale (m) — fond de la fosse
    relief: true,        // relief fractal activé
    reliefAmp: 4,        // amplitude du relief (0–20 m, l'ancien : min(depth×0.05, 4))
    visibility: 30,      // visibilité / turbidité (1–100 m) → densité FogExp2
    beachExtent: 10,     // largeur plage (% du bassin, depuis le bord)
    beachDepthPct: 12,   // profondeur plage (% de la profondeur du lagon)
    reefExtent: 20,      // largeur récif (% du bassin)
    reefDepthPct: 20,    // profondeur récif (% de la profondeur du lagon)
    pitDepthPct: 15,     // fosse : profondeur lagon (% profondeur du monde)
    pitRadiusPct: 45,    // fosse : rayon (% demi-étendue)
    compactZone: 0,      // 0 = bassin complet, 100 = zone 20 m × 20 m
    walls: false,        // parois rocheuses 45° (désactivées par défaut, comme l'ancien)
    wallTiling: 5,       // tiling texture des parois
});

/** Réglages surface / eau. */
export const WATER_DEFAULTS = Object.freeze({
    waves: true,
    waveHeight: 0.5,
    waveSpeed: 1.0,
    caustics: true,
    causticsIntensity: 0.7,
    godrays: true,
    godraysIntensity: 0.5,
    current: 0.03,       // courant marin (ondulation algues + faune)
});

/**
 * Réglages physiques ROV éditables depuis la page de configuration.
 * Miroir des clés principales de PHYSICS_DEFAULTS (sim-physics.js) —
 * toute clé absente retombe sur le défaut de la physique.
 */
export const PHYSICS_DEFAULTS_MIRROR = Object.freeze({
    mass_kg: 12.0,
    thrust_max_n: 24.5,
    thruster_tau_s: 0.08,
    vmax_surge_mps: 1.5,
    vmax_sway_mps: 1.2,
    vmax_heave_mps: 0.9,
    wmax_yaw_dps: 80,
    wmax_roll_dps: 55,
    wmax_pitch_dps: 55,
    drag_linear_ratio: 0.06,
    stab_roll_nm_rad: 8.0,
    stab_pitch_nm_rad: 8.0,
});

/** Réglages projecteurs LED (les spots 3D sont montés par env-atmosphere). */
export const LED_DEFAULTS = Object.freeze({
    on: false,
    intensity: 80,   // % de LED_MAX_INTENSITY
    tilt: 12,        // inclinaison (degrés)
});

/** Réglages caméra. */
export const CAM_DEFAULTS = Object.freeze({
    pip: false,      // PIP extérieur désactivé par défaut (choix utilisateur)
    fov: 80,         // FOV caméra FPV (60–100°)
});

/** Réglages affichage / performance (Raspberry Pi 5). */
export const DISPLAY_DEFAULTS = Object.freeze({
    quality: 'moyen',  // 'bas' | 'moyen' | 'eleve'
    fps60: false,      // rendu 30 im/s par défaut, 60 optionnel
});

/**
 * Presets de qualité : pixelRatio, ombres, facteur de densité du décor.
 * Perf (Raspberry Pi 5) : pixelRatio « moyen » ramené à 1.25 — le fill rate
 * est le premier poste de coût GPU (le MSAA s'applique au buffer agrandi).
 */
export const QUALITY_PRESETS = Object.freeze({
    bas:   { pixelRatio: 1.0,  shadows: false, shadowMap: 512,  density: 0.5 },
    moyen: { pixelRatio: 1.25, shadows: true,  shadowMap: 1024, density: 0.75 },
    eleve: { pixelRatio: 2.0,  shadows: true,  shadowMap: 2048, density: 1.0 },
});

/**
 * Faune & flore par défaut — reprise de scene_3d_config.json (BOBROV-main),
 * modèles GLB copiés sous static/sim/assets/models/.
 * Vocabulaire des zones : `surface`, `pleine_eau` (mi-eau), `fond`
 * (plancher du lagon), `recif` (anneau récifal), `sol` (flore ancrée au
 * relief). `school: true` regroupe les instances en banc ; `behavior` :
 * `nageant` (indifférent), `curieux`, `fuir`. `enabled` permet de
 * désactiver un objet sans le supprimer (épave 24 Mo).
 */
export const SCENE_OBJECTS_DEFAULTS = Object.freeze([
    { name: 'Guppy', type: 'faune', model: 'guppy.glb', real_size_m: 0.4, count: 20,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'nageant', zone: 'recif', school: true,
      speed: 1.5, behavior: 'nageant', turn_speed: 0.5, enabled: true },
    { name: 'Thon', type: 'faune', model: 'bluefin_tuna.glb', real_size_m: 1.2, count: 12,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'nageant', zone: 'pleine_eau', school: true,
      speed: 0.9, behavior: 'nageant', turn_speed: 0.4, enabled: true },
    { name: 'Baleine bleue', type: 'mamifere', model: 'blue_whale_-_textured.glb', real_size_m: 25, count: 1,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'nageant', zone: 'pleine_eau',
      speed: 0.3, behavior: 'nageant', enabled: true },
    { name: 'Néon bleu', type: 'faune', model: 'paracheirodon_innesi___tetra_neon.glb', real_size_m: 0.4, count: 60,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'nageant', zone: 'recif', school: true,
      speed: 0.5, behavior: 'nageant', turn_speed: 0.6, enabled: true },
    { name: 'Esturgeon', type: 'faune', model: 'model_66a_-_atlantic_sturgeon.glb', real_size_m: 2.04, count: 6,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'nageant', zone: 'fond',
      speed: 1, behavior: 'curieux', turn_speed: 0.4, enabled: true },
    { name: 'Épave', type: 'objet', model: 'epave.glb', real_size_m: 20, count: 1,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'fixe', zone: 'fond',
      speed: 1, behavior: 'static', enabled: true },
    { name: 'Posidonie', type: 'flore', model: 'sea_weed.glb', real_size_m: 10, count: 150,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'ancre_ondule', zone: 'sol',
      speed: 1, behavior: 'neant', enabled: true },
    { name: 'Herbier', type: 'flore', model: 'sea_weed.glb', real_size_m: 10, count: 400,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'ancre_ondule', zone: 'sol',
      speed: 1, behavior: 'neant', enabled: true },
    { name: 'Tortue', type: 'faune', model: 'tortue.glb', real_size_m: 1, count: 5,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'nageant', zone: 'recif',
      speed: 1, behavior: 'nageant', turn_speed: 0.5, enabled: true },
    { name: 'Projecteur', type: 'objet', model: 'projecteur.glb', real_size_m: 0.4, count: 0,
      scale_min: 0.8, scale_max: 1.2, kinematic: 'fixe', zone: 'recif',
      speed: 1, behavior: 'static', enabled: false },
]);

/** Réglages vie procédurale (algues, coraux, poissons, abysse, brochets). */
export const LIFE_DEFAULTS = Object.freeze({
    algae: true, algaeDensity: 1.0, algaeLen: 2.4,
    corals: true, reefDensity: 100,
    fish: true, fishCount: 500, fishSpeed: 1.3,
    abyssCreatures: true, abyssDensity: 100,
    pikes: true,
});

/**
 * Structure complète des réglages du module (section `simulator` de config.json).
 * `enabled` est géré par app.js (carte Paramètres → Sub Simu) : il est
 * simplement repris ici pour que la fusion le préserve.
 */
export function defaultSimulatorSettings() {
    return {
        world: { ...WORLD_DEFAULTS },
        water: { ...WATER_DEFAULTS },
        physics: { ...PHYSICS_DEFAULTS_MIRROR },
        led: { ...LED_DEFAULTS },
        cam: { ...CAM_DEFAULTS },
        display: { ...DISPLAY_DEFAULTS },
        life: { ...LIFE_DEFAULTS },
        scene: { objects: SCENE_OBJECTS_DEFAULTS.map((o) => ({ ...o })) },
    };
}

/** Fusion profonde (objets simples + tableaux remplacés en bloc). */
export function mergeDeep(base, patch) {
    if (patch === null || patch === undefined) return base;
    if (Array.isArray(base) || typeof base !== 'object') return patch;
    if (Array.isArray(patch) || typeof patch !== 'object') return patch;
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        out[key] = key in base ? mergeDeep(base[key], value) : value;
    }
    return out;
}

/**
 * Réglages complets du simulateur = défauts ← valeurs persistées.
 * Tolère un historique partiel (premières versions de config.json).
 */
export function resolveSimulatorSettings(persisted) {
    const defaults = defaultSimulatorSettings();
    const src = (persisted && typeof persisted === 'object') ? persisted : {};
    const merged = mergeDeep(defaults, {
        world: src.world, water: src.water, physics: src.physics,
        led: src.led, cam: src.cam, display: src.display,
        life: src.life, scene: src.scene,
    });
    if (Array.isArray(merged.scene?.objects) && merged.scene.objects.length === 0) {
        merged.scene.objects = SCENE_OBJECTS_DEFAULTS.map((o) => ({ ...o }));
    }
    return merged;
}
