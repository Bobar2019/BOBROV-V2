/**
 * BOBROV-V2 — Sub Simulator immersif · page de configuration (Paramètres → Sub Simu).
 *
 * Panneau additif injecté dans `#section-sim-config` : la carte
 * « Simulateur activé » gérée par app.js reste intacte et fonctionnelle.
 * Tout est persisté dans config.json (section `simulator.*`) via
 * GET/POST /api/config — aucune modification d'app/config.py (les clés
 * libres de la section sont tolérées par le validateur). La bibliothèque
 * GLB s'appuie sur le routeur additif /api/sim/assets/models (upload en
 * corps brut, 50 Mo max).
 *
 * Aucun import Three.js : la page fonctionne même si le vendor n'est pas
 * encore installé. Après « Enregistrer », l'événement `sim-config-saved`
 * notifie l'écran de simulation (sim.js) qui applique les réglages à chaud.
 */

import {
    resolveSimulatorSettings, defaultSimulatorSettings, QUALITY_PRESETS,
} from './env/env-defaults.js';

const SECTION_ID = 'section-sim-config';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Milieux proposés dans le tableau « Faune & flore GLB » : chaque entrée
 * combine le type moteur et la zone de placement (voir env-fauna.js).
 * La clé `type|zone` est écrite telle quelle dans l'objet de scène.
 */
const MILIEUX = [
    ['faune|surface', 'Faune — surface'],
    ['faune|pleine_eau', 'Faune — mi-eau'],
    ['faune|fond', 'Faune — fond (plancher)'],
    ['faune|recif', 'Faune — récif (plateau)'],
    ['flore|sol', 'Flore — au sol (relief)'],
    ['mamifere|pleine_eau', 'Mammifère — mi-eau'],
    ['objet|fond', 'Objet — posé au fond'],
    ['objet|recif', 'Objet — posé au récif'],
];

/** Comportements face au ROV (vocabulaire simplifié). */
const BEHAVIORS = [
    ['nageant', 'Indifférent'],
    ['curieux', 'Curieux'],
    ['fuir', 'Peur du ROV'],
];
const BEHAVIOR_LABELS = {
    nageant: 'Indifférent', curieux: 'Curieux', fuir: 'Peur du ROV',
    static: 'Statique', neant: 'Aucun',
};
const TYPE_LABELS = { faune: 'Faune', flore: 'Flore', mamifere: 'Mammifère', objet: 'Objet' };
const ZONE_LABELS = {
    surface: 'Surface', pleine_eau: 'Mi-eau', fond: 'Fond', recif: 'Récif', sol: 'Sol',
    abysse: 'Fosse', multi_couches: 'Multi-couches', plage: 'Plage',
};

/**
 * Réglages proposés à l'ajout d'un modèle : taille, nombre, banc,
 * comportement et vitesse adaptés à l'espèce — tout reste modifiable
 * dans le tableau ensuite.
 */
const MODEL_HINTS = [
    { match: /guppy/i, type: 'faune', zone: 'recif', real_size_m: 0.4, count: 20, school: true, speed: 1.5, behavior: 'nageant' },
    { match: /tuna|thon/i, type: 'faune', zone: 'pleine_eau', real_size_m: 1.2, count: 12, school: true, speed: 0.9, behavior: 'nageant' },
    { match: /neon|tetra/i, type: 'faune', zone: 'recif', real_size_m: 0.4, count: 60, school: true, speed: 0.5, behavior: 'nageant' },
    { match: /tortue|turtle/i, type: 'faune', zone: 'recif', real_size_m: 1, count: 5, school: false, speed: 1, behavior: 'curieux' },
    { match: /sturgeon|esturgeon|66a/i, type: 'faune', zone: 'fond', real_size_m: 2, count: 6, school: false, speed: 1, behavior: 'curieux' },
    { match: /whale|baleine|humpback|requin|shark/i, type: 'mamifere', zone: 'pleine_eau', real_size_m: 15, count: 1, school: false, speed: 0.3, behavior: 'nageant' },
    { match: /weed|posidonia|kelp|algae|algue|herbier/i, type: 'flore', zone: 'sol', real_size_m: 10, count: 150, school: false, speed: 1, behavior: 'neant' },
    { match: /epave|wreck|ship/i, type: 'objet', zone: 'fond', real_size_m: 20, count: 1, school: false, speed: 1, behavior: 'static' },
    { match: /projecteur|spot|light/i, type: 'objet', zone: 'recif', real_size_m: 0.4, count: 0, school: false, speed: 1, behavior: 'static' },
];
const DEFAULT_HINT = { type: 'faune', zone: 'pleine_eau', real_size_m: 1, count: 10, school: true, speed: 1, behavior: 'nageant' };

