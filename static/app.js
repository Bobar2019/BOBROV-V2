/* ============================================================================
 * BOBROV — SPA du cockpit.
 * Deux niveaux de navigation (accueil → paramètres → sections), tuiles
 * réorganisables persistées, état du socle en direct, cockpit vidéo MJPEG
 * (REC MediaRecorder → dépôt Pi, photo), médiathèque « Mes Vidéos »
 * (photos + vidéos, sélection, notes, étoiles), WiFi nmcli, manettes.
 * Zéro dépendance, zéro framework : le DOM est le seul modèle.
 * ========================================================================== */

'use strict';

/* =========================================================================
 * 1. UTILITAIRES
 * ========================================================================= */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);

/** GET JSON avec message d'erreur lisible (détail FastAPI si présent). */
async function getJSON(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
        let detail = 'HTTP ' + response.status;
        try { detail = (await response.json()).detail || detail; } catch (_) { /* corps non JSON */ }
        throw new Error(detail);
    }
    return response.json();
}

/** POST JSON — lève une erreur avec le détail si le serveur refuse. */
async function postJSON(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        let detail = 'HTTP ' + response.status;
        try { detail = (await response.json()).detail || detail; } catch (_) { /* corps non JSON */ }
        throw new Error(detail);
    }
    return response.json();
}

/** Horodatage compact pour les noms de fichiers : AAAAMMJJ_HHMMSS. */
function fileStamp() {
    const date = new Date();
    const two = (value) => String(value).padStart(2, '0');
    return date.getFullYear() + two(date.getMonth() + 1) + two(date.getDate())
        + '_' + two(date.getHours()) + two(date.getMinutes()) + two(date.getSeconds());
}

/** Dépose un blob (photo JPEG ou vidéo WebM) dans la médiathèque du Pi. */
async function uploadMedia(blob, name) {
    const response = await fetch('/api/videos/upload?name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
    });
    if (!response.ok) {
        let detail = 'HTTP ' + response.status;
        try { detail = (await response.json()).detail || detail; } catch (_) { /* corps non JSON */ }
        throw new Error(detail);
    }
    return response.json();
}

/** Fusion d'un patch dans config.json + mise à jour de l'état local. */
async function patchConfig(patch) {
    const data = await postJSON('/api/config', patch);
    CONFIG = data.config;
    return CONFIG;
}

/** Conteneur des toasts : en plein écran, il doit être un descendant de
 *  l'élément plein écran — sinon les accusés d'action (photo, enregistrements,
 *  dépôts) ne s'affichent pas ; on le rattache à la cible du moment. */
function toastHost() {
    const container = byId('toast-container');
    const target = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (container.parentElement !== target) target.appendChild(container);
    return container;
}

/** Notification discrète (coin bas de l'écran). */
function toast(message, kind = 'ok', ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = message;
    toastHost().appendChild(el);
    setTimeout(() => {
        el.classList.add('fade');
        setTimeout(() => el.remove(), 450);
    }, ms);
}

/** Écrit dans le DOM uniquement si la valeur a changé (polling à 2 Hz). */
function setText(el, value) {
    if (el && el.textContent !== String(value)) el.textContent = value;
}

function fmtBytes(n) {
    if (!Number.isFinite(n)) return '—';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
}

