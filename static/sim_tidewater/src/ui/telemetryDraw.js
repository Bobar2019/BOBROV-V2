// The cockpit's instruments, drawn exactly as static/app.js draws them: same geometry, same
// alphas, same font. What moves is where the style comes from — the cockpit keeps the stroke
// colour, the weight and the text scale in HUD.layout and sets them per instrument inside its
// render loop; here they travel with the call, in `s = { color, weight, font }`, so one module
// can serve several screens with their own settings.
//
//   drawHorizon / drawHeading / drawDepth   the flight instruments
//   drawTemperature / drawMotors / drawGrip  the vehicle's own instruments
//   drawVoltage / drawMotorV / drawMotorH    the bar gauges (drawBarGauge)

const HUD_WARN = '#ffb300';
const HUD_DANGER = '#ff2d2d';
const HUD_MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

export const HUD_COLOR = '#00d9ff';

export const clamp = ( v, a, b ) => ( v < a ? a : v > b ? b : v );
export const normalize360 = ( deg ) => ( ( deg % 360 ) + 360 ) % 360;

/** Blend of two "#rrggbb" colours (t = 0 → a, t = 1 → b). */
function mixColor( a, b, t ) {

	const ca = parseInt( a.slice( 1 ), 16 ), cb = parseInt( b.slice( 1 ), 16 );
	const mix = ( shift ) => Math.round( ( ( ca >> shift ) & 255 ) * ( 1 - t ) + ( ( cb >> shift ) & 255 ) * t );
	return '#' + ( ( 1 << 24 ) + ( mix( 16 ) << 16 ) + ( mix( 8 ) << 8 ) + mix( 0 ) ).toString( 16 ).slice( 1 );

}

/** French cardinal points every 45° (O = Ouest), tens of degrees otherwise. */
function compassLabel( deg ) {

	const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };
	if ( cardinals[ deg ] ) return cardinals[ deg ];
	return String( Math.round( deg / 10 ) ).padStart( 2, '0' );

}

// ── pen (hudGlow / hudText in app.js) ────────────────────────────────────────

export function glow( c, s, blur = 6, color = s.color ) {

	c.shadowColor = color;
	c.shadowBlur = blur;

}

export function text( c, s, str, x, y, size, align = 'left', color = s.color ) {

	c.font = '600 ' + ( size * s.font ).toFixed( 1 ) + 'px ' + HUD_MONO;
	c.textAlign = align;
	c.textBaseline = 'middle';
	c.fillStyle = color;
	c.fillText( str, x, y );

}

// ── artificial horizon ─────────────────────────────────────────────────────

/** Pitch ladder turning with the roll, over the fixed frame of the vehicle. */
export function drawHorizon( c, s, w, h, f ) {

	const cx = w / 2;
	const cy = h / 2;
	const radius = Math.min( w, h ) * 0.44;
	const ppd = radius / 32; // pixels per degree (±32° visible)

	c.save();
	glow( c, s, 8 );
	c.strokeStyle = s.color;
	c.lineWidth = 1.4 * s.weight;
	c.beginPath();
	c.arc( cx, cy, radius, 0, Math.PI * 2 );
	c.stroke();
	c.clip();

	// pitch ladder: turns with the roll, slides with the pitch
	c.translate( cx, cy );
	c.rotate( - f.roll * Math.PI / 180 );
	const yHorizon = f.pitch * ppd;
	c.lineWidth = 1.8 * s.weight;
	c.beginPath();
	c.moveTo( - radius, yHorizon );
	c.lineTo( radius, yHorizon );
	c.stroke();
	for ( let d = 5; d <= 30; d += 5 ) {

		const major = d % 10 === 0;
		const half = radius * ( major ? 0.36 : 0.17 );
		c.lineWidth = 1.2 * s.weight;
		[ - 1, 1 ].forEach( ( sign ) => {

			const y = yHorizon + sign * d * ppd;
			c.globalAlpha = major ? 0.85 : 0.45;
			c.beginPath();
			c.moveTo( - half, y );
			c.lineTo( half, y );
			c.stroke();
			if ( major ) {

				c.globalAlpha = 0.9;
				text( c, s, String( d ), - half - 9, y, 8.5, 'center' );
				text( c, s, String( d ), half + 9, y, 8.5, 'center' );

			}

		} );

	}

	c.globalAlpha = 1;
	c.restore();

	// fixed reticle of the vehicle (wings + dot) and roll index
	c.save();
	c.translate( cx, cy );
	glow( c, s, 7 );
	c.strokeStyle = s.color;
	c.lineWidth = 2.2 * s.weight;
	c.beginPath();
	c.moveTo( - radius * 0.52, 0 );
	c.lineTo( - radius * 0.18, 0 );
	c.moveTo( radius * 0.18, 0 );
	c.lineTo( radius * 0.52, 0 );
	c.stroke();
	c.beginPath();
	c.arc( 0, 0, 2.4, 0, Math.PI * 2 );
	c.fillStyle = s.color;
	c.fill();
	c.beginPath();
	c.moveTo( 0, - radius );
	c.lineTo( - 5, - radius + 10 );
	c.lineTo( 5, - radius + 10 );
	c.closePath();
	c.fill();
	c.restore();

}