/** Heuristique d'ajout par nom de fichier GLB. */
function modelHint(file) {
    for (const hint of MODEL_HINTS) {
        if (hint.match.test(file)) return { ...hint };
    }
    return { ...DEFAULT_HINT };
}

/** Kinématique moteur déduite d'un type (cohérente avec env-fauna.js). */
function kinematicFor(type) {
    if (type === 'flore') return 'ancre_ondule';
    if (type === 'objet') return 'fixe';
    return 'nageant';
}

/** Raccourcis descripteurs de champs. */
const R = (path, label, min, max, step, unit) => ({ kind: 'range', path, label, min, max, step, unit });
const C = (path, label) => ({ kind: 'check', path, label });
const S = (path, label, options) => ({ kind: 'select', path, label, options });

/** Cartes de réglages (hors faune & flore, construite à part). */
const SECTIONS = [
    {
        title: 'Environnement',
        hint: 'Monde 1 km × 1 km × 300 m par défaut, relief et eau',
        groups: [
            { title: 'Monde', fields: [
                R('world.extent', 'Étendue du bassin', 20, 1000, 10, 'm'),
                R('world.depth', 'Profondeur maximale', 5, 300, 5, 'm'),
                C('world.relief', 'Relief procédural'),
                R('world.reliefAmp', 'Amplitude du relief', 0, 20, 0.5, 'm'),
                R('world.visibility', 'Visibilité (brouillard)', 1, 100, 1, 'm'),
                R('world.compactZone', 'Zone compacte', 0, 100, 1, '%'),
            ] },
            { title: 'Fosse « Blue Hole »', fields: [
                R('world.pitDepthPct', 'Profondeur du lagon', 5, 100, 1, '%'),
                R('world.pitRadiusPct', 'Rayon de la fosse', 0, 100, 1, '%'),
            ] },
            { title: 'Plage & récif', fields: [
                R('world.beachExtent', 'Largeur plage', 0, 40, 1, '%'),
                R('world.beachDepthPct', 'Profondeur plage', 0, 40, 1, '%'),
                R('world.reefExtent', 'Largeur récif', 0, 60, 1, '%'),
                R('world.reefDepthPct', 'Profondeur récif', 0, 60, 1, '%'),
            ] },
            { title: 'Parois & surface', fields: [
                C('world.walls', 'Parois rocheuses 45°'),
                R('world.wallTiling', 'Tiling des parois', 1, 20, 1, '×'),
                C('water.waves', 'Vagues (Gerstner)'),
                R('water.waveHeight', 'Hauteur des vagues', 0, 2, 0.05, 'm'),
                R('water.waveSpeed', 'Vitesse des vagues', 0.2, 3, 0.1, '×'),
                C('water.caustics', 'Caustiques'),
                R('water.causticsIntensity', 'Intensité caustiques', 0, 1, 0.05, ''),
                C('water.godrays', 'God rays'),
                R('water.godraysIntensity', 'Intensité god rays', 0, 1, 0.05, ''),
                R('water.current', 'Courant marin', 0, 0.2, 0.005, 'm/s'),
            ] },
        ],
    },
    {
        title: 'Physique ROV',
        hint: 'Modèle de vol 6 axes à pas fixe 1/240 s',
        groups: [
            { title: 'Actionneurs', fields: [
                R('physics.mass_kg', 'Masse', 4, 40, 0.5, 'kg'),
                R('physics.thrust_max_n', 'Poussée max par propulseur', 5, 60, 0.5, 'N'),
                R('physics.thruster_tau_s', 'Rampe des hélices (τ)', 0.02, 0.5, 0.01, 's'),
            ] },
            { title: 'Vitesses maximales', fields: [
                R('physics.vmax_surge_mps', 'Avance', 0.3, 4, 0.1, 'm/s'),
                R('physics.vmax_sway_mps', 'Translation', 0.3, 3, 0.1, 'm/s'),
                R('physics.vmax_heave_mps', 'Montée / plongée', 0.2, 2, 0.05, 'm/s'),
                R('physics.wmax_yaw_dps', 'Lacet', 20, 180, 5, '°/s'),
                R('physics.wmax_roll_dps', 'Roulis', 10, 120, 5, '°/s'),
                R('physics.wmax_pitch_dps', 'Tangage', 10, 120, 5, '°/s'),
            ] },
            { title: 'Tenue en eau', fields: [
                R('physics.drag_linear_ratio', 'Traînée linéaire', 0, 0.3, 0.01, '×'),
                R('physics.stab_roll_nm_rad', 'Stabilité passive roulis', 0, 30, 0.5, 'N·m/rad'),
                R('physics.stab_pitch_nm_rad', 'Stabilité passive tangage', 0, 30, 0.5, 'N·m/rad'),
            ] },
        ],
    },
    {
        title: 'LED & Caméra',
        hint: 'Projecteurs du ROV et vue embarquée',
        groups: [
            { title: 'Projecteurs LED', fields: [
                C('led.on', 'Allumées au démarrage'),
                R('led.intensity', 'Intensité', 0, 100, 5, '%'),
                R('led.tilt', 'Inclinaison', 0, 45, 1, '°'),
            ] },
            { title: 'Caméra FPV / PIP', fields: [
                C('cam.pip', 'Vue extérieure (PIP, suit le ROV)'),
                R('cam.fov', 'Champ de vision FPV', 60, 100, 1, '°'),
            ] },
        ],
    },
    {
        title: 'Affichage & vie',
        hint: 'Performance Raspberry Pi 5 et décor procédural',
        groups: [
            { title: 'Qualité', fields: [
                S('display.quality', 'Preset', [
                    ['bas', `Bas — ${QUALITY_PRESETS.bas.pixelRatio}× , sans ombres, décor ${QUALITY_PRESETS.bas.density * 100} %`],
                    ['moyen', `Moyen — ${QUALITY_PRESETS.moyen.pixelRatio}× , ombres ${QUALITY_PRESETS.moyen.shadowMap}, décor ${QUALITY_PRESETS.moyen.density * 100} %`],
                    ['eleve', `Élevé — ${QUALITY_PRESETS.eleve.pixelRatio}× , ombres ${QUALITY_PRESETS.eleve.shadowMap}, décor ${QUALITY_PRESETS.eleve.density * 100} %`],
                ]),
                C('display.fps60', 'Rendu 60 im/s (défaut : 30 im/s)'),
            ] },
            { title: 'Vie procédurale', fields: [
                C('life.algae', 'Algues'),
                R('life.algaeDensity', 'Densité algues', 0.2, 2, 0.1, '×'),
                R('life.algaeLen', 'Longueur des algues', 0.5, 6, 0.1, 'm'),
                C('life.corals', 'Coraux'),
                R('life.reefDensity', 'Densité coraux', 0, 200, 5, ''),
                C('life.fish', 'Bancs de poissons'),
                R('life.fishCount', 'Poissons', 0, 800, 10, ''),
                R('life.fishSpeed', 'Vitesse des bancs', 0.2, 4, 0.1, '×'),
                C('life.abyssCreatures', 'Créatures abyssales'),
                R('life.abyssDensity', 'Densité créatures', 0, 200, 5, ''),
                C('life.pikes', 'Brochets'),
            ] },
        ],
    },
];