function fmtDate(epochSec) {
    try {
        return new Date(epochSec * 1000).toLocaleString('fr-FR', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    } catch (_) { return '—'; }
}

function fmtDuration(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return null;
    const s = Math.round(seconds);
    const m = Math.floor(s / 60);
    return (m > 0 ? `${m} min ` : '') + String(s % 60).padStart(2, '0') + ' s';
}

function fmtUptime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(s % 60).padStart(2, '0')} s`;
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/* =========================================================================
 * 2. THÈME (sombre par défaut, anti-FOUC géré par le script inline du head)
 * ========================================================================= */

const THEME_KEY = 'bobrov_theme';

function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Applique le thème immédiatement ; persistance locale et/ou serveur en option. */
function applyTheme(theme, { local = true, server = false } = {}) {
    const value = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', value);
    if (local) { try { localStorage.setItem(THEME_KEY, value); } catch (_) { /* stockage plein */ } }
    const darkSwitch = byId('ui-theme-dark');
    if (darkSwitch) darkSwitch.checked = value === 'dark';
    byId('btn-theme').setAttribute('aria-label',
        value === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre');
    if (server && CONFIG) {
        patchConfig({ interface: { theme: value } })
            .catch((error) => toast('Thème non persisté côté serveur : ' + error.message, 'err'));
    }
}

function initThemeToggle() {
    byId('btn-theme').addEventListener('click', () => {
        applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', { server: true });
    });
}

/* =========================================================================
 * 3. NAVIGATION SPA — accueil, sous-menu Paramètres, bouton retour contextuel
 * ========================================================================= */

let currentView = 'dashboard';        // dashboard | parameters | section
let sectionOrigin = 'dashboard';      // d'où la section courante a été ouverte

function hideAllViews() {
    byId('dashboard').style.display = 'none';
    byId('parameters').style.display = 'none';
    $$('.section-panel').forEach((section) => { section.style.display = 'none'; });
    if (HUD.editing) cancelHudEdit();   // quitter le Cockpit abandonne le mode mise en page
}

function showDashboard() {
    hideAllViews();
    currentView = 'dashboard';
    byId('dashboard').style.display = 'flex';
    byId('btn-back').style.display = 'none';
    window.scrollTo(0, 0);
}

function showParameters() {
    hideAllViews();
    currentView = 'parameters';
    byId('parameters').style.display = 'flex';
    byId('btn-back').style.display = 'flex';
    window.scrollTo(0, 0);
}

function showSection(id, origin = 'dashboard') {
    const target = byId(id);
    if (!target) return;
    hideAllViews();
    sectionOrigin = origin;
    currentView = 'section';
    target.style.display = 'block';
    byId('btn-back').style.display = 'flex';
    window.scrollTo(0, 0);
    if (id === 'section-cockpit') { videoSectionActive = true; applyCockpitFromConfig(); connectAllFeeds(); }
    if (id === 'section-system') refreshSystemSection();
    if (id === 'section-network') { lastNetworkSig = ''; renderNetworkAddresses(); refreshNetworkSection(); }
    if (id === 'section-cameras') { loadVideoDevices().catch(() => {}); }
    if (id === 'section-videos') { loadVideos().catch((error) => toast('Médiathèque : ' + error.message, 'err')); }
    if (id === 'section-manette') { openPadSection(); startPadTest(); }
    if (id === 'section-simulator') renderSimTop();
    if (id === 'section-config') { renderTileOrderInfo(TILE_GRIDS.main); renderTileOrderInfo(TILE_GRIDS.params); }
}

/** Retour contextuel : section → sous-menu (ou accueil), paramètres → accueil. */
function goBack() {
    if (padCapture) { endPadCapture(); return; }        // priorité : annuler une capture manette
    if (currentView === 'section' && sectionOrigin === 'parameters') showParameters();
    else showDashboard();
}

function initNavigation() {
    [TILE_GRIDS.main, TILE_GRIDS.params].forEach((cfg) => {
        byId(cfg.gridId).addEventListener('click', (event) => {
            if (dragState) return;                       // pas de navigation pendant un glisser
            const tile = event.target.closest('.nav-tile');
            if (!tile) return;
            const grid = tile.closest('.nav-grid');
            if (grid && grid.classList.contains('editing')) return;   // édition : pas de navigation
            event.preventDefault();
            const target = tile.dataset.target || '';
            if (target === 'parameters') showParameters();
            else showSection(target, grid && grid.id === 'params-grid' ? 'parameters' : 'dashboard');
        });
    });
    byId('btn-back').addEventListener('click', (event) => { event.preventDefault(); goBack(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') goBack(); });
}

/* =========================================================================
 * 4. ÉTAT DU SOCLE (badges topbar + section Système)
 * ========================================================================= */

let SYSTEM_STATUS = null;
let VIDEO_STATUS = null;

function renderBadges() {
    const serialBadge = byId('badge-serial');
    if (SYSTEM_STATUS) {
        const serial = SYSTEM_STATUS.serial || {};
        if (serial.connected) {
            serialBadge.className = 'badge badge-ok';
            serialBadge.textContent = 'SÉRIE ✓';
            serialBadge.title = `${serial.port} @ ${serial.baud} bauds — TX ${serial.tx_hz || '—'} Hz / RX ${serial.rx_hz || 0} Hz`;
        } else {
            serialBadge.className = 'badge badge-off';
            serialBadge.textContent = 'SÉRIE ✕';
            serialBadge.title = serial.last_error || `En attente de ${serial.port || 'la liaison'}`;
        }
        setText(byId('app-version'), 'v' + (SYSTEM_STATUS.version || '—'));
    }
    const videoBadge = byId('badge-video');
    if (VIDEO_STATUS) {
        const cams = Object.values(VIDEO_STATUS.cameras || {});
        const live = cams.filter((cam) => cam.state === 'streaming').length;
        videoBadge.className = 'badge ' + (live === cams.length ? 'badge-ok' : live > 0 ? 'badge-warn' : 'badge-off');
        videoBadge.textContent = `VIDÉO ${live}/${cams.length}`;
        videoBadge.title = cams.map((cam) => `${cam.name} : ${cam.state}`).join(' · ');
    }
}

async function pollSystem() {
    try {
        SYSTEM_STATUS = await getJSON('/api/system/status');
        renderBadges();
        if (byId('section-system').style.display === 'block') renderSystemSection();
        if (byId('section-network').style.display === 'block') renderNetworkAddresses();
    } catch (_) { /* serveur momentanément indisponible : le prochain poll réessaiera */ }
}

async function pollVideo() {
    try {
        VIDEO_STATUS = await getJSON('/api/video/status');
        renderBadges();
        renderVideoInfo();
        renderCamCardsLive();
        checkFeeds();
    } catch (_) { /* idem */ }
}

function refreshSystemSection() {
    if (SYSTEM_STATUS) renderSystemSection();
}

function renderSystemSection() {
    const serial = SYSTEM_STATUS.serial || {};
    setText(byId('sys-version'), 'v' + (SYSTEM_STATUS.version || '—') + '  (config v' + SYSTEM_STATUS.config_version + ')');
    setText(byId('sys-uptime'), fmtUptime(SYSTEM_STATUS.uptime_s));
    setText(byId('sys-serial-port'), `${serial.port || '—'} @ ${serial.baud || '—'} bauds`);
    const state = byId('sys-serial-state');
    setText(state, serial.connected ? 'connectée' : (serial.thread_alive ? 'en recherche' : 'arrêtée'));
    state.className = 'sys-value ' + (serial.connected ? 'ok' : 'err');
    setText(byId('sys-serial-rates'),
        `TX ${serial.tx_hz ?? '—'} Hz (cible ${serial.tx_hz_target ?? '—'}) · RX ${serial.rx_hz ?? '—'} Hz`);
    setText(byId('sys-serial-counts'),
        `trames TX ${serial.tx_frames ?? '—'} · RX ${serial.rx_frames ?? '—'}` +
        (serial.names_pwm != null ? ` · noms ${serial.names_pwm} PWM / ${serial.names_gpio} TOR` : ''));
    setText(byId('sys-serial-error'), serial.last_error || 'aucune');
}

/* --- Maintenance (section Système) : relance du service / reboot du Pi ---- */

/** Lance une commande de maintenance puis bascule sur le voile de reconnexion. */
async function runMaintenance(url, opts) {
    try {
        await postJSON(url, {});
    } catch (error) {
        if (!(error instanceof TypeError)) {      // refus HTTP (409, 5xx) : rien n'a démarré
            toast('Maintenance refusée : ' + error.message, 'err', 5000);
            return;
        }
        // Coupure réseau pendant le POST (le serveur a peut-être déjà redémarré) :
        // le voile ci-dessous tranche entre retour automatique et rechargement manuel.
    }
    watchServerReturn(opts);
}

/** Voile plein écran : sonde le retour du serveur et recharge la page seule.
 *
 * Le critère est l'uptime : l'instance relancée repart de zéro, alors que
 * l'ancienne affiche une valeur qui ne cesse de croître pendant le sondage.
 */
function watchServerReturn({ title, deadlineS }) {
    const startedAt = Date.now();
    const manual = byId('btn-sys-overlay-reload');
    manual.hidden = true;
    setText(byId('sys-overlay-title'), title);
    setText(byId('sys-overlay-detail'), 'Connexion au serveur perdue — reconnexion automatique…');
    byId('sys-overlay').hidden = false;

    const tick = async () => {
        const elapsedS = Math.round((Date.now() - startedAt) / 1000);
        try {
            const status = await getJSON('/api/system/status');
            if (elapsedS >= 3 && Number(status.uptime_s) < 20) {   // instance fraîche
                location.reload();
                return;
            }
        } catch (_) { /* serveur encore arrêté : nouvel essai */ }
        if (elapsedS >= deadlineS) {
            setText(byId('sys-overlay-detail'),
                'Le serveur n’a pas répondu dans le délai prévu — rechargez la page quand le Pi est de retour.');
            manual.hidden = false;
            return;
        }
        setText(byId('sys-overlay-detail'), `Reconnexion en cours… ${elapsedS} s`);
        setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
}

/* =========================================================================
 * 5. TUILES — accueil & paramètres : ordre, édition, glisser-déposer (Pointer)
 * ========================================================================= */

const DEFAULT_TILE_ORDER = ['cockpit', 'videos', 'parameters', 'simulator'];
const DEFAULT_PARAM_ORDER = ['cameras', 'network', 'config', 'manette', 'system', 'sim-config', 'glasses'];

/** Les deux grilles de tuiles : accueil (#nav-grid) et paramètres (#params-grid). */
const TILE_GRIDS = {
    main: {
        gridId: 'nav-grid',
        editBtnId: 'btnEditDash',
        saveBtnId: 'btnSaveDash',
        hintId: 'dash-edit-hint',
        infoId: 'ui-tile-order',
        configKey: 'tile_order',
        storageKey: 'bobrov_dashOrder',
        defaults: DEFAULT_TILE_ORDER,
    },
    params: {
        gridId: 'params-grid',
        editBtnId: 'btnEditParams',
        saveBtnId: 'btnSaveParams',
        hintId: 'params-edit-hint',
        infoId: 'ui-params-order',
        configKey: 'parameters_order',
        storageKey: 'bobrov_paramsOrder',
        defaults: DEFAULT_PARAM_ORDER,
    },
};

let dragState = null;

function tileOrder(cfg) {
    return $$('#' + cfg.gridId + ' .nav-tile').map((tile) => tile.dataset.tileId);
}

/** Applique l'ordre donné ; les tuiles inconnues prennent place à la fin. */
function applyTileOrder(cfg, order) {
    const grid = byId(cfg.gridId);
    if (!Array.isArray(order) || !order.length) return;
    grid.classList.add('no-enter-anim');
    const tiles = {};
    $$('.nav-tile', grid).forEach((tile) => { tiles[tile.dataset.tileId] = tile; });
    const used = new Set();
    order.forEach((id) => {
        if (tiles[id]) { grid.appendChild(tiles[id]); used.add(id); }
    });
    cfg.defaults.forEach((id) => { if (tiles[id] && !used.has(id)) grid.appendChild(tiles[id]); });
    setTimeout(() => grid.classList.remove('no-enter-anim'), 60);
    renderTileOrderInfo(cfg);
}

/** Persiste l'ordre : localStorage immédiat + config.json (tuiles = serveur). */
async function saveTileOrder(cfg) {
    const order = tileOrder(cfg);
    try { localStorage.setItem(cfg.storageKey, JSON.stringify(order)); } catch (_) { /* stockage plein */ }
    try {
        await patchConfig({ interface: { [cfg.configKey]: order } });
        toast('Disposition enregistrée');
    } catch (error) {
        toast('Disposition locale conservée (serveur : ' + error.message + ')', 'err');
    }
}

function renderTileOrderInfo(cfg) {
    const target = byId(cfg.infoId);
    if (target) target.textContent = tileOrder(cfg).join('  →  ') || '—';
}

/** Ordre initial d'une grille : config.json, sinon localStorage, sinon défaut. */
function initialTileOrder(cfg) {
    const serverOrder = (CONFIG && CONFIG.interface && CONFIG.interface[cfg.configKey]) || [];
    if (serverOrder.length) return serverOrder;
    try {
        const stored = JSON.parse(localStorage.getItem(cfg.storageKey) || 'null');
        if (Array.isArray(stored) && stored.length) return stored;
    } catch (_) { /* stockage illisible */ }
    return cfg.defaults;
}

function initTileGrid(cfg) {
    const grid = byId(cfg.gridId);
    const editHint = byId(cfg.hintId);
    let editing = false;
    let pressTimer = null;
    let pressTile = null;
    let pressX = 0, pressY = 0;

    function setEditing(on) {
        editing = on;
        grid.classList.toggle('editing', on);
        // Boutons de LA grille éditée (accueil ou paramètres) — jamais ceux de l'autre.
        byId(cfg.editBtnId).style.display = on ? 'none' : '';
        byId(cfg.saveBtnId).style.display = on ? '' : 'none';
        editHint.style.display = on ? '' : 'none';
    }
    byId(cfg.editBtnId).addEventListener('click', () => setEditing(true));
    byId(cfg.saveBtnId).addEventListener('click', () => { setEditing(false); saveTileOrder(cfg); });

    function cancelPress() {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        if (pressTile) { pressTile.classList.remove('pressing'); pressTile = null; }
    }

    function startDrag(event, tile) {
        const rect = tile.getBoundingClientRect();
        const clone = tile.cloneNode(true);
        clone.classList.add('drag-clone');
        clone.style.width = rect.width + 'px';
        clone.style.height = rect.height + 'px';
        clone.style.left = rect.left + 'px';
        clone.style.top = rect.top + 'px';
        document.body.appendChild(clone);
        tile.classList.add('dragging-ghost');
        dragState = {
            tile, clone,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            moved: false,
        };
    }

    function moveDrag(event) {
        if (pressTimer && (Math.abs(event.clientX - pressX) > 12 || Math.abs(event.clientY - pressY) > 12)) {
            cancelPress();                                   // c'était un défilement, pas un appui long
        }
        if (!dragState) return;
        dragState.moved = true;
        dragState.clone.style.left = (event.clientX - dragState.offsetX) + 'px';
        dragState.clone.style.top = (event.clientY - dragState.offsetY) + 'px';
        dragState.clone.style.display = 'none';              // voir à travers le clone
        const under = document.elementFromPoint(event.clientX, event.clientY);
        dragState.clone.style.display = '';
        const target = under && under.closest ? under.closest('.nav-tile') : null;
        if (target && target !== dragState.tile && grid.contains(target)) {
            const targetRect = target.getBoundingClientRect();
            const insertBefore = event.clientX < targetRect.left + targetRect.width / 2;
            grid.insertBefore(dragState.tile, insertBefore ? target : target.nextSibling);
        }
    }

    function endDrag() {
        cancelPress();
        if (!dragState) return;
        dragState.clone.remove();
        dragState.tile.classList.remove('dragging-ghost');
        const moved = dragState.moved;
        dragState = null;
        if (moved) saveTileOrder(cfg);
    }

    grid.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const tile = event.target.closest('.nav-tile');
        if (!tile) return;
        if (!editing) {
            pressTile = tile;
            pressX = event.clientX;
            pressY = event.clientY;
            tile.classList.add('pressing');
            pressTimer = setTimeout(() => {                  // appui long 500 ms → édition + drag
                cancelPress();
                if (navigator.vibrate) navigator.vibrate(15);
                setEditing(true);
                startDrag(event, tile);
            }, 500);
            return;
        }
        startDrag(event, tile);
    });
    grid.addEventListener('pointermove', moveDrag);
    grid.addEventListener('pointerup', endDrag);
    grid.addEventListener('pointercancel', endDrag);
    window.addEventListener('pointerup', endDrag);

}

/** Réinitialise les deux grilles sur leur ordre par défaut (accueil + paramètres). */
async function resetTileOrders() {
    Object.values(TILE_GRIDS).forEach((grid) => applyTileOrder(grid, grid.defaults));
    await saveTileOrder(TILE_GRIDS.main);
    await saveTileOrder(TILE_GRIDS.params);
}

/* =========================================================================
 * 6. COCKPIT — flux MJPEG, dispositions, PIP, REC vidéo (MediaRecorder) et
 *    photos (dépôt direct dans « Mes Vidéos », aucun ré-encodage côté Pi)
 * ========================================================================= */

const VIDEO_STATE = {
    mode: 'pip',                 // solo | duo | pip
    source: 'cam1',              // caméra principale : vue solo, principal du PIP, capture REC/photo
    pip: { enabled: true, corner: 'bottom-right', width_percent: 28, opacity: 0.9 },
    feedsStarted: false,
};

const FEEDS = {
    cam1: { img: null, overlay: null, detail: null, connectedAt: 0, lastRetry: 0, failed: false, polling: false, pollTimer: 0, pollUrl: '' },
    cam2: { img: null, overlay: null, detail: null, connectedAt: 0, lastRetry: 0, failed: false, polling: false, pollTimer: 0, pollUrl: '' },
};

/* Repli iPadOS/iOS : WebKit — y compris Chrome — n'affiche pas un flux
   multipart/x-mixed-replace dans une balise <img>. La vue passe alors par un
   sondage de frames JPEG (/api/video/frame/<cam>), une requête à la fois.
   iPadOS 13+ se présente comme « MacIntel » : le multi-touch le trahit. */
const FRAME_POLLING = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const FRAME_POLL_MS = 80;        // répit entre deux sondages d'une même caméra

let videoSectionActive = false;

function initVideo() {
    FEEDS.cam1 = { img: byId('feed-cam1'), overlay: byId('overlay-cam1'), detail: byId('detail-cam1'), connectedAt: 0, lastRetry: 0, failed: false, polling: false, pollTimer: 0, pollUrl: '' };
    FEEDS.cam2 = { img: byId('feed-cam2'), overlay: byId('overlay-cam2'), detail: byId('detail-cam2'), connectedAt: 0, lastRetry: 0, failed: false, polling: false, pollTimer: 0, pollUrl: '' };
    Object.entries(FEEDS).forEach(([cam, feed]) => {
        // img.complete est ambigu avec multipart/x-mixed-replace : Chrome peut
        // le basculer à vrai alors que le flux reste valide. Seul error marque
        // une liaison défaillante et autorise une reconnexion automatique.
        feed.img.addEventListener('load', () => { feed.failed = false; hideOverlay(cam); });
        feed.img.addEventListener('error', () => {
            if (!videoSectionActive && !VIDEO_STATE.feedsStarted) return;
            feed.failed = true;
            showOverlay(cam, 'Liaison avec le serveur interrompue.');
        });
    });

    // Disposition (segments)
    $$('#video-mode .seg-btn').forEach((button) => {
        button.addEventListener('click', () => {
            VIDEO_STATE.mode = button.dataset.mode;
            applyVideoLayout();
            connectAllFeeds();
        });
    });
    $$('#video-source .seg-btn').forEach((button) => {
        button.addEventListener('click', () => setVideoSource(button.dataset.src));
    });

    // Permuter : la caméra principale et l'incrustation PIP échangent leurs rôles.
    byId('btn-video-swap').addEventListener('click', swapVideoSources);

    // Coin du PIP
    $$('#pip-corner .pip-corner-btn').forEach((button) => {
        button.addEventListener('click', () => {
            VIDEO_STATE.pip.corner = button.dataset.corner;
            $$('#pip-corner .pip-corner-btn').forEach((other) => other.classList.toggle('active', other === button));
            applyVideoLayout();
        });
    });

    // Réglages PIP en direct
    byId('pip-enabled').addEventListener('change', (event) => {
        VIDEO_STATE.pip.enabled = event.target.checked;
        applyVideoLayout();
    });
    byId('pip-width').addEventListener('input', (event) => {
        VIDEO_STATE.pip.width_percent = Number(event.target.value);
        setText(byId('pip-width-val'), VIDEO_STATE.pip.width_percent + ' %');
        applyPipCss();
    });
    byId('pip-opacity').addEventListener('input', (event) => {
        VIDEO_STATE.pip.opacity = Number(event.target.value) / 100;
        setText(byId('pip-opacity-val'), event.target.value + ' %');
        applyPipCss();
    });

    byId('btn-video-reload').addEventListener('click', () => reloadVideoFlux());
    byId('btn-video-detach').addEventListener('click', () => {
        disconnectFeeds();
        VIDEO_STATE.feedsStarted = false;
        toast('Flux déconnectés');
    });
    byId('btn-video-shot').addEventListener('click', capturePhoto);
    byId('btn-video-rec').addEventListener('click', () => toggleRecording(false));
    byId('btn-video-recview').addEventListener('click', () => toggleRecording(true));
    byId('btn-video-full').addEventListener('click', () => {
        // Plein écran sur #video-view (et non la seule scène) : la barre de
        // commandes reste accessible par-dessus la vidéo (chevron ou manette).
        const view = byId('video-view');
        const inFs = document.fullscreenElement || document.webkitFullscreenElement;
        const method = inFs ? (document.exitFullscreen || document.webkitExitFullscreen)
                            : (view.requestFullscreen || view.webkitRequestFullscreen);
        if (!method) return;
        const result = method.call(inFs ? document : view);
        if (result && result.catch) result.catch(() => {});
    });

    // Badge REC du HUD : taille de police proportionnelle à la hauteur de la scène
    // (recalée aussi à l'entrée/sortie du plein écran), plancher 11 px pour rester lisible.
    const recHudStage = byId('video-stage');
    const fitRecBadge = () => {
        byId('rec-hud-badge').style.fontSize =
            Math.max(11, Math.round((recHudStage.clientHeight || 0) * 0.024)) + 'px';
    };
    fitRecBadge();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitRecBadge).observe(recHudStage);

    // Repli de la barre de commandes (petite flèche) — préférence mémorisée localement.
    byId('btn-toolbar-toggle').addEventListener('click', () => {
        setToolbarCollapsed(!byId('video-toolbar').classList.contains('collapsed'));
    });
    setToolbarCollapsed(initialToolbarCollapsed(), { persist: false });
}

/* -- Repli de la barre de commandes du Cockpit ----------------------------- */

const TOOLBAR_FOLD_KEY = 'bobrov_toolbar_folded';

/** Replie / déplie la barre de commandes ; la flèche et aria suivent l'état. */
function setToolbarCollapsed(collapsed, { persist = true } = {}) {
    const bar = byId('video-toolbar');
    const arrow = byId('btn-toolbar-toggle');
    if (!bar || !arrow) return;
    bar.classList.toggle('collapsed', collapsed);
    arrow.setAttribute('aria-expanded', String(!collapsed));
    arrow.title = collapsed ? 'Déplier la barre de commandes' : 'Replier la barre de commandes';
    if (persist) {
        try { localStorage.setItem(TOOLBAR_FOLD_KEY, collapsed ? '1' : '0'); } catch (_) { /* stockage plein */ }
    }
}

/** État de repli mémorisé (localStorage), relu au chargement de la page. */
function initialToolbarCollapsed() {
    try { return localStorage.getItem(TOOLBAR_FOLD_KEY) === '1'; } catch (_) { return false; }
}

/** Définit la caméra principale (vue solo, principal du PIP, capture REC/photo). */
function setVideoSource(src) {
    VIDEO_STATE.source = src === 'cam2' ? 'cam2' : 'cam1';
    $$('#video-source .seg-btn').forEach((button) => button.classList.toggle('active', button.dataset.src === VIDEO_STATE.source));
    const cfgSource = byId('cfg-source');   // « Config Cockpit » suit la vue en cours
    if (cfgSource) cfgSource.value = VIDEO_STATE.source;
    applyVideoLayout();
    connectAllFeeds();
}

/** Bouton « Permuter » : échange caméra principale et incrustation PIP. */
function swapVideoSources() {
    setVideoSource(VIDEO_STATE.source === 'cam1' ? 'cam2' : 'cam1');
    const main = VIDEO_STATE.source === 'cam2' ? 'Cam 2' : 'Cam 1';
    const other = VIDEO_STATE.source === 'cam2' ? 'Cam 1' : 'Cam 2';
    toast(VIDEO_STATE.mode === 'pip'
        ? main + ' en principal · ' + other + ' en incrustation'
        : main + ' en principale');
}

/** Applique la disposition à la scène (classes, rôles des panneaux) + variables CSS du PIP. */
function applyVideoLayout() {
    const stage = byId('video-stage');
    stage.className = 'video-stage mode-' + VIDEO_STATE.mode
        + ' pip-' + VIDEO_STATE.pip.corner
        + (VIDEO_STATE.pip.enabled ? ' pip-on' : '');
    applyPaneRoles();
    applyPipCss();
    const labels = { solo: 'Cam unique', duo: 'Côte à côte', pip: 'Incrustation' };
    const roles = VIDEO_STATE.mode === 'duo' ? '' : ' · Cam ' + (VIDEO_STATE.source === 'cam2' ? '2' : '1') + ' principale';
    setText(byId('vinfo-mode'), 'Mode : ' + labels[VIDEO_STATE.mode] + roles);
    $$('#video-mode .seg-btn').forEach((button) => button.classList.toggle('active', button.dataset.mode === VIDEO_STATE.mode));
}

/** Rôles des panneaux posés sur les éléments : .pane-main (principal) / .pane-pip (incrustation). */
function applyPaneRoles() {
    const mainCam = captureCam();
    const pipCam = mainCam === 'cam1' ? 'cam2' : 'cam1';
    byId('pane-' + mainCam).classList.add('pane-main');
    byId('pane-' + mainCam).classList.remove('pane-pip');
    byId('pane-' + pipCam).classList.add('pane-pip');
    byId('pane-' + pipCam).classList.remove('pane-main');
}

function applyPipCss() {
    const stage = byId('video-stage');
    stage.style.setProperty('--pip-w', VIDEO_STATE.pip.width_percent + '%');
    stage.style.setProperty('--pip-o', String(VIDEO_STATE.pip.opacity));
    setText(byId('pip-width-val'), VIDEO_STATE.pip.width_percent + ' %');
    setText(byId('pip-opacity-val'), Math.round(VIDEO_STATE.pip.opacity * 100) + ' %');
}

/** Applique la vue Cockpit enregistrée (mode, source, PIP) — à l'ouverture. */
function applyCockpitFromConfig() {
    const cockpit = (CONFIG && CONFIG.cockpit) || {};
    VIDEO_STATE.mode = cockpit.mode || 'pip';
    VIDEO_STATE.source = cockpit.source || 'cam1';
    const pip = (CONFIG && CONFIG.cameras && CONFIG.cameras.pip) || {};
    VIDEO_STATE.pip.enabled = pip.enabled !== false;
    VIDEO_STATE.pip.corner = pip.corner || 'bottom-right';
    VIDEO_STATE.pip.width_percent = pip.width_percent ?? 28;
    VIDEO_STATE.pip.opacity = pip.opacity ?? 0.9;
    byId('pip-enabled').checked = VIDEO_STATE.pip.enabled;
    byId('pip-width').value = VIDEO_STATE.pip.width_percent;
    byId('pip-opacity').value = Math.round(VIDEO_STATE.pip.opacity * 100);
    $$('#pip-corner .pip-corner-btn').forEach((button) => {
        button.classList.toggle('active', button.dataset.corner === VIDEO_STATE.pip.corner);
    });
    $$('#video-mode .seg-btn').forEach((button) => button.classList.toggle('active', button.dataset.mode === VIDEO_STATE.mode));
    $$('#video-source .seg-btn').forEach((button) => button.classList.toggle('active', button.dataset.src === VIDEO_STATE.source));
    applyVideoLayout();
    applyHudConfig();   // mise en page + visibilité du HUD télémétrie
}

function showOverlay(cam, detail) {
    const feed = FEEDS[cam];
    if (detail) setText(feed.detail, detail);
    feed.overlay.hidden = false;
}

function hideOverlay(cam) {
    FEEDS[cam].overlay.hidden = true;
}

/** (Re)connecte un flux MJPEG : le paramètre t force un nouvel élément image.
 *  Sur iPadOS/iOS (WebKit), bascule sur le sondage de frames JPEG. */
function connectFeed(cam, force = false) {
    const feed = FEEDS[cam];
    if (!feed || (feed.connectedAt && !force)) return;
    feed.connectedAt = Date.now();
    feed.lastRetry = Date.now();
    feed.failed = false;
    if (FRAME_POLLING) { startFramePolling(cam); return; }
    feed.img.src = '/api/video/' + cam + '?t=' + Date.now();
}

/** Sondage frame par frame (repli WebKit) : la requête suivante n'est lancée
 *  qu'après la réponse — jamais d'empilement. Chaque image arrive par un blob
 *  local : un échec serveur laisse la dernière frame affichée, sans état cassé. */
async function framePollTick(cam) {
    const feed = FEEDS[cam];
    feed.pollTimer = 0;
    if (!feed.polling) return;
    try {
        const response = await fetch('/api/video/frame/' + cam + '?t=' + Date.now(), { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const blob = await response.blob();
        if (!feed.polling) return;
        const url = URL.createObjectURL(blob);
        const previous = feed.pollUrl;
        feed.pollUrl = url;
        feed.img.src = url;
        if (previous) URL.revokeObjectURL(previous);
        feed.failed = false;
        hideOverlay(cam);
    } catch (_) {
        if (feed.polling) {
            feed.failed = true;
            // Ne pas écraser un diagnostic serveur plus précis déjà affiché
            // (« Caméra indisponible ») : le message reste stable.
            if (feed.overlay.hidden) showOverlay(cam, 'Liaison avec le serveur interrompue.');
        }
    } finally {
        if (feed.polling) feed.pollTimer = setTimeout(() => framePollTick(cam), FRAME_POLL_MS);
    }
}

function startFramePolling(cam) {
    const feed = FEEDS[cam];
    if (feed.polling) return;
    feed.polling = true;
    // Aucune image encore affichée (premier lien ou après « Déconnecter ») :
    // afficher l'attente ; checkFeeds précisera l'état dès la 1re réponse serveur.
    if (!feed.img.getAttribute('src')) showOverlay(cam, 'Connexion à la caméra…');
    framePollTick(cam);
}

function stopFramePolling(cam) {
    const feed = FEEDS[cam];
    feed.polling = false;
    if (feed.pollTimer) { clearTimeout(feed.pollTimer); feed.pollTimer = 0; }
    if (feed.pollUrl) { URL.revokeObjectURL(feed.pollUrl); feed.pollUrl = ''; }
}

function connectAllFeeds() {
    if (!videoSectionActive) return;
    VIDEO_STATE.feedsStarted = true;
    connectFeed('cam1');
    if (VIDEO_STATE.mode !== 'solo') connectFeed('cam2');
    else if (VIDEO_STATE.source === 'cam2') connectFeed('cam2');
}

function disconnectFeeds() {
    Object.entries(FEEDS).forEach(([cam, feed]) => {
        stopFramePolling(cam);
        feed.img.removeAttribute('src');
        feed.connectedAt = 0;
        feed.failed = false;
        showOverlay(cam, 'Flux déconnecté — « Reconnecter » pour reprendre.');
    });
}

/** Surveille les erreurs explicites du flux MJPEG, sans interpréter img.complete.
 *
 * Pour un multipart/x-mixed-replace, Chrome peut signaler « complete » entre
 * deux parties alors que le serveur continue à diffuser. Le précédent test
 * provoquait donc une nouvelle URL toutes les ~3 s et vidait la source du REC.
 */
function checkFeeds() {
    if (!VIDEO_STATE.feedsStarted || !VIDEO_STATUS) return;
    const now = Date.now();
    Object.entries(FEEDS).forEach(([cam, feed]) => {
        // Flux volontairement déconnecté — mais une sonde de frames active reste
        // suivie même avant sa première image (src vide) : diagnostics serveur.
        if (!feed.img.getAttribute('src') && !feed.polling) return;
        const camStatus = (VIDEO_STATUS.cameras || {})[cam] || {};
        const hasFrame = feed.img.naturalWidth > 0 && feed.img.naturalHeight > 0;
        const stale = Number.isFinite(Number(camStatus.age_s)) && Number(camStatus.age_s) > 6;
        if (!feed.failed && hasFrame && !stale) { hideOverlay(cam); return; }
        if (camStatus.state === 'error') {
            showOverlay(cam, camStatus.last_error || 'Caméra indisponible.');
            return;
        }
        // Reprise uniquement après une vraie erreur image ou aucun premier
        // JPEG reçu dans les 5 s ; jamais parce que img.complete est vrai.
        if (camStatus.state === 'streaming' || camStatus.state === 'idle') {
            showOverlay(cam, feed.failed ? 'Liaison interrompue — reconnexion…' : 'Connexion à la caméra…');
            if (now - feed.lastRetry > 5000) connectFeed(cam, true);
            return;
        }
        showOverlay(cam, camStatus.last_error || 'Caméra au repos — en attente de reprise…');
    });
}

/** Informations par caméra (fps, résolution, état) dans la barre vidéo. */
function renderVideoInfo() {
    if (!VIDEO_STATUS) return;
    const labels = { idle: 'repos', streaming: 'direct', error: 'erreur' };
    [['cam1', 'vinfo-cam1'], ['cam2', 'vinfo-cam2']].forEach(([cam, chipId]) => {
        const status = (VIDEO_STATUS.cameras || {})[cam] || {};
        const chip = byId(chipId);
        const parts = [`Cam ${cam.slice(-1)} : ${labels[status.state] || status.state || '—'}`];
        if (status.state === 'streaming') {
            parts.push(`${status.stream_fps ?? '—'} fps`);
            const card = status.card ? status.card.split(':')[0].trim() : '';
            if (card) parts.push(card.slice(0, 22));
        } else if (status.last_error) {
            parts.push('⚠');
        }
        setText(chip, parts.join(' · '));
        chip.className = 'info-chip ' + (status.state === 'streaming' ? 'chip-ok' : status.state === 'error' ? 'chip-warn' : 'chipless');
        chip.title = status.last_error || status.device || '';
    });
}

function renderCamCardsLive() {
    if (!VIDEO_STATUS) return;
    [['cam1', 'cam1-live'], ['cam2', 'cam2-live']].forEach(([cam, id]) => {
        const status = (VIDEO_STATUS.cameras || {})[cam] || {};
        const target = byId(id);
        if (status.state === 'streaming') {
            setText(target, `● direct ${status.stream_fps ?? '—'} fps`);
            target.className = 'cam-live ok';
        } else if (status.state === 'error') {
            setText(target, '● erreur');
            target.className = 'cam-live warn';
        } else {
            setText(target, '● repos');
            target.className = 'cam-live';
        }
    });
}

/** Recharge les flux : config re-lue côté serveur puis reconnexion des images. */
async function reloadVideoFlux() {
    try {
        await postJSON('/api/video/reload', {});
        Object.keys(FEEDS).forEach((cam) => { FEEDS[cam].connectedAt = 0; });
        if (videoSectionActive) {
            VIDEO_STATE.feedsStarted = true;
            connectFeed('cam1', true);
            if (VIDEO_STATE.mode !== 'solo' || VIDEO_STATE.source === 'cam2') connectFeed('cam2', true);
        }
        toast('Flux rechargés');
    } catch (error) {
        toast('Rechargement impossible : ' + error.message, 'err');
    }
}

/* -- Enregistrement vidéo (MediaRecorder → WebM → dépôt Pi) ---------------- */

const REC_HUD_FPS = 15;          // télémétrie fluide, sans doubler le coût du HUD live

const REC_STATE = {
    recorder: null, chunks: [], canvas: null, ctx: null, rafId: 0, timerId: 0,
    startedAt: 0, cam: 'cam1', mime: 'video/webm',
    view: false,       // true : caméra principale + HUD au lieu du flux brut
    fps: 30,           // cadence cible du canvas capturé (config cameras.recording.video_fps)
    nextAt: 0,         // prochaine échéance de composition (horodatage rAF, ms)
    hudCanvas: null, hudCtx: null, hudNextAt: 0,
    lastVideoCanvas: null, lastVideoCtx: null, hasVideoFrame: false,
};

function recConfig() {
    return (CONFIG && CONFIG.cameras && CONFIG.cameras.recording)
        || { video_fps: 30, video_bitrate_mbps: 4, photo_quality: 90 };
}

/** Caméra principale de la vue : flux capturé par REC / Photo et panneau principal. */
function captureCam() {
    return VIDEO_STATE.source === 'cam2' ? 'cam2' : 'cam1';
}

/** Dimensions 16:9 de REC vue : jamais agrandies au-delà du flux principal.
 *
 * Elles ne dépendent volontairement pas de la taille du stage ni du plein écran :
 * le fichier garde ainsi des proportions constantes et le HUD est rendu une seule
 * fois, directement à sa résolution finale.
 */
function recViewSize(cam) {
    const img = FEEDS[cam].img;
    const sourceW = img.naturalWidth;
    const width = Math.min(1280, sourceW);
    return {
        width: 2 * Math.floor(width / 2),
        height: 2 * Math.floor((width * 9 / 16) / 2),
    };
}

function recorderMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    // VP8 est moins coûteux à encoder/décoder que VP9 sur le Pi. Le canvas
    // capturé est opaque : aucun de ces profils standard ne porte d'alpha.
    const candidates = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
    return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) || '';
}

/** Bouton, libellé et texte au repos selon le mode d'enregistrement. */
function recButtonIds(view) {
    return view ? { button: 'btn-video-recview', label: 'btn-video-recview-label', idle: 'REC vue' }
                : { button: 'btn-video-rec', label: 'btn-video-rec-label', idle: 'REC' };
}

function toggleRecording(view = false) {
    if (REC_STATE.recorder) {
        if (REC_STATE.view !== view) { toast('Un enregistrement est déjà en cours'); return; }
        stopRecording();
        return;
    }
    startRecording(view);
}

function startRecording(view = false) {
    if (typeof MediaRecorder === 'undefined') {
        toast('Enregistrement vidéo non supporté par ce navigateur', 'err');
        return;
    }
    const cam = captureCam();
    const hasImage = FEEDS[cam].img.naturalWidth > 0;
    if (!hasImage) { toast('Aucune image à enregistrer — vérifiez le flux principal', 'err'); return; }
    setToolbarCollapsed(false, { persist: false });   // le statut « ENR » doit rester visible
    const recording = recConfig();
    const canvas = document.createElement('canvas');
    if (view) {
        // REC vue : la sortie est 16:9 et bornée par la résolution native de la
        // caméra principale, jamais par la taille CSS de la scène. Le plein écran
        // ne peut donc ni étirer le fichier ni ré-échantillonner le HUD.
        const size = recViewSize(cam);
        canvas.width = size.width;
        canvas.height = size.height;
    } else {
        canvas.width = FEEDS[cam].img.naturalWidth;
        canvas.height = FEEDS[cam].img.naturalHeight;
    }
    // Surface de sortie intégralement opaque : l'encodeur WebM n'a plus de
    // plan alpha à générer, à transporter ou à décoder.
    const ctx = canvas.getContext('2d', { alpha: false });
    const options = { videoBitsPerSecond: Math.round((Number(recording.video_bitrate_mbps) || 4) * 1_000_000) };
    const mime = recorderMime();
    if (mime) options.mimeType = mime;
    const fps = Number(recording.video_fps) || 30;
    // Cadence confiée à Chrome : les PTS WebM ne suivent plus le jitter de
    // requestAnimationFrame. La boucle rAF ne fait que préparer les pixels.
    let stream = null;
    try {
        stream = canvas.captureStream(fps);
    } catch (error) {
        toast('Capture vidéo impossible : ' + error.message, 'err');
        return;
    }
    let recorder = null;
    try {
        recorder = new MediaRecorder(stream, options);
    } catch (error) {
        toast('Enregistrement impossible : ' + error.message, 'err');
        return;
    }
    const hudCanvas = view ? document.createElement('canvas') : null;
    const hudCtx = hudCanvas ? hudCanvas.getContext('2d', { alpha: true }) : null;
    const lastVideoCanvas = view ? document.createElement('canvas') : null;
    const lastVideoCtx = lastVideoCanvas ? lastVideoCanvas.getContext('2d', { alpha: false }) : null;
    if (hudCanvas) {
        hudCanvas.width = canvas.width;
        hudCanvas.height = canvas.height;
        hudCtx.imageSmoothingEnabled = false;       // même résolution que la sortie WebM
    }
    if (lastVideoCanvas) {
        lastVideoCanvas.width = canvas.width;
        lastVideoCanvas.height = canvas.height;
        lastVideoCtx.imageSmoothingEnabled = true;
        lastVideoCtx.imageSmoothingQuality = 'high';
    }
    Object.assign(REC_STATE, { recorder, chunks: [], canvas, ctx, cam, view, fps, nextAt: 0,
                               hudCanvas, hudCtx, hudNextAt: 0,
                               lastVideoCanvas, lastVideoCtx, hasVideoFrame: false,
                               startedAt: Date.now(), mime: recorder.mimeType || 'video/webm' });
    if (view) drawViewFrame(performance.now()); else ctx.drawImage(FEEDS[cam].img, 0, 0);
    recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size) REC_STATE.chunks.push(event.data);
    });
    recorder.addEventListener('stop', finishRecording);
    recorder.start();
    REC_STATE.rafId = requestAnimationFrame(drawRecFrame);
    REC_STATE.timerId = setInterval(renderRecStatus, 500);
    const ids = recButtonIds(view);
    byId(ids.button).classList.add('recording');
    setText(byId(ids.label), 'STOP');
    renderRecStatus();
    toast(view
        ? 'Enregistrement de la caméra principale + HUD (sans PIP) — touchez STOP pour déposer la vidéo'
        : 'Enregistrement en cours (' + cam.toUpperCase() + ') — touchez STOP pour déposer la vidéo');
}

/** Recopie la vue dans le canvas de capture à la cadence vidéo (flux brut ou composé). */
function drawRecFrame(now) {
    if (!REC_STATE.recorder) return;
    const step = 1000 / (REC_STATE.fps || 30);
    if (!REC_STATE.nextAt) REC_STATE.nextAt = now;
    if (now >= REC_STATE.nextAt) {
        // Échéances alignées sur la période : horodatages réguliers (rattrapage
        // borné si la boucle d'affichage prend du retard).
        REC_STATE.nextAt += step;
        if (REC_STATE.nextAt < now) REC_STATE.nextAt = now + step;
        if (REC_STATE.view) {
            drawViewFrame(now);
        } else {
            const feed = FEEDS[REC_STATE.cam];
            if (feed.img.naturalWidth) REC_STATE.ctx.drawImage(feed.img, 0, 0, REC_STATE.canvas.width, REC_STATE.canvas.height);
        }
    }
    REC_STATE.rafId = requestAnimationFrame(drawRecFrame);
}

/** Dessine une source dans un cadre en conservant son ratio (object-fit: contain).
 * Retourne faux si aucun JPEG décodable n'est disponible. */
function drawContain(ctx, img, dx, dy, dw, dh) {
    const iw = img && (img.naturalWidth || img.width);
    const ih = img && (img.naturalHeight || img.height);
    if (!iw || !ih) return false;
    const scale = Math.min(dw / iw, dh / ih);
    const w = Math.round(iw * scale);
    const h = Math.round(ih * scale);
    const x = Math.round(dx + (dw - w) / 2);
    const y = Math.round(dy + (dh - h) / 2);
    ctx.drawImage(img, x, y, w, h);
    return true;
}

/** Dessine le HUD directement dans le cache WebM, à sa résolution définitive.
 *
 * Le cache est mis à jour à 15 i/s seulement : la télémétrie reste fluide,
 * tandis que le composite vidéo garde sa cadence complète sans redessiner les
 * dix instruments à chaque image. Les lueurs sont laissées au HUD affiché,
 * car leurs shadowBlur sont le principal coût de rendu sur le Pi.
 */
function drawRecordedHud(ctx, W, H) {
    if (!HUD.view) return;
    const previousGlow = HUD.glow;
    HUD.glow = false;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    try {
        HUD_ORDER.forEach((id) => {
            const entry = HUD.els[id];
            const item = HUD.layout[id];
            const draw = HUD_DRAW[id];
            if (!entry || !item || !draw || entry.root.classList.contains('off')) return;
            const x = Math.round(item.x / 100 * W);
            const y = Math.round(item.y / 100 * H);
            const w = Math.max(1, Math.round(item.w / 100 * W));
            const h = Math.max(1, Math.round(item.h / 100 * H));
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();
            ctx.translate(x, y);
            ctx.globalAlpha = item.opacity;
            hudStroke = item.color;
            hudWeight = item.weight;
            hudFont = item.font;
            draw(ctx, w, h, HUD.view);
            ctx.restore();
        });
    } finally {
        HUD.glow = previousGlow;
    }
}

/** Actualise le cache HUD à cadence bornée, puis le copie sans ré-échantillonnage. */
function drawRecordedHudCache(now, ctx, W, H) {
    const hudCanvas = REC_STATE.hudCanvas;
    const hudCtx = REC_STATE.hudCtx;
    if (!hudCanvas || !hudCtx) return;
    if (!REC_STATE.hudNextAt || now >= REC_STATE.hudNextAt) {
        REC_STATE.hudNextAt = now + 1000 / REC_HUD_FPS;
        drawRecordedHud(hudCtx, W, H);
    }
    ctx.drawImage(hudCanvas, 0, 0);
}

/** Met à jour la dernière trame caméra valide du REC vue.
 *
 * Une reconnexion MJPEG peut vider momentanément naturalWidth : le cache reste
 * alors intact et l'enregistrement affiche la dernière image connue, jamais
 * le fond noir de la surface de composition.
 */
function updateRecordedVideoCache(cam, W, H) {
    const cache = REC_STATE.lastVideoCanvas;
    const cacheCtx = REC_STATE.lastVideoCtx;
    const img = FEEDS[cam] && FEEDS[cam].img;
    if (!cache || !cacheCtx || !img || !img.naturalWidth || !img.naturalHeight) return false;
    cacheCtx.globalAlpha = 1;
    cacheCtx.fillStyle = '#000';
    cacheCtx.fillRect(0, 0, W, H);
    if (!drawContain(cacheCtx, img, 0, 0, W, H)) return false;
    REC_STATE.hasVideoFrame = true;
    return true;
}

/** Compose REC vue : dernière caméra valide, puis HUD télémétrie en cache. */
function drawViewFrame(now) {
    const ctx = REC_STATE.ctx;
    const canvas = REC_STATE.canvas;
    const W = canvas.width;
    const H = canvas.height;
    updateRecordedVideoCache(captureCam(), W, H);
    // Au démarrage, l'appel est précédé d'un contrôle naturalWidth. Pendant
    // une transition ultérieure, ne touchons surtout pas au canvas final tant
    // qu'aucune trame caméra n'a été mémorisée.
    if (!REC_STATE.hasVideoFrame || !REC_STATE.lastVideoCanvas) return;
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;      // source et destination ont la même taille
    ctx.drawImage(REC_STATE.lastVideoCanvas, 0, 0);
    drawRecordedHudCache(now, ctx, W, H);
    ctx.globalAlpha = 1;
}

function stopRecording() {
    if (!REC_STATE.recorder) return;
    try { REC_STATE.recorder.stop(); } catch (_) { /* déjà arrêté */ }
}

/** Arrêt effectif : assemblage du blob WebM puis dépôt dans la médiathèque. */
async function finishRecording() {
    cancelAnimationFrame(REC_STATE.rafId);
    clearInterval(REC_STATE.timerId);
    const { chunks, cam, mime, view } = REC_STATE;
    REC_STATE.recorder = null; REC_STATE.rafId = 0; REC_STATE.timerId = 0;
    REC_STATE.hudCanvas = null; REC_STATE.hudCtx = null; REC_STATE.hudNextAt = 0;
    REC_STATE.lastVideoCanvas = null; REC_STATE.lastVideoCtx = null; REC_STATE.hasVideoFrame = false;
    const ids = recButtonIds(view);
    byId(ids.button).classList.remove('recording');
    setText(byId(ids.label), ids.idle);
    renderRecStatus();          // masque le chip « ENR » et le badge REC du HUD
    if (!chunks.length) { toast('Enregistrement vide — rien à déposer', 'err'); return; }
    const name = view ? `bobrov_vue_${fileStamp()}.webm` : `bobrov_${cam}_${fileStamp()}.webm`;
    try {
        await uploadMedia(new Blob(chunks, { type: mime.split(';')[0] || 'video/webm' }), name);
        toast('Vidéo déposée : ' + name);
        loadVideos().catch(() => { /* rechargée à l'ouverture de la section */ });
    } catch (error) {
        toast('Dépôt vidéo refusé : ' + error.message, 'err', 4600);
    }
}

/** Chip « ENR » de la barre d'outils et badge REC du HUD : même horloge, textes dédiés.
 *
 * Le badge affiché sur la scène (donc visible en plein écran) distingue les deux
 * modes : « REC VIDEO HUD » pour la capture caméra + HUD, « REC VIDEO » pour le
 * flux brut. Il reste un élément d'affichage : les fichiers enregistrés sont inchangés.
 */
function renderRecStatus() {
    const chip = byId('rec-status');
    const badge = byId('rec-hud-badge');
    if (!REC_STATE.recorder) { chip.hidden = true; badge.hidden = true; return; }
    const seconds = Math.floor((Date.now() - REC_STATE.startedAt) / 1000);
    const time = String(Math.floor(seconds / 60)).padStart(2, '0')
        + ':' + String(seconds % 60).padStart(2, '0');
    chip.hidden = false;
    badge.hidden = false;
    setText(chip, (REC_STATE.view ? 'ENR vue ' : 'ENR ') + time);
    setText(byId('rec-hud-text'), (REC_STATE.view ? 'REC VIDEO HUD ' : 'REC VIDEO ') + time);
}

/* -- Photo : capture du flux affiché puis dépôt ----------------------------- */

function capturePhoto() {
    const cam = captureCam();
    const feed = FEEDS[cam];
    if (!feed.img.naturalWidth) { toast('Aucune image à capturer', 'err'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = feed.img.naturalWidth;
    canvas.height = feed.img.naturalHeight;
    canvas.getContext('2d').drawImage(feed.img, 0, 0);
    const quality = (Number(recConfig().photo_quality) || 90) / 100;
    canvas.toBlob(async (blob) => {
        if (!blob) { toast('Capture impossible', 'err'); return; }
        const name = `bobrov_${cam}_${fileStamp()}.jpg`;
        try {
            await uploadMedia(blob, name);
            toast('Photo déposée : ' + name);
            loadVideos().catch(() => { /* idem */ });
        } catch (error) {
            toast('Dépôt photo refusé : ' + error.message, 'err', 4600);
        }
    }, 'image/jpeg', quality);
}

/* =========================================================================
 * 6bis. HUD TÉLÉMÉTRIE — visuel « tête haute » incrusté sur la vidéo
 *       Données temps réel : GET /api/system/telemetry (poll 150 ms) avec
 *       lissage ; sans trame reçue (live faux) → données simulées.
 *       Instruments : horizon artificiel, ruban de cap, règle de profondeur,
 *       jauges M1–M8 (style Sub Simulator), pince filaire 3D (voies 9-10 :
 *       pincement + rotation), voies restantes 11-16, batterie et courants.
 * ========================================================================= */

const HUD_ORDER = ['horizon', 'heading', 'depth', 'temperature', 'gauges', 'grip', 'aux',
                   'voltage', 'motor_v', 'motor_h'];
const HUD_COLOR = '#00d9ff';
const HUD_WARN = '#ffb300';
const HUD_DANGER = '#ff2d2d';     // virage rouge de la jauge de profondeur
const HUD_MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

/* Couleur, finesse de trait et taille de texte de l'élément en cours de dessin :
   renseignées par la boucle de rendu depuis « Mise en page », lues par les instruments. */
let hudStroke = HUD_COLOR;
let hudWeight = 1;
let hudFont = 1;

/** Mise en page de secours (identique à config.py) si config.json est muet. */
const HUD_DEFAULT_LAYOUT = {
    horizon: { x: 37,   y: 12,   w: 26,   h: 40,  opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
    heading: { x: 34,   y: 3,    w: 32,   h: 8,   opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
    depth:   { x: 82,   y: 8,    w: 15,   h: 56,  opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1,
               max: 100 },   // « max » : profondeur max de la jauge (m) — échelle et alarmes
    temperature: { x: 82, y: 64.5, w: 15,  h: 5.2, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
    gauges:  { x: 0.5,  y: 56,   w: 26,   h: 25,  opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
    grip:    { x: 27,   y: 56,   w: 12.5, h: 8.5, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
    aux:     { x: 27,   y: 65.5, w: 12.5, h: 27,  opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
    voltage: { x: 0.5,  y: 81.5, w: 13.8, h: 5.2, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
    motor_v: { x: 0.5,  y: 87.3, w: 13.8, h: 5.2, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
    motor_h: { x: 0.5,  y: 93.1, w: 13.8, h: 5.2, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
};

const HUD_MIN_SIZE = 4;           // % de la scène — même borne que la validation backend
const HUD_OPACITY_STEP = 0.05;    // un cran de molette
const HUD_WEIGHT_MIN = 0.5;       // finesse de trait (×) — mêmes bornes que le backend
const HUD_WEIGHT_MAX = 2.5;
const HUD_FONT_MIN = 0.5;         // taille de texte (×) — mêmes bornes que le backend
const HUD_FONT_MAX = 2.5;
const HUD_DEPTH_MAX_MIN = 5;      // profondeur max de la jauge (m) — mêmes bornes que le backend
const HUD_DEPTH_MAX_MAX = 500;
const HUD_DEPTH_BLINK_M = 2;      // la jauge clignote à moins de 2 m de la profondeur max
const HUD_POLL_MS = 150;          // cadence de sondage de la télémétrie
const HUD_LIVE_WINDOW_MS = 2500;  // au-delà, retour à la simulation
const HUD_SMOOTH = 0.12;          // lissage (1 = brut)

const HUD = {
    els: {},            // id → { root, canvas, ctx, badge, w, h, dpr }
    layout: {},         // id → { x, y, w, h, opacity, color, weight, font } (% de la scène)
    layoutBackup: null, // copie avant édition (« Annuler »)
    view: null,         // valeurs affichées (lissées)
    telemetry: null,    // dernière trame reçue
    live: false,        // dernière réponse serveur
    liveAt: 0,          // horodatage de la dernière trame fraîche
    lastPollAt: 0,
    frame: 0,
    raf: 0,
    glow: true,        // désactivé ponctuellement dans le cache WebM, jamais à l'écran
    editing: false,
    active: null,       // élément sélectionné dans la barre « Mise en page »
};

const HUD_DRAW = {};   // id → fonction de dessin (rempli après les instruments)

let hudDrag = null;

function hudClamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function hudRound1(value) {
    return Math.round(value * 10) / 10;
}

/** Couleur « #rrggbb » valide, sinon repli (une valeur douteuse ne casse pas le rendu). */
function hudPickColor(value, fallback) {
    return (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) ? value.toLowerCase() : fallback;
}

/** Mélange linéaire de deux couleurs « #rrggbb » (t = 0 → a, t = 1 → b). */
function hudMixColor(a, b, t) {
    const ca = parseInt(hudPickColor(a, '#ffffff').slice(1), 16);
    const cb = parseInt(hudPickColor(b, '#ffffff').slice(1), 16);
    const mix = (shift) => Math.round((((ca >> shift) & 255) * (1 - t)) + (((cb >> shift) & 255) * t));
    return '#' + ((1 << 24) + (mix(16) << 16) + (mix(8) << 8) + mix(0)).toString(16).slice(1);
}

function hudNormalize360(deg) {
    return ((deg % 360) + 360) % 360;
}

function hudLerp(from, to, alpha) {
    return from + (to - from) * alpha;
}

/** Interpolation d'angles par le plus court chemin (cap : ±180°, pas 0/360). */
function hudLerpAngle(from, to, alpha) {
    const delta = ((to - from + 540) % 360) - 180;
    return from + delta * alpha;
}

/* -- Télémétrie → valeurs d'affichage --------------------------------------- */

/** Trame 0x02 → { roll, pitch, yaw (°), depth (m), température, tensions/courants, PWM }. */
function hudFrameFromTelemetry(telemetry) {
    if (!telemetry) return null;
    const [w, x, y, z] = telemetry.quat || [1, 0, 0, 0];
    const ref = Number((CONFIG && CONFIG.safety && CONFIG.safety.surface_pressure_mbar) || 1013.25);
    const power = telemetry.power || [];
    return {
        roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * 180 / Math.PI,
        pitch: Math.asin(hudClamp(2 * (w * y - z * x), -1, 1)) * 180 / Math.PI,
        yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180 / Math.PI,
        depth: (Number(telemetry.pressure_mbar ?? ref) - ref) / 100.5,   // 1 m d'eau ≈ 100,5 mbar
        temperature: Number(telemetry.temperature_c) || 0,
        vbat: (power[0] || 0) / 1000,     // mV → V
        iH: (power[3] || 0) / 1000,       // mA → A
        iV: (power[5] || 0) / 1000,
        pwm: telemetry.pwm_us || [],
    };
}

/** Mouvements de plongée synthétiques (aucune trame reçue). */
function hudSimulate(t) {
    const pwm = [];
    for (let i = 0; i < 16; i += 1) {
        pwm.push(hudClamp(1500 + 320 * Math.sin(0.21 * t + i * 0.55), 1000, 2000));
    }
    return {
        roll: 14 * Math.sin(0.37 * t),
        pitch: 9 * Math.sin(0.29 * t + 1.3),
        yaw: hudNormalize360(t * 7),
        depth: 6.5 + 5.5 * Math.sin(0.11 * t),
        temperature: 21.5 + 1.2 * Math.sin(0.05 * t),
        vbat: 12.4 + 0.25 * Math.sin(0.13 * t),
        iH: 3.2 + 2.3 * Math.sin(0.23 * t + 0.7),
        iV: 4.6 + 2.8 * Math.sin(0.19 * t + 2.1),
        pwm,
    };
}

/** Lissage exponentiel de la vue affichée (aucun saut visuel entre trames). */
function hudApplyView(target) {
    if (!target) return;
    if (!HUD.view) { HUD.view = Object.assign({}, target, { pwm: target.pwm.slice() }); return; }
    const view = HUD.view;
    const alpha = HUD_SMOOTH;
    view.roll = hudLerp(view.roll, target.roll, alpha);
    view.pitch = hudLerp(view.pitch, target.pitch, alpha);
    view.yaw = hudLerpAngle(view.yaw, target.yaw, alpha);
    view.depth = hudLerp(view.depth, target.depth, alpha);
    view.temperature = hudLerp(view.temperature, target.temperature, alpha);
    view.vbat = hudLerp(view.vbat, target.vbat, alpha);
    view.iH = hudLerp(view.iH, target.iH, alpha);
    view.iV = hudLerp(view.iV, target.iV, alpha);
    if (!view.pwm || view.pwm.length !== target.pwm.length) view.pwm = target.pwm.slice();
    else target.pwm.forEach((value, i) => { view.pwm[i] = hudLerp(view.pwm[i], value, alpha); });
}

function hudIsLive(now) {
    return HUD.live && !!HUD.telemetry && (now - HUD.liveAt) < HUD_LIVE_WINDOW_MS;
}

async function hudPollTelemetry() {
    try {
        const data = await getJSON('/api/system/telemetry');
        HUD.live = !!data.live;
        HUD.telemetry = data.telemetry;
        if (HUD.live) HUD.liveAt = performance.now();
    } catch (_) {
        HUD.live = false;      // serveur indisponible : la simulation prend le relais
    }
    hudRenderInfoChip();
}

function hudRenderInfoChip() {
    const chip = byId('vinfo-telemetry');
    if (!chip) return;
    const live = hudIsLive(performance.now());
    setText(chip, live ? 'Télémétrie : direct' : 'Télémétrie : simulée');
    chip.className = 'info-chip ' + (live ? 'chip-ok' : 'chip-warn');
    chip.title = live ? 'Trames série reçues à l\'instant'
        : 'Aucune trame reçue — instruments simulés';
}

/* -- Mise en page (config.json ↔ DOM) --------------------------------------- */

function hudLayoutDefaults() {
    const copy = {};
    HUD_ORDER.forEach((id) => { copy[id] = Object.assign({}, HUD_DEFAULT_LAYOUT[id]); });
    return copy;
}

function hudLayoutFromConfig() {
    const configured = (CONFIG && CONFIG.cockpit && CONFIG.cockpit.hud
        && CONFIG.cockpit.hud.elements) || {};
    const layout = {};
    HUD_ORDER.forEach((id) => {
        const base = HUD_DEFAULT_LAYOUT[id];
        const item = configured[id] || {};
        layout[id] = {
            x: hudClamp(Number(item.x ?? base.x), 0, 100),
            y: hudClamp(Number(item.y ?? base.y), 0, 100),
            w: hudClamp(Number(item.w ?? base.w), HUD_MIN_SIZE, 100),
            h: hudClamp(Number(item.h ?? base.h), HUD_MIN_SIZE, 100),
            opacity: hudClamp(Number(item.opacity ?? base.opacity), 0.05, 1),
            color: hudPickColor(item.color, base.color),
            weight: hudClamp(Number(item.weight ?? base.weight), HUD_WEIGHT_MIN, HUD_WEIGHT_MAX),
            font: hudClamp(Number(item.font ?? base.font), HUD_FONT_MIN, HUD_FONT_MAX),
        };
        // La jauge de profondeur porte en plus sa profondeur max (échelle et alarmes).
        if (id === 'depth') {
            layout[id].max = hudClamp(Number(item.max ?? base.max), HUD_DEPTH_MAX_MIN, HUD_DEPTH_MAX_MAX);
        }
    });
    return layout;
}

/** Applique la mise en page courante (positions en % de la scène + opacité). */
function hudApplyLayout() {
    HUD_ORDER.forEach((id) => {
        const entry = HUD.els[id];
        const item = HUD.layout[id];
        if (!entry || !item) return;
        entry.root.style.left = item.x + '%';
        entry.root.style.top = item.y + '%';
        entry.root.style.width = item.w + '%';
        entry.root.style.height = item.h + '%';
        entry.root.style.setProperty('--hud-o', String(item.opacity));
        entry.root.style.setProperty('--hud-c', item.color);   // cadre et étiquette en mode édition
        entry.badge.textContent = Math.round(item.opacity * 100) + ' %';
    });
}

/** Affiche/masque chaque instrument selon « cockpit.overlay » (Config Cockpit). */
function hudApplyOverlayVisibility() {
    const overlay = (CONFIG && CONFIG.cockpit && CONFIG.cockpit.overlay) || {};
    HUD_ORDER.forEach((id) => {
        const entry = HUD.els[id];
        if (entry) entry.root.classList.toggle('off', overlay[id] === false);
    });
}

/** Vue d'ensemble : relit config.json, applique disposition + visibilité, démarre le rendu. */
function applyHudConfig() {
    HUD.layout = hudLayoutFromConfig();
    hudApplyLayout();
    hudApplyOverlayVisibility();
    hudRenderInfoChip();
    startHudLoop();
}

/* -- Instruments : canvas, style collimateur cyan --------------------------- */

function hudGlow(c, on, color = hudStroke, blur = 6) {
    c.shadowColor = on && HUD.glow ? color : 'transparent';
    c.shadowBlur = on && HUD.glow ? blur : 0;
}

function hudText(c, text, x, y, size, align = 'left', color = hudStroke) {
    c.font = '600 ' + (size * hudFont).toFixed(1) + 'px ' + HUD_MONO;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.fillStyle = color;
    c.fillText(text, x, y);
}

/** Cadre le canvas sur la taille CSS de l'élément (net sur écran HiDPI). */
function hudFitCanvas(entry) {
    const rect = entry.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (entry.w !== w || entry.h !== h || entry.dpr !== dpr) {
        entry.w = w;
        entry.h = h;
        entry.dpr = dpr;
        entry.canvas.width = Math.round(w * dpr);
        entry.canvas.height = Math.round(h * dpr);
    }
    entry.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Canvas interne = dimensions CSS × DPR : aucune interpolation lors du
    // rendu HiDPI des traits, textes et copies éventuelles de cet instrument.
    entry.ctx.imageSmoothingEnabled = false;
    entry.ctx.clearRect(0, 0, w, h);
}

/** Horizon artificiel : échelle de tangage (tourne avec le roulis) + repère fixe. */
function hudDrawHorizon(c, w, h, f) {
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.44;
    const ppd = radius / 32;                    // pixels par degré (±32° visibles)

    c.save();
    hudGlow(c, true, hudStroke, 8);
    c.strokeStyle = hudStroke;
    c.lineWidth = 1.4 * hudWeight;
    c.beginPath();
    c.arc(cx, cy, radius, 0, Math.PI * 2);
    c.stroke();
    c.clip();

    // Échelle de tangage : tourne avec le roulis, glisse avec le tangage.
    c.translate(cx, cy);
    c.rotate(-f.roll * Math.PI / 180);
    const yHorizon = f.pitch * ppd;
    c.lineWidth = 1.8 * hudWeight;
    c.beginPath();
    c.moveTo(-radius, yHorizon);
    c.lineTo(radius, yHorizon);
    c.stroke();
    for (let d = 5; d <= 30; d += 5) {
        const major = d % 10 === 0;
        const half = radius * (major ? 0.36 : 0.17);
        c.lineWidth = 1.2 * hudWeight;
        [-1, 1].forEach((sign) => {
            const y = yHorizon + sign * d * ppd;
            c.globalAlpha = major ? 0.85 : 0.45;
            c.beginPath();
            c.moveTo(-half, y);
            c.lineTo(half, y);
            c.stroke();
            if (major) {
                c.globalAlpha = 0.9;
                hudText(c, String(d), -half - 9, y, 8.5, 'center');
                hudText(c, String(d), half + 9, y, 8.5, 'center');
            }
        });
    }
    c.globalAlpha = 1;
    c.restore();

    // Repère fixe de l'engin (ailes + point) et index de roulis.
    c.save();
    c.translate(cx, cy);
    hudGlow(c, true, hudStroke, 7);
    c.strokeStyle = hudStroke;
    c.lineWidth = 2.2 * hudWeight;
    c.beginPath();
    c.moveTo(-radius * 0.52, 0);
    c.lineTo(-radius * 0.18, 0);
    c.moveTo(radius * 0.18, 0);
    c.lineTo(radius * 0.52, 0);
    c.stroke();
    c.beginPath();
    c.arc(0, 0, 2.4, 0, Math.PI * 2);
    c.fillStyle = hudStroke;
    c.fill();
    c.beginPath();
    c.moveTo(0, -radius);
    c.lineTo(-5, -radius + 10);
    c.lineTo(5, -radius + 10);
    c.closePath();
    c.fill();
    if (f.simulated) hudText(c, 'SIM', radius * 0.62, radius * 0.8, 9, 'center', HUD_WARN);
    c.restore();
}

/** Points cardinaux français tous les 45° (O = Ouest), dizaines de degrés sinon. */
function hudCompassLabel(deg) {
    const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };
    if (cardinals[deg]) return cardinals[deg];
    return String(Math.round(deg / 10)).padStart(2, '0');
}

/** Ruban de cap : valeur au centre, graduations tous les 5°, cardinales tous les 30°. */
function hudDrawHeading(c, w, h, f) {
    const yaw = hudNormalize360(f.yaw);
    const px = w / 110;                          // ±55° visibles
    const cy = h - Math.max(7, h * 0.24);        // ligne de base du ruban (bas de la boîte)
    c.save();
    hudGlow(c, true, hudStroke, 6);
    hudText(c, String(Math.round(yaw) % 360).padStart(3, '0') + '°',
        w / 2, Math.max(7, h * 0.3), hudClamp(h * 0.34, 9, 18), 'center');
    c.strokeStyle = hudStroke;
    c.lineWidth = 1.2 * hudWeight;
    c.beginPath();
    c.moveTo(0, cy);
    c.lineTo(w, cy);
    c.stroke();

    for (let tick = Math.ceil((yaw - 55) / 5) * 5; tick <= yaw + 55; tick += 5) {
        const x = w / 2 + (tick - yaw) * px;
        if (x < -8 || x > w + 8) continue;
        const heading = hudNormalize360(tick);
        const cardinal = heading % 45 === 0;                 // N, NE, E, SE, S, SO, O, NO
        const major = cardinal || heading % 15 === 0;
        c.globalAlpha = cardinal ? 1 : (major ? 0.75 : 0.4);
        const tickH = major ? Math.max(4, h * (cardinal ? 0.12 : 0.1)) : Math.max(3, h * 0.06);
        c.beginPath();
        c.moveTo(x, cy);
        c.lineTo(x, cy + tickH);
        c.stroke();
        c.globalAlpha = 1;
        if (cardinal || heading % 30 === 0) {
            hudText(c, hudCompassLabel(heading), x, Math.min(h - 5, cy + tickH + 5),
                cardinal ? hudClamp(h * 0.18, 7.5, 11) : hudClamp(h * 0.16, 6.5, 10), 'center');
        }
    }

    // Curseur central pointant sur le cap courant.
    c.beginPath();
    c.moveTo(w / 2, cy - 3);
    c.lineTo(w / 2 - 5, cy - 11);
    c.lineTo(w / 2 + 5, cy - 11);
    c.closePath();
    c.fillStyle = hudStroke;
    c.fill();
    c.restore();
}

/** Profondeur : cadran à ruban défilant — l'échelle numérotée glisse sous
    l'index central immobile. La teinte vire progressivement au rouge à
    l'approche de la profondeur max et toute la jauge pulse (clignote) à
    moins de 2 m de cette limite. Profondeur max : élément « depth » de
    cockpit.hud.elements (réglage « Prof. max » de la mise en page). */
function hudDrawDepth(c, w, h, f) {
    const depth = Math.max(0, f.depth);
    const max = hudClamp(Number((HUD.layout.depth && HUD.layout.depth.max) || HUD_DEFAULT_LAYOUT.depth.max),
        HUD_DEPTH_MAX_MIN, HUD_DEPTH_MAX_MAX);
    const heat = hudClamp((depth / max - 0.5) / 0.5, 0, 1);      // rougit dès la mi-profondeur
    const color = hudMixColor(hudStroke, HUD_DANGER, heat);
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const blink = depth >= max - HUD_DEPTH_BLINK_M
        ? 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(now * 0.01))        // pulsation ≈ 1,6 Hz
        : 1;

    const top = hudClamp(h * 0.22, 34, 46);
    const bottom = h - 6;
    const rubH = Math.max(16, bottom - top);
    const xAxis = Math.round(w * 0.5);                          // axe du ruban
    const yIndex = (top + bottom) / 2;                          // index fixe
    const span = hudClamp(max, 5, 20);                          // plage visible du ruban (m)
    const pxm = rubH / span;
    const labelStep = span >= 15 ? 5 : (span >= 7 ? 2 : 1);
    const minorStep = (pxm >= 7.5 && labelStep > 1) ? 1 : labelStep;
    const fs = hudClamp(h * 0.028, 7.5, 12);
    // Fondu vers les bords : effet « tambour » du ruban.
    const fade = (y) => 1 - 0.72 * Math.pow(hudClamp(Math.abs(y - yIndex) / (rubH / 2), 0, 1), 2);
    const alpha = (a) => { c.globalAlpha = a * blink; };

    c.save();
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = 1.1 * hudWeight;

    // Compteur numérique (lisible même pendant le clignotement), surmonté de
    // la mention « PROF » : le bloc entier descend avec la taille des textes
    // pour ne jamais être rogné par le bord haut (surtout en plein écran).
    const profY = fs * 0.7 + 2;
    alpha(0.7);
    hudText(c, 'PROF', 4, profY, fs, 'left', color);
    alpha(1);
    hudText(c, depth.toFixed(1).replace('.', ',') + ' m', 4, profY + fs * 0.7 + 12, 16, 'left', color);
    hudGlow(c, true, color, 6);

    // Axe vertical du ruban.
    alpha(0.45);
    c.beginPath();
    c.moveTo(xAxis, top);
    c.lineTo(xAxis, bottom);
    c.stroke();

    // Graduations défilantes : la valeur v se place à y = yIndex + (v − depth)·pxm.
    const vHi = depth - (yIndex - top + 14) / pxm;
    const vLo = depth + (bottom - yIndex + 14) / pxm;
    for (let v = Math.ceil(vHi / minorStep) * minorStep; v <= vLo; v += minorStep) {
        if (v < 0 || v >= max) continue;                        // rien avant la surface ni au-delà du max
        const y = yIndex + (v - depth) * pxm;
        const major = Math.abs(v % labelStep) < 0.001;
        alpha((major ? 0.85 : 0.4) * fade(y));
        const half = major ? 11 : 6;
        c.beginPath();
        c.moveTo(xAxis - half, y);
        c.lineTo(xAxis + half, y);
        c.stroke();
        if (major) hudText(c, String(Math.round(v)), xAxis + 15, y, fs, 'left', color);
    }

    // Surface (0 m) : repère plus marqué.
    const ySurface = yIndex + (0 - depth) * pxm;
    if (ySurface > top - 8 && ySurface < bottom + 8) {
        alpha(0.75 * fade(hudClamp(ySurface, top, bottom)));
        c.lineWidth = 1.6 * hudWeight;
        c.beginPath();
        c.moveTo(xAxis - 16, ySurface);
        c.lineTo(xAxis + 16, ySurface);
        c.stroke();
        c.lineWidth = 1.1 * hudWeight;
    }

    // Profondeur max : la limite monte vers l'index à mesure qu'on s'en approche.
    const yMax = yIndex + (max - depth) * pxm;
    if (yMax > top - 8 && yMax < bottom + 8) {
        c.strokeStyle = HUD_DANGER;
        alpha(0.9 * fade(hudClamp(yMax, top, bottom)));
        c.lineWidth = 1.6 * hudWeight;
        c.beginPath();
        c.moveTo(xAxis - 16, yMax);
        c.lineTo(xAxis + 16, yMax);
        c.stroke();
        hudText(c, 'MAX', xAxis + 15, yMax, fs, 'left', HUD_DANGER);
        c.strokeStyle = color;
        c.lineWidth = 1.1 * hudWeight;
    }

    // Index immobile : ligne de visée et chevrons qui encadrent l'axe.
    alpha(0.6);
    c.beginPath();
    c.moveTo(xAxis - 30, yIndex);
    c.lineTo(xAxis + 30, yIndex);
    c.stroke();
    c.fillStyle = color;
    alpha(0.95);
    c.beginPath();
    c.moveTo(xAxis - 9, yIndex);
    c.lineTo(xAxis - 18, yIndex - 6);
    c.lineTo(xAxis - 18, yIndex + 6);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(xAxis + 9, yIndex);
    c.lineTo(xAxis + 18, yIndex - 6);
    c.lineTo(xAxis + 18, yIndex + 6);
    c.closePath();
    c.fill();
    c.restore();
}

/** Température de l'eau (°C) : élément autonome, réglable dans « Mise en page ». */
function hudDrawTemperature(c, w, h, f) {
    const size = hudClamp(h * 0.36, 9, 15);
    c.save();
    hudGlow(c, true, hudStroke, 6);
    hudText(c, 'T ' + f.temperature.toFixed(1).replace('.', ',') + ' °C', 4, h / 2, size, 'left');
    c.restore();
}

/* -- Schéma moteurs (ROV vu de dessus), pince filaire 3D, voies restantes --- */

/** Libellés par défaut des 8 propulseurs (géométrie du firmware BOBROV-main) :
    le schéma vu de dessus n'en affiche que le numéro court ; les noms
    personnalisés (trames 0x03) restent prioritaires. */
const HUD_MOTOR_LABELS = ['M1 H Av-D', 'M2 H Ar-D', 'M3 H Ar-G', 'M4 H Av-G',
                          'M5 V Av-D', 'M6 V Ar-D', 'M7 V Ar-G', 'M8 V Av-G'];

/** Nom d'une voie PWM : personnalisé (trames 0x03/0x04) sinon libellé par défaut. */
function hudChannelName(names, index, fallback) {
    const custom = names && names[String(index)];
    return (typeof custom === 'string' && custom.trim()) ? custom.trim() : fallback;
}

/** Écho PWM (µs) → commande normalisée [−1, +1] autour du neutre 1 500 µs. */
function hudPwmToThrust(us) {
    return hudClamp((Number(us) - 1500) / 500, -1, 1);
}

/** Écho PWM d'une trame (toujours 16 voies côté serveur) avec repli neutre. */
function hudPwmFrame(f, count) {
    return (f.pwm && f.pwm.length >= count) ? f.pwm : new Array(16).fill(1500);
}

/* Schéma « vue de dessus » : ROV 8 propulseurs, nez à droite. Positions et
   poussées positives viennent du mixage du firmware (motor_mixer.py, confirmé
   par sim-mix.js) : 4 horizontaux en X à 45°, 4 verticaux en montée positive.
   Repère écran : x = avant (droite), y = bâbord (haut) ⇒ tribord = bas. */

/** Position (unités schéma) et poussée positive (vecteur écran) par moteur. */
const HUD_ROV_MOTORS = [
    { x: +1.72, y: -1.02, dx: +0.707, dy: +0.707, vert: false },   // M1 H Av-D → avant-bâbord
    { x: -1.72, y: -1.02, dx: -0.707, dy: +0.707, vert: false },   // M2 H Ar-D → arrière-bâbord
    { x: -1.72, y: +1.02, dx: -0.707, dy: -0.707, vert: false },   // M3 H Ar-G → arrière-tribord
    { x: +1.72, y: +1.02, dx: +0.707, dy: -0.707, vert: false },   // M4 H Av-G → avant-tribord
    { x: +0.92, y: -0.42, dx: 0, dy: +1, vert: true },             // M5 V Av-D → montée
    { x: -0.92, y: -0.42, dx: 0, dy: +1, vert: true },             // M6 V Ar-D → montée
    { x: -0.92, y: +0.42, dx: 0, dy: +1, vert: true },             // M7 V Ar-G → montée
    { x: +0.92, y: +0.42, dx: 0, dy: +1, vert: true },             // M8 V Av-G → montée
];

/** Boîte englobante fixe (châssis, carénages, flèches max, textes) : le
    cadrage reste stable quelles que soient les commandes. */
const HUD_ROV_BOX = { minX: -3.2, maxX: 3.2, minY: -1.95, maxY: 1.95 };
const HUD_ROV_R = 0.34;         // rayon des carénages
const HUD_ROV_BLADE = 0.3;      // longueur des pales
const HUD_ROV_HULL = [          // contour du châssis (nez biseauté à droite)
    [-2.1, -1.42], [1.7, -1.42], [2.1, -0.9], [2.1, 0.9], [1.7, 1.42], [-2.1, 1.42],
];

/** Phases des hélices (rad) et horodatage du rendu : animation continue. */
const HUD_ROV_SPIN = [0, 0.9, 1.8, 2.7, 0.45, 1.35, 2.25, 3.15];
let hudRovSpinMs = 0;

/** Flèche de poussée (pixels) : hampe + deux barbes. */
function hudRovArrow(c, x0, y0, ux, uy, len, size) {
    const x1 = x0 + ux * len;
    const y1 = y0 + uy * len;
    const nx = -uy;
    const ny = ux;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.moveTo(x1, y1);
    c.lineTo(x1 - ux * size + nx * size * 0.55, y1 - uy * size + ny * size * 0.55);
    c.moveTo(x1, y1);
    c.lineTo(x1 - ux * size - nx * size * 0.55, y1 - uy * size - ny * size * 0.55);
    c.stroke();
}

/**
 * Schéma des 8 propulseurs — ROV 8 propulseurs vu de dessus, nez à droite :
 * châssis filaire, carénage + hélice 3 pales par moteur (sens et vitesse
 * suivent la commande), flèche de poussée proportionnelle à |commande| dans
 * la direction du mixage (horizontaux en X à 45°, verticaux montée/descente) ;
 * ambre près de la butée, numéro et commande en % à côté de chaque carénage.
 */
function hudDrawMotors(c, w, h, f) {
    const names = (SYSTEM_STATUS && SYSTEM_STATUS.serial && SYSTEM_STATUS.serial.names_pwm) || {};
    const pwm = hudPwmFrame(f, 8);
    const padX = hudClamp(w * 0.02, 4, 10);
    const header = hudClamp(h * 0.11, 10, 16);

    // Commande par moteur ; les pales avancent (sens horaire si t > 0).
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const dt = hudRovSpinMs ? hudClamp((now - hudRovSpinMs) / 1000, 0, 0.12) : 0;
    hudRovSpinMs = now;
    const thrusts = [];
    let active = 0;
    for (let i = 0; i < 8; i += 1) {
        const t = hudPwmToThrust(pwm[i]);
        thrusts.push(t);
        if (Math.abs(t) > 0.05) active += 1;
        if (Math.abs(t) > 0.02) HUD_ROV_SPIN[i] -= t * (0.8 + 5 * Math.abs(t)) * dt;
    }

    // Cadrage : boîte fixe sous le titre ; la police est bornée par l'échelle
    // pour que libellés et flèches ne se croisent pas dans les petites boîtes.
    const availW = Math.max(8, w - padX * 2);
    const availH = Math.max(8, h - header - padX);
    const bw = HUD_ROV_BOX.maxX - HUD_ROV_BOX.minX;
    const bh = HUD_ROV_BOX.maxY - HUD_ROV_BOX.minY;
    const scale = Math.min(availW / bw, availH / bh);
    const fs = hudClamp(Math.min(h * 0.06, scale * 0.22), 6.2, 9);
    const ox = padX + (availW - bw * scale) / 2 - HUD_ROV_BOX.minX * scale;
    const oy = header + padX + (availH - bh * scale) / 2 + HUD_ROV_BOX.maxY * scale;
    const px = (x) => ox + x * scale;
    const py = (y) => oy - y * scale;   // y image inversé

    c.save();
    hudGlow(c, true, hudStroke, 5);
    hudText(c, 'MOTEURS M1–M8', padX, header * 0.6, fs, 'left');
    hudText(c, active + ' ACTIFS', w - padX, header * 0.6, fs, 'right');
    if (scale < 3) { c.restore(); return; }

    // Châssis : contour, ligne axiale et compartiment central (discrets).
    c.strokeStyle = hudStroke;
    c.lineWidth = 1.3 * hudWeight;
    c.lineJoin = 'round';
    c.globalAlpha = 0.7;
    c.beginPath();
    HUD_ROV_HULL.forEach(([hx, hy], k) => (k ? c.lineTo(px(hx), py(hy)) : c.moveTo(px(hx), py(hy))));
    c.closePath();
    c.stroke();
    c.lineWidth = 1 * hudWeight;
    c.globalAlpha = 0.2;
    c.beginPath();
    c.moveTo(px(-2.1), py(0));
    c.lineTo(px(2.1), py(0));
    c.stroke();
    c.globalAlpha = 0.32;
    c.beginPath();
    c.rect(px(-0.42), py(0.26), 0.84 * scale, 0.52 * scale);
    c.stroke();

    // Les 8 propulseurs : carénage, hélice animée, flèche de poussée, texte.
    for (let i = 0; i < 8; i += 1) {
        const m = HUD_ROV_MOTORS[i];
        const t = thrusts[i];
        const color = Math.abs(t) > 0.85 ? HUD_WARN : hudStroke;
        const cx = px(m.x);
        const cy = py(m.y);
        c.strokeStyle = color;
        hudGlow(c, true, color, 5);

        if (!m.vert) {           // axe d'hélice : matérialise le « X » à 45°
            c.globalAlpha = 0.3;
            c.lineWidth = 1 * hudWeight;
            c.beginPath();
            c.moveTo(px(m.x - m.dx * 0.22), py(m.y - m.dy * 0.22));
            c.lineTo(px(m.x + m.dx * 0.22), py(m.y + m.dy * 0.22));
            c.stroke();
        }

        c.globalAlpha = 0.45;    // carénage
        c.lineWidth = 1 * hudWeight;
        c.beginPath();
        c.arc(cx, cy, HUD_ROV_R * scale, 0, Math.PI * 2);
        c.stroke();

        c.globalAlpha = 0.85;    // hélice (3 pales)
        c.lineWidth = 1.1 * hudWeight;
        c.beginPath();
        for (let k = 0; k < 3; k += 1) {
            const a = HUD_ROV_SPIN[i] + k * (Math.PI * 2 / 3);
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            c.moveTo(px(m.x + ca * 0.07), py(m.y + sa * 0.07));
            c.lineTo(px(m.x + ca * HUD_ROV_BLADE), py(m.y + sa * HUD_ROV_BLADE));
        }
        c.stroke();
        c.globalAlpha = 0.9;     // moyeu
        c.fillStyle = color;
        c.beginPath();
        c.arc(cx, cy, Math.max(1, 0.05 * scale), 0, Math.PI * 2);
        c.fill();

        if (Math.abs(t) > 0.02) {   // flèche de poussée (direction du mixage)
            const sgn = t > 0 ? 1 : -1;
            const r0 = HUD_ROV_R + 0.06;
            c.globalAlpha = 0.95;
            c.lineWidth = 1.4 * hudWeight;
            hudRovArrow(c, px(m.x + m.dx * sgn * r0), py(m.y + m.dy * sgn * r0),
                m.dx * sgn, -m.dy * sgn,
                (0.14 + 0.68 * Math.abs(t)) * scale, Math.max(3, 0.14 * scale));
        }

        c.globalAlpha = 1;       // numéro + commande : verticaux décalés vers l'axe
        const pct = Math.round(t * 100);
        const label = hudChannelName(names, i + 1, HUD_MOTOR_LABELS[i].split(' ')[0]);
        const off = HUD_ROV_R + (m.vert ? 0.04 : 0.1);   // verticaux : au plus près
        const ty = m.vert ? m.y - 0.2 * Math.sign(m.y) : m.y;
        hudText(c, (label.length > 8 ? label.slice(0, 7) + '…' : label)
            + ' ' + (pct > 0 ? '+' : '') + pct,
            px(m.x > 0 ? m.x + off : m.x - off), py(ty), fs,
            m.x > 0 ? 'left' : 'right', color);
    }
    c.restore();
}

/* -- Pince filaire 3D : voies 9 (pincement) et 10 (rotation) ---------------- */

/** Vue 3/4 plongeante de la pince : lacet, tangage (rad) et recul caméra. */
const HUD_GRIP_VIEW = { yaw: -0.62, pitch: -0.3, dist: 24 };
const HUD_GRIP_PJ = { cy: Math.cos(HUD_GRIP_VIEW.yaw), sy: Math.sin(HUD_GRIP_VIEW.yaw),
                      cp: Math.cos(HUD_GRIP_VIEW.pitch), sp: Math.sin(HUD_GRIP_VIEW.pitch) };

/** Point monde → plan image (perspective légère) : lacet (Y) puis tangage (X). */
function hudGripProject(pj, x, y, z) {
    const x1 = x * pj.cy + z * pj.sy;
    const z1 = -x * pj.sy + z * pj.cy;
    const y2 = y * pj.cp - z1 * pj.sp;
    const z2 = y * pj.sp + z1 * pj.cp;
    const k = HUD_GRIP_VIEW.dist / (HUD_GRIP_VIEW.dist + z2);
    return [x1 * k, y2 * k];
}

/** Boîte filaire (12 arêtes), sommets transformés par `move`. */
function hudGripBox(segs, move, x0, x1, y0, y1, z0, z1) {
    const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
               [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(move);
    [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
        .forEach(([a, b]) => segs.push([p[a], p[b]]));
}

/** Cercle filaire dans le plan YZ (14 segments), transformé par `move`. */
function hudGripRing(segs, move, x, r) {
    const n = 14;
    for (let i = 0; i < n; i += 1) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        segs.push([move([x, Math.cos(a0) * r, Math.sin(a0) * r]),
                   move([x, Math.cos(a1) * r, Math.sin(a1) * r])]);
    }
}

/** Géométrie de la pince pour un état : poignet fixe, ensemble mobile rollé. */
function hudGripGeometry(open, roll) {
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const fixed = [];     // poignet (fixe)
    const moving = [];    // collier, base et mâchoires (suivent la rotation)
    const still = (p) => p;
    const rolled = (p) => [p[0], p[1] * cr - p[2] * sr, p[1] * sr + p[2] * cr];

    // Poignet : cylindre filaire (2 cercles + 6 génératrices).
    hudGripRing(fixed, still, -2.6, 0.52);
    hudGripRing(fixed, still, -0.5, 0.52);
    for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        fixed.push([[-2.6, Math.cos(a) * 0.52, Math.sin(a) * 0.52],
                    [-0.5, Math.cos(a) * 0.52, Math.sin(a) * 0.52]]);
    }
    // Collier tournant + repères radiaux (matérialisent l'angle de rotation).
    hudGripRing(moving, rolled, -0.5, 0.56);
    hudGripRing(moving, rolled, 0.12, 0.56);
    moving.push([rolled([-0.5, 0, 0]), rolled([-0.5, 0.56, 0])]);
    moving.push([rolled([0.12, 0, 0]), rolled([0.12, 0.56, 0])]);
    // Base des mâchoires, puis deux doigts parallèles écartés par la voie 9.
    hudGripBox(moving, rolled, 0.12, 0.78, -0.5, 0.5, -0.42, 0.42);
    const gap = 0.1 + open * 0.95;
    const lip = 0.34;
    hudGripBox(moving, rolled, 0.78, 3.1, gap, gap + lip, -0.17, 0.17);
    hudGripBox(moving, rolled, 0.78, 3.1, -gap - lip, -gap, -0.17, 0.17);
    return { fixed, moving };
}

/** Boîte englobante image de référence : union des états extrêmes (ouverture
    0 → 1 × rotation −90° → +90°), calculée une fois puis mise en cache —
    l'échelle et le centrage restent stables, seules les mâchoires bougent. */
let hudGripRefBox = null;

function hudGripReferenceBox() {
    if (hudGripRefBox) return hudGripRefBox;
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (let oi = 0; oi <= 4; oi += 1) {
        for (let rd = -90; rd <= 90; rd += 30) {
            const geom = hudGripGeometry(oi / 4, rd * Math.PI / 180);
            geom.fixed.concat(geom.moving).forEach(([a, b]) => {
                [a, b].forEach((p) => {
                    const q = hudGripProject(HUD_GRIP_PJ, p[0], p[1], p[2]);
                    box.minX = Math.min(box.minX, q[0]);
                    box.maxX = Math.max(box.maxX, q[0]);
                    box.minY = Math.min(box.minY, q[1]);
                    box.maxY = Math.max(box.maxY, q[1]);
                });
            });
        }
    }
    hudGripRefBox = box;
    return box;
}

/** Projection d'un jeu de segments vers l'image (paires de points écran). */
function hudGripProjectSegs(segs) {
    return segs.map(([a, b]) => [hudGripProject(HUD_GRIP_PJ, a[0], a[1], a[2]),
                                 hudGripProject(HUD_GRIP_PJ, b[0], b[1], b[2])]);
}

/**
 * Pince filaire 3D — voie 9 : ouverture des mâchoires (1 000 µs fermée →
 * 2 000 µs ouverte) ; voie 10 : rotation du poignet autour de l'axe
 * (1 500 µs = 0°, 1 000/2 000 µs = ±90°). Le corps reste fixe ; collier,
 * base et mâchoires suivent la rotation. Le dessin s'ajuste à la boîte de
 * l'élément ; valeurs en bas (% d'ouverture, angle en degrés).
 */
function hudDrawGrip(c, w, h, f) {
    const names = (SYSTEM_STATUS && SYSTEM_STATUS.serial && SYSTEM_STATUS.serial.names_pwm) || {};
    const pwm = hudPwmFrame(f, 10);
    const open = hudClamp((Number(pwm[8]) - 1000) / 1000, 0, 1);
    const roll = hudClamp((Number(pwm[9]) - 1500) / 500, -1, 1) * Math.PI / 2;
    const geom = hudGripGeometry(open, roll);
    const fixedP = hudGripProjectSegs(geom.fixed);
    const movingP = hudGripProjectSegs(geom.moving);

    // Ajustement à la boîte : bande de texte réservée en bas ; l'échelle et le
    // centrage viennent de la boîte de référence (cache) pour rester stables.
    const ref = hudGripReferenceBox();
    const pad = Math.max(3, Math.min(w, h) * 0.04);
    const fs = hudClamp(h * 0.13, 6.5, 10);
    const textH = Math.min(h * 0.45, fs * 1.8);
    const availW = Math.max(8, w - pad * 2);
    const availH = Math.max(4, h - textH - pad * 2);
    const bw = Math.max(0.001, ref.maxX - ref.minX);
    const bh = Math.max(0.001, ref.maxY - ref.minY);
    const scale = Math.min(availW / bw, availH / bh) * 0.985;
    const ox = (w - bw * scale) / 2 - ref.minX * scale;
    const oy = pad + (availH - bh * scale) / 2 + ref.maxY * scale;

    const stroke = (segs) => {
        c.beginPath();
        segs.forEach(([a, b]) => {
            c.moveTo(ox + a[0] * scale, oy - a[1] * scale);   // y image inversé
            c.lineTo(ox + b[0] * scale, oy - b[1] * scale);
        });
        c.stroke();
    };

    c.save();
    c.strokeStyle = hudStroke;
    c.lineWidth = 1.1 * hudWeight;
    c.lineJoin = 'round';
    hudGlow(c, true, hudStroke, 4);
    c.globalAlpha = 0.5;
    stroke(fixedP);                               // poignet (discret)
    c.globalAlpha = 0.9;
    stroke(movingP);                              // mâchoires (nettes)
    c.globalAlpha = 1;

    const deg = Math.round(roll * 180 / Math.PI);
    const openName = hudChannelName(names, 9, 'PINCE');
    const rotName = hudChannelName(names, 10, 'ROT');
    hudText(c, (openName.length > 14 ? openName.slice(0, 13) + '…' : openName)
        + ' ' + Math.round(open * 100) + ' %', pad, h - fs * 0.55, fs, 'left');
    hudText(c, rotName + ' ' + (deg > 0 ? '+' : '') + deg + '°',
        w - pad, h - fs * 0.55, fs, 'right');
    c.restore();
}

/** Voies PWM restantes (11 à 16) : six jauges en microsecondes. */
function hudDrawAux(c, w, h, f) {
    const names = (SYSTEM_STATUS && SYSTEM_STATUS.serial && SYSTEM_STATUS.serial.names_pwm) || {};
    const pwm = hudPwmFrame(f, 16);
    const rowH = h / 6;
    for (let i = 0; i < 6; i += 1) {
        c.save();
        c.translate(0, rowH * i);
        hudBarGauge(c, w, rowH, { label: hudChannelName(names, 11 + i, 'VOIE ' + (11 + i)),
                                  value: pwm[10 + i], unit: 'µs', min: 1000, max: 2000,
                                  decimals: 0, ticks: 4, warnAt: 1500 });
        c.restore();
    }
}

/* -- Jauges séparées : tension batterie et courants moteurs ------------------ */

/** Jauge à barre : libellé, valeur, piste graduée et repère de seuil d'alarme.
    opts : { label, value, unit, min, max, decimals, ticks, warnLow, warnHigh, warnAt } */
function hudBarGauge(c, w, h, opts) {
    const pad = Math.max(3, Math.min(w, h) * 0.06);
    const fsLabel = hudClamp(h * 0.18, 6.5, 10);   // tailles brutes : hudText applique hudFont
    const fsValue = hudClamp(h * 0.34, 9, 18);
    const rowH = fsValue * hudFont;
    const tickZone = hudClamp(h * 0.16, 4, 9);
    const rowY = pad + rowH * 0.5;
    const barTop = Math.min(h - pad - tickZone - 3, pad + rowH + 2);
    const barBottom = Math.max(barTop + 3, h - pad - tickZone);
    const barW = w - pad * 2;
    const warn = (opts.warnLow !== undefined && opts.value < opts.warnLow)
        || (opts.warnHigh !== undefined && Math.abs(opts.value) > opts.warnHigh);
    const color = warn ? HUD_WARN : hudStroke;
    const frac = hudClamp((opts.value - opts.min) / (opts.max - opts.min), 0, 1);

    c.save();
    hudGlow(c, true, hudStroke, 5);
    hudText(c, opts.label, pad, rowY, fsLabel, 'left');
    hudText(c, opts.value.toFixed(opts.decimals).replace('.', ',') + ' ' + opts.unit,
        w - pad, rowY, fsValue, 'right', color);

    // Piste, contour, puis remplissage proportionnel (ambre en alarme).
    c.globalAlpha = 0.16;
    c.fillStyle = hudStroke;
    c.fillRect(pad, barTop, barW, barBottom - barTop);
    c.globalAlpha = 1;
    c.strokeStyle = hudStroke;
    c.lineWidth = 1 * hudWeight;
    c.strokeRect(pad + 0.5, barTop + 0.5, barW - 1, barBottom - barTop - 1);
    if (frac > 0.005) {
        hudGlow(c, true, color, 6);
        c.fillStyle = color;
        c.globalAlpha = 0.8;
        c.fillRect(pad + 1, barTop + 1, (barW - 2) * frac, barBottom - barTop - 2);
        c.globalAlpha = 1;
    }

    // Graduations sous la barre + repère du seuil d'alarme.
    c.globalAlpha = 0.5;
    for (let t = 0; t <= opts.ticks; t += 1) {
        const x = pad + (barW * t) / opts.ticks;
        c.beginPath();
        c.moveTo(x, barBottom);
        c.lineTo(x, barBottom + tickZone * (t % 2 === 0 ? 0.7 : 0.45));
        c.stroke();
    }
    if (opts.warnAt !== undefined) {
        const xWarn = pad + barW * hudClamp((opts.warnAt - opts.min) / (opts.max - opts.min), 0, 1);
        c.globalAlpha = 0.9;
        c.lineWidth = 1.2 * hudWeight;
        c.beginPath();
        c.moveTo(xWarn, barTop);
        c.lineTo(xWarn, barBottom + tickZone * 0.85);
        c.stroke();
    }
    c.restore();
}

/** Tension batterie : jauge 9–13 V, alarme sous 11 V. */
function hudDrawVoltage(c, w, h, f) {
    hudBarGauge(c, w, h, { label: 'VOLTAGE', value: f.vbat, unit: 'V', min: 9, max: 13,
                           decimals: 1, ticks: 8, warnLow: 11, warnAt: 11 });
}

/** Courant des moteurs verticaux : jauge 0–30 A, alarme au-delà de 20 A. */
function hudDrawMotorV(c, w, h, f) {
    hudBarGauge(c, w, h, { label: 'MOTEUR VERT.', value: f.iV, unit: 'A', min: 0, max: 30,
                           decimals: 1, ticks: 6, warnHigh: 20, warnAt: 20 });
}

/** Courant des moteurs horizontaux : jauge 0–30 A, alarme au-delà de 20 A. */
function hudDrawMotorH(c, w, h, f) {
    hudBarGauge(c, w, h, { label: 'MOTEUR HORIZ.', value: f.iH, unit: 'A', min: 0, max: 30,
                           decimals: 1, ticks: 6, warnHigh: 20, warnAt: 20 });
}

Object.assign(HUD_DRAW, {
    horizon: hudDrawHorizon,
    heading: hudDrawHeading,
    depth: hudDrawDepth,
    temperature: hudDrawTemperature,
    gauges: hudDrawMotors,
    grip: hudDrawGrip,
    aux: hudDrawAux,
    voltage: hudDrawVoltage,
    motor_v: hudDrawMotorV,
    motor_h: hudDrawMotorH,
});

/* -- Boucle de rendu (section Cockpit uniquement) --------------------------- */

function startHudLoop() {
    if (!HUD.raf) HUD.raf = requestAnimationFrame(hudLoop);
}

function hudLoop(now) {
    HUD.raf = 0;
    const section = byId('section-cockpit');
    if (!section || section.style.display !== 'block') return;   // section fermée : extinction
    if (now - HUD.lastPollAt >= HUD_POLL_MS) {
        HUD.lastPollAt = now;
        hudPollTelemetry();
    }
    HUD.frame += 1;
    // Rendu à ~30 im/s : suffisant pour des aiguilles lissées, moitié du coût GPU.
    if (HUD.frame % 2 === 1) { HUD.raf = requestAnimationFrame(hudLoop); return; }

    const live = hudIsLive(now);
    hudApplyView(live ? hudFrameFromTelemetry(HUD.telemetry) : hudSimulate(now / 1000));
    if (HUD.view) HUD.view.simulated = !live;

    HUD_ORDER.forEach((id) => {
        const entry = HUD.els[id];
        const item = HUD.layout[id];
        if (!entry || !item || !HUD.view) return;
        if (entry.root.classList.contains('off') && !HUD.editing) return;
        hudFitCanvas(entry);
        hudStroke = item.color;        // couleur, finesse et taille de texte par élément
        hudWeight = item.weight;
        hudFont = item.font;
        HUD_DRAW[id](entry.ctx, entry.w, entry.h, HUD.view);
    });
    HUD.raf = requestAnimationFrame(hudLoop);
}

/* -- Éditeur de mise en page : glisser = position, poignée = taille,
      molette = transparence, puis enregistrement dans config.json ---------- */

/** Position du pointeur en % de la scène vidéo (référentiel du HUD). */
function hudStagePos(event) {
    const rect = byId('video-stage').getBoundingClientRect();
    return {
        x: ((event.clientX - rect.left) / rect.width) * 100,
        y: ((event.clientY - rect.top) / rect.height) * 100,
    };
}

function startHudEdit() {
    if (HUD.editing) return;
    HUD.editing = true;
    HUD.layoutBackup = JSON.parse(JSON.stringify(HUD.layout));
    byId('hud-layer').classList.add('editing');
    byId('hud-toolbar').hidden = false;
    if (!HUD.active) HUD.active = HUD_ORDER[0];
    hudSyncEditorControls();
    startHudLoop();
    toast('Mise en page : clic = sélectionner · glisser = position · molette = transparence');
}

function endHudEdit() {
    HUD.editing = false;
    HUD.layoutBackup = null;
    byId('hud-layer').classList.remove('editing');
    byId('hud-toolbar').hidden = true;
}

/** Quitte le mode mise en page en abandonnant les modifications non enregistrées. */
function cancelHudEdit() {
    if (!HUD.editing) return;
    HUD.layout = HUD.layoutBackup || hudLayoutFromConfig();
    endHudEdit();
    hudApplyLayout();
}

/** Enregistre la mise en page dans config.json (arrondie à 0,1 %). */
async function saveHudEdit() {
    const elements = {};
    HUD_ORDER.forEach((id) => {
        const item = HUD.layout[id];
        const entry = {
            x: hudRound1(item.x),
            y: hudRound1(item.y),
            w: hudRound1(item.w),
            h: hudRound1(item.h),
            // Opacité gardée au centième : ne pas dégrader 0,92 en 0,9 à l'enregistrement.
            opacity: Math.round(item.opacity * 100) / 100,
            color: hudPickColor(item.color, HUD_COLOR),
            weight: Math.round(item.weight * 10) / 10,
            font: Math.round(item.font * 10) / 10,
        };
        if (id === 'depth') {
            entry.max = Math.round(item.max * 10) / 10;   // profondeur max de la jauge (m)
        }
        elements[id] = entry;
    });
    try {
        await patchConfig({ cockpit: { hud: { elements } } });
        endHudEdit();
        applyHudConfig();
        toast('Disposition, couleurs, finesse et textes enregistrés dans config.json');
    } catch (error) {
        toast('Mise en page refusée : ' + error.message, 'err', 4600);
    }
}

/** Rétablit la disposition par défaut (à confirmer par « Enregistrer »). */
function resetHudEdit() {
    HUD.layout = hudLayoutDefaults();
    hudApplyLayout();
    toast('Disposition par défaut restaurée — « Enregistrer » pour la conserver');
}

/** Persiste les cases « HUD télémétrie » de Config Cockpit (cockpit.overlay). */
async function saveOverlayToggles() {
    const overlay = {};
    HUD_ORDER.forEach((id) => { overlay[id] = byId('ovl-' + id).checked; });
    try {
        await patchConfig({ cockpit: { overlay } });
        hudApplyOverlayVisibility();
        toast('Incrustation télémétrie enregistrée');
    } catch (error) {
        toast('Incrustation refusée : ' + error.message, 'err');
    }
}

/** Reflète l'élément sélectionné dans les réglages de la barre « Mise en page ». */
function hudSyncEditorControls() {
    const item = HUD.layout[HUD.active];
    if (!item) return;
    byId('hud-el-select').value = HUD.active;
    byId('hud-el-color').value = hudPickColor(item.color, HUD_COLOR);
    byId('hud-el-weight').value = String(item.weight);
    setText(byId('hud-el-weight-val'), '×' + item.weight.toFixed(1).replace('.', ','));
    byId('hud-el-font').value = String(item.font);
    setText(byId('hud-el-font-val'), '×' + item.font.toFixed(1).replace('.', ','));
    // « Prof. max » ne concerne que la jauge de profondeur.
    byId('hud-ctl-max').hidden = HUD.active !== 'depth';
    if (HUD.active === 'depth') {
        byId('hud-el-max').value = String(Math.round(item.max * 10) / 10);
    }
    HUD_ORDER.forEach((id) => {
        const entry = HUD.els[id];
        if (entry) entry.root.classList.toggle('active', id === HUD.active);
    });
}

function initHudEditor() {
    const layer = byId('hud-layer');

    layer.addEventListener('pointerdown', (event) => {
        if (!HUD.editing || event.button !== 0) return;
        const root = event.target.closest ? event.target.closest('.hud-el') : null;
        if (!root || !layer.contains(root)) return;
        const item = HUD.layout[root.dataset.hud];
        if (!item) return;
        HUD.active = root.dataset.hud;      // la barre de réglages suit l'élément cliqué
        hudSyncEditorControls();
        hudDrag = {
            root,
            pointerId: event.pointerId,
            resize: event.target.classList.contains('hud-handle'),
            origin: hudStagePos(event),
            base: { x: item.x, y: item.y, w: item.w, h: item.h },
        };
        root.classList.add('dragging');
        try { root.setPointerCapture(event.pointerId); } catch (_) { /* pointeur déjà libéré */ }
        event.preventDefault();
    });

    layer.addEventListener('pointermove', (event) => {
        if (!hudDrag || event.pointerId !== hudDrag.pointerId) return;
        const pos = hudStagePos(event);
        const item = HUD.layout[hudDrag.root.dataset.hud];
        const base = hudDrag.base;
        if (hudDrag.resize) {
            item.w = hudClamp(pos.x - item.x, HUD_MIN_SIZE, 100 - item.x);
            item.h = hudClamp(pos.y - item.y, HUD_MIN_SIZE, 100 - item.y);
        } else {
            item.x = hudClamp(base.x + pos.x - hudDrag.origin.x, 0, 100 - item.w);
            item.y = hudClamp(base.y + pos.y - hudDrag.origin.y, 0, 100 - item.h);
        }
        hudApplyLayout();
        event.preventDefault();
    });

    const finishDrag = (event) => {
        if (!hudDrag || event.pointerId !== hudDrag.pointerId) return;
        hudDrag.root.classList.remove('dragging');
        try { hudDrag.root.releasePointerCapture(hudDrag.pointerId); } catch (_) { /* déjà relâché */ }
        hudDrag = null;
    };
    layer.addEventListener('pointerup', finishDrag);
    layer.addEventListener('pointercancel', finishDrag);

    // Molette : transparence de l'élément survolé (±0,05 par cran).
    layer.addEventListener('wheel', (event) => {
        if (!HUD.editing) return;
        const root = event.target.closest ? event.target.closest('.hud-el') : null;
        if (!root) return;
        event.preventDefault();
        const item = HUD.layout[root.dataset.hud];
        const step = event.deltaY > 0 ? -HUD_OPACITY_STEP : HUD_OPACITY_STEP;
        // Arrondi à 0,01 : un arrondi à 0,1 figerait la valeur (0,9 − 0,05 = 0,85 → 0,9).
        item.opacity = hudClamp(Math.round((item.opacity + step) * 100) / 100, 0.05, 1);
        hudApplyLayout();
    }, { passive: false });

    // Échap : quitte le mode mise en page (prioritaire sur le « retour » de la SPA).
    document.addEventListener('keydown', (event) => {
        if (!HUD.editing || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancelHudEdit();
    }, true);

    // Réglages de l'élément sélectionné : couleur, finesse des traits, taille des textes.
    const select = byId('hud-el-select');
    HUD_ORDER.forEach((id) => {
        const entry = HUD.els[id];
        const name = entry ? entry.root.querySelector('.hud-el-name') : null;
        select.appendChild(new Option(name ? name.textContent : id, id));
    });
    select.addEventListener('change', (event) => {
        HUD.active = event.target.value;
        hudSyncEditorControls();
    });
    byId('hud-el-color').addEventListener('input', (event) => {
        const item = HUD.layout[HUD.active];
        if (!item) return;
        item.color = hudPickColor(event.target.value, item.color);
        hudApplyLayout();          // l'échantillon de couleur et le cadre suivent tout de suite
    });
    byId('hud-el-weight').addEventListener('input', (event) => {
        const item = HUD.layout[HUD.active];
        if (!item) return;
        item.weight = hudClamp(Number(event.target.value) || 1, HUD_WEIGHT_MIN, HUD_WEIGHT_MAX);
        setText(byId('hud-el-weight-val'), '×' + item.weight.toFixed(1).replace('.', ','));
    });
    byId('hud-el-font').addEventListener('input', (event) => {
        const item = HUD.layout[HUD.active];
        if (!item) return;
        item.font = hudClamp(Number(event.target.value) || 1, HUD_FONT_MIN, HUD_FONT_MAX);
        setText(byId('hud-el-font-val'), '×' + item.font.toFixed(1).replace('.', ','));
    });
    // Profondeur max de la jauge (depth) : échelle du cadran et seuils d'alarme.
    byId('hud-el-max').addEventListener('input', (event) => {
        const item = HUD.layout.depth;
        if (!item) return;
        item.max = hudClamp(Number(event.target.value) || HUD_DEFAULT_LAYOUT.depth.max,
            HUD_DEPTH_MAX_MIN, HUD_DEPTH_MAX_MAX);
    });
    // À la sortie du champ : réécrit la valeur bornée (la frappe n'est jamais contrariée).
    byId('hud-el-max').addEventListener('change', (event) => {
        const item = HUD.layout.depth;
        if (item) event.target.value = String(Math.round(item.max * 10) / 10);
    });
    hudSyncEditorControls();
}

function initHud() {
    HUD_ORDER.forEach((id) => {
        const root = document.querySelector('.hud-el[data-hud="' + id + '"]');
        if (!root) return;
        const canvas = root.querySelector('.hud-canvas');
        HUD.els[id] = {
            root,
            canvas,
            ctx: canvas.getContext('2d'),
            badge: root.querySelector('.hud-el-badge'),
            w: 0, h: 0, dpr: 0,
        };
    });
    HUD.layout = hudLayoutDefaults();
    hudApplyLayout();
    initHudEditor();

    byId('btn-hud-edit').addEventListener('click', () => {
        if (HUD.editing) cancelHudEdit();
        else startHudEdit();
    });
    byId('btn-hud-save').addEventListener('click', saveHudEdit);
    byId('btn-hud-reset').addEventListener('click', resetHudEdit);
    byId('btn-hud-cancel').addEventListener('click', cancelHudEdit);
    // Config Cockpit : « Mise en page… » ouvre le Cockpit en mode réglage.
    byId('btn-hud-layout').addEventListener('click', () => {
        showSection('section-cockpit', 'parameters');
        startHudEdit();
    });
    byId('btn-ovl-save').addEventListener('click', saveOverlayToggles);
}

/* =========================================================================
 * 7. RÉGLAGES — lecture / écriture de config.json, cascade caméras, boutons
 * ========================================================================= */

let CONFIG = null;            // config.json courant (source de vérité serveur)
let videoDevices = [];        // périphériques V4L2 détectés (GET /api/video/devices)
let lastNetworkSig = '';      // évite de reconstruire la liste d'adresses au poll

async function loadConfig() {
    CONFIG = await getJSON('/api/config');
}

function cameraConfig(cam) {
    return (CONFIG && CONFIG.cameras && CONFIG.cameras[cam]) || {};
}

/* -- Caméras : cascade périphérique → résolution → cadence ----------------- */

function deviceInfo(devicePath) {
    return videoDevices.find((device) => device.device === devicePath) || null;
}

/** Tailles supportées en MJPG (repli : premier format listé par le pilote). */
function deviceSizes(devicePath) {
    const info = deviceInfo(devicePath);
    if (!info || !info.formats || !info.formats.length) return [];
    const format = info.formats.find((f) => f.fourcc === 'MJPG') || info.formats[0];
    return format.sizes || [];
}

async function loadVideoDevices() {
    const data = await getJSON('/api/video/devices');
    videoDevices = data.devices || [];
    renderDeviceList();
    ['cam1', 'cam2'].forEach((cam) => {
        const select = byId(cam + '-device');
        const current = cameraConfig(cam);
        select.innerHTML = '';
        videoDevices.forEach((device) => {
            select.add(new Option(`${device.device} — ${device.name}`, device.device));
        });
        if (current.device && !deviceInfo(current.device)) {
            // caméra débranchée : son chemin est conservé pour ne pas perdre le réglage
            select.add(new Option(`${current.device} — (non détectée)`, current.device));
        }
        if (current.device && Array.from(select.options).some((o) => o.value === current.device)) {
            select.value = current.device;
        } else if (select.options.length) {
            select.selectedIndex = 0;
        }
        fillResolutions(cam);
    });
}

/** Résolution actuellement choisie (repli : valeurs de config.json). */
function cameraResolution(cam) {
    const match = /^(\d+)x(\d+)$/.exec(byId(cam + '-resolution').value || '');
    if (match) return [Number(match[1]), Number(match[2])];
    const current = cameraConfig(cam);
    return [Number(current.width) || 640, Number(current.height) || 480];
}

function fillResolutions(cam) {
    const select = byId(cam + '-resolution');
    const current = cameraConfig(cam);
    const sizes = deviceSizes(byId(cam + '-device').value);
    select.innerHTML = '';
    if (sizes.length) {
        sizes.forEach((size) => select.add(new Option(`${size.width} × ${size.height}`, `${size.width}x${size.height}`)));
    } else {
        // caméra occupée ou absente : seule la valeur de config est connue
        const w = Number(current.width) || 640;
        const h = Number(current.height) || 480;
        select.add(new Option(`${w} × ${h} (config)`, `${w}x${h}`));
    }
    if (current.width && current.height) {
        const wanted = `${Number(current.width)}x${Number(current.height)}`;
        if (Array.from(select.options).some((option) => option.value === wanted)) select.value = wanted;
    }
    fillFps(cam);
    updateCamDeviceInfo(cam);
}

function fillFps(cam) {
    const select = byId(cam + '-fps');
    const current = cameraConfig(cam);
    const [width, height] = cameraResolution(cam);
    const size = deviceSizes(byId(cam + '-device').value)
        .find((entry) => entry.width === width && entry.height === height);
    const rates = (size && size.fps && size.fps.length) ? size.fps : [Number(current.fps) || 30];
    select.innerHTML = '';
    rates.forEach((rate) => {
        const rounded = Math.round(rate);
        select.add(new Option(`${rounded} i/s`, String(rounded)));
    });
    const wanted = String(Math.round(Number(current.fps) || 30));
    if (Array.from(select.options).some((option) => option.value === wanted)) select.value = wanted;
}

function renderDeviceList() {
    const container = byId('cams-devices');
    container.innerHTML = '';
    if (!videoDevices.length) {
        container.appendChild(el('p', 'hint', 'Aucun périphérique de capture V4L2 détecté.'));
        return;
    }
    videoDevices.forEach((device) => {
        const item = el('div', 'device-item');
        item.appendChild(el('span', 'dev-name', device.name || device.device));
        item.appendChild(el('span', 'dev-path', device.device));
        const formats = (device.formats || []).map((format) => format.fourcc).join(' ');
        const meta = [device.driver, formats, device.mjpeg ? 'MJPEG' : '', device.busy ? 'occupée' : 'libre']
            .filter(Boolean).join(' · ');
        item.appendChild(el('span', 'dev-meta', meta));
        container.appendChild(item);
    });
}

function updateCamDeviceInfo(cam) {
    const target = byId(cam + '-dev-info');
    const device = byId(cam + '-device').value;
    const info = deviceInfo(device);
    if (!info) { setText(target, `${device || '—'} — non détectée (débranchée ou occupée ?).`); return; }
    const [width, height] = cameraResolution(cam);
    // le champ card V4L2 répète souvent le modèle (« Marque: Marque… ») : on coupe au ':'
    const shortName = (info.name || '').split(':')[0].trim() || info.name;
    const parts = [shortName];
    if (info.driver) parts.push(`pilote ${info.driver}`);
    parts.push(info.mjpeg ? 'MJPEG natif' : 'MJPEG non confirmé');
    parts.push(`${width} × ${height}`);
    if (info.busy) parts.push('occupée (flux actif)');
    setText(target, parts.join(' · '));
}

/* -- Réseau ---------------------------------------------------------------- */

function renderNetworkAddresses() {
    const container = byId('net-addresses');
    const port = (CONFIG && CONFIG.network && CONFIG.network.port) || location.port || 8080;
    const addresses = (SYSTEM_STATUS && SYSTEM_STATUS.addresses) || [];
    const signature = port + '|' + addresses.join(',');
    if (signature === lastNetworkSig) return;
    lastNetworkSig = signature;
    container.innerHTML = '';
    if (!addresses.length) {
        container.appendChild(el('p', 'hint', 'Adresses indisponibles — actualisation automatique…'));
        lastNetworkSig = '';                 // retente au prochain poll
        return;
    }
    addresses.forEach((address) => {
        const item = el('div', 'device-item');
        item.appendChild(el('span', 'dev-name', 'Cockpit web'));
        item.appendChild(el('span', 'dev-path', `http://${address}:${port}`));
        item.appendChild(el('span', 'dev-meta', 'ouvrir sur le poste de pilotage'));
        container.appendChild(item);
    });
}

