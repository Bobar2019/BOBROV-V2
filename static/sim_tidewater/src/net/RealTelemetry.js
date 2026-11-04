// The real vehicle behind the bench. The cockpit relays its telemetry frames over the backend
// (/api/system/telemetry, the very route static/app.js polls on the HUD), and only the attitude is
// taken from them: the frame carries no position sensor, so depth, thrusters, pack, probe and
// currents stay the simulator's. A vehicle whose IMU is missing does not upset that — the quaternion
// is then useless (or the route silent), and everything below stays in simulation.
//
// What it hands out is written straight into RovController, which both the onboard camera and the
// 3D model read: the FPV then follows the real frame's roll, pitch and heading, and so does the
// model seen from the free camera. The keys keep the frame whenever the real one lies level and
// still — a pilot nudging the sticks with the vehicle flat should still be able to fly it about the
// simulator — and take it back the moment it moves again.
//
// The sense of the three axes is the scene's own (simulator.real.invert, the switches of the
// "ROV réel" folder in the settings): the cockpit's switches correct its HUD over the video feed,
// which is a different thing from the way the model lies in the 3D scene. The correction is made
// here, once, before the pose — the model, the onboard camera and the instruments then all agree,
// and the cockpit's own settings stay on the cockpit's side.

const URL = '/api/system/telemetry';
const CONFIG_URL = '/api/config'; // the cockpit's config.json, where the scene's sense is stored
const AXES = [ 'roll', 'pitch', 'heading' ];
const POLL_MS = 150; // the cockpit's own cadence (HUD_POLL_MS in static/app.js)
const TIMEOUT_MS = 1200; // a hung request must not stop the polling for good
const LIVE_S = 2.5; // the cockpit's window before a frame counts as stale (HUD_LIVE_WINDOW_MS)
const SMOOTH_HZ = 8; // the angles are interpolated between two frames (~0.12 s)
// a frame parked on a bench is never dead level — the vehicle on the desk sits at about 2° of list
const LEVEL_DEG = 5; // |roll| and |pitch| under this: the real frame lies level
const RATE_DEG = 2; // and turns slower than this (°/s)...
const STILL_S = 0.5; // ...for that long, and the keys get the frame back

const RAD = 180 / Math.PI;
const clamp = ( v, a, b ) => ( v < a ? a : v > b ? b : v );
const wrapPi = ( a ) => Math.atan2( Math.sin( a ), Math.cos( a ) );

// The telemetry's attitude, as the cockpit decodes and draws it (hudFrameFromTelemetry in
// static/app.js): roll positive with the starboard side down, pitch positive on the nose up, yaw
// positive turning to starboard. The frame is posed the other way round on two of them — pitch
// positive on the nose down, yaw positive to port — so those turn over here; roll keeps its sign.
const ROLL_SIGN = 1;
const PITCH_SIGN = - 1;
const YAW_SIGN = - 1;
// the scene's switches (saveInvert) flip any of them: they turn the model the other way round in the
// 3D scene, they do not re-read the sensor.

/** The cockpit's decode: a unit quaternion to roll, pitch and yaw (radians). */
function decode( q ) {

	let w = Number( q[ 0 ] ), x = Number( q[ 1 ] ), y = Number( q[ 2 ] ), z = Number( q[ 3 ] );
	const n = Math.hypot( w, x, y, z );
	if ( ! ( n > 0 ) ) return { pitch: 0, roll: 0, yaw: 0 };
	w /= n;
	x /= n;
	y /= n;
	z /= n;
	return {
		roll: Math.atan2( 2 * ( w * x + y * z ), 1 - 2 * ( x * x + y * y ) ),
		pitch: Math.asin( clamp( 2 * ( w * y - z * x ), - 1, 1 ) ),
		yaw: Math.atan2( 2 * ( w * z + x * y ), 1 - 2 * ( y * y + z * z ) ),
	};

}

export class RealTelemetry {