const state = {
    booted: false,
    settings: null,
    catalog: [],
    dirty: false,
    refs: {},
};

// --------------------------------------------------------------------- //
// Boot                                                                   //
// --------------------------------------------------------------------- //

async function boot() {
    const section = document.getElementById(SECTION_ID);
    if (!section || state.booted) return;
    state.booted = true;

    const shell = document.createElement('div');
    shell.className = 'sim-config-shell';
    shell.id = 'sim-cfg-shell';
    shell.innerHTML = '<p class="hint">Chargement des réglages du simulateur…</p>';
    section.appendChild(shell);
    state.refs.shell = shell;

    shell.addEventListener('input', (event) => onFieldChange(event));
    shell.addEventListener('change', (event) => onFieldChange(event));
    shell.addEventListener('click', (event) => onClick(event));
    bindDropZone(shell);

    state.settings = await loadSettings();
    state.catalog = await loadCatalog();
    renderForm();
}

async function loadSettings() {
    try {
        const response = await fetch('/api/config', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = await response.json();
        return resolveSimulatorSettings(config && config.simulator ? config.simulator : null);
    } catch (error) {
        console.warn('[SubSim] réglages indisponibles, défauts du formulaire :', error);
        return resolveSimulatorSettings(null);
    }
}

async function loadCatalog() {
    try {
        const response = await fetch('/api/sim/assets/models', { cache: 'no-store' });
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data.models) && data.models.length) return data.models;
        }
    } catch (error) {
        console.warn('[SubSim] catalogue GLB indisponible, repli local :', error);
    }
    // Repli : modèles cités par les objets par défaut.
    const seen = new Map();
    for (const object of defaultSimulatorSettings().scene.objects) {
        if (!seen.has(object.model)) {
            seen.set(object.model, {
                file: object.model, name: object.name, source: 'integrated',
                url: `/sim/assets/models/${object.model}`,
            });
        }
    }
    return [...seen.values()];
}