/* -- Simulateur & formulaires ---------------------------------------------- */

function renderSimState() {
    const enabled = byId('sim-enabled').checked;
    setText(byId('sim-state'), enabled
        ? 'Simulateur actif demandé — la télémétrie simulée sera branchée à l\'étape 10.'
        : 'Simulateur inactif — la télémétrie provient de l\'ESP32-S3.');
    renderSimTop();
}

/** Ligne d'état de la section Sub Simulator (tuile de l'accueil). */
function renderSimTop() {
    const enabled = !!(CONFIG && CONFIG.simulator && CONFIG.simulator.enabled);
    setText(byId('sim-state-top'), enabled
        ? 'Simulateur activé dans les paramètres — écran de simulation à l\'étape 10.'
        : 'Simulateur inactif — activez-le dans Paramètres → Sub Simu.');
}

/** Positionne un curseur et son <output> (formatage optionnel). */
function setSlider(inputId, outputId, value, format = (v) => v) {
    const input = byId(inputId);
    input.value = value;
    setText(byId(outputId), format(input.value));
}

function fillSettings() {
    if (!CONFIG) return;

    // Caméras (device / résolution / cadence : remplies par loadVideoDevices)
    ['cam1', 'cam2'].forEach((cam) => {
        const quality = byId(cam + '-quality');
        quality.value = cameraConfig(cam).jpeg_quality ?? 80;
        setText(byId(cam + '-quality-val'), quality.value);
    });

    // Manettes & IMU
    const input = CONFIG.input || {};
    setSlider('in-deadzone', 'in-deadzone-val', input.deadzone ?? 0.08, (v) => Number(v).toFixed(2));
    setSlider('in-expo', 'in-expo-val', input.expo ?? 1.5, (v) => Number(v).toFixed(1));
    setSlider('in-maxspeed', 'in-maxspeed-val', input.max_speed_us ?? 400);
    byId('in-imu-enabled').checked = !!(input.imu && input.imu.enabled);
    byId('in-imu-device').value = (input.imu && input.imu.device) || '';
    setText(byId('in-neutral-hint'), (CONFIG.safety && CONFIG.safety.neutral_us) || 1500);

    // Réseau
    byId('net-host').value = (CONFIG.network && CONFIG.network.host) || '0.0.0.0';
    byId('net-port').value = (CONFIG.network && CONFIG.network.port) || 8080;
    lastNetworkSig = '';
    renderNetworkAddresses();

    // Lunettes AR
    const glasses = CONFIG.ar_glasses || {};
    byId('ar-enabled').checked = !!glasses.enabled;
    byId('ar-host').value = glasses.host || '';
    byId('ar-port').value = glasses.port || 5000;

    // Interface (fusionnée dans Config Cockpit)
    byId('ui-language').value = (CONFIG.interface && CONFIG.interface.language) || 'fr';

    // Enregistrement Cockpit (carte « Enregistrement » de la section Caméras)
    const recording = (CONFIG.cameras && CONFIG.cameras.recording) || {};
    byId('rec-fps').value = String(Number(recording.video_fps) || 30);
    setSlider('rec-bitrate', 'rec-bitrate-val', recording.video_bitrate_mbps ?? 4, (v) => v + ' Mbit/s');
    setSlider('rec-quality', 'rec-quality-val', recording.photo_quality ?? 90, (v) => v + ' %');

    // Config Cockpit : disposition par défaut + incrustation télémétrie
    const cockpit = CONFIG.cockpit || {};
    byId('cfg-mode').value = cockpit.mode || 'pip';
    byId('cfg-source').value = cockpit.source || 'cam1';
    HUD_ORDER.forEach((key) => {
        const box = byId('ovl-' + key);
        if (box) box.checked = (cockpit.overlay || {})[key] !== false;
    });
    renderTileOrderInfo(TILE_GRIDS.main);
    renderTileOrderInfo(TILE_GRIDS.params);

    // Manette : association des actions et routage BOB BL AR
    renderPadActions();
    renderHeadTrackerSettings();

    // Sub Simulator
    byId('sim-enabled').checked = !!(CONFIG.simulator && CONFIG.simulator.enabled);
    renderSimState();
}