	constructor() {

		this.enabled = true; // the menu's switch: off, the frame is the simulator's alone
		this.invert = { roll: false, pitch: false, heading: false }; // the scene's own axis sense
		this._sign = { roll: 1, pitch: 1, heading: 1 }; // the same, as ±1 applied at the decode
		this._configAt = 0; // performance.now() of the read; 0 until config.json answers
		this._triedAt = 0;
		this._configBusy = false;
		this.state = 'off'; // 'off' (nothing heard) | 'live' | 'lost'
		this.ageS = Infinity; // seconds since the vehicle stamped the frame held
		this._askedAt = 0; // when the last poll went out
		this._inflight = false;
		this._heard = false; // at least one usable frame since the start
		this._at = 0; // performance.now() of that frame
		this._stamp = 0; // its own age, as the route reported it

		this._raw = null; // last decoded angles (rad, the telemetry's own frame)
		this._rawAt = 0;
		this._target = { pitch: 0, roll: 0, yaw: 0 }; // the same, in the frame's own frame
		this._att = { pitch: 0, roll: 0, yaw: 0 }; // smoothed: what the controller is posed with
		this._valid = false; // _att holds a sample
		this._still = STILL_S; // seconds the real frame has been level and still
		this._moving = false;
		this._wasDriving = false;

		this.loadInvert();

	}

	// ── one frame ───────────────────────────────────────────────────────────

	update( dt ) {

		if ( ! this.enabled ) {

			this.state = 'off';
			this._moving = false;
			this._valid = false;
			return;

		}

		const now = performance.now();
		// config.json not read yet (standalone copy, backend not up): try again, gently
		if ( ! this._configAt && now - this._triedAt > 3000 ) this.loadInvert();
		if ( ! this._inflight && now - this._askedAt >= POLL_MS ) this._poll();

		this.ageS = this._heard ? this._stamp + ( now - this._at ) / 1000 : Infinity;
		if ( ! ( this.ageS <= LIVE_S ) ) {

			// nothing usable (standalone, no vehicle, or the frames stopped): the simulation's own
			// motion stands, untouched
			this.state = this._heard ? 'lost' : 'off';
			this._moving = false;
			this._valid = false;
			return;

		}

		this.state = 'live';
		const acquiring = this._moving && ! this._wasDriving;
		this._wasDriving = this._moving;
		if ( ! this._moving || acquiring || ! this._valid ) {

			// the keys hold the frame (or are just taking it back, or just handing it over, or the
			// first frame after a gap): mirror the samples exactly — the handover then starts from
			// the very frame the vehicle sent, not from the tail of an interpolation
			this._att.pitch = this._target.pitch;
			this._att.roll = this._target.roll;
			this._att.yaw = this._target.yaw;
			this._valid = true;
			return;

		}

		// interpolate: the route answers some seven times a second, well under the frame rate
		const k = 1 - Math.exp( - dt * SMOOTH_HZ );
		this._att.pitch += ( this._target.pitch - this._att.pitch ) * k;
		this._att.roll += ( this._target.roll - this._att.roll ) * k;
		this._att.yaw += wrapPi( this._target.yaw - this._att.yaw ) * k;

	}

	/** The attitude to pose the frame with (radians, the controller's own convention), or null. */
	attitude() {

		return this.driving ? this._att : null;

	}

	/** True while the telemetry really poses the frame: the level-and-still test gave way. */
	get driving() {

		return this.state === 'live' && this._moving && this._valid;

	}

	// ── the scene's own axis sense ──────────────────────────────────────────

	/** Reads the scene's axis sense (simulator.real.invert); silent, and retried until it answers. */
	async loadInvert() {

		if ( this._configBusy ) return;
		this._configBusy = true;
		this._triedAt = performance.now();
		try {

			const res = await fetch( CONFIG_URL, { cache: 'no-store' } );
			if ( ! res.ok ) throw new Error( String( res.status ) );
			const cfg = await res.json();
			const sense = ( cfg && cfg.simulator && cfg.simulator.real && cfg.simulator.real.invert ) || {};
			for ( const axis of AXES ) this.invert[ axis ] = sense[ axis ] === true;
			this._syncSigns();
			this._configAt = performance.now();

		} catch {

			// standalone (no backend), or the route is down: the switches start off, the read retries

		} finally {

			this._configBusy = false;

		}

	}