// --------------------------------------------------------------------- //
// Rendu du formulaire                                                    //
// --------------------------------------------------------------------- //

function renderForm() {
    const shell = state.refs.shell;
    shell.innerHTML = `
        <p class="hint sim-cfg-intro">Réglages du simulateur immersif, persistés dans
        <code>config.json</code> (section <code>simulator</code>). Modifications appliquées
        en direct après « Enregistrer » (retour sur l'écran de simulation).</p>
        <div id="sim-cfg-status" class="sim-cfg-status" hidden></div>
        <div class="sim-cfg-cards">
            ${SECTIONS.map(sectionHtml).join('')}
            ${faunaCardHtml()}
        </div>
        <div class="row-end sim-cfg-actions">
            <span id="sim-cfg-dirty" class="sim-cfg-dirty" hidden>Modifications non enregistrées</span>
            <button id="sim-cfg-reset" class="btn btn-ghost" type="button">Réinitialiser aux défauts</button>
            <button id="sim-cfg-save" class="btn btn-success" type="button">Enregistrer</button>
        </div>`;
}

function sectionHtml(section) {
    const groups = section.groups.map((group) => `
        <div class="sim-cfg-group">
            <h4><span>${group.title}</span></h4>
            ${group.fields.map((field) => fieldHtml(field, getByPath(state.settings, field.path))).join('')}
        </div>`).join('');
    return `
    <section class="card sim-cfg-card">
        <h3>${section.title}</h3>
        ${section.hint ? `<p class="hint sim-cfg-hint">${section.hint}</p>` : ''}
        ${groups}
    </section>`;
}

function fieldHtml(field, value) {
    if (field.kind === 'range') {
        const out = `${formatValue(value)}${field.unit ? ` ${field.unit}` : ''}`;
        return `
        <label class="sim-cfg-row">
            <span class="sim-cfg-label">${field.label}${field.unit ? ` <em>(${field.unit})</em>` : ''}</span>
            <input type="range" data-cfg="${field.path}" min="${field.min}" max="${field.max}"
                step="${field.step}" value="${Number(value)}">
            <output data-cfg-out="${field.path}">${out}</output>
        </label>`;
    }
    if (field.kind === 'check') {
        return `
        <label class="sim-cfg-check"><input type="checkbox" data-cfg="${field.path}"${value ? ' checked' : ''}>
            <span>${field.label}</span></label>`;
    }
    const options = field.options.map(([optValue, label]) => {
        const selected = String(value) === String(optValue) ? ' selected' : '';
        return `<option value="${optValue}"${selected}>${label}</option>`;
    }).join('');
    return `
    <label class="sim-cfg-row sim-cfg-row-select">
        <span class="sim-cfg-label">${field.label}</span>
        <select data-cfg="${field.path}">${options}</select>
    </label>`;
}