/** Heading ribbon: value in the middle, ticks every 5°, cardinals every 45°. */
export function drawHeading( c, s, w, h, f ) {

	const yaw = normalize360( f.yaw );
	const px = w / 110; // ±55° visible
	const cy = h - Math.max( 7, h * 0.24 ); // baseline of the ribbon, bottom of the box
	c.save();
	glow( c, s, 6 );
	text( c, s, String( Math.round( yaw ) % 360 ).padStart( 3, '0' ) + '°',
		w / 2, Math.max( 7, h * 0.3 ), clamp( h * 0.34, 9, 18 ), 'center' );
	c.strokeStyle = s.color;
	c.lineWidth = 1.2 * s.weight;
	c.beginPath();
	c.moveTo( 0, cy );
	c.lineTo( w, cy );
	c.stroke();

	for ( let tick = Math.ceil( ( yaw - 55 ) / 5 ) * 5; tick <= yaw + 55; tick += 5 ) {

		const x = w / 2 + ( tick - yaw ) * px;
		if ( x < - 8 || x > w + 8 ) continue;
		const heading = normalize360( tick );
		const cardinal = heading % 45 === 0; // N, NE, E, SE, S, SO, O, NO
		const major = cardinal || heading % 15 === 0;
		c.globalAlpha = cardinal ? 1 : ( major ? 0.75 : 0.4 );
		const tickH = major ? Math.max( 4, h * ( cardinal ? 0.12 : 0.1 ) ) : Math.max( 3, h * 0.06 );
		c.beginPath();
		c.moveTo( x, cy );
		c.lineTo( x, cy + tickH );
		c.stroke();
		c.globalAlpha = 1;
		if ( cardinal || heading % 30 === 0 ) {

			text( c, s, compassLabel( heading ), x, Math.min( h - 5, cy + tickH + 5 ),
				cardinal ? clamp( h * 0.18, 7.5, 11 ) : clamp( h * 0.16, 6.5, 10 ), 'center' );

		}

	}

	// centre cursor on the live heading
	c.beginPath();
	c.moveTo( w / 2, cy - 3 );
	c.lineTo( w / 2 - 5, cy - 11 );
	c.lineTo( w / 2 + 5, cy - 11 );
	c.closePath();
	c.fillStyle = s.color;
	c.fill();
	c.restore();

}

/** Depth: scrolling tape, the numbered scale sliding under a fixed index. The hue turns red as
    the max depth closes in and the whole gauge pulses within 2 m of it. */