/* -- Enregistrements -------------------------------------------------------- */

async function saveCameras() {
    const patch = { cameras: {} };
    ['cam1', 'cam2'].forEach((cam) => {
        const [width, height] = cameraResolution(cam);
        patch.cameras[cam] = {
            device: byId(cam + '-device').value,
            width,
            height,
            fps: Number(byId(cam + '-fps').value) || 30,
            jpeg_quality: Number(byId(cam + '-quality').value) || 80,
        };
    });
    try {
        await patchConfig(patch);
        Object.keys(FEEDS).forEach((cam) => { FEEDS[cam].connectedAt = 0; });
        await postJSON('/api/video/reload', {});
        if (VIDEO_STATE.feedsStarted) { connectFeed('cam1', true); connectFeed('cam2', true); }
        toast('Caméras enregistrées — flux rechargés');
        loadVideoDevices().catch(() => {});
    } catch (error) {
        toast('Enregistrement refusé : ' + error.message, 'err');
    }
}

async function saveControls() {
    const patch = {
        input: {
            deadzone: Number(byId('in-deadzone').value),
            expo: Number(byId('in-expo').value),
            max_speed_us: Number(byId('in-maxspeed').value),
            imu: {
                enabled: byId('in-imu-enabled').checked,
                device: byId('in-imu-device').value.trim(),
            },
            head_tracker: headTrackerSettingsForm(),
        },
    };
    try { await patchConfig(patch); toast('Réglages manettes & IMU enregistrés'); }
    catch (error) { toast('Enregistrement refusé : ' + error.message, 'err'); }
}