function faunaCardHtml() {
    const objects = state.settings.scene.objects;
    const imported = state.catalog.filter((model) => model.source === 'imported');
    return `
    <section class="card sim-cfg-card sim-cfg-fauna">
        <h3>Faune & flore GLB</h3>
        <p class="hint sim-cfg-hint">Choisissez un modèle GLB, ajoutez-le au tableau, puis réglez son
        <b>milieu</b> (surface, mi-eau, fond… ou flore au sol suivant le relief), son <b>nombre</b>,
        la <b>taille réelle</b> et son <b>comportement</b> face au ROV. « Enregistrer » applique
        immédiatement le tableau dans Sub Simulator.</p>
        <div class="sim-cfg-addbar">
            <label class="sim-cfg-addpick">
                <span>Modèle GLB</span>
                <select id="sim-cfg-addmodel">${addModelOptions()}</select>
            </label>
            <button id="sim-cfg-obj-add" class="btn btn-ghost" type="button">+ Ajouter au tableau</button>
            <button id="sim-cfg-browse" class="btn btn-ghost" type="button">Importer un .glb…</button>
            <span class="sim-drop sim-drop-inline" id="sim-cfg-drop">ou glisser-déposer ici (50 Mo max)</span>
            <input type="file" id="sim-cfg-file" accept=".glb,.gltf" multiple hidden>
        </div>
        ${imported.length ? `
        <p class="sim-cfg-imported">Modèles importés :
            ${imported.map((model) => `<span class="sim-cfg-chip">${escapeHtml(model.name || model.file)}
                <button class="sim-cfg-chip-del" type="button" data-cat-del="${escapeHtml(model.file)}"
                    title="Supprimer ce fichier importé">✕</button></span>`).join('')}
        </p>` : ''}
        <div class="sim-cfg-table-head"><h4><span>Mes éléments (${objects.length})</span></h4></div>
        <div class="sim-cfg-table-wrap">${objectsTableHtml(objects)}</div>
        <div class="row-end sim-cfg-card-actions">
            <span class="hint">Après « Enregistrer », retournez dans Sub Simulator.</span>
            <button class="btn btn-success" type="button" data-cfg-save="1">Enregistrer</button>
        </div>
    </section>`;
}

/** Options du sélecteur d'ajout (bibliothèque de modèles GLB). */
function addModelOptions() {
    if (!state.catalog.length) return '<option value="">Catalogue indisponible</option>';
    return state.catalog.map((model) => {
        const suffix = `${model.source === 'imported' ? ' · importé' : ''}${model.size ? ` · ${formatSize(model.size)}` : ''}`;
        return `<option value="${escapeHtml(model.file)}">${escapeHtml(model.name || model.file)}${suffix}</option>`;
    }).join('');
}