export function drawDepth( c, s, w, h, f ) {

	const blinkM = 2; // the gauge pulses within 2 m of the max depth
	const depth = Math.max( 0, f.depth );
	const max = clamp( Number( f.max ) || 40, 5, 500 );
	const heat = clamp( ( depth / max - 0.5 ) / 0.5, 0, 1 ); // turns red from half the range
	const color = mixColor( s.color, HUD_DANGER, heat );
	const now = performance.now();
	const blink = depth >= max - blinkM
		? 0.3 + 0.7 * ( 0.5 + 0.5 * Math.sin( now * 0.01 ) ) // ≈ 1.6 Hz
		: 1;

	const top = clamp( h * 0.22, 34, 46 );
	const bottom = h - 6;
	const rubH = Math.max( 16, bottom - top );
	const xAxis = Math.round( w * 0.5 ); // axis of the tape
	const yIndex = ( top + bottom ) / 2; // fixed index
	const span = clamp( max, 5, 20 ); // visible range of the tape (m)
	const pxm = rubH / span;
	const labelStep = span >= 15 ? 5 : ( span >= 7 ? 2 : 1 );
	const minorStep = ( pxm >= 7.5 && labelStep > 1 ) ? 1 : labelStep;
	const fs = clamp( h * 0.028, 7.5, 12 );
	// fade towards the edges: the drum effect of the tape
	const fade = ( y ) => 1 - 0.72 * Math.pow( clamp( Math.abs( y - yIndex ) / ( rubH / 2 ), 0, 1 ), 2 );
	const alpha = ( a ) => {

		c.globalAlpha = a * blink;

	};

	c.save();
	c.strokeStyle = color;
	c.fillStyle = color;
	c.lineWidth = 1.1 * s.weight;

	// digital read-out (legible even while the gauge pulses), under the "PROF" header
	const profY = fs * 0.7 + 2;
	alpha( 0.7 );
	text( c, s, 'PROF', 4, profY, fs, 'left', color );
	alpha( 1 );
	text( c, s, depth.toFixed( 1 ).replace( '.', ',' ) + ' m', 4, profY + fs * 0.7 + 12, 16, 'left', color );
	glow( c, s, 6, color );

	// axis of the tape
	alpha( 0.45 );
	c.beginPath();
	c.moveTo( xAxis, top );
	c.lineTo( xAxis, bottom );
	c.stroke();

	// sliding ticks: value v sits at y = yIndex + (v − depth)·pxm
	const vHi = depth - ( yIndex - top + 14 ) / pxm;
	const vLo = depth + ( bottom - yIndex + 14 ) / pxm;
	for ( let v = Math.ceil( vHi / minorStep ) * minorStep; v <= vLo; v += minorStep ) {

		if ( v < 0 || v >= max ) continue; // nothing above the surface nor past the max
		const y = yIndex + ( v - depth ) * pxm;
		const major = Math.abs( v % labelStep ) < 0.001;
		alpha( ( major ? 0.85 : 0.4 ) * fade( y ) );
		const half = major ? 11 : 6;
		c.beginPath();
		c.moveTo( xAxis - half, y );
		c.lineTo( xAxis + half, y );
		c.stroke();
		if ( major ) text( c, s, String( Math.round( v ) ), xAxis + 15, y, fs, 'left', color );

	}

	// surface (0 m): a heavier mark
	const ySurface = yIndex + ( 0 - depth ) * pxm;
	if ( ySurface > top - 8 && ySurface < bottom + 8 ) {

		alpha( 0.75 * fade( clamp( ySurface, top, bottom ) ) );
		c.lineWidth = 1.6 * s.weight;
		c.beginPath();
		c.moveTo( xAxis - 16, ySurface );
		c.lineTo( xAxis + 16, ySurface );
		c.stroke();
		c.lineWidth = 1.1 * s.weight;

	}

	// max depth: the limit climbs towards the index as it closes in
	const yMax = yIndex + ( max - depth ) * pxm;
	if ( yMax > top - 8 && yMax < bottom + 8 ) {

		c.strokeStyle = HUD_DANGER;
		alpha( 0.9 * fade( clamp( yMax, top, bottom ) ) );
		c.lineWidth = 1.6 * s.weight;
		c.beginPath();
		c.moveTo( xAxis - 16, yMax );
		c.lineTo( xAxis + 16, yMax );
		c.stroke();
		text( c, s, 'MAX', xAxis + 15, yMax, fs, 'left', HUD_DANGER );
		c.strokeStyle = color;
		c.lineWidth = 1.1 * s.weight;

	}

	// fixed index: sight line and the chevrons that frame the axis
	alpha( 0.6 );
	c.beginPath();
	c.moveTo( xAxis - 30, yIndex );
	c.lineTo( xAxis + 30, yIndex );
	c.stroke();
	c.fillStyle = color;
	alpha( 0.95 );
	c.beginPath();
	c.moveTo( xAxis - 9, yIndex );
	c.lineTo( xAxis - 18, yIndex - 6 );
	c.lineTo( xAxis - 18, yIndex + 6 );
	c.closePath();
	c.fill();
	c.beginPath();
	c.moveTo( xAxis + 9, yIndex );
	c.lineTo( xAxis + 18, yIndex - 6 );
	c.lineTo( xAxis + 18, yIndex + 6 );
	c.closePath();
	c.fill();
	c.restore();

}

/** Water temperature (°C), a standalone element. */
export function drawTemperature( c, s, w, h, f ) {

	const size = clamp( h * 0.36, 9, 15 );
	c.save();
	glow( c, s, 6 );
	text( c, s, 'T ' + f.temperature.toFixed( 1 ).replace( '.', ',' ) + ' °C', 4, h / 2, size, 'left' );
	c.restore();

}

// ── thruster diagram (top view, nose to the right) ─────────────────────────

/** Default labels of the 8 thrusters (firmware geometry): the diagram only shows the short
    number, the thrust in % sits next to each duct. */
const MOTOR_LABELS = [ 'M1 H Av-D', 'M2 H Ar-D', 'M3 H Ar-G', 'M4 H Av-G',
	'M5 V Av-D', 'M6 V Ar-D', 'M7 V Ar-G', 'M8 V Av-G' ];