async function saveNetwork() {
    const host = byId('net-host').value.trim() || '0.0.0.0';
    const port = Number(byId('net-port').value) || 8080;
    try {
        await patchConfig({ network: { host, port } });
        lastNetworkSig = '';
        renderNetworkAddresses();
        toast('Réseau enregistré — appliquez avec « Relancer cockpit » (Paramètres → Système)', 'ok', 5200);
    } catch (error) { toast('Enregistrement refusé : ' + error.message, 'err'); }
}

async function copyCockpitUrl() {
    const url = location.origin;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(url);
        } else {
            // HTTP sur réseau local = hors contexte sécurisé : repli classique
            const helper = document.createElement('textarea');
            helper.value = url;
            helper.style.position = 'fixed';
            helper.style.opacity = '0';
            document.body.appendChild(helper);
            helper.select();
            document.execCommand('copy');
            helper.remove();
        }
        toast('Adresse copiée : ' + url);
    } catch (_) {
        toast('Copie refusée — adresse du cockpit : ' + url, 'err', 4600);
    }
}

async function saveGlasses() {
    const patch = {
        ar_glasses: {
            enabled: byId('ar-enabled').checked,
            host: byId('ar-host').value.trim(),
            port: Number(byId('ar-port').value) || 5000,
        },
    };
    try { await patchConfig(patch); toast('Réglages lunettes AR enregistrés'); }
    catch (error) { toast('Enregistrement refusé : ' + error.message, 'err'); }
}

