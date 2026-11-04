// Keyboard / mouse input with pointer lock support, and the real cockpit's gamepad.
//
// The pad is read natively (navigator.getGamepads), but its wiring is not invented here: the cockpit
// stores it in config.json under input.gamepad and the simulator reads the same block over
// GET /api/config — same axis and button indices, same per-source invert flags, same per-pad filter
// (the `pad` key is a Gamepad.id). A stick assigned in Paramètres › Manette therefore moves the
// virtual frame the way it moves the real one, and an axis fitted the wrong way round is corrected
// once, on the cockpit's side, with its « inversé » box. The six historic channels keep their
// meaning: voie1 = surge, voie2 = sway, voie3 = heave, voie4 = yaw, voie5 = roll, voie6 = pitch.

const PAD_CONFIG_URL = '/api/config'; // the cockpit's config.json, where the mapping is stored
const PAD_RETRY_MS = 3000; // before the first answer, the read is tried again at this pace
const PAD_STICK_ON = 0.7; // an axis counts as pushed past this (the cockpit's own threshold)
const PAD_BUTTON_ON = 0.5;
// the historical ids (voie1..6) → the named functions of the cockpit's catalogue
const PAD_LEGACY_IDS = { voie1: 'surge', voie2: 'sway', voie3: 'heave', voie4: 'yaw', voie5: 'roll', voie6: 'pitch' };
// the functions the frame drives with; the rest of the catalogue belongs to the poste (REC, cams…)
const PAD_DRIVE_IDS = new Set( [ 'surge', 'sway', 'heave', 'yaw', 'roll', 'pitch', 'yaw_left', 'yaw_right', 'surface', 'light' ] );

const clamp = ( v, a, b ) => ( v < a ? a : v > b ? b : v );

/** The cockpit's short label for a pad (hardware suffix and length trimmed). */
function padShortName( id ) {

	const short = String( id || '' ).replace( /\s*\(.*?\)\s*/g, ' ' ).replace( /\s+/g, ' ' ).trim();
	return short.length > 28 ? short.slice( 0, 26 ) + '…' : short;

}

/** The BOB BL AR never drives the frame: the cockpit filters it out of its own readers too. */
function isHeadTracker( pad, deviceId ) {

	if ( ! pad || ! pad.id ) return false;
	return deviceId ? pad.id === deviceId : pad.id.toUpperCase().includes( 'BOB BL AR' );

}

export class Input {

	constructor( dom ) {

		this.dom = dom;
		this.keys = new Set();
		this.pressed = new Set();
		this.look = { x: 0, y: 0 };
		this.wheel = 0;
		this.mouseDown = false;
		this.rightDown = false;
		this.locked = false;
		this.enabled = true;

		// ---- the real cockpit's gamepad: mapping, and this frame's read of it
		this.pad = {
			ready: false, // config.json has answered at least once
			enabled: false, // input.gamepad.enabled, the cockpit's own switch
			deadzone: 0.08, // input.deadzone
			expo: 1.5, // input.expo
			trackerId: '', // head_tracker.device_id: that pad is never a driving pad
			sources: new Map(), // action id → [{ type, index, invert, pad }]
			value: new Map(), // action id → [-1, +1] this frame
			active: new Map(), // action id → pushed / pressed this frame
			pressed: new Set(), // actions whose edge fell this frame (cleared by endFrame)
			held: new Set(), // actions held last frame, for the edges
			count: 0, // pads allowed to drive
			label: '', // short name of the first of them
			triedAt: 0,
			busy: false,
		};
		this.loadPadConfig();

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.target && ( e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' ) ) return;
			if ( ! this.keys.has( e.code ) ) this.pressed.add( e.code );
			this.keys.add( e.code );
			if ( [ 'Space', 'ArrowUp', 'ArrowDown', 'Tab' ].includes( e.code ) ) e.preventDefault();

		} );
		window.addEventListener( 'keyup', ( e ) => this.keys.delete( e.code ) );
		window.addEventListener( 'blur', () => this.keys.clear() );