/* Diagram positions and positive thrust (screen vector) per motor, from the firmware's mixer:
   4 horizontals in an X at 45°, 4 verticals positive on the way up.
   Screen frame: x = forward (right), y = port (up) ⇒ starboard = down. */
const ROV_MOTORS = [
	{ x: + 1.72, y: - 1.02, dx: + 0.707, dy: + 0.707, vert: false }, // M1 H Av-D
	{ x: - 1.72, y: - 1.02, dx: - 0.707, dy: + 0.707, vert: false }, // M2 H Ar-D
	{ x: - 1.72, y: + 1.02, dx: - 0.707, dy: - 0.707, vert: false }, // M3 H Ar-G
	{ x: + 1.72, y: + 1.02, dx: + 0.707, dy: - 0.707, vert: false }, // M4 H Av-G
	{ x: + 0.92, y: - 0.42, dx: 0, dy: + 1, vert: true }, // M5 V Av-D
	{ x: - 0.92, y: - 0.42, dx: 0, dy: + 1, vert: true }, // M6 V Ar-D
	{ x: - 0.92, y: + 0.42, dx: 0, dy: + 1, vert: true }, // M7 V Ar-G
	{ x: + 0.92, y: + 0.42, dx: 0, dy: + 1, vert: true }, // M8 V Av-G
];

/** Fixed bounding box (frame, ducts, max arrows, texts): the framing never moves. */
const ROV_BOX = { minX: - 3.2, maxX: 3.2, minY: - 1.95, maxY: 1.95 };
const ROV_R = 0.34; // duct radius
const ROV_BLADE = 0.3; // blade length
const ROV_HULL = [ // frame outline (bevelled nose on the right)
	[ - 2.1, - 1.42 ], [ 1.7, - 1.42 ], [ 2.1, - 0.9 ], [ 2.1, 0.9 ], [ 1.7, 1.42 ], [ - 2.1, 1.42 ],
];

/** Blade phases (rad) and timestamp of the last paint: the props keep turning between frames. */
const ROV_SPIN = [ 0, 0.9, 1.8, 2.7, 0.45, 1.35, 2.25, 3.15 ];
let rovSpinMs = 0;

/** Thrust arrow (pixels): shaft and two barbs. */
function rovArrow( c, x0, y0, ux, uy, len, size ) {

	const x1 = x0 + ux * len;
	const y1 = y0 + uy * len;
	const nx = - uy;
	const ny = ux;
	c.beginPath();
	c.moveTo( x0, y0 );
	c.lineTo( x1, y1 );
	c.moveTo( x1, y1 );
	c.lineTo( x1 - ux * size + nx * size * 0.55, y1 - uy * size + ny * size * 0.55 );
	c.moveTo( x1, y1 );
	c.lineTo( x1 - ux * size - nx * size * 0.55, y1 - uy * size - ny * size * 0.55 );
	c.stroke();

}

/** Echo PWM (µs) → normalised command [−1, +1] around the 1 500 µs neutral. */
const pwmToThrust = ( us ) => clamp( ( Number( us ) - 1500 ) / 500, - 1, 1 );

/**
 * The 8 thrusters seen from above, nose to the right: wire frame, duct + 3-blade prop per motor
 * (direction and speed follow the command), thrust arrow proportional to |command| in the
 * direction of the mixer; amber near the stop, number and command in % beside each duct.
 */
