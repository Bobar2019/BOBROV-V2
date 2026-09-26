/**
 * BOBROV-V2 — Sub Simulator immersif · instruments HUD incrustés.
 *
 * Réécriture « cockpit » : la vue 2D (profil latéral, ROV schématique) est
 * remplacée par des instruments en incrustation sur la scène 3D, avec les
 * mêmes codes couleur que le HUD du cockpit :
 *
 *   horizon artificiel (centre)   ruban de cap (haut)
 *   bande de profondeur (droite)  jauges M1–M8 (bas gauche)
 *   chrono · FPS · batterie · courants (bandeau bas)
 *   mini-carte cap & position (bas droite, échelle du monde réel)
 *
 * Le module ne fait que LIRE l'instantané produit par sim-physics.js et les
 * métadonnées passées dans `ui` (état, monde, cadence). Aucune dépendance
 * Three.js : les instruments sont des canvas 2D transparents.
 */

const COLORS = Object.freeze({
    hud: 'rgba(0, 217, 255, 0.85)',
    hudSoft: 'rgba(0, 217, 255, 0.45)',
    hudDim: 'rgba(0, 217, 255, 0.22)',
    panel: 'rgba(6, 17, 26, 0.55)',
    text: '#e8f4f8',
    textDim: 'rgba(232, 244, 248, 0.62)',
    warn: '#ffb300',
    danger: '#ff3b30',
    ok: '#00e676',
    sand: 'rgba(200, 177, 138, 0.40)',
    reef: 'rgba(53, 208, 186, 0.38)',
    pit: 'rgba(0, 217, 255, 0.20)',
});

const MONO = '"Source Code Pro", monospace';

export class SimView {
    /**
     * @param {object} refs canvas HUD (horizon, heading, depthTape, minimap)
     *        + références DOM produites par sim.js (valeurs, badges, moteurs).
     */
    constructor(refs) {
        this.horizon = refs.horizon;
        this.heading = refs.heading;
        this.depthTape = refs.depthTape;
        this.minimap = refs.minimap;
        this.hold = refs.hold;
        this.holdText = refs.holdText;
        this.holdAction = refs.holdAction;
        this.dom = refs.dom;
        this.hctx = this.horizon.getContext('2d');
        this.hdctx = this.heading.getContext('2d');
        this.dctx = this.depthTape.getContext('2d');
        this.mctx = this.minimap.getContext('2d');
        this.trace = [];
        this.lastTrace = null;
    }

    resetTrace() {
        this.trace.length = 0;
        this.lastTrace = null;
    }

    // ------------------------------------------------------------------ //
    // Boucle de rendu                                                     //
    // ------------------------------------------------------------------ //

    /** Rendu complet des instruments (appelé au rythme de l'écran). */
    render(snapshot, ui) {
        this.renderHorizon(snapshot);
        this.renderHeading(snapshot);
        this.renderDepthTape(snapshot, ui);
        this.renderMinimap(snapshot, ui);
        this.updateDom(snapshot, ui);
    }

    /** Sortie d'écran : efface les instruments et neutralise le bandeau. */
    renderIdle() {
        for (const [ctx, canvas] of [
            [this.hctx, this.horizon], [this.hdctx, this.heading],
            [this.dctx, this.depthTape], [this.mctx, this.minimap],
        ]) {
            const frame = this.prepare(ctx, canvas);
            if (frame) frame.ctx.clearRect(0, 0, frame.w, frame.h);
        }
        this.updateDom(null, { running: false });
    }

    // ------------------------------------------------------------------ //
    // Horizon artificiel                                                  //
    // ------------------------------------------------------------------ //

