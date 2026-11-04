// Keyboard / mouse input with pointer lock support, and the cockpit's two gamepad blocks.
//
// The pads are read natively (navigator.getGamepads), but their wiring is not invented here: the
// cockpit stores two independent blocks in config.json and the scene reads both over GET /api/config.
//   · input.gamepad     → the ROV mesh only: surge / sway / heave / yaw / roll / pitch, plus the
//                         poste's own switches (light, surface, yaw_left, yaw_right…).
//   · input.sim_gamepad → the 3D scene only: the free camera's five axes (surge / sway / heave /
//                         yaw / pitch) and its commands (sim_cam_free, sim_view_internal,
//                         sim_cam_chase, sim_light). The cockpit clones its movement axes into it.
// Same axis and button indices, same per-source invert flags, same per-pad filter (the `pad` key is
// a Gamepad.id) in both. A stick assigned in Paramètres › Manette moves the virtual frame the way it
// moves the real one, and an axis fitted the wrong way round is corrected once, on the cockpit's
// side, with its « inversé » box. The six historic channels keep their meaning: voie1 = surge,
// voie2 = sway, voie3 = heave, voie4 = yaw, voie5 = roll, voie6 = pitch.

const PAD_CONFIG_URL = '/api/config'; // the cockpit's config.json, where both mappings are stored
const PAD_RETRY_MS = 3000; // before the first answer, the read is tried again at this pace
const PAD_STICK_ON = 0.7; // an axis counts as pushed past this (the cockpit's own threshold)
const PAD_BUTTON_ON = 0.5;
// the historical ids (voie1..6) → the named functions of the cockpit's catalogue
const PAD_LEGACY_IDS = { voie1: 'surge', voie2: 'sway', voie3: 'heave', voie4: 'yaw', voie5: 'roll', voie6: 'pitch' };
// « cockpit » block: the functions that drive the ROV mesh; the rest of the catalogue is the poste's
const PAD_ROV_IDS = new Set( [ 'surge', 'sway', 'heave', 'yaw', 'roll', 'pitch', 'yaw_left', 'yaw_right', 'surface', 'light' ] );
// « simulateur » block: the free camera's five axes and the commands of the scene
const PAD_SIM_IDS = new Set( [ 'surge', 'sway', 'heave', 'yaw', 'pitch', 'sim_cam_free', 'sim_view_internal', 'sim_cam_chase', 'sim_light' ] );

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