/** Tableau simple des éléments de la scène (une ligne = un élément GLB). */
function objectsTableHtml(objects) {
    if (!objects.length) {
        return '<p class="hint sim-cfg-empty">Aucun élément — choisissez un modèle GLB et cliquez sur « Ajouter au tableau ».</p>';
    }
    const rows = objects.map((object, index) => {
        const type = object.type || 'faune';
        const isFauna = type === 'faune';
        const locked = type === 'flore' || type === 'objet';
        const number = (field, min, step) => `
            <input type="number" class="sim-cfg-num" data-obj="${index}" data-field="${field}"
                min="${min}" step="${step}" value="${Number(object[field] ?? 0)}">`;
        return `
        <tr class="sim-cfg-row-${type}${object.enabled === false ? ' sim-cfg-row-off' : ''}">
            <td class="sim-cfg-cell-check"><input type="checkbox" data-obj="${index}" data-field="enabled"
                ${object.enabled !== false ? 'checked' : ''} title="Visible dans Sub Simulator"></td>
            <td class="sim-cfg-cell-model"><select data-obj="${index}" data-field="model"
                title="${escapeHtml(String(object.model || ''))}">${catalogOptions(object)}</select></td>
            <td><input type="text" class="sim-cfg-text" data-obj="${index}" data-field="name"
                value="${escapeHtml(String(object.name ?? ''))}"></td>
            <td><select data-obj="${index}" data-field="milieu">${milieuOptions(object)}</select></td>
            <td class="sim-cfg-cell-check"><input type="checkbox" data-obj="${index}" data-field="school"
                ${object.school ? 'checked' : ''}${isFauna ? '' : ' disabled'}
                title="${isFauna ? 'Regrouper en banc (dès 2)' : 'Les bancs concernent la faune nageante'}"></td>
            <td>${number('count', 0, 1)}</td>
            <td>${number('real_size_m', 0.05, 0.05)}</td>
            <td><select data-obj="${index}" data-field="behavior"${locked ? ' disabled' : ''}>${behaviorOptions(object)}</select></td>
            <td><button class="btn btn-ghost sim-cfg-obj-del" type="button" data-obj-del="${index}"
                title="Supprimer du tableau">✕</button></td>
        </tr>`;
    }).join('');
    return `
    <table class="sim-cfg-table sim-cfg-table-fauna">
        <thead><tr>
            <th class="sim-cfg-th-check" title="Visible">Actif</th>
            <th>Modèle GLB</th>
            <th>Nom</th>
            <th>Milieu</th>
            <th class="sim-cfg-th-check" title="Regrouper en banc">Banc</th>
            <th>Nombre</th>
            <th>Taille (m)</th>
            <th>Comportement</th>
            <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
}

/** Clé milieu (`type|zone`) d'un objet — tolère les valeurs historiques. */
function milieuKey(object) {
    return `${object.type || 'faune'}|${object.zone || 'pleine_eau'}`;
}

/** Options du sélecteur de milieu (faune/flore/mammifère/objet + avancé). */
function milieuOptions(object) {
    const key = milieuKey(object);
    const options = MILIEUX.map(([value, label]) => [value, label]);
    if (!options.some(([value]) => value === key)) {
        const typeLabel = TYPE_LABELS[object.type || 'faune'] || 'Faune';
        const zoneLabel = ZONE_LABELS[object.zone || 'pleine_eau'] || 'Mi-eau';
        options.unshift([key, `Avancé — ${typeLabel} / ${zoneLabel}`]);
    }
    return options.map(([value, label]) => {
        const selected = value === key ? ' selected' : '';
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');
}

/** Options du sélecteur de comportement (vocabulaire simple + dynamique). */
function behaviorOptions(object) {
    const current = object.behavior || 'nageant';
    const options = BEHAVIORS.map(([value, label]) => [value, label]);
    if (!options.some(([value]) => value === current)) {
        options.unshift([current, BEHAVIOR_LABELS[current] || current]);
    }
    return options.map(([value, label]) => {
        const selected = value === current ? ' selected' : '';
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');
}

/** Options du sélecteur de modèle d'une ligne (bibliothèque + valeur en cours). */
function catalogOptions(object) {
    const options = state.catalog.map((model) => [
        model.file,
        `${model.name || model.file}${model.source === 'imported' ? ' · importé' : ''}`,
    ]);
    if (object.model && !options.some(([value]) => value === object.model)) {
        options.unshift([object.model, String(object.model)]);
    }
    return options.map(([value, label]) => {
        const selected = String(object.model) === String(value) ? ' selected' : '';
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');
}

// --------------------------------------------------------------------- //
// Édition (délégation d'événements)                                      //
// --------------------------------------------------------------------- //

function onFieldChange(event) {
    const el = event.target;
    // Champ fichier de la carte faune (délégué : le champ est recréé à
    // chaque rendu) → import GLB immédiat.
    if (el && el.id === 'sim-cfg-file') {
        uploadFiles(el.files);
        el.value = '';
        return;
    }
    if (el.dataset && el.dataset.obj !== undefined) {
        onObjectField(el);
        return;
    }
    const path = el.dataset ? el.dataset.cfg : null;
    if (!path) return;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'range' || el.type === 'number') {
        value = Number(el.value);
        if (!Number.isFinite(value)) return;
    } else value = el.value;
    setByPath(state.settings, path, value);
    if (el.type === 'range') {
        const out = state.refs.shell.querySelector(`[data-cfg-out="${path}"]`);
        if (out) {
            const field = findField(path);
            out.textContent = `${formatValue(value)}${field && field.unit ? ` ${field.unit}` : ''}`;
        }
    }
    markDirty();
}

function onObjectField(el) {
    const index = Number(el.dataset.obj);
    const field = el.dataset.field;
    const object = state.settings.scene.objects[index];
    if (!object || !field) return;

    // Milieu : écrit type + zone + cinématique cohérents (voir env-fauna.js).
    if (field === 'milieu') {
        const [type, zone] = String(el.value).split('|');
        if (type && zone) {
            applyMilieu(object, type, zone);
            rerenderFauna();
        }
        markDirty();
        return;
    }

    if (el.type === 'checkbox') object[field] = el.checked;
    else if (el.type === 'number') {
        const value = Number(el.value);
        if (!Number.isFinite(value)) return;
        object[field] = Math.max(0, value);
    } else object[field] = el.value;
    if (field === 'model') {
        const entry = state.catalog.find((model) => model.file === el.value);
        object.source = entry ? entry.source : 'integrated';
        delete object.url;
    }
    if (field === 'behavior' && el.value === 'static') object.kinematic = 'fixe';
    markDirty();
}

/** Applique un milieu (clé `type|zone`) à un objet de scène. */
function applyMilieu(object, type, zone) {
    object.type = type;
    object.zone = zone;
    object.kinematic = kinematicFor(type);
    if (type === 'flore') {
        object.behavior = 'neant';
        object.school = false;
    } else if (type === 'objet') {
        object.behavior = 'static';
        object.school = false;
    } else if (type === 'mamifere') {
        object.school = false;
        if (!BEHAVIORS.some(([value]) => value === object.behavior)) object.behavior = 'nageant';
    } else if (!BEHAVIORS.some(([value]) => value === object.behavior)) {
        // Faune : comportements autorisés nageant/curieux/fuir uniquement.
        object.behavior = 'nageant';
    }
}

function onClick(event) {
    const target = event.target;
    const shell = state.refs.shell;

    if (target.closest('#sim-cfg-save') || target.closest('[data-cfg-save]')) { save(); return; }
    if (target.closest('#sim-cfg-reset')) {
        state.settings = resolveSimulatorSettings(null);
        renderForm();
        markDirty();
        status('Défauts rechargés — cliquez sur « Enregistrer » pour appliquer.', 'warn');
        return;
    }
    if (target.closest('#sim-cfg-obj-add')) {
        const picker = shell.querySelector('#sim-cfg-addmodel');
        if (picker && picker.value) addObjectFromCatalog(picker.value);
        return;
    }
    if (target.closest('#sim-cfg-browse')) {
        shell.querySelector('#sim-cfg-file').click();
        return;
    }
    const delBtn = target.closest('[data-cat-del]');
    if (delBtn) { deleteModel(delBtn.dataset.catDel); return; }
    const objDel = target.closest('[data-obj-del]');
    if (objDel) {
        state.settings.scene.objects.splice(Number(objDel.dataset.objDel), 1);
        rerenderFauna();
        markDirty();
    }
}

// --------------------------------------------------------------------- //
// Objets : ajout / suppression                                           //
// --------------------------------------------------------------------- //

/**
 * Ajoute un élément GLB au tableau avec des réglages adaptés au modèle
 * (heuristique MODEL_HINTS) : nom unique, milieu, nombre, banc et vitesse.
 */
function addObjectFromCatalog(file) {
    const entry = state.catalog.find((model) => model.file === file);
    const hint = modelHint(file);
    const objects = state.settings.scene.objects;
    const baseName = (entry && entry.name) ? entry.name
        : file.replace(/\.(glb|gltf)$/i, '').replace(/[_-]+/g, ' ').trim();
    let name = baseName;
    let n = 2;
    while (objects.some((object) => object.name === name)) name = `${baseName} ${n++}`;
    objects.push({
        name, type: hint.type, model: file, source: entry ? entry.source : 'integrated',
        real_size_m: hint.real_size_m, count: hint.count,
        scale_min: 0.8, scale_max: 1.2, kinematic: kinematicFor(hint.type), zone: hint.zone,
        school: hint.school, speed: hint.speed, behavior: hint.behavior, turn_speed: 0.5,
        enabled: true,
    });
    rerenderFauna();
    markDirty();
    status(`« ${name} » ajouté au tableau — réglez son milieu puis « Enregistrer ».`, 'info');
}

function deleteModel(file) {
    if (!window.confirm(`Supprimer le modèle importé « ${file} » ?\nLes objets qui l'utilisent ne se chargeront plus.`)) return;
    fetch(`/api/sim/assets/models/${encodeURIComponent(file)}`, { method: 'DELETE' })
        .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            status(`« ${file} » supprimé.`, 'ok');
            state.catalog = await loadCatalog();
            renderForm();
        })
        .catch((error) => status(`Suppression impossible : ${error.message}`, 'error'));
}