	/** Stores the sense the switches just gave in config.json, then mirrors the frame held at once. */
	async saveInvert() {

		this._syncSigns();
		try {

			const res = await fetch( CONFIG_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { simulator: { real: { invert: {
					roll: this.invert.roll, pitch: this.invert.pitch, heading: this.invert.heading,
				} } } } ),
			} );
			if ( ! res.ok ) throw new Error( String( res.status ) );

		} catch {

			// the switch still holds for this session: config.json is out of reach right now

		}

	}

	/** Applies ±1 to each axis; a flip mirrors the sample held instead of swinging to the new one. */
	_syncSigns() {

		for ( const axis of AXES ) {

			const sign = this.invert[ axis ] ? - 1 : 1;
			if ( sign === this._sign[ axis ] ) continue;
			this._sign[ axis ] = sign;
			// the switch is named after the heading, the sample after its yaw
			const field = axis === 'heading' ? 'yaw' : axis;
			this._att[ field ] = - this._att[ field ];
			this._target[ field ] = - this._target[ field ];

		}

	}

	// ── the link (menu rows, HUD badge) ─────────────────────────────────────

	/** Forgets the sample held: the switch was flicked, the next frames start from scratch. */
	restart() {

		this._heard = false;
		this._raw = null;
		this._valid = false;
		this._still = STILL_S;
		this._moving = false;
		this._wasDriving = false;
		this.state = 'off';
		this.ageS = Infinity;

	}

	linkLabel() {

		return this.state === 'live' ? 'Directe' : this.state === 'lost' ? 'Perdue' : 'Hors ligne';

	}

	ageLabel() {

		return this.ageS === Infinity ? '—' : `${ this.ageS.toFixed( 1 ) } s`;

	}

	/** Who holds the frame: the telemetry, the keys over a level and still vehicle, or neither. */
	driveLabel() {

		return this.driving ? 'Télémétrie' : this.state === 'live' ? 'Clavier (à plat)' : 'Simulée';

	}

	// ── the route ───────────────────────────────────────────────────────────

	async _poll() {

		this._askedAt = performance.now();
		this._inflight = true;
		const ac = typeof AbortController === 'function' ? new AbortController() : null;
		const timer = ac ? setTimeout( () => ac.abort(), TIMEOUT_MS ) : 0;
		try {

			const res = await fetch( URL, { cache: 'no-store', signal: ac ? ac.signal : undefined } );
			if ( ! res.ok ) throw new Error( String( res.status ) );
			this._accept( await res.json() );

		} catch {

			// no backend (a standalone copy of the simulator) or a route that is not answering:
			// `ageS` climbs and the frame goes back to the simulator's own motion

		} finally {

			clearTimeout( timer );
			this._inflight = false;

		}

	}

	_accept( data ) {

		const t = data && data.telemetry;
		const q = t && t.quat;
		if ( ! q || q.length < 4 ) return;

		const raw = decode( q );
		const now = performance.now();
		this._heard = true;
		this._at = now;
		this._stamp = Number( t.age_s ) || 0;
		this._target.pitch = this._sign.pitch * PITCH_SIGN * raw.pitch;
		this._target.roll = this._sign.roll * ROLL_SIGN * raw.roll;
		this._target.yaw = this._sign.heading * YAW_SIGN * raw.yaw;
		this._motion( raw, now );

	}

	// Level and still: the real frame is not doing anything the pilot did not ask for, so the keys
	// may have it. Anything else — a list, a turn, a swell rolling it — and the telemetry has it.
	_motion( raw, now ) {

		const dt = this._raw ? Math.max( 1e-3, ( now - this._rawAt ) / 1000 ) : 0;
		let rate = 0;
		if ( this._raw ) {

			rate = Math.max(
				Math.abs( raw.roll - this._raw.roll ),
				Math.abs( raw.pitch - this._raw.pitch ),
				Math.abs( wrapPi( raw.yaw - this._raw.yaw ) ),
			) * RAD / dt;

		}

		const level = Math.abs( raw.roll ) * RAD <= LEVEL_DEG && Math.abs( raw.pitch ) * RAD <= LEVEL_DEG;
		if ( level && rate <= RATE_DEG ) this._still += dt;
		else this._still = 0;
		this._moving = this._still < STILL_S;

		this._raw = raw;
		this._rawAt = now;

	}

}