    renderHorizon(snapshot) {
        const frame = this.prepare(this.hctx, this.horizon);
        if (!frame) return;
        const { ctx, w, h } = frame;
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2 - 6;
        ctx.clearRect(0, 0, w, h);

        // Boule ciel/mer (translucide : la scène 3D reste visible tout autour)
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
        if (snapshot) {
            const pitch = snapshot.att.pitch;
            ctx.translate(cx, cy);
            ctx.rotate(-snapshot.att.roll);
            const offset = (pitch / (Math.PI / 2)) * r * 0.9;

            const sky = ctx.createLinearGradient(0, -r * 2, 0, 0);
            sky.addColorStop(0, 'rgba(14, 77, 119, 0.72)');
            sky.addColorStop(1, 'rgba(42, 135, 184, 0.78)');
            ctx.fillStyle = sky;
            ctx.fillRect(-r * 2, -r * 2 + offset, r * 4, r * 2);

            const sea = ctx.createLinearGradient(0, 0, 0, r * 2);
            sea.addColorStop(0, 'rgba(10, 61, 79, 0.80)');
            sea.addColorStop(1, 'rgba(5, 32, 40, 0.85)');
            ctx.fillStyle = sea;
            ctx.fillRect(-r * 2, offset, r * 4, r * 2);

            // Ligne d'horizon
            ctx.strokeStyle = 'rgba(232, 244, 248, 0.92)';
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(-r, offset);
            ctx.lineTo(r, offset);
            ctx.stroke();

            // Échelle de tangage (−30° à +30°, pas de 10°)
            ctx.strokeStyle = 'rgba(232, 244, 248, 0.55)';
            ctx.lineWidth = 1;
            ctx.font = `500 8px ${MONO}`;
            ctx.fillStyle = 'rgba(232, 244, 248, 0.55)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (const deg of [-30, -20, -10, 10, 20, 30]) {
                const y = offset + (deg / 90) * r * 0.9;
                const half = deg % 20 === 0 ? r * 0.42 : r * 0.26;
                ctx.beginPath();
                ctx.moveTo(-half, y);
                ctx.lineTo(half, y);
                ctx.stroke();
                ctx.fillText(`${deg > 0 ? '+' : ''}${deg}`, 0, y - 6);
            }
        } else {
            ctx.fillStyle = 'rgba(18, 53, 74, 0.55)';
            ctx.fillRect(0, 0, w, h);
        }
        ctx.restore();