async function saveInterface() {
    const patch = {
        interface: {
            theme: currentTheme(),
            language: byId('ui-language').value,
        },
    };
    try { await patchConfig(patch); toast('Interface enregistrée'); }
    catch (error) { toast('Enregistrement refusé : ' + error.message, 'err'); }
}

async function saveSimulator() {
    try {
        await patchConfig({ simulator: { enabled: byId('sim-enabled').checked } });
        renderSimState();
        toast('Réglage simulateur enregistré');
    } catch (error) { toast('Enregistrement refusé : ' + error.message, 'err'); }
}

/* -- Enregistrement (Caméras) ------------------------------------------------ */

async function saveRecording() {
    const patch = {
        cameras: {
            recording: {
                video_fps: Number(byId('rec-fps').value) || 30,
                video_bitrate_mbps: Number(byId('rec-bitrate').value) || 4,
                photo_quality: Number(byId('rec-quality').value) || 90,
            },
        },
    };
    try { await patchConfig(patch); toast('Réglages d\'enregistrement enregistrés'); }
    catch (error) { toast('Enregistrement refusé : ' + error.message, 'err'); }
}

/* -- Config Cockpit : disposition + incrustation ---------------------------- */

async function saveCockpitLayout() {
    const patch = {
        cockpit: { mode: byId('cfg-mode').value, source: byId('cfg-source').value },
        cameras: { pip: { ...VIDEO_STATE.pip } },
    };
    try { await patchConfig(patch); toast('Disposition du Cockpit enregistrée'); }
    catch (error) { toast('Enregistrement refusé : ' + error.message, 'err'); }
}

/* -- Réseau WiFi (nmcli côté Pi) -------------------------------------------- */

let NETWORK_STATUS = null;
let wifiNetworks = [];

/** État réseau complet : interfaces, radio WiFi, préférence LAN uniquement. */
async function refreshNetworkSection() {
    try {
        NETWORK_STATUS = await getJSON('/api/network');
        renderNetworkStatus();
    } catch (error) {
        setText(byId('wifi-state'), 'nmcli indisponible : ' + error.message);
    }
}

function renderNetworkStatus() {
    const status = NETWORK_STATUS || {};
    const container = byId('net-devices');
    container.innerHTML = '';
    if (!status.nmcli) {
        setText(byId('wifi-state'), 'NetworkManager (nmcli) indisponible'
            + (status.error ? ' — ' + status.error : ''));
        container.appendChild(el('p', 'hint', 'État réseau indisponible.'));
        return;
    }
    const wifi = status.wifi || {};
    const state = wifi.connected
        ? `WiFi connecté sur « ${wifi.connection || wifi.device} » (${wifi.device}).`
        : 'WiFi non connecté.';
    setText(byId('wifi-state'), state + (status.wifi_enabled
        ? ' Le WiFi reste activable depuis cette page.'
        : ' Préférence « LAN uniquement » : le WiFi sera déconnecté au prochain démarrage du service.'));
    (status.devices || []).forEach((device) => {
        const item = el('div', 'device-item');
        item.appendChild(el('span', 'dev-name', device.device));
        item.appendChild(el('span', 'dev-path', device.type));
        item.appendChild(el('span', 'dev-meta', device.state + (device.connection ? ' · ' + device.connection : '')));
        container.appendChild(item);
    });
    if (!(status.devices || []).length) container.appendChild(el('p', 'hint', 'Aucune interface détectée.'));
}

async function scanWifi() {
    const button = byId('btn-wifi-scan');
    const list = byId('wifi-list');
    button.disabled = true;
    list.innerHTML = '';
    list.appendChild(el('p', 'hint', 'Scan en cours… quelques secondes.'));
    try {
        const data = await postJSON('/api/network/scan', {});
        wifiNetworks = data.networks || [];
        renderWifiList();
        toast(wifiNetworks.length + ' réseau(x) détecté(s)');
    } catch (error) {
        list.innerHTML = '';
        list.appendChild(el('p', 'hint', 'Scan impossible : ' + error.message));
    } finally {
        button.disabled = false;
    }
}

function renderWifiList() {
    const list = byId('wifi-list');
    list.innerHTML = '';
    if (!wifiNetworks.length) {
        list.appendChild(el('p', 'hint', 'Aucun réseau trouvé.'));
        return;
    }
    wifiNetworks.forEach((network) => {
        const secured = !!network.security && network.security !== '--';
        const row = el('div', 'device-item');
        row.appendChild(el('span', 'dev-name', network.ssid));
        row.appendChild(el('span', 'wifi-sig', network.signal + ' %'));
        row.appendChild(el('span', 'dev-meta', secured ? network.security : 'ouvert'));
        if (network.active) row.appendChild(el('span', 'kind-chip video', 'connecté'));
        const actions = el('span', 'dev-actions');
        if (secured) {
            const input = document.createElement('input');
            input.type = 'password';
            input.className = 'wifi-pass-input';
            input.placeholder = 'Mot de passe';
            actions.appendChild(input);
        }
        const connect = el('button', 'btn btn-mini', 'Connecter');
        connect.type = 'button';
        connect.addEventListener('click', () => connectWifi(network.ssid, row));
        actions.appendChild(connect);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

async function connectWifi(ssid, row) {
    const input = row.querySelector('.wifi-pass-input');
    const password = input ? input.value : '';
    try {
        const data = await postJSON('/api/network/connect', { ssid, password });
        toast(data.message || ('Connexion à « ' + ssid + ' » demandée'), 'ok', 4200);
        if (input) input.value = '';
        setTimeout(refreshNetworkSection, 2500);
    } catch (error) {
        toast('Connexion refusée : ' + error.message, 'err', 5200);
    }
}

async function lanOnly() {
    if (!window.confirm('Déconnecter le WiFi et rester en LAN uniquement ?')) return;
    try {
        const data = await postJSON('/api/network/disconnect', {});
        toast(data.message || 'WiFi déconnecté — mode LAN uniquement');
        await refreshNetworkSection();
    } catch (error) {
        toast('Déconnexion refusée : ' + error.message, 'err');
    }
}

/* -- Manette (Gamepad API) ---------------------------------------------------
 * Catalogue complet des fonctions du ROV et du poste, tableau par manette :
 * « Assigner » sur la ligne d'une fonction → attente d'un appui bouton ou
 * d'une poussée d'axe → enregistrement immédiat dans config.json. Une
 * fonction peut porter une source par manette (clé `pad` = Gamepad.id) ;
 * sans clé `pad`, la source vaut pour toutes les manettes. */

let padDraft = null;          // copie de travail rendue puis enregistrée à chaque changement
let padCapture = null;        // capture en cours : {actionId, padKey, pads: Map(id → référence au repos)}
let padCaptureTimer = 0;

/* -- BOB BL AR : source d'entrée générique, sans destination imposée -------- */
const HEAD_TRACKER_ACTION = 'head_tracker_engage';
const HEAD_TRACKER_STATE = { active: false, values: {}, deviceId: '', lastTareAt: 0 };

function headTrackerConfig() {
    const input = (CONFIG && CONFIG.input) || {};
    const raw = input.head_tracker || {};
    return {
        enabled: !!raw.enabled,
        device_id: typeof raw.device_id === 'string' ? raw.device_id : '',
        mode: raw.mode === 'always' ? 'always' : 'hold',
        routes: Array.isArray(raw.routes) ? raw.routes : [],
    };
}

function isBobBlAr(pad, configuredId = headTrackerConfig().device_id) {
    if (!pad || !pad.id) return false;
    return configuredId ? pad.id === configuredId : pad.id.toUpperCase().includes('BOB BL AR');
}

function headTrackerPad(pads = padsConnected()) {
    const cfg = headTrackerConfig();
    return pads.find((pad) => isBobBlAr(pad, cfg.device_id)) || null;
}

function padSourceActive(pad, source) {
    if (!pad || !source || (source.pad && source.pad !== pad.id)) return false;
    if (source.type === 'button') {
        const button = pad.buttons[source.index];
        return !!(button && (button.pressed || button.value > 0.5));
    }
    return Math.abs(pad.axes[source.index] || 0) > 0.7;
}

function headTrackerEngaged(pads) {
    const actions = (CONFIG && CONFIG.input && CONFIG.input.gamepad && CONFIG.input.gamepad.actions) || [];
    const engage = actions.find((action) => action && action.id === HEAD_TRACKER_ACTION);
    return !!(engage && pads.some((pad) => padSourcesOf(engage).some((source) => padSourceActive(pad, source))));
}

function publishHeadTrackerInput(active, values, deviceId) {
    HEAD_TRACKER_STATE.active = active;
    HEAD_TRACKER_STATE.values = values;
    HEAD_TRACKER_STATE.deviceId = deviceId || '';
    window.BOBROV_HEAD_TRACKER_INPUT = HEAD_TRACKER_STATE;
    window.dispatchEvent(new CustomEvent('bobrov:head-tracker-input', {
        detail: { active, values: { ...values }, deviceId: HEAD_TRACKER_STATE.deviceId },
    }));
}

/** Lit les axes configurés et les route comme des consignes [-1, +1]. */
function updateHeadTrackerInput(pads = padsConnected()) {
    const cfg = headTrackerConfig();
    const tracker = cfg.enabled ? headTrackerPad(pads) : null;
    const active = !!tracker && (cfg.mode === 'always' || headTrackerEngaged(pads));
    const values = {};
    if (active) {
        cfg.routes.forEach((route) => {
            if (!route || typeof route.action !== 'string') return;
            const raw = tracker.axes[Number(route.axis)] || 0;
            const value = Math.max(-1, Math.min(1, route.invert ? -raw : raw));
            values[route.action] = Math.max(-1, Math.min(1, (values[route.action] || 0) + value));
        });
    }
    publishHeadTrackerInput(active, values, tracker && tracker.id);
    const status = byId('head-status');
    if (status) setText(status, !cfg.enabled ? 'Routage désactivé.'
        : !tracker ? 'BOB BL AR non détecté.'
            : active ? 'Routage actif — valeurs normalisées publiées.' : 'BOB BL AR prêt — en attente du bouton d’activation.');
}

/** Tare BLE : toute magnitude non nulle déclenche l'Output Report BOB BL AR. */
function requestHeadTrackerTare() {
    const now = Date.now();
    if (now - HEAD_TRACKER_STATE.lastTareAt < 250) return;
    const tracker = headTrackerConfig().enabled ? headTrackerPad() : null;
    if (!tracker) { toast('BOB BL AR introuvable — tare non envoyée', 'err'); return; }
    const actuator = tracker.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') {
        toast('BOB BL AR détecté, mais vibrationActuator est indisponible', 'err', 5200);
        return;
    }
    HEAD_TRACKER_STATE.lastTareAt = now;
    try {
        Promise.resolve(actuator.playEffect('dual-rumble', {
            duration: 100, strongMagnitude: 1.0, weakMagnitude: 1.0,
        })).then(() => toast('Tare BOB BL AR envoyée'))
            .catch(() => toast('Échec de l’envoi de la tare BOB BL AR', 'err'));
    } catch (_) {
        toast('Échec de l’envoi de la tare BOB BL AR', 'err');
    }
}

/** Actions du poste exécutables dans le navigateur : id → fonction. */
const PAD_TRIGGERS = {
    rec: () => toggleRecording(false),        // REC brut : flux caméra sans HUD
    rec_view: () => toggleRecording(true),    // REC vue : caméra principale + HUD
    swap_cams: () => swapVideoSources(),      // Permuter : principale ↔ incrustation PIP
    toggle_toolbar: () => {                   // Barre de commandes : replier / déplier
        setToolbarCollapsed(!byId('video-toolbar').classList.contains('collapsed'));
    },
    head_tracker_engage: requestHeadTrackerTare,
};

/** Catalogue des fonctions proposées, groupé pour le tableau de la section.
 *  kind : 'axis' (axe seul), 'button' (bouton seul), 'both' (au choix). */
const PAD_FUNCTIONS = [
    {
        group: 'Déplacements',
        items: [
            { id: 'surge', label: 'Avance / recul', hint: 'Axe du joystick, avant / arrière', kind: 'both' },
            { id: 'sway', label: 'Latéral — gauche / droite', hint: 'Axe du joystick', kind: 'both' },
            { id: 'heave', label: 'Montée / descente', hint: 'Axe du joystick', kind: 'both' },
            { id: 'yaw', label: 'Pivoter — gauche / droite', hint: 'Axe du joystick (cap)', kind: 'both' },
            { id: 'roll', label: 'Roulis (axe)', hint: 'Axe analogique dédié', kind: 'axis' },
            { id: 'pitch', label: 'Tangage (axe)', hint: 'Axe analogique dédié', kind: 'axis' },
        ],
    },
    {
        group: 'Manœuvres par boutons',
        items: [
            { id: 'yaw_left', label: 'Pivoter à gauche', hint: 'Bouton maintenu', kind: 'button' },
            { id: 'yaw_right', label: 'Pivoter à droite', hint: 'Bouton maintenu', kind: 'button' },
            { id: 'roll_left', label: 'Roulis gauche', hint: 'Bouton maintenu', kind: 'button' },
            { id: 'roll_right', label: 'Roulis droite', hint: 'Bouton maintenu', kind: 'button' },
            { id: 'pitch_up', label: 'Tangage — cabrer', hint: 'Bouton maintenu', kind: 'button' },
            { id: 'pitch_down', label: 'Tangage — piquer', hint: 'Bouton maintenu', kind: 'button' },
        ],
    },
    {
        group: 'Armement & sécurité',
        items: [
            { id: 'arm_toggle', label: 'Armer / désarmer', hint: 'Bascule à chaque appui', kind: 'button' },
            { id: 'estop', label: 'Arrêt d\'urgence (E-Stop)', kind: 'button' },
            { id: 'dryrun', label: 'Dry-run (moteurs à vide)', kind: 'button' },
            { id: 'surface', label: 'Retour surface', hint: 'Bouton maintenu', kind: 'button' },
            { id: 'reset', label: 'RAZ de session', kind: 'button' },
        ],
    },
    {
        group: 'Éclairage & captures',
        items: [
            { id: 'light', label: 'Éclairage on / off', kind: 'button' },
            { id: 'rec_view', label: 'Enregistrer la vue (vidéo + HUD)', kind: 'button' },
            { id: 'rec', label: 'Enregistrer la vidéo (sans HUD)', kind: 'button' },
            { id: 'swap_cams', label: 'Permuter les caméras',
              hint: 'Échange caméra principale et PIP', kind: 'button' },
            { id: 'toggle_toolbar', label: 'Replier / déplier la barre de commandes',
              hint: 'Afficher ou masquer les boutons (utile en plein écran)', kind: 'button' },
        ],
    },
    {
        group: 'Head-tracker',
        items: [
            { id: 'head_tracker_engage', label: 'Activer / recentrer le head-tracker BOB BL AR',
              hint: 'Appui : tare matérielle ; maintien : active le routage configuré', kind: 'button' },
        ],
    },
    {
        group: 'Simulateur',
        items: [
            { id: 'pause', label: 'Pause / reprise', hint: 'Sub Simulator', kind: 'button' },
        ],
    },
];

const PAD_ITEMS = new Map();
PAD_FUNCTIONS.forEach((group) => group.items.forEach((item) => PAD_ITEMS.set(item.id, item)));

/** Voies historiques du cockpit → fonctions nommées du catalogue. */
const PAD_LEGACY_IDS = {
    voie1: 'surge', voie2: 'sway', voie3: 'heave',
    voie4: 'yaw', voie5: 'roll', voie6: 'pitch',
};

function padsConnected() {
    return Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean);
}

/** Libellé court d'une manette (suffixe matériel retiré, longueur bornée). */
function padShortLabel(id) {
    if (!id) return 'Toutes les manettes';
    const short = id.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return short.length > 30 ? short.slice(0, 28) + '…' : short;
}

/** Sources d'une action : `sources` (courant) ou `source` (format hérité). */
function padSourcesOf(entry) {
    if (Array.isArray(entry.sources)) return entry.sources;
    return entry.source ? [entry.source] : [];
}

function padCleanSource(source) {
    const out = { type: source.type === 'axis' ? 'axis' : 'button', index: Number(source.index) || 0 };
    out.invert = !!source.invert;
    if (typeof source.pad === 'string' && source.pad) out.pad = source.pad;
    return out;
}

/** Relit config.json : catalogue complet, sources conservées par fonction. */
function buildPadDraft() {
    const gamepad = (CONFIG && CONFIG.input && CONFIG.input.gamepad) || {};
    const stored = Array.isArray(gamepad.actions) ? gamepad.actions : [];
    const byId = new Map();
    stored.forEach((action) => {
        if (!action || typeof action.id !== 'string') return;
        const id = PAD_LEGACY_IDS[action.id] || action.id;
        byId.set(id, {
            label: typeof action.label === 'string' && action.label ? action.label : id,
            sources: padSourcesOf(action).map(padCleanSource),
        });
    });
    padDraft = [];
    PAD_FUNCTIONS.forEach((group) => group.items.forEach((item) => {
        const found = byId.get(item.id);
        padDraft.push({ id: item.id, label: item.label, sources: found ? found.sources : [] });
        byId.delete(item.id);
    }));
    byId.forEach((entry, id) => padDraft.push({ id, label: entry.label, sources: entry.sources }));
}

/** Entrée dans la section : relit la configuration puis affiche le tableau. */
function openPadSection() {
    buildPadDraft();
    renderPadActions();
    renderHeadTrackerSettings();
}

function sourceLabel(source) {
    const kind = source.type === 'axis' ? 'Axe ' + source.index : 'Bouton ' + source.index;
    return kind + (source.invert ? ' · inversé' : '');
}

/** Colonnes du tableau : manettes détectées, manettes déjà associées, « toutes ». */
function padColumns(pads) {
    const columns = [];
    const seen = new Set();
    pads.forEach((pad) => {
        if (seen.has(pad.id)) return;
        seen.add(pad.id);
        columns.push({ key: pad.id, label: padShortLabel(pad.id), connected: true });
    });
    padDraft.forEach((entry) => entry.sources.forEach((source) => {
        if (!source.pad || seen.has(source.pad)) return;
        seen.add(source.pad);
        columns.push({ key: source.pad, label: padShortLabel(source.pad), connected: false });
    }));
    if (!columns.length || padDraft.some((entry) => entry.sources.some((source) => !source.pad))) {
        columns.push({ key: '', label: 'Toutes les manettes', connected: pads.length > 0 });
    }
    return columns;
}

function renderPadActions() {
    if (!padDraft) buildPadDraft();
    const container = byId('pad-actions');
    if (!container) return;
    const pads = padsConnected();
    const columns = padColumns(pads);
    container.innerHTML = '';
    container.style.setProperty('--pad-cols', String(columns.length));
    const head = el('div', 'pad-fn-head');
    head.appendChild(el('span', 'pad-fn-title', 'Fonction'));
    columns.forEach((column) => {
        const cell = el('span', 'pad-fn-col' + (column.key && !column.connected ? ' offline' : ''),
            column.label + (column.key && !column.connected ? ' — hors ligne' : ''));
        if (column.key) cell.title = column.key;
        head.appendChild(cell);
    });
    container.appendChild(head);
    PAD_FUNCTIONS.forEach((group) => {
        container.appendChild(el('div', 'pad-fn-group', group.group));
        group.items.forEach((item) => {
            const action = padDraft.find((entry) => entry.id === item.id);
            if (action) container.appendChild(padFnRow(item, action, columns));
        });
    });
    const extras = padDraft.filter((entry) => !PAD_ITEMS.has(entry.id));
    if (extras.length) {
        container.appendChild(el('div', 'pad-fn-group', 'Autres fonctions du fichier'));
        extras.forEach((action) => container.appendChild(padFnRow(null, action, columns)));
    }
    const hint = byId('pad-capture-hint');
    if (hint) {
        if (padCapture) {
            const action = padDraft.find((entry) => entry.id === padCapture.actionId);
            const item = PAD_ITEMS.get(padCapture.actionId);
            const where = padCapture.padKey ? padShortLabel(padCapture.padKey) : 'toutes les manettes';
            const what = !item || item.kind === 'both' ? 'poussez un axe ou appuyez sur un bouton'
                : item.kind === 'axis' ? 'poussez un axe' : 'appuyez sur un bouton';
            hint.hidden = false;
            hint.textContent = `« ${action ? action.label : padCapture.actionId} » · ${where} : ${what}`
                + ' — enregistrement dès la détection (Échap pour annuler).';
        } else {
            hint.hidden = true;
        }
    }
}

function padFnRow(item, action, columns) {
    const row = el('div', 'pad-fn-row');
    const name = el('span', 'pad-fn-name', item ? item.label : action.label);
    if (item && item.hint) name.appendChild(el('em', 'pad-fn-note', item.hint));
    row.appendChild(name);
    columns.forEach((column) => row.appendChild(padFnCell(action, column.key)));
    return row;
}

function padFnCell(action, padKey) {
    const cell = el('div', 'pad-fn-cell');
    const capturing = !!padCapture && padCapture.actionId === action.id && padCapture.padKey === padKey;
    if (capturing) cell.classList.add('capturing');
    const source = action.sources.find((entry) => (entry.pad || '') === padKey);
    if (source) cell.appendChild(el('span', 'pad-fn-badge', sourceLabel(source)));
    if (capturing) {
        const cancel = el('button', 'btn-mini', 'Annuler');
        cancel.type = 'button';
        cancel.addEventListener('click', endPadCapture);
        cell.appendChild(cancel);
        return cell;
    }
    const assign = el('button', 'btn-mini', source ? 'Changer' : 'Assigner');
    assign.type = 'button';
    assign.addEventListener('click', () => beginPadCapture(action.id, padKey));
    cell.appendChild(assign);
    if (source) {
        const clear = el('button', 'btn-mini warn', '✕');
        clear.type = 'button';
        clear.title = 'Effacer l\'association';
        clear.addEventListener('click', () => clearPadSource(action, padKey));
        cell.appendChild(clear);
    }
    return cell;
}

/* -- Capture : « Assigner » → attente d'un appui ou d'une poussée d'axe ----- */

function beginPadCapture(actionId, padKey) {
    if (padCapture && padCapture.actionId === actionId && padCapture.padKey === padKey) {
        endPadCapture();
        return;
    }
    if (!navigator.getGamepads) { toast('Gamepad API non supportée par ce navigateur', 'err'); return; }
    const pads = padsConnected();
    if (!pads.length) { toast('Aucune manette détectée — allumez-la et appuyez sur un bouton', 'err'); return; }
    const targets = padKey ? pads.filter((pad) => pad.id === padKey) : pads;
    if (!targets.length) {
        toast('Manette non connectée — rebranchez-la puis réessayez', 'err');
        return;
    }
    if (padCapture) endPadCapture();
    padCapture = { actionId, padKey: padKey || '', pads: new Map() };
    targets.forEach((pad) => padCapture.pads.set(pad.id, padRestState(pad)));
    renderPadActions();
    clearInterval(padCaptureTimer);
    padCaptureTimer = setInterval(captureGamepadStep, 90);
    if (navigator.vibrate) navigator.vibrate(10);
}

/** Référence au repos : positions d'axes et boutons déjà enfoncés (ignorés). */
function padRestState(pad) {
    return {
        axes: Array.from(pad.axes, (value) => (Number.isFinite(value) ? value : 0)),
        buttons: Array.from(pad.buttons, (button) => !!(button && (button.pressed || button.value > 0.5))),
    };
}

function endPadCapture() {
    padCapture = null;
    clearInterval(padCaptureTimer);
    padCaptureTimer = 0;
    renderPadActions();
}

/** Scrute la manette visée : poussée d'axe (> 0,5 depuis le repos) ou bouton neuf. */
function captureGamepadStep() {
    if (!padCapture) return;
    const pads = padsConnected();
    if (padCapture.padKey && !pads.some((pad) => pad.id === padCapture.padKey)) {
        endPadCapture();
        toast('Manette débranchée — association annulée', 'err');
        return;
    }
    for (const pad of pads) {
        if (padCapture.padKey && pad.id !== padCapture.padKey) continue;
        let rest = padCapture.pads.get(pad.id);
        if (!rest) {
            rest = padRestState(pad);
            padCapture.pads.set(pad.id, rest);
        }
        const item = PAD_ITEMS.get(padCapture.actionId);
        const kind = item ? item.kind : 'both';
        if (kind !== 'button') {
            for (let index = 0; index < pad.axes.length; index += 1) {
                const value = Number.isFinite(pad.axes[index]) ? pad.axes[index] : 0;
                const origin = rest.axes[index] || 0;
                if (Math.abs(value - origin) > 0.5) {
                    assignPadSource(pad, { type: 'axis', index, invert: value < origin });
                    return;
                }
            }
        }
        if (kind !== 'axis') {
            for (let index = 0; index < pad.buttons.length; index += 1) {
                const button = pad.buttons[index];
                if (!button || rest.buttons[index]) continue;      // bouton enfoncé avant la capture
                if (button.pressed || button.value > 0.5) {
                    assignPadSource(pad, { type: 'button', index });
                    return;
                }
            }
        }
    }
}

function assignPadSource(pad, source) {
    const action = padDraft && padDraft.find((entry) => entry.id === padCapture.actionId);
    if (!action) { endPadCapture(); return; }
    const key = padCapture.padKey;                                   // '' = toutes les manettes
    const next = { type: source.type, index: source.index, invert: !!source.invert };
    if (key) next.pad = pad.id;
    action.sources = action.sources.filter((entry) => (entry.pad || '') !== key);
    action.sources.push(next);
    endPadCapture();
    const where = key ? ' · ' + padShortLabel(key) : '';
    toast(`« ${action.label} » → ${sourceLabel(next)}${where}`);
    saveGamepad(true);                                               // enregistrement immédiat
}

function clearPadSource(action, padKey) {
    action.sources = action.sources.filter((entry) => (entry.pad || '') !== padKey);
    renderPadActions();
    saveGamepad(true);
}

async function saveGamepad(silent) {
    if (!padDraft) return false;
    const actions = padDraft.map((entry) => ({
        id: entry.id,
        label: entry.label,
        sources: entry.sources.map((source) => {
            const out = { type: source.type, index: source.index, invert: !!source.invert };
            if (source.pad) out.pad = source.pad;
            return out;
        }),
    }));
    try {
        await patchConfig({ input: { gamepad: { enabled: true, actions } } });
        if (!silent) toast('Associations des manettes enregistrées');
        return true;
    } catch (error) {
        toast('Enregistrement refusé : ' + error.message, 'err', 5200);
        return false;
    }
}

function scanGamepads(quiet) {
    const list = byId('pad-list');
    if (!list) return;
    const pads = padsConnected();
    list.innerHTML = '';
    if (!pads.length) {
        list.appendChild(el('p', 'hint', 'Aucune manette détectée — branchez-la puis appuyez sur un bouton pour la réveiller.'));
    } else {
        pads.forEach((pad) => {
            const item = el('div', 'device-item');
            item.appendChild(el('span', 'dev-name', padShortLabel(pad.id) || ('Manette ' + pad.index)));
            item.appendChild(el('span', 'dev-path', '#' + pad.index));
            item.appendChild(el('span', 'dev-meta', pad.buttons.length + ' boutons · '
                + pad.axes.length + ' axes · ' + (pad.mapping || 'mapping inconnu')));
            list.appendChild(item);
        });
    }
    renderPadActions();                                  // colonnes = manettes connectées
    renderHeadTrackerSettings();
    if (!quiet) toast(pads.length + ' manette(s) détectée(s)');
}

/* -- Lecture des manettes : déclenchement des actions du poste -------------- */

let padReaderTimer = 0;
const padPrevState = new Map();

function padReaderSources() {
    const actions = (CONFIG && CONFIG.input && CONFIG.input.gamepad && CONFIG.input.gamepad.actions) || [];
    return actions.filter((action) => action && PAD_TRIGGERS[action.id] && padSourcesOf(action).length);
}

/** Front montant d'un bouton ou d'un axe assigné → déclenche l'action du poste. */
function padReaderStep() {
    if (padCapture || !navigator.getGamepads) return;   // assignation en cours : muet
    const pads = padsConnected();
    updateHeadTrackerInput(pads);
    const sources = padReaderSources();
    if (!sources.length) return;
    pads.forEach((pad) => {
        sources.forEach((action) => {
            let active = false;
            padSourcesOf(action).forEach((source) => {
                if (source.pad && source.pad !== pad.id) return;
                if (source.type === 'button') {
                    const button = pad.buttons[source.index];
                    if (button && (button.pressed || button.value > 0.5)) active = true;
                } else if (Math.abs(pad.axes[source.index] || 0) > 0.7) {
                    active = true;
                }
            });
            const key = action.id + ':' + pad.id;
            const was = padPrevState.get(key) || false;
            padPrevState.set(key, active);
            if (active && !was) PAD_TRIGGERS[action.id]();
        });
    });
}

/** Branchement/débranchement : met à jour la liste et les colonnes du tableau. */
function refreshPadSection() {
    const section = byId('section-manette');
    if (!section || section.style.display !== 'block') return;
    scanGamepads(true);
}

function startPadReader() {
    if (!navigator.getGamepads) return;
    clearInterval(padReaderTimer);
    padReaderTimer = setInterval(padReaderStep, 90);
    window.addEventListener('gamepadconnected', refreshPadSection);
    window.addEventListener('gamepaddisconnected', refreshPadSection);
}

/* -- Test manette : dessins temps réel (DUALSHOCK 4 + BOB BL AR) ------------ */

const PAD_TEST = {
    raf: 0,
    frame: 0,
    built: '',                 // signature du câblage DOM (barres, LEDs, sélecteurs)
    map: { roll: 0, pitch: 1, yaw: 2, button: 0 },
};

/** Manette standard (PlayStation) et manette au mapping inconnu (BOB BL AR). */
function padTestPads() {
    const pads = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean);
    const ps = pads.find((pad) => pad.mapping === 'standard' && pad.buttons.length >= 12) || null;
    const rov = headTrackerPad(pads);
    return { ps, rov };
}