export function drawMotors( c, s, w, h, f ) {

	const pwm = ( f.pwm && f.pwm.length >= 8 ) ? f.pwm : new Array( 16 ).fill( 1500 );
	const padX = clamp( w * 0.02, 4, 10 );
	const header = clamp( h * 0.11, 10, 16 );

	// command per motor; the blades advance (clockwise if t > 0)
	const now = performance.now();
	const dt = rovSpinMs ? clamp( ( now - rovSpinMs ) / 1000, 0, 0.12 ) : 0;
	rovSpinMs = now;
	const thrusts = [];
	let active = 0;
	for ( let i = 0; i < 8; i += 1 ) {

		const t = pwmToThrust( pwm[ i ] );
		thrusts.push( t );
		if ( Math.abs( t ) > 0.05 ) active += 1;
		if ( Math.abs( t ) > 0.02 ) ROV_SPIN[ i ] -= t * ( 0.8 + 5 * Math.abs( t ) ) * dt;

	}

	// framing: fixed box under the title; the font is bounded by the scale so labels and arrows
	// never cross in small boxes
	const availW = Math.max( 8, w - padX * 2 );
	const availH = Math.max( 8, h - header - padX );
	const bw = ROV_BOX.maxX - ROV_BOX.minX;
	const bh = ROV_BOX.maxY - ROV_BOX.minY;
	const scale = Math.min( availW / bw, availH / bh );
	const fs = clamp( Math.min( h * 0.06, scale * 0.22 ), 6.2, 9 );
	const ox = padX + ( availW - bw * scale ) / 2 - ROV_BOX.minX * scale;
	const oy = header + padX + ( availH - bh * scale ) / 2 + ROV_BOX.maxY * scale;
	const px = ( x ) => ox + x * scale;
	const py = ( y ) => oy - y * scale; // image y is inverted

	c.save();
	glow( c, s, 5 );
	text( c, s, 'MOTEURS M1–M8', padX, header * 0.6, fs, 'left' );
	text( c, s, active + ' ACTIFS', w - padX, header * 0.6, fs, 'right' );
	if ( scale < 3 ) {

		c.restore();
		return;

	}

	// frame: outline, centreline and central compartment (faint)
	c.strokeStyle = s.color;
	c.lineWidth = 1.3 * s.weight;
	c.lineJoin = 'round';
	c.globalAlpha = 0.7;
	c.beginPath();
	ROV_HULL.forEach( ( [ hx, hy ], k ) => ( k ? c.lineTo( px( hx ), py( hy ) ) : c.moveTo( px( hx ), py( hy ) ) ) );
	c.closePath();
	c.stroke();
	c.lineWidth = 1 * s.weight;
	c.globalAlpha = 0.2;
	c.beginPath();
	c.moveTo( px( - 2.1 ), py( 0 ) );
	c.lineTo( px( 2.1 ), py( 0 ) );
	c.stroke();
	c.globalAlpha = 0.32;
	c.beginPath();
	c.rect( px( - 0.42 ), py( 0.26 ), 0.84 * scale, 0.52 * scale );
	c.stroke();

	// the 8 thrusters: duct, animated prop, thrust arrow, label
	for ( let i = 0; i < 8; i += 1 ) {

		const m = ROV_MOTORS[ i ];
		const t = thrusts[ i ];
		const color = Math.abs( t ) > 0.85 ? HUD_WARN : s.color;
		const cx = px( m.x );
		const cy = py( m.y );
		c.strokeStyle = color;
		glow( c, s, 5, color );

		if ( ! m.vert ) { // prop axis: materialises the 45° "X"

			c.globalAlpha = 0.3;
			c.lineWidth = 1 * s.weight;
			c.beginPath();
			c.moveTo( px( m.x - m.dx * 0.22 ), py( m.y - m.dy * 0.22 ) );
			c.lineTo( px( m.x + m.dx * 0.22 ), py( m.y + m.dy * 0.22 ) );
			c.stroke();

		}

		c.globalAlpha = 0.45; // duct
		c.lineWidth = 1 * s.weight;
		c.beginPath();
		c.arc( cx, cy, ROV_R * scale, 0, Math.PI * 2 );
		c.stroke();

		c.globalAlpha = 0.85; // prop (3 blades)
		c.lineWidth = 1.1 * s.weight;
		c.beginPath();
		for ( let k = 0; k < 3; k += 1 ) {

			const a = ROV_SPIN[ i ] + k * ( Math.PI * 2 / 3 );
			const ca = Math.cos( a );
			const sa = Math.sin( a );
			c.moveTo( px( m.x + ca * 0.07 ), py( m.y + sa * 0.07 ) );
			c.lineTo( px( m.x + ca * ROV_BLADE ), py( m.y + sa * ROV_BLADE ) );

		}

		c.stroke();
		c.globalAlpha = 0.9; // hub
		c.fillStyle = color;
		c.beginPath();
		c.arc( cx, cy, Math.max( 1, 0.05 * scale ), 0, Math.PI * 2 );
		c.fill();

		if ( Math.abs( t ) > 0.02 ) { // thrust arrow (direction of the mixer)

			const sgn = t > 0 ? 1 : - 1;
			const r0 = ROV_R + 0.06;
			c.globalAlpha = 0.95;
			c.lineWidth = 1.4 * s.weight;
			rovArrow( c, px( m.x + m.dx * sgn * r0 ), py( m.y + m.dy * sgn * r0 ),
				m.dx * sgn, - m.dy * sgn,
				( 0.14 + 0.68 * Math.abs( t ) ) * scale, Math.max( 3, 0.14 * scale ) );

		}

		c.globalAlpha = 1; // number + command: verticals pulled towards the axis
		const pct = Math.round( t * 100 );
		const label = MOTOR_LABELS[ i ].split( ' ' )[ 0 ];
		const off = ROV_R + ( m.vert ? 0.04 : 0.1 );
		const ty = m.vert ? m.y - 0.2 * Math.sign( m.y ) : m.y;
		text( c, s, label + ' ' + ( pct > 0 ? '+' : '' ) + pct,
			px( m.x > 0 ? m.x + off : m.x - off ), py( ty ), fs,
			m.x > 0 ? 'left' : 'right', color );

	}

	c.restore();

}

