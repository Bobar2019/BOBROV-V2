import {
	Box3, BufferAttribute, BufferGeometry, Group, MathUtils, Matrix3, Mesh, Vector3, mergeGeometries,
} from '../engine/index.js';
import { GLTFLoader } from '../engine/loaders/GLTFLoader.js';
import { standard } from '../materials/Materials.js';

const BASE = new URL( '.', document.baseURI ).href + 'models/';

// Scale applied to the CAD export (43 cm long in the file). x3 puts the frame at ~1.3 m, which
// reads at human scale in the scene next to the pier; change it here, nothing else keys off it.
const SCALE = 3.0;

const _v = new Vector3();
const _p = new Vector3();
const _n3 = new Matrix3();

// Bake one glTF primitive into a mergeable geometry: the mesh's world matrix goes into the
// vertices (and, through the inverse transpose, into the normals — the frame is scaled), and the
// attribute set is made uniform. mergeGeometries() refuses geometries that disagree on the
// attribute list or on indexing, and the CAD export mixes both.
function bake( mesh ) {

	const src = mesh.geometry;
	const pos = src.attributes.position, nrm = src.attributes.normal, uv = src.attributes.uv;
	const m = mesh.matrixWorld, count = pos.count;

	const P = new Float32Array( count * 3 ); // position
	const N = new Float32Array( count * 3 ); // normal
	const U = new Float32Array( count * 2 ); // uv (unused by these materials, zeros are fine)
	if ( nrm ) _n3.getNormalMatrix( m );

	for ( let i = 0; i < count; i ++ ) {

		_p.fromBufferAttribute( pos, i ).applyMatrix4( m );
		P[ i * 3 ] = _p.x; P[ i * 3 + 1 ] = _p.y; P[ i * 3 + 2 ] = _p.z;

		if ( nrm ) {

			_p.fromBufferAttribute( nrm, i ).applyNormalMatrix( _n3 );
			N[ i * 3 ] = _p.x; N[ i * 3 + 1 ] = _p.y; N[ i * 3 + 2 ] = _p.z;

		}

		if ( uv ) { U[ i * 2 ] = uv.getX( i ); U[ i * 2 + 1 ] = uv.getY( i ); }

	}

	const g = new BufferGeometry();
	g.setAttribute( 'position', new BufferAttribute( P, 3 ) );
	g.setAttribute( 'normal', new BufferAttribute( N, 3 ) );
	g.setAttribute( 'uv', new BufferAttribute( U, 2 ) );

	const index = src.index;
	const I = new Uint32Array( index ? index.count : count );
	if ( index ) for ( let i = 0; i < index.count; i ++ ) I[ i ] = index.getX( i );
	else for ( let i = 0; i < count; i ++ ) I[ i ] = i;
	g.setIndex( new BufferAttribute( I, 1 ) );

	if ( ! nrm ) g.computeVertexNormals(); // some primitives ship without normals
	g.computeBoundingBox();
	return g;

}

// Work-class ROV: the Onshape frame in bob_rov_3D.glb, with the two lamp heads of projecteur.glb
// mounted on the front of the frame.
//
// The GLB ships in its CAD frame: +X along the hull, +Y up, +Z across. The group is built in the
// engine's vehicle frame instead (+Z forward, +Y up, +X port, same as the boat was), by turning
// the CAD nodes -90 deg about Y. Everything else (anchors, controller, camera) then works in the
// usual forward = +Z.
export class RovModel {

	// loads both GLBs (bob_rov_3D.glb + projecteur.glb) and returns the assembled model
	static async load() {

		const loader = new GLTFLoader();
		const hull = await loader.loadAsync( BASE + 'bob_rov_3D.glb' );
		const lamps = await loader.loadAsync( BASE + 'projecteur.glb' );
		return new RovModel( hull, lamps );

	}