/** One block's read state: the cockpit's and the simulator's are separate but identical. */
function newPadSet() {

	return {
		ready: false, // the block has answered at least once
		enabled: false, // input.gamepad.enabled / input.sim_gamepad.enabled, the cockpit's switches
		sources: new Map(), // action id → [{ type, index, invert, pad }]
		value: new Map(), // action id → [-1, +1] this frame
		active: new Map(), // action id → pushed / pressed this frame
		pressed: new Set(), // actions whose edge fell this frame (cleared by endFrame)
		held: new Set(), // actions held last frame, for the edges
		count: 0, // pads allowed to drive
		label: '', // short name of the first of them
	};

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

		// ---- the cockpit's two pad blocks, and this frame's read of them
		// shared by both blocks: the cockpit writes them once for all the pads
		this.padCfg = {
			deadzone: 0.08, // input.deadzone
			expo: 1.5, // input.expo
			trackerId: '', // head_tracker.device_id: that pad is never a driving pad
			triedAt: 0,
			busy: false,
		};
		this.pad = newPadSet(); // input.gamepad → the ROV mesh
		this.simPad = newPadSet(); // input.sim_gamepad → free camera, views, projectors
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

	/** Reads the cockpit's mappings once (and again while they have not answered). */
	async loadPadConfig() {

		if ( this.padCfg.busy ) return;
		this.padCfg.busy = true;
		this.padCfg.triedAt = performance.now();
		try {

			const res = await fetch( PAD_CONFIG_URL, { cache: 'no-store' } );
			if ( ! res.ok ) throw new Error( String( res.status ) );
			this.applyPadConfig( await res.json() );

		} catch {

			// no backend behind the page (a stand-alone copy of the scene): the keys keep the frame,
			// and the read is retried so a cockpit that comes back is picked up without a reload

		} finally {

			this.padCfg.busy = false;

		}

	}

	/** Takes the input block as the cockpit stores it: two independent pad mappings. */
	applyPadConfig( cfg ) {

		const input = ( cfg && cfg.input ) || {};
		const cfgPad = this.padCfg;
		const deadzone = Number( input.deadzone ), expo = Number( input.expo );
		cfgPad.deadzone = Number.isFinite( deadzone ) ? clamp( deadzone, 0, 0.5 ) : 0.08;
		cfgPad.expo = Number.isFinite( expo ) && expo > 0 ? expo : 1.5;
		const tracker = input.head_tracker;
		cfgPad.trackerId = tracker && typeof tracker.device_id === 'string' ? tracker.device_id : '';

		this._applyPadBlock( this.pad, input.gamepad, PAD_ROV_IDS );
		this._applyPadBlock( this.simPad, input.sim_gamepad, PAD_SIM_IDS );

	}

	/** One mapping block into one read set; the ids it does not know are left to the poste. */
	_applyPadBlock( set, block, ids ) {

		const mapping = block || {};
		set.enabled = mapping.enabled === true;
		set.sources = new Map();
		const actions = Array.isArray( mapping.actions ) ? mapping.actions : [];
		actions.forEach( ( action ) => {

			if ( ! action || typeof action.id !== 'string' ) return;
			const id = PAD_LEGACY_IDS[ action.id ] || action.id;
			if ( ! ids.has( id ) ) return; // REC, cams, autopilot: the poste's business
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
			if ( clean.length ) set.sources.set( id, ( set.sources.get( id ) || [] ).concat( clean ) );

		} );
		set.ready = true;

	}

	/** One frame of the pads: values, pressed edges, connected names. Called once per frame. */
	pollPads() {

		const cfgPad = this.padCfg;
		const now = performance.now();
		if ( ! ( this.pad.ready && this.simPad.ready ) && ! cfgPad.busy && now - cfgPad.triedAt > PAD_RETRY_MS ) this.loadPadConfig();

		// typing in a panel field or no Gamepad API: the pads are mute, and each block keeps its switch
		const pads = this.enabled && navigator.getGamepads ? this._drivePads() : [];
		this._pollPadSet( this.pad, pads );
		this._pollPadSet( this.simPad, pads );

	}

	/** One block's read against the pads that are allowed to drive. */
	_pollPadSet( set, pads ) {

		set.value.clear();
		set.active.clear();
		set.pressed.clear();
		set.count = 0;
		set.label = '';
		if ( ! set.enabled || ! pads.length ) {

			// that block's switch off, or no pad left: its functions stay silent this frame
			set.held.clear();
			return;

		}

		set.count = pads.length;
		set.label = padShortName( pads[ 0 ].id );
		const held = new Set();
		set.sources.forEach( ( list, id ) => {

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
			set.value.set( id, clamp( value, - 1, 1 ) );
			set.active.set( id, active );
			if ( active ) {

				// a front montant, as the cockpit reads its own buttons: down now, up last frame
				if ( ! set.held.has( id ) ) set.pressed.add( id );
				held.add( id );

			}

		} );
		set.held = held;

	}

	/** Stick response: dead zone, then the cockpit's expo curve; full deflection stays 1. */
	_curve( v ) {

		const a = Math.abs( v );
		if ( a <= this.padCfg.deadzone ) return 0;
		const t = Math.min( 1, ( a - this.padCfg.deadzone ) / ( 1 - this.padCfg.deadzone ) );
		return ( v < 0 ? - 1 : 1 ) * Math.pow( t, this.padCfg.expo );

	}

	/** The pads that may drive: everything but the BOB BL AR head-tracker. */
	_drivePads() {

		const tracker = this.padCfg.trackerId;
		return Array.from( navigator.getGamepads() ).filter( ( pad ) => pad && pad.connected !== false && ! isHeadTracker( pad, tracker ) );

	}

	/**
	 * The ROV's three commands, from the « cockpit » block only. The ROV's channels count positive
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

	/**
	 * The free camera's five axes, from the « simulateur » block only, read the way the mouse and
	 * the keys are: surge / sway / heave translate in the view's own frame (already positive ahead,
	 * starboard and up), yaw turns to starboard, pitch looks up. FlyCamera applies the signs.
	 */
	simCommand() {

		const value = ( id ) => this.simPad.value.get( id ) || 0;
		return {
			surge: value( 'surge' ),
			sway: value( 'sway' ),
			heave: value( 'heave' ),
			yaw: value( 'yaw' ),
			pitch: value( 'pitch' ),
		};

	}

	/** true once per pad press of a ROV function (an edge, like hit for the keys). */
	padHit( id ) {

		return this.enabled && this.pad.pressed.has( id );

	}

	/** true once per pad press of a scene function (free cam, internal view, projectors). */
	simHit( id ) {

		return this.enabled && this.simPad.pressed.has( id );

	}

	/** One line for the settings panel: is a pad driving, and what the cockpit wired on the ROV. */
	padLabel() {

		const pad = this.pad;
		if ( ! pad.ready ) return 'mapping du cockpit en cours de lecture…';
		if ( ! pad.enabled ) return 'manettes désactivées dans le cockpit (Paramètres › Manette)';
		if ( ! navigator.getGamepads ) return 'Gamepad API absente de ce navigateur';
		if ( ! pad.count ) return pad.sources.size ? 'aucune manette détectée' : 'aucune fonction assignée dans le cockpit';
		return pad.label + ' · ' + pad.sources.size + ' fonctions';

	}

	/** The same line for the scene: « Contrôle Simulateur 3D » block. */
	simLabel() {

		const pad = this.simPad;
		if ( ! pad.ready ) return 'mapping du cockpit en cours de lecture…';
		if ( ! pad.enabled ) return 'contrôle simulateur désactivé (Paramètres › Manette)';
		if ( ! navigator.getGamepads ) return 'Gamepad API absente de ce navigateur';
		if ( ! pad.count ) return pad.sources.size ? 'aucune manette détectée' : 'aucune fonction assignée au simulateur';
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
		this.simPad.pressed.clear();

	}

}
