import * as THREE from '../engine/index.js';

// Free-fly debug camera: drag (or pointer lock) to look, WASD + QE to move, Shift = fast.
// The cockpit's « Contrôle Simulateur 3D » pad block (input.sim_gamepad) does the same job with
// its sticks: surge / sway / heave translate, and yaw / pitch turn the view at a steady rate, so
// the pad and the keys add up instead of one taking over from the other.
const LOOK_PER_PIXEL = 0.0022; // mouse sensitivity
const STICK_TURN = 1.6; // rad/s at full stick deflection
export class FlyCamera {

	constructor( camera, dom, input ) {

		this.camera = camera;
		this.dom = dom;
		this.input = input;
		this.yaw = 0;
		this.pitch = 0;
		this.speed = 8;
		this.enabled = true;
		this.velocity = new THREE.Vector3();
		this._fwd = new THREE.Vector3();
		this._right = new THREE.Vector3();

	}

	setPose( position, yaw, pitch ) {

		this.camera.position.copy( position );
		this.yaw = yaw;
		this.pitch = pitch;
		this.apply();

	}

	apply() {

		this.camera.rotation.set( this.pitch, this.yaw, 0, 'YXZ' );

	}

	update( dt ) {

		if ( ! this.enabled ) return;
		const inp = this.input;
		const stick = inp.simCommand();

		// look — the mouse as a displacement, the pad's sticks as a rate. The sticks keep the
		// cockpit's own sense (yaw positive to starboard, pitch positive nose up), so yaw turns the
		// other way here: a stick pushed right swings the view right, exactly like the mouse.
		const look = inp.consumeLook();
		this.yaw -= look.x * LOOK_PER_PIXEL + stick.yaw * STICK_TURN * dt;
		this.pitch -= look.y * LOOK_PER_PIXEL - stick.pitch * STICK_TURN * dt;
		this.pitch = Math.max( - 1.55, Math.min( 1.55, this.pitch ) );
		this.apply();

		// translation — in the view's own frame, as the keys do it
		const fast = inp.down( 'ShiftLeft' ) || inp.down( 'ShiftRight' );
		const speed = this.speed * ( fast ? 6 : 1 );
		this.camera.getWorldDirection( this._fwd );
		this._right.crossVectors( this._fwd, this.camera.up ).normalize();
		const move = new THREE.Vector3();
		if ( inp.down( 'KeyW' ) ) move.add( this._fwd );
		if ( inp.down( 'KeyS' ) ) move.sub( this._fwd );
		if ( inp.down( 'KeyD' ) ) move.add( this._right );
		if ( inp.down( 'KeyA' ) ) move.sub( this._right );
		if ( inp.down( 'KeyE' ) || inp.down( 'Space' ) ) move.y += 1;
		if ( inp.down( 'KeyQ' ) || inp.down( 'KeyC' ) ) move.y -= 1;
		if ( move.lengthSq() > 0 ) move.normalize(); // a key is always full speed
		move.addScaledVector( this._fwd, stick.surge );
		move.addScaledVector( this._right, stick.sway );
		move.y += stick.heave;
		if ( move.lengthSq() > 1 ) move.normalize(); // keys and sticks together stay inside full speed
		this.velocity.lerp( move.multiplyScalar( speed ), 1 - Math.exp( - dt * 8 ) );
		this.camera.position.addScaledVector( this.velocity, dt );

	}

}
