import * as THREE from '../engine/index.js';
import { WORLD } from '../world/WorldLayout.js';

const clamp = THREE.MathUtils.clamp;
const DEG = Math.PI / 180;

const _f = new THREE.Vector3();
const _e = new THREE.Euler( 0, 0, 0, 'YXZ' );

// shortest way round on the circle: the heading has no end (and the telemetry's wraps at ±π)
const wrapPi = ( a ) => Math.atan2( Math.sin( a ), Math.cos( a ) );

// Kinematic ROV: the test vehicle of the bench. Unlike the boat it replaced, there is no rigid
// body to integrate — an ROV is close to neutrally buoyant and driven by thrusters, so the
// controller writes the pose straight onto the model's group:
//
//   W / S    surge (forward / astern)        C / Ctrl   dive
//   A / D    yaw                             Space      surface
//
// Depth is the state that matters: it is held between the surface and the seabed (the terrain
// height under the frame, less a clearance), and the frame floats on the swell at depth 0.
export class RovController {

	constructor( { model, query, terrain, start = WORLD.rovDock } ) {

		this.model = model;
		this.query = query;
		this.terrain = terrain;

		this.position = new THREE.Vector3( start.position.x, 0, start.position.z );
		this.quaternion = new THREE.Quaternion();
		this.velocity = new THREE.Vector3();
		this.yaw = start.heading || 0;
		this.pitch = 0;
		this.roll = 0;

		this.throttle = 0; // -1..1 (lever, smoothed)
		this.steer = 0; // -1..1
		this.vertical = 0; // -1..1 (dive .. surface)
		this.driven = false;

		this.depth = 0; // m of the origin below the surface (0 = afloat)
		this.waterH = 0;
		this.hasWater = false;
		this.speed = 0;

		// the read-back is coarse (it lands a frame or two late, and only every few frames), so the
		// pose does not read `waterH` directly: it follows it through a critically damped spring
		this.surface = 0; // water level the frame rides this frame
		this.surfaceVel = 0; // m/s of that level
		this.meanLevel = 0; // slow mean of it: the level a dived frame hangs at
		this.level = 0; // level the pose was written against (read back by the onboard instruments)
		this._surfaceInit = false;

		// a real frame on the link (net/RealTelemetry): its attitude is written over the trim below
		this.external = null;
		this._extWeight = 0; // 0..1: ramp in and out of the handover
		this._extHeld = false;
		this._aligned = false; // the heading has been laid on the telemetry's once
		this._yawOffset = 0; // where the telemetry's heading was picked up

		this.maxDepth = 40; // m, also limited by the seabed
		this.maxSpeed = 2.6; // m/s at full thrust
		this.diveSpeed = 1.1; // m/s
		this.turnRate = 0.9; // rad/s at full rudder
		this.slot = query.allocate( 'rov', 1 );

		this.apply();

	}

	// ---- water read-back (the same GPU query the walker uses: one point under the frame)
	queueQueries() {

		this.query.setPoint( this.slot, this.position.x, this.position.z );

	}

	toWorld( local, out ) {

		return out.copy( local ).applyQuaternion( this.quaternion ).add( this.position );

	}

	// The attitude of a real frame alongside (net/RealTelemetry), or null to leave the frame to the
	// keys. The heading is taken as a delta: the simulator's compass has its own origin, so the
	// handover picks up where the frame pointed instead of spinning it round to a foreign bearing.
	setExternalAttitude( attitude ) {

		this.external = attitude || null;

	}

	setInput( throttle, steer, dt, vertical = 0 ) {

		const k = 1 - Math.exp( - dt * 6 );
		this.throttle += ( throttle - this.throttle ) * k;
		this.steer += ( steer - this.steer ) * k;
		this.vertical += ( vertical - this.vertical ) * ( 1 - Math.exp( - dt * 4 ) );

	}

