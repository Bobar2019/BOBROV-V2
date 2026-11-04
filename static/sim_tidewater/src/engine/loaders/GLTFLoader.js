// GLTFLoader: the three.js-style entry point for this engine. The project has no three.js — GLB
// files are read by the CPU-side parser in ../loaders/GLTF.js (plus the smaller debris reader in
// world/debris/GLB.js) — so this class is the thin, renderable-object layer on top of it:
//
//   const loader = new GLTFLoader();
//   const gltf = await loader.loadAsync( 'models/bob_rov_3D.glb' );
//   scene.add( gltf.scene );                 // Group mirroring the glTF node hierarchy
//   gltf.meshes                              // every Mesh, in file order
//
// Handled: node TRS / matrix, POSITION / NORMAL / TEXCOORD_0, indexed or not, pbrMetallicRoughness
// base colour + metallic / roughness, doubleSided, alphaMode BLEND. Not handled (not used by the
// assets we ship): Draco / meshopt, skins, morph targets, animations, embedded textures, samplers.

import {
	BufferAttribute, BufferGeometry, Color, Group, Mesh, Object3D, Uint16BufferAttribute,
} from '../index.js';
import { standard } from '../../materials/Materials.js';
import { parseGLB } from './GLTF.js';

export class GLTFLoader {

	constructor( manager = null ) {

		this.manager = manager;
		this.materials = new Map(); // glTF material index -> engine material
		this.meshes = [];

	}

	// three.js callback form: load( url, onLoad, onProgress, onError )
	load( url, onLoad, onProgress = null, onError = null ) {

		this.loadAsync( url, onProgress ).then( onLoad ).catch( ( e ) => {

			if ( onError ) onError( e ); else console.error( e );

		} );

	}

	async loadAsync( url, onProgress = null ) {

		let buffer;
		if ( globalThis.__assetFile ) buffer = await globalThis.__assetFile( url );
		else {

			const res = await fetch( url );
			if ( ! res.ok ) throw new Error( 'GLTFLoader: ' + url + ' ' + res.status );
			buffer = await res.arrayBuffer();

		}

		if ( onProgress ) onProgress( { loaded: buffer.byteLength, total: buffer.byteLength } );
		return this.parse( buffer );

	}

	parse( buffer ) {

		const gltf = parseGLB( buffer );
		const json = gltf.json;
		this.meshes = [];

		const matOf = ( i ) => {

			if ( i === undefined ) return this._material( json.materials[ 0 ] || {} );
			if ( ! this.materials.has( i ) ) this.materials.set( i, this._material( json.materials[ i ] || {} ) );
			return this.materials.get( i );

		};

		const nodes = gltf.nodes.map( ( n ) => {

			const o = new Object3D();
			o.name = n.name || '';
			o.position.set( n.t[ 0 ], n.t[ 1 ], n.t[ 2 ] );
			o.quaternion.set( n.r[ 0 ], n.r[ 1 ], n.r[ 2 ], n.r[ 3 ] );
			o.scale.set( n.s[ 0 ], n.s[ 1 ], n.s[ 2 ] );
			return o;

		} );

		for ( let i = 0; i < nodes.length; i ++ ) {

			const n = gltf.nodes[ i ];
			for ( const c of n.children ) nodes[ i ].add( nodes[ c ] );
			if ( n.mesh === undefined ) continue;
			// one Mesh per primitive: the engine draws a mesh with a single material
			gltf.meshes[ n.mesh ].forEach( ( prim, pi ) => {

				if ( prim.mode !== undefined && prim.mode !== 4 ) return; // triangles only
				const mesh = new Mesh( this._geometry( prim ), matOf( prim.material ) );
				mesh.name = ( n.name || 'node' + i ) + ( pi ? '_' + pi : '' );
				mesh.userData.gltfNode = n.name || '';
				mesh.castShadow = true;
				mesh.receiveShadow = true;
				nodes[ i ].add( mesh );
				this.meshes.push( mesh );

			} );

		}

		const scene = new Group();
		scene.name = 'gltf-scene';
		for ( const r of gltf.roots ) scene.add( nodes[ r ] );
		return { scene, nodes, meshes: this.meshes, materials: this.materials, json };

	}

	_geometry( prim ) {

		const g = new BufferGeometry();
		const at = prim.attributes;
		if ( at.POSITION ) g.setAttribute( 'position', new BufferAttribute( this._floats( at.POSITION ), 3 ) );
		if ( at.NORMAL ) g.setAttribute( 'normal', new BufferAttribute( this._floats( at.NORMAL ), 3 ) );
		if ( at.TEXCOORD_0 ) g.setAttribute( 'uv', new BufferAttribute( this._floats( at.TEXCOORD_0 ), 2 ) );
		if ( prim.indices ) {

			const ix = prim.indices;
			// GL cannot index 8-bit: widen as the shared debris reader does
			g.setIndex( ix instanceof Uint8Array ? new Uint16BufferAttribute( ix, 1 ) : new BufferAttribute( ix, 1 ) );

		}

		g.computeBoundingBox();
		return g;

	}

	// attribute -> tightly packed Float32 (normalized integers expanded, as three does)
	_floats( a ) {

		if ( a.array instanceof Float32Array ) return a.array;
		const out = new Float32Array( a.array.length );
		const k = a.normalized ? 1 / ( a.componentType === 5120 ? 127 : a.componentType === 5122 ? 32767 : a.componentType === 5121 ? 255 : 65535 ) : 1;
		for ( let i = 0; i < out.length; i ++ ) out[ i ] = a.array[ i ] * k;
		return out;

	}

	_material( m ) {

		const pbr = m.pbrMetallicRoughness || {};
		const c = pbr.baseColorFactor || [ 1, 1, 1, 1 ];
		const mat = standard( {
			// glTF factors are linear, which is the engine's working space: no conversion
			color: new Color( c[ 0 ], c[ 1 ], c[ 2 ] ),
			metalness: pbr.metallicFactor ?? 1,
			roughness: pbr.roughnessFactor ?? 1,
		} );
		mat.name = m.name || 'gltf-material';
		if ( m.doubleSided ) mat.side = 'double';
		if ( m.alphaMode === 'BLEND' ) {

			mat.transparent = true;
			mat.opacity = c[ 3 ];

		}

		return mat;

	}

}