	constructor( hull, lamps ) {

		this.group = new Group();
		this.group.name = 'ROV';

		// ---- frame: CAD +X -> engine +Z
		const frame = new Group();
		frame.name = 'rov-frame';
		frame.rotation.y = - Math.PI / 2;
		frame.scale.setScalar( SCALE );
		frame.add( hull.scene );
		this.group.add( frame );

		this.group.updateMatrixWorld( true );
		const box = this.box = new Box3().setFromObject( hull.scene, true );
		box.getSize( _v );
		this.dimensions = { length: _v.z, width: _v.x, height: _v.y };

		// ---- projectors: the two lamp heads of projecteur.glb. They keep their own CAD frame, so
		// the pair keeps its spacing and faces the way the lenses do. The tripod feet of the file
		// (PIED_G / PIED_D) are left out — there is nothing to stand on aboard a vehicle.
		const lampMeshes = lamps.meshes.filter( ( m ) => /^projecteur[A-Z]/i.test( m.userData.gltfNode || '' ) );

		const rig = new Group();
		rig.name = 'rov-lamps';
		rig.rotation.y = - Math.PI / 2;
		rig.scale.setScalar( SCALE );
		for ( const m of lampMeshes ) rig.add( m );
		this.group.add( rig );
		this.group.updateMatrixWorld( true );

		// ---- heads: nine primitives each, and their nodes all sit at the origin of the file, so
		// neither the node transform nor a node position is of any use here — everything is
		// measured from the geometry. The zero-thickness plates become the emissive lens, the
		// housing keeps the colours of the export.
		this.lensMaterial = standard( {
			color: 0x121c22, emissive: 0xbfe4ff, emissiveIntensity: 0, roughness: 0.25, metalness: 0,
		} );
		const heads = new Map(); // node name -> Box3 in the group frame
		for ( const m of lampMeshes ) {

			m.geometry.computeBoundingBox();
			const b = m.geometry.boundingBox.clone().applyMatrix4( m.matrixWorld );
			let hb = heads.get( m.userData.gltfNode );
			if ( ! hb ) heads.set( m.userData.gltfNode, hb = new Box3() );
			hb.union( b );

			b.getSize( _p ); // a lens plate has no thickness on one axis
			if ( Math.min( _p.x, _p.y, _p.z ) < 0.001 ) m.material = this.lensMaterial;

		}

		// mount the pair: centred on the centreline, standing on the frame top, inboard of the nose
		const mid = new Vector3();
		for ( const hb of heads.values() ) mid.add( hb.getCenter( _p ) );
		if ( heads.size ) mid.multiplyScalar( 1 / heads.size );
		rig.position.set( - mid.x, box.max.y + 0.06 - mid.y, box.max.z - 0.12 - mid.z );
		this.group.updateMatrixWorld( true );

		this.lightsOn = false;

		// ---- anchors (group frame)
		// onboard camera: just above the frame, behind the lamps, looking forward
		this.eye = new Vector3( 0, box.max.y + 0.02, box.max.z - 0.24 );
		// where a swimmer/diver would stand to grab the frame
		this.boardPoint = new Vector3( 0, 0, box.min.z );

		// projector positions in the group frame, for the local lights added by addRovLights()
		this.lampAnchors = [];
		for ( const hb of heads.values() ) this.lampAnchors.push( hb.getCenter( new Vector3() ).add( rig.position ) );

		// ---- collapse the export: one draw per material instead of the 400-odd primitives of the
		// two GLBs, which is what the Pi 5 needs back. The scaffolding groups go away with it.
		this.meshes = this._merge( hull.meshes.concat( lampMeshes ) );
		this.group.remove( frame );
		this.group.remove( rig );

	}

	// The group is still untransformed here, so the meshes' world matrices bake straight into
	// group space and the merged meshes can hang off the group itself.
	_merge( meshes ) {

		const buckets = new Map(); // material -> baked geometries
		for ( const m of meshes ) {

			let list = buckets.get( m.material );
			if ( ! list ) buckets.set( m.material, list = [] );
			list.push( bake( m ) );

		}

		const out = [];
		for ( const [ material, list ] of buckets ) {

			const merged = list.length > 1 ? mergeGeometries( list ) : list[ 0 ];
			for ( const geometry of merged ? [ merged ] : list ) {

				const mesh = new Mesh( geometry, material );
				mesh.name = material.name;
				mesh.castShadow = true;
				mesh.receiveShadow = true;
				this.group.add( mesh );
				out.push( mesh );

			}

		}

		return out;

	}

	setLights( on ) {

		this.lightsOn = !! on;
		this.lensMaterial.emissiveIntensity = on ? 8 : 0;

	}

	// how deep the origin sits under the surface while the frame floats on its own (m)
	get floatDraft() {

		return MathUtils.clamp( this.dimensions.height * 0.32, 0.05, 0.3 );

	}

}