	update( dt ) {

		dt = Math.min( dt, 0.1 );

		// ---- water height under the frame
		const q = this.query;
		if ( q.cpuValid ) {

			const h = q.cpu[ this.slot * 4 ];
			if ( Number.isFinite( h ) ) {

				this.waterH = h;
				this.hasWater = true;

			}

		}

		const ground = this.terrain ? this.terrain.heightAt( this.position.x, this.position.z ) : - 40;
		const draft = this.model.floatDraft;

		// ---- vertical: thruster-set depth, held between the seabed and the surface
		if ( this.driven ) this.depth -= this.vertical * this.diveSpeed * dt;
		else this.depth = Math.max( 0, this.depth - 0.6 * dt ); // let go: it drifts back up
		const floor = Math.max( 0, this.waterH - ground - draft - 0.35 ); // keep the frame off the bottom
		this.depth = clamp( this.depth, 0, Math.min( this.maxDepth, floor ) );

		// ---- surge: thrust along the heading, with the drag of the frame as the response lag
		_f.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) ).multiplyScalar( this.throttle * this.maxSpeed );
		this.velocity.x += ( _f.x - this.velocity.x ) * ( 1 - Math.exp( - dt * 1.7 ) );
		this.velocity.z += ( _f.z - this.velocity.z ) * ( 1 - Math.exp( - dt * 1.7 ) );

		// ---- heading
		const authority = 0.35 + 0.65 * clamp( Math.abs( this.throttle ) + 0.35, 0, 1 );
		this.yaw += this.steer * this.turnRate * authority * dt;

		this.position.x += this.velocity.x * dt;
		this.position.z += this.velocity.z * dt;
		this.speed = Math.hypot( this.velocity.x, this.velocity.z );

		// ---- pose: origin floats at the waterline, or hangs `depth` under it
		// `waterH` is a read-back: what it reports jumps by centimetres and only changes every few
		// frames, and the onboard camera is welded to the frame, so taken as-is it steps the whole
		// view ten times a second. The spring turns those jumps back into the smooth rise and fall
		// of the swell (it is a low-pass with a continuous speed: no snap, no overshoot).
		const target = this.hasWater ? this.waterH : 0;
		if ( ! this._surfaceInit ) {

			this._surfaceInit = true;
			this.surface = this.meanLevel = target;

		} else if ( Math.abs( target - this.surface ) > 1.5 ) {

			// the frame was dropped somewhere else altogether: follow it at once
			this.surface = target;
			this.surfaceVel = 0;

		} else {

			const w = 7; // rad/s: settles in ~0.4 s, well inside the swell's own period
			this.surfaceVel += ( ( target - this.surface ) * w * w - this.surfaceVel * 2 * w ) * dt;
			this.surface += this.surfaceVel * dt;

		}

		// the swell carries the frame while it floats, and fades out with the first half-metre of
		// dive: under the surface the frame hangs under its trim and the waves pass over it, so the
		// onboard view stops bobbing as soon as the lens is under water
		const ride = clamp( 1 - this.depth / 0.5, 0, 1 );
		// the mean follows the sea level itself (the tide) whatever the depth; while the frame is
		// afloat it is quick enough to lag the swell a little, once dived it is slow enough that not
		// even the longest swell gets through it: a dived frame is a steady platform
		const meanRate = ride > 0.01 ? 0.6 : 0.1;
		this.meanLevel += ( this.surface - this.meanLevel ) * ( 1 - Math.exp( - dt * meanRate ) );

		const surface = this.meanLevel + ( this.surface - this.meanLevel ) * ride;
		this.level = surface;
		this.position.y = surface - draft - this.depth;

		// a little nose-down when diving (the pose is written positive on the nose down, like an
		// Euler angle about +X), and a slight list into the turn
		const wantPitch = - clamp( this.vertical, - 1, 1 ) * 10 * DEG + this.speed * 0.6 * DEG;
		const wantRoll = - this.steer * 6 * DEG;
		this.pitch += ( wantPitch - this.pitch ) * ( 1 - Math.exp( - dt * 2.5 ) );
		this.roll += ( wantRoll - this.roll ) * ( 1 - Math.exp( - dt * 2.5 ) );

		// a real frame on the link: its attitude is written over the trim, through the weight above
		// so that both handovers are a short blend rather than a jump
		this._extWeight += ( ( this.external ? 1 : 0 ) - this._extWeight ) * ( 1 - Math.exp( - dt * 5 ) );
		if ( this.external ) {

			if ( ! this._extHeld ) {

				this._extHeld = true;
				// the first handover lays the heading on the real one — the onboard ribbon then reads
				// what the cockpit reads, π being the offset of the simulator's own compass. After
				// that the heading is picked up where the frame stands, so a turn taken with the keys
				// while the real frame lay still is not undone by a snap.
				this._yawOffset = this._aligned ? this.yaw - this.external.yaw : Math.PI;
				this._aligned = true;

			}

			const k = this._extWeight;
			this.pitch += ( this.external.pitch - this.pitch ) * k;
			this.roll += ( this.external.roll - this.roll ) * k;
			this.yaw += wrapPi( this.external.yaw + this._yawOffset - this.yaw ) * k;

		} else {

			this._extHeld = false;

		}

		this.quaternion.setFromEuler( _e.set( this.pitch, this.yaw, this.roll, 'YXZ' ) );

		this.apply();

	}

	apply() {

		const g = this.model.group;
		g.position.copy( this.position );
		g.quaternion.copy( this.quaternion );
		g.updateMatrixWorld( true );

	}

}
