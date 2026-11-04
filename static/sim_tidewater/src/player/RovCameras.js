import * as THREE from '../engine/index.js';

const clamp = THREE.MathUtils.clamp;

const _q = new THREE.Quaternion();
const _look = new THREE.Quaternion();
const _e = new THREE.Euler( 0, 0, 0, 'YXZ' );
const _flip = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), Math.PI );
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

// The ROV's three eyes. Caméra Interne: FPV at model.eye, looking where the frame points, with a
// limited look-around that recentres when the mouse rests. Caméra Libre (the free flight around the
// frame, the default) is the engine's FlyCamera; freePose() below gives it its entry pose. Caméra de
// suivi: the eye stays where the free flight left it, bolted to the hull — see setMode / chase.
//
// The camera object itself is never re-parented: the engine's camera is shared with the water
// queries and the post chain, all of which read its world position. Instead the rig writes the
// pose the parenting would have produced (group.matrixWorld applied to the local eye).
export class RovCameras {

	constructor( { camera, input } ) {

		this.camera = camera;
		this.input = input;
		this.mode = 'free'; // 'free' (FlyCamera) | 'internal' (FPV) | 'chase' (bolted to the hull)

		this.lookYaw = 0; // look-around, relative to the frame
		this.lookPitch = 0;
		this._chaseLocal = null; // the eye in the frame's own axes, latched on entering 'chase'

	}

	setMode( mode, rov ) {

		this.mode = mode;
		this.lookYaw = this.lookPitch = 0;
		if ( mode === 'chase' ) this.latch( rov );

	}

	/**
	 * Where the eye sits in the frame's own space, right now: inverse(frame world) × camera world.
	 * Captured when the mode is entered, so the shot the pilot had lined up in the free flight is
	 * the one he keeps — the controls then go back to the frame and the eye rides along with it.
	 */
	latch( rov ) {

		const g = rov && rov.model && rov.model.group;
		if ( ! g ) return;
		// the camera's matrixWorld is only written at render time: without this refresh the latch
		// would capture the pose of the frame before the one on screen
		this.camera.updateMatrixWorld( true );
		g.updateMatrixWorld( true );
		this._chaseLocal = ( this._chaseLocal || new THREE.Matrix4() )
			.copy( g.matrixWorld ).invert().multiply( this.camera.matrixWorld );

	}

	update( dt, rov ) {

		// Caméra de suivi: nothing to aim and nothing to recentre, the hull does the driving — the
		// mouse is only drained, so the look-around does not jump when the pilot gets the eye back
		if ( this.mode === 'chase' ) {

			this.input.consumeLook();
			this.chase( rov );
			return;

		}

		const look = this.input.consumeLook();
		const moved = Math.abs( look.x ) + Math.abs( look.y ) > 0.5;
		this.lookYaw = clamp( this.lookYaw - look.x * 0.0022, - 2.1, 2.1 );
		this.lookPitch = clamp( this.lookPitch - look.y * 0.0022, - 1.0, 0.9 );
		// recentre slowly when the mouse rests, so the view follows the frame again
		if ( ! moved ) {

			const k = 1 - Math.exp( - dt * 0.6 );
			this.lookYaw += ( 0 - this.lookYaw ) * k;
			this.lookPitch += ( 0 - this.lookPitch ) * k;

		}

		const g = rov.model.group;
		g.updateMatrixWorld( true );
		this.camera.position.copy( rov.model.eye ).applyMatrix4( g.matrixWorld );
		// the camera looks down -Z while the frame points +Z: flip, then the look-around on top.
		// The look-around goes through a quaternion: multiply() reads its argument's own fields, so
		// handing it an Euler leaves the camera without a valid rotation (and the frame goes black).
		_e.set( this.lookPitch, this.lookYaw, 0, 'YXZ' );
		_q.copy( rov.quaternion ).multiply( _flip ).multiply( _look.setFromEuler( _e ) );
		this.camera.quaternion.copy( _q );

	}

	// The frame's own axes × the latched offset: same hull, same roll, same heading, no damping and
	// no lag — a rig bolt, not a spring. rovCtl.apply() has already refreshed the group's matrixWorld
	// this frame, so the eye is placed on the pose being simulated, not on the one before it.
	chase( rov ) {

		if ( ! this._chaseLocal ) return;
		const g = rov.model.group;
		g.updateMatrixWorld( true );
		_m.multiplyMatrices( g.matrixWorld, this._chaseLocal );
		_m.decompose( this.camera.position, this.camera.quaternion, _s );

	}

	// Pose for the free camera when it takes over: out in front of the frame and a little to port,
	// looking back at it. Ahead is open water at the pier, so the shot is clear of the deck and its
	// railings. The height is taken from the frame, not from the surface: once the frame has dived,
	// a camera left above the water would only see a blurred patch of seabed through the swell.
	freePose( rov, out ) {

		const a = rov.yaw + 0.45, dist = 4.2, up = 1.15;
		out.position = out.position || new THREE.Vector3();
		out.position.set(
			rov.position.x + Math.sin( a ) * dist,
			rov.position.y + up,
			rov.position.z + Math.cos( a ) * dist,
		);
		out.yaw = a; // fly camera looks down -Z, so this faces back at the frame
		out.pitch = - Math.atan2( up, dist ); // aimed at the frame, not at the horizon
		return out;

	}

}