function padTestLoop() {
    PAD_TEST.raf = 0;
    const section = byId('section-manette');
    if (!section || section.style.display !== 'block') return;   // section fermée : extinction
    PAD_TEST.raf = requestAnimationFrame(padTestLoop);
    PAD_TEST.frame += 1;
    if (PAD_TEST.frame % 2) return;                              // ~30 im/s
    const { ps, rov } = padTestPads();
    padTestBuild(ps, rov);
    padTestSync(ps, rov);
    padDrawPs4(ps);
    padDrawRov(rov);
}

function startPadTest() {
    if (!PAD_TEST.raf) PAD_TEST.raf = requestAnimationFrame(padTestLoop);
}

/** Barre d'axe : libellé + remplissage bidirectionnel depuis le centre + valeur. */
function padAxisRow(label, id) {
    const row = el('div', 'pad-axis');
    row.appendChild(el('span', 'pad-axis-label', label));
    const bar = el('div', 'pad-axis-bar');
    const fill = el('div', 'pad-axis-fill');
    fill.id = id + '-fill';
    bar.appendChild(fill);
    row.appendChild(bar);
    const value = el('span', 'pad-axis-val', '0.00');
    value.id = id + '-val';
    row.appendChild(value);
    return row;
}

function padAxisUpdate(id, value) {
    const fill = byId(id + '-fill');
    if (!fill) return;
    const magnitude = Math.min(1, Math.abs(value));
    fill.style.left = (value < 0 ? 50 - magnitude * 50 : 50) + '%';
    fill.style.width = magnitude * 50 + '%';
    const label = byId(id + '-val');
    if (label) setText(label, (value >= 0 ? '+' : '') + value.toFixed(2));
}

/** (Re)construit barres, LEDs et sélecteurs quand les manettes changent. */
function padTestBuild(ps, rov) {
    const signature = (ps ? 'ps' + ps.axes.length + '/' + ps.buttons.length : 'ps0')
        + '|' + (rov ? 'rov' + rov.axes.length + '/' + rov.buttons.length : 'rov0');
    if (PAD_TEST.built === signature) return;
    PAD_TEST.built = signature;

    const psLabels = ['LX', 'LY', 'RX', 'RY'];   // mapping standard
    const psHost = byId('pad-ps-axes');
    psHost.innerHTML = '';
    const psCount = Math.max(4, ps ? ps.axes.length : 0);
    for (let i = 0; i < psCount; i += 1) psHost.appendChild(padAxisRow(psLabels[i] || 'Axe ' + i, 'psax' + i));

    const psBtnHost = byId('pad-ps-btns');
    psBtnHost.innerHTML = '';
    const psBtnCount = Math.max(18, ps ? ps.buttons.length : 0);   // DUALSHOCK 4 : 18 boutons
    for (let i = 0; i < psBtnCount; i += 1) {
        const led = el('span', 'pad-led');
        led.appendChild(el('i'));
        led.appendChild(document.createTextNode('Bouton ' + i));
        led.id = 'psled' + i;
        psBtnHost.appendChild(led);
    }

    const rovHost = byId('pad-rov-axes');
    rovHost.innerHTML = '';
    const rovCount = Math.max(1, rov ? rov.axes.length : 6);
    for (let i = 0; i < rovCount; i += 1) rovHost.appendChild(padAxisRow('Axe ' + i, 'rovax' + i));

    const btnHost = byId('pad-rov-btns');
    btnHost.innerHTML = '';
    const btnCount = Math.max(1, rov ? rov.buttons.length : 2);
    for (let i = 0; i < btnCount; i += 1) {
        const led = el('span', 'pad-led');
        led.appendChild(el('i'));
        led.appendChild(document.createTextNode('Bouton ' + i));
        led.id = 'rovled' + i;
        btnHost.appendChild(led);
    }

    ['roll', 'pitch', 'yaw'].forEach((key) => {
        const select = byId('pad-map-' + key);
        select.innerHTML = '';
        for (let i = 0; i < rovCount; i += 1) select.appendChild(new Option('Axe ' + i, String(i)));
        PAD_TEST.map[key] = Math.min(PAD_TEST.map[key], rovCount - 1);
        select.value = String(PAD_TEST.map[key]);
    });
    const buttonSelect = byId('pad-map-button');
    buttonSelect.innerHTML = '';
    for (let i = 0; i < btnCount; i += 1) buttonSelect.appendChild(new Option('Bouton ' + i, String(i)));
    PAD_TEST.map.button = Math.min(PAD_TEST.map.button, btnCount - 1);
    buttonSelect.value = String(PAD_TEST.map.button);
}

/** États « connectée », barres d'axes et LEDs boutons à chaque image. */
function padTestSync(ps, rov) {
    const livePs = byId('pad-ps-live');
    setText(livePs, ps ? 'connectée' : 'non connectée');
    livePs.classList.toggle('on', !!ps);
    const liveRov = byId('pad-rov-live');
    setText(liveRov, rov ? 'connectée' : 'non connectée');
    liveRov.classList.toggle('on', !!rov);

    for (let i = 0; i < Math.max(4, ps ? ps.axes.length : 0); i += 1) {
        padAxisUpdate('psax' + i, (ps && ps.axes[i]) || 0);
    }
    for (let i = 0; i < Math.max(18, ps ? ps.buttons.length : 0); i += 1) {
        const led = byId('psled' + i);
        if (led) led.classList.toggle('on', padButtonDown(ps, i));
    }
    if (rov) {
        rov.axes.forEach((value, index) => padAxisUpdate('rovax' + index, value || 0));
        rov.buttons.forEach((button, index) => {
            const led = byId('rovled' + index);
            if (led) led.classList.toggle('on', !!(button && (button.pressed || button.value > 0.5)));
        });
    } else {
        for (let i = 0; i < 6; i += 1) padAxisUpdate('rovax' + i, 0);
        for (let i = 0; i < 2; i += 1) {
            const led = byId('rovled' + i);
            if (led) led.classList.remove('on');
        }
    }
}

/** Actions analogiques disponibles comme cibles d'un axe head-tracker. */
function headTrackerAxisActions() {
    return PAD_FUNCTIONS.flatMap((group) => group.items)
        .filter((item) => item.kind === 'axis' || item.kind === 'both');
}

function headTrackerSettingsForm() {
    const routes = Array.from(byId('head-routes').querySelectorAll('[data-head-route]')).map((row) => ({
        axis: Number(row.querySelector('[data-head-axis]').value) || 0,
        action: row.querySelector('[data-head-action]').value,
        invert: row.querySelector('[data-head-invert]').checked,
    })).filter((route) => route.action);
    return {
        enabled: byId('head-enabled').checked,
        device_id: byId('head-device').value,
        mode: byId('head-mode').value === 'always' ? 'always' : 'hold',
        routes,
    };
}

function headTrackerRouteRow(route, axisCount) {
    const row = el('div', 'settings-grid');
    row.dataset.headRoute = '1';
    const axis = document.createElement('select');
    axis.dataset.headAxis = '1';
    for (let index = 0; index < axisCount; index += 1) axis.add(new Option('Axe BOB ' + index, String(index)));
    axis.value = String(Math.min(Math.max(0, Number(route.axis) || 0), axisCount - 1));
    const action = document.createElement('select');
    action.dataset.headAction = '1';
    headTrackerAxisActions().forEach((item) => action.add(new Option(item.label, item.id)));
    action.value = route.action;
    const invert = document.createElement('input');
    invert.type = 'checkbox';
    invert.className = 'switch';
    invert.dataset.headInvert = '1';
    invert.checked = !!route.invert;
    const remove = el('button', 'btn btn-mini warn', 'Retirer');
    remove.type = 'button';
    remove.addEventListener('click', () => row.remove());
    const axisLabel = el('label'); axisLabel.append('Axe BOB ', axis);
    const actionLabel = el('label'); actionLabel.append('Action analogique ', action);
    const invertLabel = el('label', 'switch-label', 'Inverser '); invertLabel.appendChild(invert);
    row.append(axisLabel, actionLabel, invertLabel, remove);
    return row;
}

function renderHeadTrackerSettings(settingsOverride) {
    const cfg = settingsOverride || headTrackerConfig();
    const pads = padsConnected();
    const tracker = headTrackerPad(pads);
    const device = byId('head-device');
    if (!device) return;
    const candidates = pads.filter((pad) => isBobBlAr(pad, '') || pad.id === cfg.device_id);
    device.innerHTML = '';
    device.add(new Option('Détection automatique (BOB BL AR)', ''));
    candidates.forEach((pad) => device.add(new Option(padShortLabel(pad.id), pad.id)));
    if (cfg.device_id && !Array.from(device.options).some((option) => option.value === cfg.device_id)) {
        device.add(new Option(padShortLabel(cfg.device_id) + ' — hors ligne', cfg.device_id));
    }
    device.value = cfg.device_id;
    byId('head-enabled').checked = cfg.enabled;
    byId('head-mode').value = cfg.mode;
    const host = byId('head-routes');
    host.innerHTML = '';
    const axisCount = Math.max(1, tracker ? tracker.axes.length : 6);
    cfg.routes.forEach((route) => host.appendChild(headTrackerRouteRow(route, axisCount)));
}

/** Prépare un canvas de test (taille CSS × DPR) et retourne contexte + dimensions. */
function padCanvasFit(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
}

function padRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** Initialisation des sélecteurs d'axes de la vue ROV. */
function initPadTest() {
    ['roll', 'pitch', 'yaw', 'button'].forEach((key) => {
        byId('pad-map-' + key).addEventListener('change', (event) => {
            PAD_TEST.map[key] = Number(event.target.value) || 0;
        });
    });
}

/** Valeur d'axe bornée à [-1, 1] (0 si la manette ou l'axe manque). */
function padAxisValue(pad, index) {
    const value = (pad && pad.axes[index]) || 0;
    return Math.max(-1, Math.min(1, value));
}

/** État analogique d'un bouton (course des gâchettes L2/R2 incluse). */
function padButtonLevel(pad, index) {
    const button = pad && pad.buttons[index];
    if (!button) return 0;
    return Math.max(button.pressed ? 1 : 0, Math.min(1, button.value || 0));
}

/** Bouton considéré appuyé : pressé ou valeur analogique > 50 %. */
function padButtonDown(pad, index) {
    return padButtonLevel(pad, index) > 0.5;
}

/** Pastille de bouton (L1/R1, Share/Options) : s'illumine à l'appui. */
function padPill(c, x, y, w, h, label, on, color) {
    c.save();
    hudGlow(c, on, color, 10);
    padRoundRect(c, x, y, w, h, h / 2);
    c.fillStyle = on ? color : 'rgba(255, 255, 255, 0.06)';
    c.globalAlpha = on ? 0.85 : 1;
    c.fill();
    c.globalAlpha = 1;
    c.strokeStyle = on ? color : 'rgba(140, 180, 205, 0.45)';
    c.lineWidth = 1.2;
    c.stroke();
    hudText(c, label, x + w / 2, y + h / 2 + 0.5, 8.5, 'center', on ? '#04121a' : 'rgba(190, 220, 235, 0.75)');
    c.restore();
}

/** Gâchette basse (L2/R2) : rail vertical rempli selon la course 0 → 1. */
function padTriggerGauge(c, x, y, h, level, label, color) {
    const w = 13;
    c.save();
    padRoundRect(c, x - w / 2, y, w, h, 6);
    c.fillStyle = 'rgba(255, 255, 255, 0.05)';
    c.fill();
    c.strokeStyle = 'rgba(140, 180, 205, 0.45)';
    c.lineWidth = 1.2;
    c.stroke();
    const filled = h * Math.max(0, Math.min(1, level));
    if (filled > 2) {
        hudGlow(c, true, color, 8);
        padRoundRect(c, x - w / 2 + 3, y + h - filled + 3, w - 6, Math.max(2, filled - 6), 3);
        c.fillStyle = color;
        c.globalAlpha = 0.75 + 0.25 * Math.min(1, level);
        c.fill();
        c.globalAlpha = 1;
    }
    hudText(c, label, x, y + h + 10, 8.5, 'center', 'rgba(190, 220, 235, 0.8)');
    c.restore();
}

/** Croix directionnelle : chaque bras s'allume seul (12 haut, 13 bas, 14 gauche, 15 droite). */
function padDpad(c, cx, cy, up, down, left, right, color) {
    const arm = 8;
    const size = 26;
    const rects = [
        [cx - arm, cy - size, arm * 2, size],
        [cx - size, cy - arm, size, arm * 2],
        [cx, cy - arm, size, arm * 2],
        [cx - arm, cy, arm * 2, size],
    ];
    const states = [up, left, right, down];
    c.save();
    rects.forEach((rect, index) => {
        const on = states[index];
        hudGlow(c, on, color, 10);
        padRoundRect(c, rect[0], rect[1], rect[2], rect[3], 3);
        c.fillStyle = on ? color : 'rgba(255, 255, 255, 0.07)';
        c.globalAlpha = on ? 0.9 : 1;
        c.fill();
        c.globalAlpha = 1;
        hudGlow(c, false);
        c.strokeStyle = 'rgba(140, 180, 205, 0.4)';
        c.lineWidth = 1;
        c.stroke();
    });
    c.restore();
}

/** Bouton rond (face, PS) : symbole coloré qui s'illumine à l'appui. */
function padFaceButton(c, cx, cy, r, symbol, on, color, size = 12) {
    c.save();
    hudGlow(c, on, color, 14);
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = on ? color : 'rgba(255, 255, 255, 0.06)';
    c.globalAlpha = on ? 0.9 : 1;
    c.fill();
    c.globalAlpha = 1;
    c.strokeStyle = on ? color : 'rgba(140, 180, 205, 0.5)';
    c.lineWidth = 1.3;
    c.stroke();
    hudText(c, symbol, cx, cy + 0.5, size, 'center', on ? '#04121a' : color);
    c.restore();
}

/** Stick analogique : capuchon mobile (course ±8) + clic L3/R3. */
function padStick(c, cx, cy, x, y, radius, pressed, color) {
    const travel = 8;
    const px = cx + x * travel;
    const py = cy + y * travel;
    c.save();
    c.beginPath();
    c.arc(cx, cy, radius, 0, Math.PI * 2);
    c.fillStyle = 'rgba(0, 0, 0, 0.35)';
    c.fill();
    c.strokeStyle = 'rgba(140, 180, 205, 0.5)';
    c.lineWidth = 1.3;
    c.stroke();
    c.strokeStyle = 'rgba(140, 180, 205, 0.22)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(cx - radius + 3, cy);
    c.lineTo(cx + radius - 3, cy);
    c.moveTo(cx, cy - radius + 3);
    c.lineTo(cx, cy + radius - 3);
    c.stroke();
    hudGlow(c, pressed || Math.abs(x) + Math.abs(y) > 0.05, color, 12);
    c.beginPath();
    c.arc(px, py, radius * 0.56, 0, Math.PI * 2);
    c.fillStyle = pressed ? color : '#1d3341';
    c.fill();
    c.strokeStyle = color;
    c.lineWidth = 1.4;
    c.stroke();
    c.restore();
}

/** Silhouette de la DUALSHOCK 4 (repère 320 × 220). */
const PS4_SHELL = 'M 70,62 Q 70,30 160,30 Q 250,30 250,62 L 250,78 C 250,120 244,150 226,168'
    + ' C 208,185 182,182 172,160 C 166,148 164,138 160,130 C 156,138 154,148 148,160'
    + ' C 138,182 112,185 94,168 C 76,150 70,120 70,78 Z';

/** Manette PlayStation : coque, sticks, croix, boutons de face et gâchettes en direct. */
function padDrawPs4(pad) {
    const canvas = byId('pad-ps-canvas');
    if (!canvas) return;
    const { ctx, w, h } = padCanvasFit(canvas);
    hudFont = 1;   // les libellés du test manette ne suivent pas la taille de texte du HUD
    const scale = Math.min(w / 320, h / 220);
    ctx.setTransform(scale, 0, 0, scale, (w - 320 * scale) / 2, (h - 220 * scale) / 2);
    ctx.lineCap = 'round';
    const dim = !pad;
    const down = (index) => padButtonDown(pad, index);
    const level = (index) => padButtonLevel(pad, index);

    // Coque
    const shell = new Path2D(PS4_SHELL);
    ctx.fillStyle = dim ? '#101a23' : '#16222e';
    ctx.fill(shell);
    ctx.strokeStyle = dim ? 'rgba(140, 180, 205, 0.25)' : 'rgba(140, 180, 205, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke(shell);

    // Gâchettes : pastilles L1/R1 et jauges de course L2/R2
    padPill(ctx, 86, 16, 50, 15, 'L1', down(4), '#ffb300');
    padPill(ctx, 184, 16, 50, 15, 'R1', down(5), '#ffb300');
    padTriggerGauge(ctx, 40, 62, 66, level(6), 'L2', '#ffb300');
    padTriggerGauge(ctx, 280, 62, 66, level(7), 'R2', '#ffb300');

    // Croix directionnelle
    padDpad(ctx, 105, 88, down(12), down(13), down(14), down(15), '#9fb6c9');

    // Boutons de face : △ 3, ○ 1, ✕ 0, □ 2 (mapping standard)
    padFaceButton(ctx, 210, 60, 12, '△', down(3), '#45d6a5');
    padFaceButton(ctx, 236, 86, 12, '○', down(1), '#f4657e');
    padFaceButton(ctx, 210, 112, 12, '✕', down(0), '#6fb8f2');
    padFaceButton(ctx, 186, 88, 12, '□', down(2), '#e58fc0');

    // Zone tactile (17), Share (8), Options (9), bouton PS (16)
    ctx.save();
    hudGlow(ctx, down(17), HUD_COLOR, 12);
    padRoundRect(ctx, 136, 66, 34, 26, 5);
    ctx.fillStyle = down(17) ? 'rgba(0, 217, 255, 0.32)' : 'rgba(255, 255, 255, 0.05)';
    ctx.fill();
    ctx.strokeStyle = down(17) ? HUD_COLOR : 'rgba(140, 180, 205, 0.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
    padPill(ctx, 116, 64, 16, 10, 'S', down(8), '#9fb6c9');
    padPill(ctx, 174, 64, 16, 10, 'O', down(9), '#9fb6c9');
    padFaceButton(ctx, 160, 122, 9, 'PS', down(16), '#9fb6c9', 7);

    // Sticks analogiques (axes 0/1 et 2/3, clics L3 10 et R3 11)
    padStick(ctx, 104, 146, padAxisValue(pad, 0), padAxisValue(pad, 1), 21, down(10), HUD_COLOR);
    padStick(ctx, 216, 146, padAxisValue(pad, 2), padAxisValue(pad, 3), 21, down(11), HUD_COLOR);
}