// --------------------------------------------------------------------- //
// Upload GLB (glisser-déposer, corps brut)                               //
// --------------------------------------------------------------------- //

/**
 * Glisser-déposer délégué au niveau du shell : la carte est réécrite à
 * chaque rendu, donc aucun listener n'est attaché aux éléments recréés.
 * Le champ fichier est traité par `onFieldChange` (délégation `change`).
 */
function bindDropZone(shell) {
    const dropOf = (event) => (event.target.closest ? event.target.closest('#sim-cfg-drop') : null);
    shell.addEventListener('dragover', (event) => {
        const drop = dropOf(event);
        if (!drop) return;
        event.preventDefault();
        drop.classList.add('sim-drop-over');
    });
    shell.addEventListener('dragleave', (event) => {
        const drop = dropOf(event);
        if (!drop) return;
        drop.classList.remove('sim-drop-over');
    });
    shell.addEventListener('drop', (event) => {
        const drop = dropOf(event);
        if (!drop) return;
        event.preventDefault();
        drop.classList.remove('sim-drop-over');
        uploadFiles(event.dataTransfer ? event.dataTransfer.files : null);
    });
}

async function uploadFiles(fileList) {
    const files = fileList ? [...fileList] : [];
    const messages = [];
    for (const file of files) {
        if (!/\.(glb|gltf)$/i.test(file.name)) {
            messages.push([`« ${file.name} » ignoré : extension .glb ou .gltf attendue.`, 'warn']);
            continue;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            messages.push([`« ${file.name} » ignoré : ${formatSize(file.size)} > 50 Mo.`, 'warn']);
            continue;
        }
        try {
            const response = await fetch(`/api/sim/assets/models?name=${encodeURIComponent(file.name)}`,
                { method: 'POST', body: file });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            messages.push([`« ${data.file} » importé (${formatSize(data.size)}) — ajoutez-le au tableau.`, 'ok']);
        } catch (error) {
            messages.push([`Échec d'import de « ${file.name} » : ${error.message}`, 'error']);
        }
    }
    state.catalog = await loadCatalog();
    renderForm();
    if (messages.length) {
        const kind = messages.some(([, k]) => k === 'error') ? 'error'
            : (messages.some(([, k]) => k === 'warn') ? 'warn' : 'ok');
        status(messages.map(([text]) => text).join(' '), kind);
    }
}

