import * as THREE from '../engine/index.js';
import { DRAW, HUD_COLOR, clamp, normalize360 } from './telemetryDraw.js';

// The ROV's onboard screen, in the cockpit's own hand. The real vehicle lays its telemetry over
// the camera feed (static/index.html #hud-layer, static/style.css, drawn by static/app.js); here
// the same instruments are laid over the WebGL view with the same markup and the same rules
// (telemetry.css), and drawn by the same painters (telemetryDraw.js). Two things change:
//
//   the feed     instead of the serial frames relayed over the WebSocket, the numbers are read
//                off the simulator's state every frame —
//                  depth     the mesh's Y, mapped back through the level it floats on and its draft
//                  pitch     X of the mesh's Euler angles (YXZ, the order the frame is posed in),
//                            turned over: the instruments are positive on the nose up
//                  roll      Z of the same angles
//                  heading   Y of the same angles, in the compass frame of the simulator's dial
//                and the quantities the bench frame has no sensor for (thruster echoes, pack,
//                water probe, gripper) are worked out from its commands, below
//
//   the layout   read from config.json (cockpit.hud.elements / cockpit.overlay), the very table
//                the cockpit writes from "Mise en page": position, size, opacity, colour, stroke
//                weight and text scale follow it, so the two screens cannot drift apart

const HUD_ORDER = [ 'horizon', 'heading', 'depth', 'temperature', 'gauges', 'grip', 'voltage', 'motor_v', 'motor_h' ];