/** Vue ROV (BOB BL AR) : boule roulis/tangage, curseur de cap, voyant bouton. */
function padDrawRov(pad) {
    const canvas = byId('pad-rov-canvas');
    if (!canvas) return;
    const { ctx, w, h } = padCanvasFit(canvas);
    hudFont = 1;   // les libellés du test manette ne suivent pas la taille de texte du HUD
    const scale = Math.min(w / 320, h / 200);
    ctx.setTransform(scale, 0, 0, scale, (w - 320 * scale) / 2, (h - 200 * scale) / 2);
    ctx.lineCap = 'round';
    const dim = !pad;
    const roll = pad ? padAxisValue(pad, PAD_TEST.map.roll) : 0;
    const pitch = pad ? padAxisValue(pad, PAD_TEST.map.pitch) : 0;
    const yaw = pad ? padAxisValue(pad, PAD_TEST.map.yaw) : 0;
    const buttonOn = pad ? padButtonDown(pad, PAD_TEST.map.button) : false;

    // Carré roulis / tangage : grille, axes médians et boule mobile
    ctx.save();
    padRoundRect(ctx, 18, 18, 144, 144, 10);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.fill();
    ctx.strokeStyle = dim ? 'rgba(140, 180, 205, 0.3)' : 'rgba(140, 180, 205, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(140, 180, 205, 0.16)';
    [66, 114].forEach((v) => {
        ctx.beginPath();
        ctx.moveTo(v, 20);
        ctx.lineTo(v, 160);
        ctx.moveTo(20, v);
        ctx.lineTo(160, v);
        ctx.stroke();
    });
    ctx.strokeStyle = 'rgba(140, 180, 205, 0.38)';
    ctx.beginPath();
    ctx.moveTo(90, 20);
    ctx.lineTo(90, 160);
    ctx.moveTo(20, 90);
    ctx.lineTo(160, 90);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(90, 90, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(140, 180, 205, 0.55)';
    ctx.fill();
    ctx.restore();

    ctx.save();
    hudGlow(ctx, !dim && Math.abs(roll) + Math.abs(pitch) > 0.02, HUD_COLOR, 16);
    ctx.beginPath();
    ctx.arc(90 + roll * 56, 90 + pitch * 56, 11, 0, Math.PI * 2);
    ctx.fillStyle = HUD_COLOR;
    ctx.globalAlpha = dim ? 0.25 : 0.92;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = HUD_COLOR;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    // Curseur de cap : rail horizontal, repères quart et centre
    ctx.save();
    hudText(ctx, 'CAP', 18, 168, 9, 'left', 'rgba(190, 220, 235, 0.8)');
    hudText(ctx, (yaw >= 0 ? '+' : '') + yaw.toFixed(2), 41, 168, 9, 'left',
        dim ? 'rgba(140, 180, 205, 0.55)' : HUD_COLOR);
    padRoundRect(ctx, 18, 176, 284, 10, 5);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140, 180, 205, 0.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(140, 180, 205, 0.3)';
    [89, 231].forEach((x) => {
        ctx.beginPath();
        ctx.moveTo(x, 173);
        ctx.lineTo(x, 189);
        ctx.stroke();
    });
    ctx.strokeStyle = 'rgba(140, 180, 205, 0.7)';
    ctx.beginPath();
    ctx.moveTo(160, 171);
    ctx.lineTo(160, 191);
    ctx.stroke();
    hudGlow(ctx, !dim && Math.abs(yaw) > 0.02, HUD_COLOR, 14);
    ctx.beginPath();
    ctx.arc(160 + yaw * 132, 181, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = HUD_COLOR;
    ctx.globalAlpha = dim ? 0.25 : 0.95;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = HUD_COLOR;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Voyant du bouton sélectionné
    const onColor = '#2ee6a8';
    ctx.save();
    hudGlow(ctx, buttonOn, onColor, 18);
    ctx.beginPath();
    ctx.arc(239, 46, 17, 0, Math.PI * 2);
    ctx.fillStyle = buttonOn ? onColor : 'rgba(255, 255, 255, 0.05)';
    ctx.globalAlpha = buttonOn ? 0.95 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = buttonOn ? onColor : 'rgba(140, 180, 205, 0.45)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
    hudText(ctx, buttonOn ? 'APPUYÉ' : 'REPOS', 239, 74, 9, 'center',
        buttonOn ? onColor : 'rgba(190, 220, 235, 0.7)');
    hudText(ctx, 'Bouton ' + PAD_TEST.map.button, 239, 88, 9, 'center', 'rgba(140, 180, 205, 0.75)');

    // Valeurs numériques : roulis, tangage, cap
    [['Roulis', roll, 116], ['Tangage', pitch, 134], ['Cap', yaw, 152]].forEach((row) => {
        hudText(ctx, row[0], 176, row[2], 10, 'left', 'rgba(190, 220, 235, 0.75)');
        hudText(ctx, (row[1] >= 0 ? '+' : '') + row[1].toFixed(2), 302, row[2], 10, 'right',
            Math.abs(row[1]) > 0.02 ? HUD_COLOR : 'rgba(140, 180, 205, 0.55)');
    });
}

/* -- Câblage des contrôles -------------------------------------------------- */

function bindSlider(inputId, outputId, format = (v) => v) {
    byId(inputId).addEventListener('input', () => setText(byId(outputId), format(byId(inputId).value)));
}

function initSettingsButtons() {
    // Curseurs : valeur affichée en direct
    bindSlider('in-deadzone', 'in-deadzone-val', (v) => Number(v).toFixed(2));
    bindSlider('in-expo', 'in-expo-val', (v) => Number(v).toFixed(1));
    bindSlider('in-maxspeed', 'in-maxspeed-val');
    bindSlider('cam1-quality', 'cam1-quality-val');
    bindSlider('cam2-quality', 'cam2-quality-val');

    // Caméras : cascade + enregistrement
    ['cam1', 'cam2'].forEach((cam) => {
        byId(cam + '-device').addEventListener('change', () => fillResolutions(cam));
        byId(cam + '-resolution').addEventListener('change', () => { fillFps(cam); updateCamDeviceInfo(cam); });
    });
    byId('btn-cameras-save').addEventListener('click', saveCameras);

    // Manettes & IMU
    byId('btn-controls-save').addEventListener('click', saveControls);

    // Réseau
    byId('btn-network-save').addEventListener('click', saveNetwork);
    byId('btn-copy-url').addEventListener('click', copyCockpitUrl);

    // Lunettes AR
    byId('btn-glasses-save').addEventListener('click', saveGlasses);

    // Interface (le commutateur de thème s'applique et se persiste en direct)
    byId('btn-ui-save').addEventListener('click', saveInterface);
    byId('ui-theme-dark').addEventListener('change', (event) => {
        applyTheme(event.target.checked ? 'dark' : 'light', { server: true });
    });

    // Enregistrement (COCKPIT → carte « Enregistrement »)
    bindSlider('rec-bitrate', 'rec-bitrate-val', (v) => v + ' Mbit/s');
    bindSlider('rec-quality', 'rec-quality-val', (v) => v + ' %');
    byId('btn-rec-save').addEventListener('click', saveRecording);

    // Config Cockpit (disposition des flux enregistrée dans config.json)
    byId('btn-pip-apply').addEventListener('click', saveCockpitLayout);

    // Réseau WiFi (nmcli côté Pi)
    byId('btn-wifi-scan').addEventListener('click', scanWifi);
    byId('btn-lan-only').addEventListener('click', lanOnly);

    // Manette (Gamepad API)
    byId('btn-pad-scan').addEventListener('click', scanGamepads);
    byId('btn-pad-save').addEventListener('click', saveGamepad);
    byId('btn-head-route-add').addEventListener('click', () => {
        const draft = headTrackerSettingsForm();
        const tracker = headTrackerPad();
        const axisCount = Math.max(1, tracker ? tracker.axes.length : 6);
        draft.routes.push({ axis: 0, action: 'yaw', invert: false });
        renderHeadTrackerSettings(draft);
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && padCapture) endPadCapture(); });

    // Sub Simulator
    byId('sim-enabled').addEventListener('change', renderSimState);
    byId('btn-sim-save').addEventListener('click', saveSimulator);
    byId('btn-sim-open-config').addEventListener('click', () => showSection('section-sim-config', 'parameters'));

    // Système
    byId('btn-sys-refresh').addEventListener('click', async () => {
        await pollSystem();
        renderSystemSection();
        lastNetworkSig = '';
        renderNetworkAddresses();
        toast('État actualisé');
    });
    byId('btn-sys-restart').addEventListener('click', () => {
        if (!window.confirm('Relancer le service du cockpit ?\nCoupure d’environ 3 s — la page se reconnectera automatiquement.')) return;
        runMaintenance('/api/system/restart', { title: 'RELANCE DU COCKPIT', deadlineS: 60 });
    });
    byId('btn-sys-reboot').addEventListener('click', () => {
        if (!window.confirm('Redémarrer tout le Raspberry Pi ?\nLe cockpit sera indisponible environ une minute (caméras et liaison série comprises).')) return;
        runMaintenance('/api/system/reboot', { title: 'REDÉMARRAGE DU PI', deadlineS: 240 });
    });
    byId('btn-sys-overlay-reload').addEventListener('click', () => location.reload());
}

/* =========================================================================
 * 8. MÉDIATHÈQUE « MES VIDÉOS » — liste (photos + vidéos), sélection,
 *    lecteur, notes et étoiles
 * ========================================================================= */

let mediaList = [];
const MEDIA_BY_NAME = new Map();
const THUMB_CACHE = new Map();       // dataURL des vignettes vidéo (durée de la session)
const selectedNames = new Set();     // noms cochés dans la liste
let currentMediaName = null;
let thumbObserver = null;
let savedTimer = null;

function mediaUrl(name) {
    return '/api/videos/file/' + encodeURIComponent(name);
}

async function loadVideos() {
    const data = await getJSON('/api/videos');
    mediaList = data.items || [];
    MEDIA_BY_NAME.clear();
    mediaList.forEach((item) => MEDIA_BY_NAME.set(item.name, item));
    Array.from(selectedNames).forEach((name) => {
        if (!MEDIA_BY_NAME.has(name)) selectedNames.delete(name);   // média disparu du dossier
    });
    if (data.folder) setText(byId('videos-folder-info'), data.folder);
    renderVideos();
}

/** Liste filtrée (recherche + étoiles + type) puis triée selon la barre d'outils. */
function filteredVideos() {
    const search = byId('videos-search').value.trim().toLowerCase();
    const minStars = Number(byId('videos-filter-stars').value) || 0;
    const kind = byId('videos-filter-kind').value;
    const sort = byId('videos-sort').value;
    const items = mediaList.filter((item) => {
        if (search && !item.name.toLowerCase().includes(search)) return false;
        if (kind !== 'all' && (item.kind || 'video') !== kind) return false;
        return item.stars >= minStars;
    });
    if (sort === 'recent') items.sort((a, b) => b.mtime - a.mtime);
    else if (sort === 'old') items.sort((a, b) => a.mtime - b.mtime);
    else if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    else if (sort === 'stars') items.sort((a, b) => (b.stars - a.stars) || (b.mtime - a.mtime));
    return items;
}

function renderVideos() {
    const list = byId('videos-list');
    list.innerHTML = '';
    const items = filteredVideos();
    const emptyCard = byId('videos-empty');
    if (!mediaList.length) {
        emptyCard.hidden = false;
        setText(byId('videos-count'), 'Aucun média enregistré');
        updateMediaToolbar();
        return;
    }
    emptyCard.hidden = true;
    const total = mediaList.length;
    const totalBytes = mediaList.reduce((sum, item) => sum + (item.size_bytes || 0), 0);
    setText(byId('videos-count'), items.length === total
        ? `${total} média${total > 1 ? 's' : ''} · ${fmtBytes(totalBytes)}`
        : `${items.length} / ${total} médias affichés`);
    if (!items.length) {
        list.appendChild(el('p', 'hint', 'Aucun média ne correspond au filtre.'));
        updateMediaToolbar();
        return;
    }
    items.forEach((item) => list.appendChild(mediaRow(item)));
    updateMediaToolbar();
}

/** Rangée de la liste : case à cocher, vignette, nom + type, méta + étoiles. */
function mediaRow(item) {
    const photo = (item.kind || 'video') === 'photo';
    const row = el('div', 'media-row' + (item.name === currentMediaName ? ' active' : ''));
    row.dataset.name = item.name;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'checkbox';
    check.checked = selectedNames.has(item.name);
    check.title = 'Sélectionner';
    check.addEventListener('click', (event) => event.stopPropagation());
    check.addEventListener('change', () => {
        if (check.checked) selectedNames.add(item.name);
        else selectedNames.delete(item.name);
        updateMediaToolbar();
    });
    row.appendChild(check);

    const thumb = el('div', 'media-thumb');
    thumb.dataset.thumbName = item.name;
    if (photo) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = mediaUrl(item.name);   // la photo est sa propre vignette
        thumb.appendChild(img);
    } else {
        const cached = THUMB_CACHE.get(item.name);
        if (cached) {
            const img = document.createElement('img');
            img.alt = '';
            img.src = cached;
            thumb.appendChild(img);
        } else {
            thumb.appendChild(el('span', 'vc-placeholder', '▶'));
            if (thumbObserver) thumbObserver.observe(thumb);
        }
    }
    row.appendChild(thumb);

    const main = el('div', 'media-main');
    const nameLine = el('div', 'media-name');
    nameLine.appendChild(el('span', '', item.name));
    nameLine.appendChild(el('span', 'kind-chip ' + (photo ? 'photo' : 'video'), photo ? 'photo' : 'vidéo'));
    main.appendChild(nameLine);
    const sub = el('div', 'media-sub');
    const facts = [fmtDate(item.mtime), fmtDuration(item.duration_s), fmtBytes(item.size_bytes)].filter(Boolean);
    sub.appendChild(el('span', '', facts.join(' · ')));
    sub.appendChild(starsDisplay(item.stars || 0));
    main.appendChild(sub);
    row.appendChild(main);

    row.addEventListener('click', () => openPlayer(item.name));
    return row;
}

/** Met à jour la barre de sélection : compteur, « tout sélectionner », boutons. */
function updateMediaToolbar() {
    const visible = filteredVideos().map((item) => item.name);
    const selectedVisible = visible.filter((name) => selectedNames.has(name));
    const selectAll = byId('media-select-all');
    selectAll.checked = visible.length > 0 && selectedVisible.length === visible.length;
    selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visible.length;
    const count = selectedNames.size;
    setText(byId('media-selected-count'), count
        ? `${count} élément${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}`
        : 'Aucun élément sélectionné');
    byId('btn-media-view').disabled = count === 0;
    byId('btn-media-rename').disabled = count !== 1;
    byId('btn-media-download').disabled = count === 0;
    byId('btn-media-delete').disabled = count === 0;
}

function selectAllMedia(checked) {
    filteredVideos().forEach((item) => {
        if (checked) selectedNames.add(item.name);
        else selectedNames.delete(item.name);
    });
    renderVideos();
}

/* -- Renommage : la ligne du média édité passe en saisie en place ---------- */

function mediaRowByName(name) {
    return $$('#videos-list .media-row').find((row) => row.dataset.name === name) || null;
}

function renameSelection() {
    if (selectedNames.size !== 1) { toast('Sélectionnez un seul média à renommer', 'err'); return; }
    beginRename(Array.from(selectedNames)[0]);
}

/** Remplace le nom de la ligne par un champ (sans extension) + ✓ / ✕. */
function beginRename(name) {
    const row = mediaRowByName(name);
    const nameLine = row ? row.querySelector('.media-name') : null;
    if (!row || !nameLine || row.querySelector('.rename-line')) return;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';

    const line = el('div', 'rename-line');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = stem;
    input.maxLength = 120;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Nouveau nom (sans extension)');
    const okBtn = el('button', 'btn-mini ok', '✓');
    okBtn.type = 'button';
    okBtn.title = 'Valider le nouveau nom';
    const cancelBtn = el('button', 'btn-mini', '✕');
    cancelBtn.type = 'button';
    cancelBtn.title = 'Annuler';
    line.append(input, el('span', 'rename-ext', ext), okBtn, cancelBtn);
    nameLine.replaceWith(line);

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commitRename(name, input.value); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); renderVideos(); }
    });
    okBtn.addEventListener('click', () => commitRename(name, input.value));
    cancelBtn.addEventListener('click', () => renderVideos());
    input.focus();
    input.select();
}

/** Envoie le renommage, puis suit sélection, vignette en cache et lecteur. */
async function commitRename(oldName, raw) {
    const newName = raw.trim();
    if (!newName) { toast('Le nouveau nom ne peut pas être vide', 'err'); renderVideos(); return; }
    let finalName;
    try {
        const data = await postJSON('/api/videos/rename', { name: oldName, new_name: newName });
        finalName = data.name || oldName;
    } catch (error) {
        toast(`Renommage refusé : ${error.message}`, 'err', 4600);
        renderVideos();
        return;
    }
    if (finalName === oldName) { toast('Nom inchangé'); renderVideos(); return; }
    selectedNames.delete(oldName);
    selectedNames.add(finalName);
    if (THUMB_CACHE.has(oldName)) {
        THUMB_CACHE.set(finalName, THUMB_CACHE.get(oldName));
        THUMB_CACHE.delete(oldName);
    }
    const reopen = currentMediaName === oldName ? finalName : null;
    try {
        await loadVideos();
        if (reopen) openPlayer(reopen);
    } catch (error) { toast('Médiathèque : ' + error.message, 'err'); }
    toast(`Renommé en « ${finalName} »`);
}

function viewSelection() {
    const name = Array.from(selectedNames)[0];
    if (!name) { toast('Sélectionnez un média à visionner', 'err'); return; }
    openPlayer(name);
}

/** Téléchargements espacés : les navigateurs bloquent les rafales de liens. */
function downloadSelection() {
    const names = Array.from(selectedNames);
    if (!names.length) return;
    names.forEach((name, index) => {
        setTimeout(() => {
            const link = document.createElement('a');
            link.href = mediaUrl(name);
            link.download = name;
            document.body.appendChild(link);
            link.click();
            link.remove();
        }, index * 350);
    });
    toast(`${names.length} téléchargement${names.length > 1 ? 's' : ''} lancé${names.length > 1 ? 's' : ''}`);
}

async function deleteMedia(name) {
    const response = await fetch('/api/videos/file/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!response.ok) {
        let detail = 'HTTP ' + response.status;
        try { detail = (await response.json()).detail || detail; } catch (_) { /* corps non JSON */ }
        throw new Error(detail);
    }
}

async function deleteSelection() {
    const names = Array.from(selectedNames);
    if (!names.length) return;
    if (!window.confirm(`Supprimer définitivement ${names.length} média${names.length > 1 ? 's' : ''} ?`)) return;
    let removed = 0;
    for (const name of names) {
        try { await deleteMedia(name); removed += 1; selectedNames.delete(name); }
        catch (error) { toast(`Suppression de « ${name} » refusée : ${error.message}`, 'err', 4600); }
    }
    if (removed) toast(`${removed} média${removed > 1 ? 's' : ''} supprimé${removed > 1 ? 's' : ''}`);
    try {
        await loadVideos();
        if (currentMediaName && !MEDIA_BY_NAME.has(currentMediaName)) closePlayer();
    } catch (error) { toast('Médiathèque : ' + error.message, 'err'); }
}

/** Rangée d'étoiles en lecture seule (affichage des cartes). */
function starsDisplay(stars) {
    const wrap = el('span', 'stars readonly');
    for (let index = 1; index <= 5; index += 1) {
        wrap.appendChild(el('span', 'star' + (index <= stars ? ' on' : ''), '★'));
    }
    return wrap;
}

/* -- Vignettes (générées à l'approche du viewport, puis mises en cache) ----- */

function initThumbObserver() {
    if (!('IntersectionObserver' in window)) return;   // repli : placeholders seuls
    thumbObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            thumbObserver.unobserve(entry.target);
            const name = entry.target.dataset.thumbName;
            if (name && !THUMB_CACHE.has(name)) buildThumb(name, entry.target);
        });
    }, { rootMargin: '240px 0px' });
}

/** Vignette : décode la vidéo hors écran, saute ~10 % de la durée, capture. */
function buildThumb(name, container) {
    const video = document.createElement('video');
    let finished = false;
    const guard = setTimeout(() => finish(true), 12000);

    function finish(failed) {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        let dataUrl = null;
        if (!failed) {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 320;
                canvas.height = video.videoHeight || 180;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                dataUrl = canvas.toDataURL('image/jpeg', 0.72);
            } catch (_) { dataUrl = null; /* capture refusée */ }
        }
        video.removeAttribute('src');
        video.load();
        if (!dataUrl) return;                          // placeholder conservé
        THUMB_CACHE.set(name, dataUrl);
        const img = document.createElement('img');
        img.alt = '';
        img.src = dataUrl;
        const placeholder = container.querySelector('.vc-placeholder');
        if (placeholder) container.replaceChild(img, placeholder);
        else container.insertBefore(img, container.firstChild);
    }

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('loadedmetadata', () => {
        try { video.currentTime = Math.min(1, Math.max(0.1, (video.duration || 1) * 0.1)); }
        catch (_) { finish(true); }
    }, { once: true });
    video.addEventListener('seeked', () => finish(false), { once: true });
    video.addEventListener('error', () => finish(true), { once: true });
    video.src = mediaUrl(name);
}

/* -- Lecteur : lecture, étoiles, notes -------------------------------------- */

function playerDetails(item) {
    const parts = [fmtDate(item.mtime)];
    if ((item.kind || 'video') !== 'photo') parts.push(fmtDuration(item.duration_s));
    parts.push(fmtBytes(item.size_bytes));
    return parts.filter(Boolean).join(' · ');
}

function renderPlayerStars(stars) {
    $$('#player-stars .star').forEach((star) => {
        star.classList.toggle('on', Number(star.dataset.value) <= stars);
    });
}

function openPlayer(name) {
    const item = MEDIA_BY_NAME.get(name);
    if (!item) return;
    currentMediaName = name;
    const photo = (item.kind || 'video') === 'photo';
    byId('player-card').hidden = false;
    setText(byId('player-name'), name);
    setText(byId('player-details'), playerDetails(item));
    const video = byId('player-video');
    const image = byId('player-photo');
    if (photo) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.hidden = true;
        image.hidden = false;
        image.src = mediaUrl(name);
    } else {
        image.removeAttribute('src');
        image.hidden = true;
        video.hidden = false;
        video.src = mediaUrl(name);
        video.play().catch(() => { /* lecture manuelle (restrictions navigateur) */ });
    }
    byId('player-notes').value = item.notes || '';
    renderPlayerStars(item.stars);
    byId('player-saved').classList.remove('show');
    renderVideos();
    byId('player-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closePlayer() {
    const video = byId('player-video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.hidden = false;
    const image = byId('player-photo');
    image.removeAttribute('src');
    image.hidden = true;
    byId('player-card').hidden = true;
    currentMediaName = null;
    renderVideos();
}

function flashSaved() {
    const tag = byId('player-saved');
    tag.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => tag.classList.remove('show'), 1800);
}

async function saveMeta(name, patch) {
    try {
        const data = await postJSON('/api/videos/meta/' + encodeURIComponent(name), patch);
        const item = MEDIA_BY_NAME.get(name);
        if (item) {
            if (data.stars != null) item.stars = data.stars;
            if (data.notes != null) item.notes = data.notes;
        }
        flashSaved();
        renderVideos();
    } catch (error) {
        toast('Enregistrement impossible : ' + error.message, 'err');
    }
}

const saveNotesDebounced = debounce(() => {
    if (currentMediaName) saveMeta(currentMediaName, { notes: byId('player-notes').value });
}, 800);

function initMediaUI() {
    byId('videos-search').addEventListener('input', debounce(renderVideos, 180));
    byId('videos-sort').addEventListener('change', renderVideos);
    byId('videos-filter-stars').addEventListener('change', renderVideos);
    byId('videos-filter-kind').addEventListener('change', renderVideos);
    byId('media-select-all').addEventListener('change', (event) => selectAllMedia(event.target.checked));
    byId('btn-media-view').addEventListener('click', viewSelection);
    byId('btn-media-rename').addEventListener('click', renameSelection);
    byId('btn-media-download').addEventListener('click', downloadSelection);
    byId('btn-media-delete').addEventListener('click', deleteSelection);
    byId('btn-videos-refresh').addEventListener('click', async () => {
        try { await loadVideos(); toast('Médiathèque actualisée'); }
        catch (error) { toast('Médiathèque : ' + error.message, 'err'); }
    });
    byId('btn-player-close').addEventListener('click', closePlayer);
    byId('player-saved').textContent = 'Enregistré';
    $$('#player-stars .star').forEach((star) => {
        star.addEventListener('click', () => {
            if (!currentMediaName) return;
            const value = Number(star.dataset.value);
            const item = MEDIA_BY_NAME.get(currentMediaName);
            const target = (item && item.stars === value) ? 0 : value;   // re-clic : retire l'étoile
            renderPlayerStars(target);
            saveMeta(currentMediaName, { stars: target });
        });
    });
    byId('player-notes').addEventListener('input', saveNotesDebounced);
    initThumbObserver();
    updateMediaToolbar();
}

/* =========================================================================
 * 9. AMORÇAGE — configuration, ordres des tuiles, sondes périodiques (2 s)
 * ========================================================================= */

async function init() {
    initThemeToggle();
    initNavigation();
    initTileGrid(TILE_GRIDS.main);
    initTileGrid(TILE_GRIDS.params);
    initVideo();
    initHud();
    startPadReader();
    initPadTest();
    initSettingsButtons();
    initMediaUI();

    try {
        await loadConfig();
        fillSettings();
        applyTheme((CONFIG.interface && CONFIG.interface.theme) || 'dark', { local: true });
        applyCockpitFromConfig();
        Object.values(TILE_GRIDS).forEach((cfg) => applyTileOrder(cfg, initialTileOrder(cfg)));
    } catch (error) {
        toast('Configuration indisponible : ' + error.message, 'err', 5000);
    }
    byId('btn-ui-reset-tiles').addEventListener('click', resetTileOrders);
    loadVideoDevices().catch((error) => toast('Caméras : ' + error.message, 'err'));
    loadVideos().catch(() => { /* la médiathèque sera rechargée à l'ouverture de sa section */ });

    pollSystem();
    pollVideo();
    setInterval(pollSystem, 2000);
    setInterval(pollVideo, 2000);
}

document.addEventListener('DOMContentLoaded', init);