// ── wire-frame 3D gripper (channels 9 and 10) ─────────────────────────────

/** Dive view of the gripper: yaw, pitch (rad) and camera setback. */
const GRIP_VIEW = { yaw: - 0.62, pitch: - 0.3, dist: 24 };
const GRIP_PJ = { cy: Math.cos( GRIP_VIEW.yaw ), sy: Math.sin( GRIP_VIEW.yaw ),
	cp: Math.cos( GRIP_VIEW.pitch ), sp: Math.sin( GRIP_VIEW.pitch ) };

/** World point → image plane (light perspective): yaw (Y) then pitch (X). */
function gripProject( pj, x, y, z ) {

	const x1 = x * pj.cy + z * pj.sy;
	const z1 = - x * pj.sy + z * pj.cy;
	const y2 = y * pj.cp - z1 * pj.sp;
	const z2 = y * pj.sp + z1 * pj.cp;
	const k = GRIP_VIEW.dist / ( GRIP_VIEW.dist + z2 );
	return [ x1 * k, y2 * k ];

}

/** Wire-frame box (12 edges), vertices passed through `move`. */
function gripBox( segs, move, x0, x1, y0, y1, z0, z1 ) {

	const p = [ [ x0, y0, z0 ], [ x1, y0, z0 ], [ x1, y1, z0 ], [ x0, y1, z0 ],
		[ x0, y0, z1 ], [ x1, y0, z1 ], [ x1, y1, z1 ], [ x0, y1, z1 ] ].map( move );
	[ [ 0, 1 ], [ 1, 2 ], [ 2, 3 ], [ 3, 0 ], [ 4, 5 ], [ 5, 6 ], [ 6, 7 ], [ 7, 4 ], [ 0, 4 ], [ 1, 5 ], [ 2, 6 ], [ 3, 7 ] ]
		.forEach( ( [ a, b ] ) => segs.push( [ p[ a ], p[ b ] ] ) );

}

/** Wire-frame circle in the YZ plane (14 segments), passed through `move`. */
function gripRing( segs, move, x, r ) {

	const n = 14;
	for ( let i = 0; i < n; i += 1 ) {

		const a0 = ( i / n ) * Math.PI * 2;
		const a1 = ( ( i + 1 ) / n ) * Math.PI * 2;
		segs.push( [ move( [ x, Math.cos( a0 ) * r, Math.sin( a0 ) * r ] ),
			move( [ x, Math.cos( a1 ) * r, Math.sin( a1 ) * r ] ) ] );

	}

}

/** Gripper geometry for one state: fixed wrist, rolled moving assembly. */
function gripGeometry( open, roll ) {

	const cr = Math.cos( roll );
	const sr = Math.sin( roll );
	const fixed = []; // wrist (fixed)
	const moving = []; // collar, base and jaws (follow the rotation)
	const still = ( p ) => p;
	const rolled = ( p ) => [ p[ 0 ], p[ 1 ] * cr - p[ 2 ] * sr, p[ 1 ] * sr + p[ 2 ] * cr ];

	// wrist: wire-frame cylinder (2 circles + 6 generatrices)
	gripRing( fixed, still, - 2.6, 0.52 );
	gripRing( fixed, still, - 0.5, 0.52 );
	for ( let i = 0; i < 6; i += 1 ) {

		const a = ( i / 6 ) * Math.PI * 2;
		fixed.push( [ [ - 2.6, Math.cos( a ) * 0.52, Math.sin( a ) * 0.52 ],
			[ - 0.5, Math.cos( a ) * 0.52, Math.sin( a ) * 0.52 ] ] );

	}

	// turning collar + radial marks (they show the rotation angle)
	gripRing( moving, rolled, - 0.5, 0.56 );
	gripRing( moving, rolled, 0.12, 0.56 );
	moving.push( [ rolled( [ - 0.5, 0, 0 ] ), rolled( [ - 0.5, 0.56, 0 ] ) ] );
	moving.push( [ rolled( [ 0.12, 0, 0 ] ), rolled( [ 0.12, 0.56, 0 ] ) ] );
	// jaw base, then two parallel fingers spaced by channel 9
	gripBox( moving, rolled, 0.12, 0.78, - 0.5, 0.5, - 0.42, 0.42 );
	const gap = 0.1 + open * 0.95;
	const lip = 0.34;
	gripBox( moving, rolled, 0.78, 3.1, gap, gap + lip, - 0.17, 0.17 );
	gripBox( moving, rolled, 0.78, 3.1, - gap - lip, - gap, - 0.17, 0.17 );
	return { fixed, moving };

}