// The cockpit's fallback layout (HUD_DEFAULT_LAYOUT in app.js), in % of the scene, until
// config.json answers. The heading ribbon sits one notch lower than the cockpit's 3 %: the
// simulator hangs its notifications from the very top of the screen, and the toast of the
// boarding would sit on the heading value.
const DEFAULT_LAYOUT = {
	horizon: { x: 37, y: 12, w: 26, h: 40, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
	heading: { x: 34, y: 6, w: 32, h: 8, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
	depth: { x: 82, y: 8, w: 15, h: 56, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1, max: 40 },
	temperature: { x: 82, y: 64.5, w: 15, h: 5.2, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
	gauges: { x: 0.5, y: 56, w: 26, h: 25, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
	grip: { x: 27, y: 56, w: 12.5, h: 8.5, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
	voltage: { x: 0.5, y: 81.5, w: 13.8, h: 5.2, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
	motor_v: { x: 0.5, y: 87.3, w: 13.8, h: 5.2, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
	motor_h: { x: 0.5, y: 93.1, w: 13.8, h: 5.2, opacity: 0.92, color: HUD_COLOR, weight: 1, font: 1 },
};

const CONFIG_URL = '/api/config'; // same origin: the simulator lives beside the cockpit
const CONFIG_MIN_MS = 1000; // at most one re-read per second

// The bench frame carries no sensors of its own: what the real vehicle sends over its serial
// frames is worked out from its commands here — a pack that sags under the load, eight thrusters
// drawing their share, a probe in the water under the frame.
const PACK = { nominal: 12.6, sag: 0.012 }; // V at rest, and V lost per amp of pack current
const THRUSTER = { idle: 0.25, full: 4.6 }; // A per thruster, at rest and at full command
const WATER = { surface: 18.6, gradient: 0.12 }; // °C at the surface, and °C lost per metre

const _e = new THREE.Euler( 0, 0, 0, 'YXZ' );
const isColour = ( v ) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test( v );

export class RovTelemetry {

	constructor( parent ) {

		this.visible = false;
		this.layout = {};
		this._els = {}; // id → { root, canvas, ctx, w, h, dpr }
		this._loading = false;
		this._configAt = 0;

		const layer = this.layer = document.createElement( 'div' );
		layer.className = 'hud-layer';
		layer.setAttribute( 'role', 'img' );
		layer.setAttribute( 'aria-label',
			'Telemetry: artificial horizon, heading, depth, temperature, thrusters, gripper, '
			+ 'pack and motor currents' );

		for ( const id of HUD_ORDER ) {

			this.layout[ id ] = { ...DEFAULT_LAYOUT[ id ] };
			const el = document.createElement( 'div' );
			el.className = 'hud-el';
			el.dataset.hud = id;
			const canvas = document.createElement( 'canvas' );
			canvas.className = 'hud-canvas';
			el.append( canvas );
			layer.append( el );
			this._els[ id ] = { root: el, canvas, ctx: canvas.getContext( '2d' ), w: 0, h: 0, dpr: 0 };
			this._place( id );

		}

		parent.append( layer );
		this.load();

	}

	// ── layout: config.json, as the cockpit writes it ───────────────────────

	/** Re-reads the cockpit's layout. Silent on failure: the fallback above already stands. */
	async load() {

		if ( this._loading ) return;
		this._loading = true;
		try {

			const res = await fetch( CONFIG_URL, { cache: 'no-store' } );
			if ( ! res.ok ) throw new Error( String( res.status ) );
			this._applyConfig( await res.json() );

		} catch {

			// standalone (no backend): the cockpit's fallback layout stands

		} finally {

			// one re-read per second at most, whether or not the backend answered
			this._configAt = performance.now();
			this._loading = false;

		}

	}

	/** Applies cockpit.hud.elements and cockpit.overlay to the instruments on screen. */
	_applyConfig( cfg ) {

		const cockpit = ( cfg && cfg.cockpit ) || {};
		const items = ( cockpit.hud && cockpit.hud.elements ) || {};
		const overlay = cockpit.overlay || {};
		const num = ( v, d ) => ( Number.isFinite( Number( v ) ) ? Number( v ) : d );
		const pick = ( v, d ) => ( isColour( v ) ? v : d );

		for ( const id of HUD_ORDER ) {

			const item = items[ id ] || {};
			const base = DEFAULT_LAYOUT[ id ];
			this.layout[ id ] = {
				x: clamp( num( item.x, base.x ), 0, 100 ),
				y: clamp( num( item.y, base.y ), 0, 100 ),
				w: clamp( num( item.w, base.w ), 4, 100 ),
				h: clamp( num( item.h, base.h ), 4, 100 ),
				opacity: clamp( num( item.opacity, base.opacity ), 0.05, 1 ),
				color: pick( item.color, base.color ),
				weight: clamp( num( item.weight, base.weight ), 0.5, 2.5 ),
				font: clamp( num( item.font, base.font ), 0.5, 2.5 ),
				max: clamp( num( item.max, base.max || 40 ), 5, 500 ),
			};
			this._els[ id ].root.classList.toggle( 'off', overlay[ id ] === false );
			this._place( id );

		}

	}

	/** Writes one instrument's box, opacity and clearance bands onto its element. */
	_place( id ) {

		const el = this._els[ id ].root;
		const it = this.layout[ id ];
		el.style.left = it.x + '%';
		el.style.top = it.y + '%';
		el.style.width = it.w + '%';
		el.style.height = it.h + '%';
		el.style.setProperty( '--hud-o', String( it.opacity ) );
		// the bands the simulator's own chrome occupies (telemetry.css): the settings rail along the
		// right edge, and the status block that takes the whole width on a phone
		el.dataset.right = ( it.x + it.w >= 92 ) ? '1' : '0';
		el.dataset.top = ( it.y < 40 ) ? '1' : '0';

	}

	// ── visibility ──────────────────────────────────────────────────────────

	// the cockpit's instruments are always up; these belong to the onboard camera
	setVisible( on ) {

		on = !! on;
		if ( on === this.visible ) return;
		this.visible = on;
		this.layer.classList.toggle( 'is-on', on );
		// the layout is edited in the cockpit: pick it up again when the screen comes back
		if ( on && performance.now() - this._configAt > CONFIG_MIN_MS ) this.load();

	}

	// ── one frame of the screen ─────────────────────────────────────────────

	/** Draws every instrument from the frame's own state. */
	update( rov ) {

		if ( ! this.visible || ! rov || ! rov.model ) return;

		const f = this._frame( rov );
		for ( const id of HUD_ORDER ) {

			const entry = this._els[ id ];
			if ( entry.root.classList.contains( 'off' ) ) continue;
			if ( ! this._fit( entry ) ) continue;
			DRAW[ id ]( entry.ctx, this.layout[ id ], entry.w, entry.h, f );

		}

	}

	/** Pose and sensors of the frame: what the onboard screen shows. */
	_frame( rov ) {

		const group = rov.model.group;

		// the mesh's Euler angles, in the order the controller poses the frame (YXZ), so that X is
		// the pitch, Y the heading and Z the roll, with no coupling between them at the extremes
		_e.setFromQuaternion( group.quaternion, 'YXZ' );
		// the instruments read pitch positive on the nose up, as the cockpit's own frames do
		// (asin(2(wy − zx)) in static/app.js), while the pose is written positive on the nose down
		const pitch = - THREE.MathUtils.radToDeg( _e.x );
		const roll = THREE.MathUtils.radToDeg( _e.z );
		// heading in the compass frame of the simulator's dial (+X east, −Z north): the ribbon and
		// the dial read the same number
		const yaw = normalize360( THREE.MathUtils.radToDeg( Math.atan2( Math.sin( _e.y ), - Math.cos( _e.y ) ) ) );

		// depth: the mesh's Y read back through the level the pose was written against and the
		// frame's draft — the controller writes y = level − draft − depth, so this is the frame's own
		// immersion
		const level = rov.hasWater ? rov.level : 0;
		const depth = Math.max( 0, level - rov.model.floatDraft - group.position.y );

		const pwm = this._pwm( rov );
		const amps = ( us ) => THRUSTER.idle + ( THRUSTER.full - THRUSTER.idle ) * Math.abs( ( us - 1500 ) / 500 );
		let iH = 0, iV = 0;
		for ( let i = 0; i < 4; i ++ ) iH += amps( pwm[ i ] );
		for ( let i = 4; i < 8; i ++ ) iV += amps( pwm[ i ] );

		return {
			pitch, roll, yaw, depth, pwm,
			iH, iV,
			vbat: PACK.nominal - PACK.sag * ( iH + iV ),
			// the probe sits under the frame: the deeper it hangs, the colder the water it reads
			temperature: WATER.surface - WATER.gradient * Math.min( depth, 60 ),
			max: this.layout.depth.max,
		};

	}

	/** The 16 PWM echoes of the firmware frame, from the controller's three commands. */
	_pwm( rov ) {

		const surge = clamp( rov.throttle, - 1, 1 );
		const yaw = clamp( rov.steer, - 1, 1 );
		const heave = clamp( rov.vertical, - 1, 1 );
		const pwm = new Array( 16 ).fill( 1500 );

		// horizontals in an X: the two motors of a diagonal share a sign, the other diagonal
		// opposes it on the rudder — a turn speeds one side up and slows the other down
		const mix = [ surge + yaw, surge - yaw, surge + yaw, surge - yaw ];
		for ( let i = 0; i < 4; i ++ ) pwm[ i ] = 1500 + 500 * clamp( mix[ i ], - 1, 1 );
		// verticals: positive on the way up, as in the firmware's mixer
		for ( let i = 4; i < 8; i ++ ) pwm[ i ] = 1500 + 500 * heave;

		// channels 9 and 10: the bench frame carries no arm, so the jaws rest closed and centred
		pwm[ 8 ] = 1000;
		pwm[ 9 ] = 1500;
		return pwm;

	}

	// ── canvas plumbing (hudFitCanvas in app.js) ────────────────────────────

	/** Frames the canvas on its CSS box, HiDPI clean, and clears it. False if the box is not laid out. */
	_fit( entry ) {

		const rect = entry.root.getBoundingClientRect();
		const w = Math.round( rect.width ), h = Math.round( rect.height );
		if ( w < 2 || h < 2 ) return false;
		// capped at 2: nine canvases of this size every frame are worth a bounded fill rate
		const dpr = Math.min( 2, window.devicePixelRatio || 1 );
		if ( entry.w !== w || entry.h !== h || entry.dpr !== dpr ) {

			entry.w = w;
			entry.h = h;
			entry.dpr = dpr;
			entry.canvas.width = Math.round( w * dpr );
			entry.canvas.height = Math.round( h * dpr );

		}

		entry.ctx.setTransform( dpr, 0, 0, dpr, 0, 0 );
		entry.ctx.clearRect( 0, 0, w, h );
		return true;

	}

}