        // Cadran fixe + repère de roulis
        ctx.save();
        ctx.translate(cx, cy);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.hudSoft;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        // Index de cap (triangle fixe en haut)
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(-5, -r + 9);
        ctx.lineTo(5, -r + 9);
        ctx.closePath();
        ctx.strokeStyle = COLORS.hud;
        ctx.lineWidth = 2;
        ctx.stroke();
        // Repère central (ailes + point)
        ctx.strokeStyle = COLORS.hud;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-16, 0);
        ctx.lineTo(-6, 0);
        ctx.moveTo(6, 0);
        ctx.lineTo(16, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.hud;
        ctx.fill();
        // Aiguille de roulis (tourne autour du centre)
        if (snapshot) {
            ctx.rotate(snapshot.att.roll);
            ctx.beginPath();
            ctx.moveTo(0, -r + 2);
            ctx.lineTo(0, -r + 12);
            ctx.strokeStyle = 'rgba(0, 230, 118, 0.9)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        ctx.restore();
    }

    // ------------------------------------------------------------------ //
    // Ruban de cap                                                        //
    // ------------------------------------------------------------------ //

    renderHeading(snapshot) {
        const frame = this.prepare(this.hdctx, this.heading);
        if (!frame) return;
        const { ctx, w, h } = frame;
        ctx.clearRect(0, 0, w, h);

        roundRect(ctx, 1, 1, w - 2, h - 2, 7);
        ctx.fillStyle = COLORS.panel;
        ctx.fill();
        ctx.strokeStyle = COLORS.hudDim;
        ctx.lineWidth = 1;
        ctx.stroke();

        if (!snapshot) return;
        const headingDeg = snapshot.att.headingDeg;
        const span = 90;                    // ±45° affichés
        const pxPerDeg = w / span;
        const cx = w / 2;
        const baseY = h - 4;

        ctx.save();
        ctx.beginPath();
        ctx.rect(2, 2, w - 4, h - 4);
        ctx.clip();
        for (let d = -45; d <= 45; d += 5) {
            const deg = headingDeg + d;
            const norm = ((Math.round(deg) % 360) + 360) % 360;
            const x = cx + d * pxPerDeg;
            const cardinal = norm % 90 === 0;
            const major = norm % 30 === 0;
            const len = cardinal ? 11 : (major ? 8 : 4);
            ctx.strokeStyle = cardinal ? COLORS.hud : (major ? COLORS.hudSoft : COLORS.hudDim);
            ctx.lineWidth = cardinal ? 1.6 : 1;
            ctx.beginPath();
            ctx.moveTo(x, baseY);
            ctx.lineTo(x, baseY - len);
            ctx.stroke();
            if (norm % 30 === 0) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                if (cardinal) {
                    const letters = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' };
                    ctx.fillStyle = COLORS.text;
                    ctx.font = `700 11px ${MONO}`;
                    ctx.fillText(letters[norm], x, 3);
                } else {
                    ctx.fillStyle = COLORS.textDim;
                    ctx.font = `500 9px ${MONO}`;
                    ctx.fillText(`${norm}`, x, 4);
                }
            }
        }
        ctx.restore();

        // Fenêtre de lecture centrale
        const boxW = 46;
        const boxH = Math.min(18, h - 4);
        ctx.fillStyle = 'rgba(4, 12, 18, 0.85)';
        ctx.fillRect(cx - boxW / 2, h - boxH - 1, boxW, boxH);
        ctx.strokeStyle = COLORS.hud;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(cx - boxW / 2, h - boxH - 1, boxW, boxH);
        ctx.fillStyle = COLORS.hud;
        ctx.font = `700 12px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${String(Math.round(headingDeg) % 360).padStart(3, '0')}°`, cx, h - boxH / 2);
    }

    // ------------------------------------------------------------------ //
    // Bande de profondeur                                                 //
    // ------------------------------------------------------------------ //

    renderDepthTape(snapshot, ui) {
        const frame = this.prepare(this.dctx, this.depthTape);
        if (!frame) return;
        const { ctx, w, h } = frame;
        ctx.clearRect(0, 0, w, h);

        roundRect(ctx, 1, 1, w - 2, h - 2, 7);
        ctx.fillStyle = COLORS.panel;
        ctx.fill();
        ctx.strokeStyle = COLORS.hudDim;
        ctx.lineWidth = 1;
        ctx.stroke();

        const maxDepth = ui && ui.world ? ui.world.depth : 300;
        const top = 16;
        const bottom = h - 16;
        const axisX = w - 16;
        const yOf = (d) => top + (Math.max(0, Math.min(maxDepth, d)) / Math.max(1, maxDepth)) * (bottom - top);

        // Axe + graduations
        ctx.strokeStyle = COLORS.hudSoft;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(axisX, top);
        ctx.lineTo(axisX, bottom);
        ctx.stroke();

        const step = niceStep(maxDepth);
        ctx.font = `500 9px ${MONO}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let d = 0; d <= maxDepth + 0.5; d += step) {
            const y = yOf(d);
            const major = Math.round(d) % (step * 2) === 0;
            ctx.strokeStyle = major ? COLORS.hudSoft : COLORS.hudDim;
            ctx.beginPath();
            ctx.moveTo(axisX, y);
            ctx.lineTo(axisX - (major ? 9 : 5), y);
            ctx.stroke();
            if (major) {
                ctx.fillStyle = COLORS.textDim;
                ctx.fillText(`${Math.round(d)}`, axisX - 12, y);
            }
        }

        // Marqueur de profondeur courante
        if (snapshot) {
            const depth = snapshot.pos.depth;
            const y = yOf(depth);
            ctx.beginPath();
            ctx.moveTo(axisX, y);
            ctx.lineTo(axisX - 12, y - 5);
            ctx.lineTo(axisX - 12, y + 5);
            ctx.closePath();
            ctx.fillStyle = COLORS.hud;
            ctx.fill();

            const label = `${depth.toFixed(1)} m`;
            ctx.font = `700 10px ${MONO}`;
            const textW = ctx.measureText(label).width + 10;
            const boxY = Math.max(top, Math.min(bottom - 14, y - 7));
            roundRect(ctx, 5, boxY, Math.min(textW, w - 10), 14, 4);
            ctx.fillStyle = 'rgba(4, 12, 18, 0.85)';
            ctx.fill();
            ctx.strokeStyle = COLORS.hud;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = COLORS.hud;
            ctx.textAlign = 'left';
            ctx.fillText(label, 10, boxY + 7);
        }
    }

    // ------------------------------------------------------------------ //
    // Mini-carte cap & position (échelle du monde)                        //
    // ------------------------------------------------------------------ //

    renderMinimap(snapshot, ui) {
        const frame = this.prepare(this.mctx, this.minimap);
        if (!frame) return;
        const { ctx, w, h } = frame;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(8, 22, 33, 0.72)';
        ctx.fillRect(0, 0, w, h);

        const world = (ui && ui.world) || { extent: 1000, beachExtent: 10, reefExtent: 20, pitRadiusPct: 45 };
        const half = Math.max(10, world.extent / 2);
        const scale = 0.46;   // marge pour les libellés
        const xOf = (x) => w / 2 + (x / half) * (w * scale);
        const yOf = (north) => h / 2 - (north / half) * (h * scale);

        // Quadrillage (10 divisions) + anneaux topographiques
        ctx.strokeStyle = COLORS.hudDim;
        ctx.lineWidth = 1;
        for (let i = 1; i <= 9; i++) {
            const gx = (w * i) / 10;
            const gy = (h * i) / 10;
            ctx.beginPath();
            ctx.moveTo(gx, 0);
            ctx.lineTo(gx, h);
            ctx.moveTo(0, gy);
            ctx.lineTo(w, gy);
            ctx.stroke();
        }
        const rPix = (pct) => (Math.min(w, h) / 2) * 0.92 * pct;
        const beachPct = 1 - (world.beachExtent || 0) / 100;
        const reefPct = beachPct - (world.reefExtent || 0) / 100;
        const pitPct = (world.pitRadiusPct || 0) / 100;
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, rPix(beachPct), 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.sand;
        ctx.stroke();
        if (reefPct > 0.02) {
            ctx.beginPath();
            ctx.arc(w / 2, h / 2, rPix(reefPct), 0, Math.PI * 2);
            ctx.strokeStyle = COLORS.reef;
            ctx.stroke();
        }
        if (pitPct > 0.02) {
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.arc(w / 2, h / 2, rPix(pitPct), 0, Math.PI * 2);
            ctx.strokeStyle = COLORS.pit;
            ctx.stroke();
            ctx.restore();
        }
        ctx.strokeStyle = COLORS.hudSoft;
        ctx.lineWidth = 1.6;
        ctx.strokeRect(1, 1, w - 2, h - 2);

        // Rose des vents
        ctx.fillStyle = COLORS.textDim;
        ctx.font = `500 9px ${MONO}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('N ↑', 5, 4);

        if (!snapshot) return;
        const p = snapshot.pos;

        // Trace (échantillonnée tous les 2 m)
        if (!this.lastTrace || Math.hypot(p.x - this.lastTrace.x, p.north - this.lastTrace.north) > 2) {
            this.trace.push({ x: p.x, north: p.north });
            this.lastTrace = { x: p.x, north: p.north };
            if (this.trace.length > 400) this.trace.shift();
        }
        ctx.beginPath();
        for (let i = 0; i < this.trace.length; i++) {
            const point = this.trace[i];
            if (i === 0) ctx.moveTo(xOf(point.x), yOf(point.north));
            else ctx.lineTo(xOf(point.x), yOf(point.north));
        }
        ctx.strokeStyle = COLORS.hudSoft;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // ROV (triangle orienté cap ; 0 = nord en haut)
        const rx = xOf(p.x);
        const ry = yOf(p.north);
        ctx.save();
        ctx.translate(rx, ry);
        ctx.rotate(snapshot.att.heading);
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.lineTo(5.6, 6);
        ctx.lineTo(0, 3);
        ctx.lineTo(-5.6, 6);
        ctx.closePath();
        ctx.fillStyle = COLORS.ok;
        ctx.fill();
        ctx.restore();

        // Position en mètres (utile sur un monde de 1 km)
        ctx.fillStyle = COLORS.textDim;
        ctx.font = `500 9px ${MONO}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`E ${Math.round(p.x)} · N ${Math.round(p.north)} m`, 5, h - 4);
    }

    // ------------------------------------------------------------------ //
    // Instruments DOM (bandeau d'état, badges, jauges M1–M8)              //
    // ------------------------------------------------------------------ //

    updateDom(snapshot, ui) {
        const d = this.dom;
        if (!d) return;
        const running = !!(ui && ui.running);

        // Badges
        if (d.badges) {
            setBadge(d.badges.run, running ? 'EN MARCHE' : 'EN PAUSE', running ? 'ok' : 'off');
            if (snapshot) {
                const arm = snapshot.flags.armState;
                if (arm === 2) setBadge(d.badges.arm, 'E-STOP', 'danger');
                else if (arm === 1) setBadge(d.badges.arm, 'ARMÉ', 'ok');
                else setBadge(d.badges.arm, 'DÉSARMÉ', 'off');
                setBadge(d.badges.dry, snapshot.flags.dryRun ? 'DRY-RUN' : 'SORTIES ACTIVES',
                    snapshot.flags.dryRun ? 'warn' : 'off');
                setBadge(d.badges.wd, 'WATCHDOG · LIAISON PERDUE', 'danger', snapshot.flags.watchdog);
                if (d.badges.saturation) {
                    const sat = snapshot.saturation.H || snapshot.saturation.V;
                    setBadge(d.badges.saturation, 'MIXAGE SATURÉ', 'warn', sat);
                }
            }
            if (d.badges.pad) {
                const label = ui && ui.padId ? `MANETTE · ${ui.padId}` : 'MANETTE NON DÉTECTÉE';
                setBadge(d.badges.pad, label, ui && ui.padId ? 'ok' : 'off');
            }
        }

        // Bandeau « sorties coupées » : rend la cause du pilotage inerte
        // visible et déblocable en un clic (dry-run → armement).
        if (this.hold) {
            let holdLabel = null;
            let holdAction = '';
            if (running && snapshot) {
                const f = snapshot.flags;
                if (f.watchdog) {
                    holdLabel = 'LIAISON PERDUE — pilotage neutralisé (watchdog)';
                } else if (f.armState === 2) {
                    holdLabel = 'E-STOP ACTIF — sorties coupées';
                    holdAction = 'Acquitter et armer';
                } else if (f.dryRun) {
                    holdLabel = 'DRY-RUN ACTIF — sorties coupées';
                    holdAction = 'Couper le dry-run et armer';
                } else if (f.armState !== 1) {
                    holdLabel = 'ROV DÉSARMÉ — sorties coupées';
                    holdAction = 'Armer';
                }
            }
            setHold(this.hold, this.holdText, this.holdAction, holdLabel, holdAction);
        }
        if (!snapshot) return;

        const bat = snapshot.battery;
        setText(d.valHeading, `${String(Math.round(snapshot.att.headingDeg) % 360).padStart(3, '0')}°`);
        setText(d.valRollPitch, `${snapshot.att.rollDeg.toFixed(0)}° / ${snapshot.att.pitchDeg.toFixed(0)}°`);
        setText(d.valTime, formatChrono(snapshot.t));
        setText(d.valFps, ui && ui.fps ? String(Math.round(ui.fps)) : '—');
        setText(d.valVoltage, `${bat.voltage.toFixed(2)} V`);
        setWarn(d.valVoltage, bat.low);
        setText(d.valSoc, `${Math.round(bat.soc * 100)} %`);
        setWarn(d.valSoc, bat.soc < 0.2);
        setText(d.valCurrentH, `${bat.currentH.toFixed(1)} A`);
        setWarn(d.valCurrentH, bat.currentH > 20);
        setText(d.valCurrentV, `${bat.currentV.toFixed(1)} A`);
        setWarn(d.valCurrentV, bat.currentV > 20);

        // Jauges M1–M8 (sorties du mixage réel)
        if (d.thrustRows) {
            for (let i = 0; i < d.thrustRows.length; i++) {
                const row = d.thrustRows[i];
                const value = snapshot.thrust[i];
                setThrustBar(row.fill, value);
                setText(row.valueEl, `${Math.round(value * 100)}%`);
            }
        }
    }

    // ------------------------------------------------------------------ //
    // Utilitaires                                                         //
    // ------------------------------------------------------------------ //

    /** Adapte un canvas au DPR et renvoie le contexte prêt à dessiner (CSS px). */
    prepare(ctx, canvas) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return null;
        const dpr = window.devicePixelRatio || 1;
        const W = Math.round(rect.width * dpr);
        const H = Math.round(rect.height * dpr);
        if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W;
            canvas.height = H;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx, w: rect.width, h: rect.height };
    }
}

// ---------------------------------------------------------------------- //
// Helpers                                                                //
// ---------------------------------------------------------------------- //

/** Pas de graduation « rond » (1/2/5×10^n) donnant 4 à 8 graduations. */
function niceStep(max) {
    if (max <= 10) return 2;
    let step = Math.pow(10, Math.floor(Math.log10(max)));
    while (max / step > 8) step *= 2;
    while (max / step < 4) step /= 2;
    return step >= 1 ? Math.round(step) : step;
}

function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
}

function setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
}

function setWarn(el, warn) {
    if (el) el.classList.toggle('sim-warn-text', !!warn);
}

function setBadge(el, label, kind, visible = true) {
    if (!el) return;
    el.hidden = !visible;
    if (!visible) return;
    const nextClass = `badge sim-badge-${kind}`;
    if (el.className !== nextClass) el.className = nextClass;
    setText(el, label);
}

/** Bandeau d'alerte « sorties coupées » (masqué tant que label est nul). */
function setHold(wrap, textEl, actionEl, label, actionLabel) {
    if (!wrap) return;
    const show = !!label;
    if (wrap.hidden === show) wrap.hidden = !show;   // n'écrit au DOM qu'au changement
    if (!show) return;
    const danger = label.startsWith('E-STOP') || label.startsWith('LIAISON');
    wrap.classList.toggle('sim-hold-danger', danger);
    setText(textEl, label);
    if (actionEl) {
        actionEl.hidden = !actionLabel;
        setText(actionEl, actionLabel);
    }
}

function setThrustBar(el, value) {
    if (!el) return;
    const half = Math.abs(value) * 50;
    if (value >= 0) {
        el.style.left = '50%';
        el.style.width = `${half.toFixed(1)}%`;
    } else {
        el.style.left = `${(50 - half).toFixed(1)}%`;
        el.style.width = `${half.toFixed(1)}%`;
    }
    el.classList.toggle('sim-thr-neg', value < -0.005);
}

function formatChrono(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