/** Reference image box: union of the extreme states (opening 0 → 1 × rotation −90° → +90°),
    computed once and cached — scale and centring stay put, only the jaws move. */
let gripRefBox = null;

function gripReferenceBox() {

	if ( gripRefBox ) return gripRefBox;
	const box = { minX: Infinity, maxX: - Infinity, minY: Infinity, maxY: - Infinity };
	for ( let oi = 0; oi <= 4; oi += 1 ) {

		for ( let rd = - 90; rd <= 90; rd += 30 ) {

			const geom = gripGeometry( oi / 4, rd * Math.PI / 180 );
			geom.fixed.concat( geom.moving ).forEach( ( [ a, b ] ) => {

				[ a, b ].forEach( ( p ) => {

					const q = gripProject( GRIP_PJ, p[ 0 ], p[ 1 ], p[ 2 ] );
					box.minX = Math.min( box.minX, q[ 0 ] );
					box.maxX = Math.max( box.maxX, q[ 0 ] );
					box.minY = Math.min( box.minY, q[ 1 ] );
					box.maxY = Math.max( box.maxY, q[ 1 ] );

				} );

			} );

		}

	}

	gripRefBox = box;
	return box;

}

/** Projection of a set of segments onto the image (pairs of screen points). */
function gripProjectSegs( segs ) {

	return segs.map( ( [ a, b ] ) => [ gripProject( GRIP_PJ, a[ 0 ], a[ 1 ], a[ 2 ] ),
		gripProject( GRIP_PJ, b[ 0 ], b[ 1 ], b[ 2 ] ) ] );

}

/**
 * Wire-frame 3D gripper — channel 9: jaw opening (1 000 µs closed → 2 000 µs open); channel 10:
 * wrist rotation about the axis (1 500 µs = 0°, 1 000/2 000 µs = ±90°). The body stays put; the
 * collar, base and jaws follow the rotation. Values along the bottom (% opening, angle in deg).
 */
export function drawGrip( c, s, w, h, f ) {

	const pwm = ( f.pwm && f.pwm.length >= 10 ) ? f.pwm : new Array( 16 ).fill( 1500 );
	const open = clamp( ( Number( pwm[ 8 ] ) - 1000 ) / 1000, 0, 1 );
	const roll = clamp( ( Number( pwm[ 9 ] ) - 1500 ) / 500, - 1, 1 ) * Math.PI / 2;
	const geom = gripGeometry( open, roll );
	const fixedP = gripProjectSegs( geom.fixed );
	const movingP = gripProjectSegs( geom.moving );

	// fit to the box: a text band is kept at the bottom; scale and centring come from the
	// reference box (cached) so the drawing stays put
	const ref = gripReferenceBox();
	const pad = Math.max( 3, Math.min( w, h ) * 0.04 );
	const fs = clamp( h * 0.13, 6.5, 10 );
	const textH = Math.min( h * 0.45, fs * 1.8 );
	const availW = Math.max( 8, w - pad * 2 );
	const availH = Math.max( 4, h - textH - pad * 2 );
	const bw = Math.max( 0.001, ref.maxX - ref.minX );
	const bh = Math.max( 0.001, ref.maxY - ref.minY );
	const scale = Math.min( availW / bw, availH / bh ) * 0.985;
	const ox = ( w - bw * scale ) / 2 - ref.minX * scale;
	const oy = pad + ( availH - bh * scale ) / 2 + ref.maxY * scale;

	const stroke = ( segs ) => {

		c.beginPath();
		segs.forEach( ( [ a, b ] ) => {

			c.moveTo( ox + a[ 0 ] * scale, oy - a[ 1 ] * scale ); // image y is inverted
			c.lineTo( ox + b[ 0 ] * scale, oy - b[ 1 ] * scale );

		} );
		c.stroke();

	};

	c.save();
	c.strokeStyle = s.color;
	c.lineWidth = 1.1 * s.weight;
	c.lineJoin = 'round';
	glow( c, s, 4 );
	c.globalAlpha = 0.5;
	stroke( fixedP ); // wrist (faint)
	c.globalAlpha = 0.9;
	stroke( movingP ); // jaws (sharp)
	c.globalAlpha = 1;

	const deg = Math.round( roll * 180 / Math.PI );
	text( c, s, 'PINCE ' + Math.round( open * 100 ) + ' %', pad, h - fs * 0.55, fs, 'left' );
	text( c, s, 'ROT ' + ( deg > 0 ? '+' : '' ) + deg + '°', w - pad, h - fs * 0.55, fs, 'right' );
	c.restore();

}

// ── bar gauges: pack voltage and motor currents ────────────────────────────

