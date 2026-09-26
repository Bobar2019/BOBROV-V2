/**
 * BOBROV-V2 — Sub Simulator · mixage 6 axes DOF → 8 propulseurs.
 * Module isolé : aucune dépendance, aucun effet de bord.
 *
 * Source de vérité (copie strictement nécessaire à la physique) :
 *   /home/bob/BOBROV-main/backend/motor_mixer.py
 *   confirmé par /home/bob/BOBROV-main/I2C_ESP32_PROTOCOL.md §3.2
 *
 * Géométrie : 4 horizontaux en X à 45° (M1–M4, canaux ch0–ch3) et
 * 4 verticaux (M5–M8, ch4–ch7). Numérotation « départ avant-droit,
 * sens horaire strict », deux groupes distincts :
 *   M1 Av-D · M2 Ar-D · M3 Ar-G · M4 Av-G  (horizontaux)
 *   M5 Av-D · M6 Ar-D · M7 Ar-G · M8 Av-G  (verticaux)
 *
 * Conventions (identiques au firmware) :
 *   surge > 0 : avance              sway > 0 : translation vers la droite
 *   yaw   > 0 : lacet horaire (vue de dessus)
 *   heave > 0 : montée              roll / pitch > 0 : tribord bas / nez haut
 */

export const DOF_AXES = Object.freeze(['surge', 'sway', 'yaw', 'heave', 'roll', 'pitch']);

export function neutralDof() {
    return { surge: 0, sway: 0, yaw: 0, heave: 0, roll: 0, pitch: 0 };
}

/** Description des 8 propulseurs (ordre de numérotation officiel). */
export const MOTORS = Object.freeze([
    { id: 1, channel: 0, group: 'H', label: 'M1 · Horiz Av-D' },
    { id: 2, channel: 1, group: 'H', label: 'M2 · Horiz Ar-D' },
    { id: 3, channel: 2, group: 'H', label: 'M3 · Horiz Ar-G' },
    { id: 4, channel: 3, group: 'H', label: 'M4 · Horiz Av-G' },
    { id: 5, channel: 4, group: 'V', label: 'M5 · Vert Av-D' },
    { id: 6, channel: 5, group: 'V', label: 'M6 · Vert Ar-D' },
    { id: 7, channel: 6, group: 'V', label: 'M7 · Vert Ar-G' },
    { id: 8, channel: 7, group: 'V', label: 'M8 · Vert Av-G' },
]);

export const HORIZONTAL_IDS = Object.freeze([1, 2, 3, 4]);
export const VERTICAL_IDS = Object.freeze([5, 6, 7, 8]);

/**
 * Matrices de mixage — copiées telles quelles de `motor_mixer.py`
 * (coefficients [surge, sway, yaw] pour les horizontaux,
 *  [heave, roll, pitch] pour les verticaux).
 */
export const HORIZONTAL_MATRIX = Object.freeze({
    1: { surge: +0.707, sway: -0.707, yaw: -1.0 },
    2: { surge: -0.707, sway: -0.707, yaw: +1.0 },
    3: { surge: -0.707, sway: +0.707, yaw: -1.0 },
    4: { surge: +0.707, sway: +0.707, yaw: +1.0 },
});

export const VERTICAL_MATRIX = Object.freeze({
    5: { heave: +1.0, roll: -1.0, pitch: +1.0 },
    6: { heave: +1.0, roll: -1.0, pitch: -1.0 },
    7: { heave: +1.0, roll: +1.0, pitch: -1.0 },
    8: { heave: +1.0, roll: +1.0, pitch: +1.0 },
});

/**
 * Normalisation par groupe (règle exacte du firmware) : si un moteur du
 * groupe dépasse ±1, tout le groupe est réduit du même facteur pour
 * préserver les ratios relatifs. Modifie `motors` en place.
 * Retourne true si le groupe a été normalisé.
 */
export function normalizeGroup(motors, ids) {
    let maxAbs = 0;
    for (const id of ids) {
        const abs = Math.abs(motors[id]);
        if (abs > maxAbs) maxAbs = abs;
    }
    if (maxAbs <= 1.0) return false;
    const scale = 1.0 / maxAbs;
    for (const id of ids) motors[id] *= scale;
    return true;
}

/**
 * Mixage complet : consignes DOF ∈ [−1, +1] → poussées M1..M8 ∈ [−1, +1].
 * @param {{surge:number,sway:number,yaw:number,heave:number,roll:number,pitch:number}} dof
 * @param {{H:boolean,V:boolean}} [saturation] objet optionnel rempli avec l'état de saturation
 * @returns {Record<number, number>} poussées indexées par numéro de moteur (1..8)
 */
export function mixDofToMotors(dof, saturation = null) {
    const motors = {};
    for (const id of HORIZONTAL_IDS) {
        const row = HORIZONTAL_MATRIX[id];
        motors[id] = row.surge * dof.surge + row.sway * dof.sway + row.yaw * dof.yaw;
    }
    const satH = normalizeGroup(motors, HORIZONTAL_IDS);
    for (const id of VERTICAL_IDS) {
        const row = VERTICAL_MATRIX[id];
        motors[id] = row.heave * dof.heave + row.roll * dof.roll + row.pitch * dof.pitch;
    }
    const satV = normalizeGroup(motors, VERTICAL_IDS);
    if (saturation) {
        saturation.H = satH;
        saturation.V = satV;
    }
    return motors;
}

/**
 * Allocation inverse : poussées moteurs → torseur réalisé (transposée du
 * mixage). C'est exactement l'effort que les 8 propulseurs exercent sur
 * la coque, en unités de poussée moteur (à multiplier par la poussée
 * max et les bras de levier pour obtenir N et N·m).
 */
export function allocateMotorsToDof(thrust) {
    const out = neutralDof();
    for (const id of HORIZONTAL_IDS) {
        const t = thrust[id] || 0;
        const row = HORIZONTAL_MATRIX[id];
        out.surge += row.surge * t;
        out.sway += row.sway * t;
        out.yaw += row.yaw * t;
    }
    for (const id of VERTICAL_IDS) {
        const t = thrust[id] || 0;
        const row = VERTICAL_MATRIX[id];
        out.heave += row.heave * t;
        out.roll += row.roll * t;
        out.pitch += row.pitch * t;
    }
    return out;
}

/**
 * Gain d'un axe : somme des carrés des coefficients (Σ coef²). Un axe
 * commandé à +1 produit cette valeur sur la transposée — sert au
 * dimensionnement des efforts max de la physique.
 */
export function axisGain(axis) {
    let sum = 0;
    for (const id of [...HORIZONTAL_IDS, ...VERTICAL_IDS]) {
        const row = id <= 4 ? HORIZONTAL_MATRIX[id] : VERTICAL_MATRIX[id];
        if (row[axis] !== undefined) sum += row[axis] * row[axis];
    }
    return sum;
}
