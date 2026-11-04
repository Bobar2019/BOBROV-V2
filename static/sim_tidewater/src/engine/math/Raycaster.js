// Minimal three.js-compatible Raycaster: a camera ray from a pointer position, triangle-precise
// hits on Mesh objects (no BVH: the test-bench meshes are a few thousand triangles, and a pick
// only happens on a right click).
//
//   const rc = new Raycaster();
//   rc.setFromCamera( ndc, camera );            // ndc: Vector2 in -1..1
//   const hits = rc.intersectObject( group, true );
//   hits[ 0 ] = { object, point, distance, face }
//
// Works with the engine's reversed-depth projection: the far-plane point of the NDC ray is
// unprojected at z = 0.5, which gives the same direction whatever the depth convention.

import { Matrix4 } from './Matrix4.js';
import { Ray } from './Ray.js';
import { Vector3 } from './Vector3.js';

const _inv = /*@__PURE__*/ new Matrix4();
const _localRay = /*@__PURE__*/ new Ray();
const _origin = /*@__PURE__*/ new Vector3();
const _dir = /*@__PURE__*/ new Vector3();
const _point = /*@__PURE__*/ new Vector3();
const _world = /*@__PURE__*/ new Vector3();
const _a = /*@__PURE__*/ new Vector3();
const _b = /*@__PURE__*/ new Vector3();
const _c = /*@__PURE__*/ new Vector3();

export class Raycaster {

	constructor( origin = new Vector3(), direction = new Vector3( 0, 0, - 1 ), near = 0, far = Infinity ) {

		this.ray = new Ray( origin, direction );
		this.near = near;
		this.far = far;
		this.params = {};

	}

	set( origin, direction ) {

		this.ray.set( origin, direction );
		return this;

	}

	setFromCamera( coords, camera ) {

		const ray = this.ray;
		ray.origin.setFromMatrixPosition( camera.matrixWorld );
		ray.direction.set( coords.x, coords.y, 0.5 ).unproject( camera ).sub( ray.origin ).normalize();
		return this;

	}

	intersectObjects( objects, recursive = true ) {

		const hits = [];
		for ( const o of objects ) this.intersectObject( o, recursive, hits );
		hits.sort( ( a, b ) => a.distance - b.distance );
		return hits;

	}

	intersectObject( object, recursive = true, hits = [] ) {

		if ( object.visible === false ) return hits;
		object.updateWorldMatrix( true, false );
		if ( object.isMesh ) this._mesh( object, hits );
		if ( recursive ) for ( const c of object.children ) this.intersectObject( c, recursive, hits );
		return hits;

	}

	_mesh( object, hits ) {

		const geo = object.geometry;
		const pos = geo && geo.getAttribute ? geo.getAttribute( 'position' ) : null;
		if ( ! pos ) return;
		if ( ! geo.boundingBox ) geo.computeBoundingBox && geo.computeBoundingBox();

		// the ray in the mesh's own frame (so a scaled / rotated part costs nothing)
		_inv.copy( object.matrixWorld ).invert();
		_origin.copy( this.ray.origin ).applyMatrix4( _inv );
		_dir.copy( this.ray.direction ).transformDirection( _inv ).normalize();
		const localRay = _localRay.set( _origin, _dir );

		const arr = pos.array, stride = pos.itemSize || 3;
		const index = geo.index ? geo.index.array : null;
		const count = index ? index.length : arr.length / stride;
		const start = this.ray.origin;

		for ( let i = 0; i < count; i += 3 ) {

			const ia = ( index ? index[ i ] : i ) * stride;
			const ib = ( index ? index[ i + 1 ] : i + 1 ) * stride;
			const ic = ( index ? index[ i + 2 ] : i + 2 ) * stride;
			_a.set( arr[ ia ], arr[ ia + 1 ], arr[ ia + 2 ] );
			_b.set( arr[ ib ], arr[ ib + 1 ], arr[ ib + 2 ] );
			_c.set( arr[ ic ], arr[ ic + 1 ], arr[ ic + 2 ] );
			// no back-face culling: thin parts (lamp lenses, plates) are often single-sided
			if ( ! localRay.intersectTriangle( _a, _b, _c, false, _point ) ) continue;
			_world.copy( _point ).applyMatrix4( object.matrixWorld );
			const d = _world.distanceTo( start );
			if ( d < this.near || d > this.far ) continue;
			hits.push( { object, point: _world.clone(), distance: d, face: null } );

		}

		return hits;

	}

}