		dom.addEventListener( 'mousedown', ( e ) => {

			if ( e.button === 0 ) this.mouseDown = true;
			if ( e.button === 2 ) this.rightDown = true;

		} );
		window.addEventListener( 'mouseup', ( e ) => {

			if ( e.button === 0 ) this.mouseDown = false;
			if ( e.button === 2 ) this.rightDown = false;

		} );
		dom.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );
		window.addEventListener( 'mousemove', ( e ) => {

			if ( this.locked || this.mouseDown || this.rightDown ) {

				this.look.x += e.movementX;
				this.look.y += e.movementY;

			}

		} );
		dom.addEventListener( 'wheel', ( e ) => {

			this.wheel += Math.sign( e.deltaY );
			e.preventDefault();

		}, { passive: false } );

		document.addEventListener( 'pointerlockchange', () => {

			this.locked = document.pointerLockElement === dom;

		} );

	}

	// ---------------------------------------------------------------- gamepad

	/** Reads the cockpit's mapping once (and again while it has not answered). */
	async loadPadConfig() {

		if ( this.pad.busy ) return;
		this.pad.busy = true;
		this.pad.triedAt = performance.now();
		try {

			const res = await fetch( PAD_CONFIG_URL, { cache: 'no-store' } );
			if ( ! res.ok ) throw new Error( String( res.status ) );
			this.applyPadConfig( await res.json() );

		} catch {

			// no backend behind the page (a stand-alone copy of the scene): the keys keep the frame,
			// and the read is retried so a cockpit that comes back is picked up without a reload

		} finally {

			this.pad.busy = false;

		}

	}

	/** Takes the input block as the cockpit stores it. */
	applyPadConfig( cfg ) {

		const input = ( cfg && cfg.input ) || {};
		const gamepad = input.gamepad || {};
		const pad = this.pad;
		const deadzone = Number( input.deadzone ), expo = Number( input.expo );
		pad.deadzone = Number.isFinite( deadzone ) ? clamp( deadzone, 0, 0.5 ) : 0.08;
		pad.expo = Number.isFinite( expo ) && expo > 0 ? expo : 1.5;
		pad.enabled = gamepad.enabled === true;
		pad.trackerId = input.head_tracker && typeof input.head_tracker.device_id === 'string' ? input.head_tracker.device_id : '';

		const sources = new Map();
		const actions = Array.isArray( gamepad.actions ) ? gamepad.actions : [];
		actions.forEach( ( action ) => {

			if ( ! action || typeof action.id !== 'string' ) return;
			const id = PAD_LEGACY_IDS[ action.id ] || action.id;
			if ( ! PAD_DRIVE_IDS.has( id ) ) return; // REC, cams, autopilot: the poste's business
			// `sources` is the current format (one source per pad), `source` the inherited one
			const list = Array.isArray( action.sources ) ? action.sources : action.source ? [ action.source ] : [];
			const clean = [];
			list.forEach( ( source ) => {

				if ( ! source || typeof source !== 'object' ) return;
				clean.push( {
					type: source.type === 'axis' ? 'axis' : 'button',
					index: Math.max( 0, Math.floor( Number( source.index ) ) || 0 ),
					invert: source.invert === true,
					pad: typeof source.pad === 'string' ? source.pad : '',
				} );

			} );
			// the same function wired twice (surge and voie1) keeps both sources, not two entries
			if ( clean.length ) sources.set( id, ( sources.get( id ) || [] ).concat( clean ) );

		} );
		pad.sources = sources;
		pad.ready = true;

	}

	/** One frame of the pads: values, pressed edges, connected names. Called once per frame. */
	pollPads() {

		const pad = this.pad;
		const now = performance.now();
		if ( ! pad.ready && ! pad.busy && now - pad.triedAt > PAD_RETRY_MS ) this.loadPadConfig();

		pad.value.clear();
		pad.active.clear();
		pad.pressed.clear();
		if ( ! this.enabled || ! pad.enabled || ! navigator.getGamepads ) {

			// typing in a panel field, the cockpit's switch off, or no Gamepad API: the pads are mute
			pad.count = 0;
			pad.label = '';
			pad.held.clear();
			return;

		}

		const pads = this._drivePads();
		pad.count = pads.length;
		pad.label = pads.length ? padShortName( pads[ 0 ].id ) : '';
		const held = new Set();
		if ( pads.length ) pad.sources.forEach( ( list, id ) => {

			let value = 0, active = false;
			list.forEach( ( source ) => {

				pads.forEach( ( p ) => {

					if ( source.pad && source.pad !== p.id ) return; // wired for another pad
					if ( source.type === 'axis' ) {

						const raw = clamp( Number( p.axes[ source.index ] ) || 0, - 1, 1 );
						value += this._curve( source.invert ? - raw : raw );
						if ( Math.abs( raw ) > PAD_STICK_ON ) active = true;

					} else {

						const button = p.buttons[ source.index ];
						const raw = button ? ( button.pressed ? 1 : clamp( Number( button.value ) || 0, 0, 1 ) ) : 0;
						value += source.invert ? - raw : raw;
						if ( raw > PAD_BUTTON_ON ) active = true;

					}

				} );

			} );
			pad.value.set( id, clamp( value, - 1, 1 ) );
			pad.active.set( id, active );
			if ( active ) {

				// a front montant, as the cockpit reads its own buttons: down now, up last frame
				if ( ! pad.held.has( id ) ) pad.pressed.add( id );
				held.add( id );

			}

		} );
		pad.held = held;

	}

	/** Stick response: dead zone, then the cockpit's expo curve; full deflection stays 1. */
	_curve( v ) {

		const a = Math.abs( v );
		if ( a <= this.pad.deadzone ) return 0;
		const t = Math.min( 1, ( a - this.pad.deadzone ) / ( 1 - this.pad.deadzone ) );
		return ( v < 0 ? - 1 : 1 ) * Math.pow( t, this.pad.expo );

	}

	/** The pads that may drive: everything but the BOB BL AR head-tracker. */
	_drivePads() {

		const tracker = this.pad.trackerId;
		return Array.from( navigator.getGamepads() ).filter( ( pad ) => pad && pad.connected !== false && ! isHeadTracker( pad, tracker ) );

	}

	/**
	 * The frame's three commands, from the pilot's own wiring. The ROV's channels count positive
	 * surge ahead, positive heave up and positive yaw to starboard; the frame counts yaw the other
	 * way (steer positive swings the bow to port, like A), so that one turns over here. The held
	 * « Retour surface » button is the cockpit's own priority and adds full rise.
	 */
	padCommand() {

		const value = ( id ) => this.pad.value.get( id ) || 0;
		const on = ( id ) => this.pad.active.get( id ) === true;
		const steer = - value( 'yaw' ) + ( on( 'yaw_left' ) ? 1 : 0 ) - ( on( 'yaw_right' ) ? 1 : 0 );
		return {
			throttle: value( 'surge' ),
			steer: clamp( steer, - 1, 1 ),
			vertical: clamp( value( 'heave' ) + ( on( 'surface' ) ? 1 : 0 ), - 1, 1 ),
		};

	}

	/** true once per pad press of a function (an edge, like hit for the keys). */
	padHit( id ) {

		return this.enabled && this.pad.pressed.has( id );

	}

	/** One line for the settings panel: is a pad driving, and what the cockpit wired on it. */
	padLabel() {

		const pad = this.pad;
		if ( ! pad.ready ) return 'mapping du cockpit en cours de lecture…';
		if ( ! pad.enabled ) return 'manettes désactivées dans le cockpit (Paramètres › Manette)';
		if ( ! navigator.getGamepads ) return 'Gamepad API absente de ce navigateur';
		if ( ! pad.count ) return pad.sources.size ? 'aucune manette détectée' : 'aucune fonction assignée dans le cockpit';
		return pad.label + ' · ' + pad.sources.size + ' fonctions';

	}

	requestLock() {

		if ( ! this.locked ) this.dom.requestPointerLock?.()?.catch?.( () => {} );

	}

	down( code ) {

		return this.enabled && this.keys.has( code );

	}

	// true once per physical key press
	hit( code ) {

		return this.enabled && this.pressed.has( code );

	}

	consumeLook() {

		const l = { x: this.look.x, y: this.look.y };
		this.look.x = 0;
		this.look.y = 0;
		return l;

	}

	consumeWheel() {

		const w = this.wheel;
		this.wheel = 0;
		return w;

	}

	endFrame() {

		this.pressed.clear();
		this.pad.pressed.clear();

	}

}