// --------------------------------------------------------------------- //
// Persistance                                                            //
// --------------------------------------------------------------------- //

async function save() {
    status('Enregistrement…');
    const { world, water, physics, led, cam, display, life, scene } = state.settings;
    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ simulator: { world, water, physics, led, cam, display, life, scene } }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        state.settings = resolveSimulatorSettings(data.config && data.config.simulator
            ? data.config.simulator : null);
        renderForm();
        markClean();
        status('Réglages enregistrés — appliqués à l\'écran de simulation.', 'ok');
        window.dispatchEvent(new CustomEvent('sim-config-saved'));
    } catch (error) {
        status(`Échec de l'enregistrement : ${error.message}`, 'error');
    }
}

function markDirty() {
    state.dirty = true;
    const el = state.refs.shell.querySelector('#sim-cfg-dirty');
    if (el) el.hidden = false;
}

function markClean() {
    state.dirty = false;
    const el = state.refs.shell.querySelector('#sim-cfg-dirty');
    if (el) el.hidden = true;
}

function status(message, kind = 'info') {
    const el = state.refs.shell.querySelector('#sim-cfg-status');
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    el.className = `sim-cfg-status sim-cfg-status-${kind}`;
}

/** Réécrit toute la carte faune & flore (ajout, suppression, milieu). */
function rerenderFauna() {
    const card = state.refs.shell.querySelector('.sim-cfg-fauna');
    if (!card) return;
    const host = document.createElement('div');
    host.innerHTML = faunaCardHtml();
    card.replaceWith(host.firstElementChild);
}

// --------------------------------------------------------------------- //
// Utilitaires                                                            //
// --------------------------------------------------------------------- //

function getByPath(object, path) {
    return path.split('.').reduce((node, key) => (node == null ? node : node[key]), object);
}

function setByPath(object, path, value) {
    const keys = path.split('.');
    let node = object;
    for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]];
    node[keys[keys.length - 1]] = value;
}

function findField(path) {
    for (const section of SECTIONS) {
        for (const group of section.groups) {
            const field = group.fields.find((item) => item.path === path);
            if (field) return field;
        }
    }
    return null;
}

function formatValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return String(Number(number.toFixed(3)));
}

function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
    return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