/** Bar gauge: label, value, ticked track and alarm mark.
    opts: { label, value, unit, min, max, decimals, ticks, warnLow, warnHigh, warnAt } */
export function drawBarGauge( c, s, w, h, opts ) {

	const pad = Math.max( 3, Math.min( w, h ) * 0.06 );
	const fsLabel = clamp( h * 0.18, 6.5, 10 ); // nominal sizes: text puts the scale back
	const fsValue = clamp( h * 0.34, 9, 18 );
	const rowH = fsValue * s.font;
	const tickZone = clamp( h * 0.16, 4, 9 );
	const rowY = pad + rowH * 0.5;
	const barTop = Math.min( h - pad - tickZone - 3, pad + rowH + 2 );
	const barBottom = Math.max( barTop + 3, h - pad - tickZone );
	const barW = w - pad * 2;
	const warn = ( opts.warnLow !== undefined && opts.value < opts.warnLow )
		|| ( opts.warnHigh !== undefined && Math.abs( opts.value ) > opts.warnHigh );
	const color = warn ? HUD_WARN : s.color;
	const frac = clamp( ( opts.value - opts.min ) / ( opts.max - opts.min ), 0, 1 );

	c.save();
	glow( c, s, 5 );
	text( c, s, opts.label, pad, rowY, fsLabel, 'left' );
	text( c, s, opts.value.toFixed( opts.decimals ).replace( '.', ',' ) + ' ' + opts.unit,
		w - pad, rowY, fsValue, 'right', color );

	// track, outline, then the proportional fill (amber on alarm)
	c.globalAlpha = 0.16;
	c.fillStyle = s.color;
	c.fillRect( pad, barTop, barW, barBottom - barTop );
	c.globalAlpha = 1;
	c.strokeStyle = s.color;
	c.lineWidth = 1 * s.weight;
	c.strokeRect( pad + 0.5, barTop + 0.5, barW - 1, barBottom - barTop - 1 );
	if ( frac > 0.005 ) {

		glow( c, s, 6, color );
		c.fillStyle = color;
		c.globalAlpha = 0.8;
		c.fillRect( pad + 1, barTop + 1, ( barW - 2 ) * frac, barBottom - barTop - 2 );
		c.globalAlpha = 1;

	}

	// ticks under the bar + the alarm mark
	c.globalAlpha = 0.5;
	for ( let t = 0; t <= opts.ticks; t += 1 ) {

		const x = pad + ( barW * t ) / opts.ticks;
		c.beginPath();
		c.moveTo( x, barBottom );
		c.lineTo( x, barBottom + tickZone * ( t % 2 === 0 ? 0.7 : 0.45 ) );
		c.stroke();

	}

	if ( opts.warnAt !== undefined ) {

		const xWarn = pad + barW * clamp( ( opts.warnAt - opts.min ) / ( opts.max - opts.min ), 0, 1 );
		c.globalAlpha = 0.9;
		c.lineWidth = 1.2 * s.weight;
		c.beginPath();
		c.moveTo( xWarn, barTop );
		c.lineTo( xWarn, barBottom + tickZone * 0.85 );
		c.stroke();

	}

	c.restore();

}

/** Pack voltage: 9–13 V gauge, alarm under 11 V. */
export function drawVoltage( c, s, w, h, f ) {

	drawBarGauge( c, s, w, h, { label: 'VOLTAGE', value: f.vbat, unit: 'V', min: 9, max: 13,
		decimals: 1, ticks: 8, warnLow: 11, warnAt: 11 } );

}

/** Vertical motor current: 0–30 A gauge, alarm above 20 A. */
export function drawMotorV( c, s, w, h, f ) {

	drawBarGauge( c, s, w, h, { label: 'MOTEUR VERT.', value: f.iV, unit: 'A', min: 0, max: 30,
		decimals: 1, ticks: 6, warnHigh: 20, warnAt: 20 } );

}

/** Horizontal motor current: 0–30 A gauge, alarm above 20 A. */
export function drawMotorH( c, s, w, h, f ) {

	drawBarGauge( c, s, w, h, { label: 'MOTEUR HORIZ.', value: f.iH, unit: 'A', min: 0, max: 30,
		decimals: 1, ticks: 6, warnHigh: 20, warnAt: 20 } );

}

/** Instrument id → painter (the cockpit's HUD_DRAW table). */
export const DRAW = {
	horizon: drawHorizon,
	heading: drawHeading,
	depth: drawDepth,
	temperature: drawTemperature,
	gauges: drawMotors,
	grip: drawGrip,
	voltage: drawVoltage,
	motor_v: drawMotorV,
	motor_h: drawMotorH,
};
