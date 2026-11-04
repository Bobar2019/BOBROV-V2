import * as THREE from '../engine/index.js';
import { ShaderModule, UniformBlock } from '../engine/gpu/Shader.js';
import { commonModule } from '../engine/render/wgsl/common.js';
import { surfaceModule } from '../engine/render/wgsl/lighting.js';
import { G } from '../engine/render/Frame.js';
import { SceneLighting } from './SceneLighting.js';

// Local lights (lanterns, lamp posts, path lights, lit windows, the ROV's projectors, the handheld
// flashlight) without a light object per lamp: unrolling every light into every
// material would multiply shader size and compile time. Instead the CPU packs a few of them into
// three small uniform arrays each frame — the switched spots first (the ROV's projectors), then the
// lamps nearest the camera — and every lit material evaluates them in ONE loop (the physical BRDF:
// diffuse + GGX specular), inverse-square falloff with a smooth range window, optional spot cone, no
// shadows. Skipped entirely (uniform loop bound) when nothing is lit (daytime without the flashlight
// or the projectors). They bypass the sun-only terms of the direct light (clouds, caustics, contact
// shadows).
//
// WGSL: `localLightsModule` (prefix localLights) installs the `localLights` lighting hook and exposes
//   uniforms localLights.{ pos[ 8 ], col[ 8 ], dir[ 8 ], count, flashOn, flashPos, flashDir, flashCol, flashCone }
//   fn localLightsSpotProfile( cd: f32, cosInner: f32, cosOuter: f32 ) -> f32
// for effects outside the lighting model (underwater beam in-scatter, marine snow: add the module).
// Exclusions per material define: IS_WATER, NO_LOCAL_LIGHTS (the former `material.localLights = false`);
// LOCAL_LIGHTS_CHEAP (material.localLightsCheap) = Lambert only.
const MAX = 8;
const v4 = () => Array.from( { length: MAX }, () => new THREE.Vector4() );
const params = new UniformBlock( 'LocalLightParams', {
	pos: [ `vec4f[${ MAX }]`, v4() ], // xyz, range^2
	col: [ `vec4f[${ MAX }]`, v4() ], // rgb x intensity, cos(inner cone)
	dir: [ `vec4f[${ MAX }]`, v4() ], // spot axis, cos(outer cone) (-2: point light)
	count: [ 'i32', 0 ],
	flashOn: [ 'f32', 0 ],
	flashCone: [ 'vec2f', new THREE.Vector2( 0.99, 0.82 ) ], // cos inner, cos outer
	flashPos: [ 'vec3f', new THREE.Vector3() ],
	flashDir: [ 'vec3f', new THREE.Vector3( 0, 0, - 1 ) ],
	flashCol: [ 'vec3f', new THREE.Vector3() ], // rgb x intensity
}, { label: 'localLights' } );
const F = params.fields;
const uPos = { array: F.pos.value };
const uCol = { array: F.col.value };
const uDir = { array: F.dir.value };
const uCount = F.count;

// the flashlight for effects outside the lighting model (underwater beam in-scatter, marine snow):
// `{ value }` handles of the localLights uniforms
export const FLASH = {
	on: F.flashOn,
	pos: F.flashPos,
	dir: F.flashDir,
	col: F.flashCol,
	cone: F.flashCone,
};

export const localLightsModule = new ShaderModule( {
	name: 'localLights',
	deps: [ commonModule, surfaceModule ],
	uniforms: params,
	uniformName: 'localLights',
	code: /* wgsl */`
// spot profile shared by the shading, the beam and the snow: hot centre, soft edge, faint spill
fn localLightsSpotProfile( cd: f32, cosInner: f32, cosOuter: f32 ) -> f32 {
	let m = smoothstep( cosOuter, cosInner, cd );
	return max( m * m, smoothstep( cosOuter - 0.55, cosOuter, cd ) * 0.05 );
}

fn hookLocalLights( s: Surface, P: vec3f, N: vec3f, V: vec3f, acc: ptr<function, LightAccum> ) {
#if !IS_WATER && !NO_LOCAL_LIGHTS
	let diffuseColor = s.albedo * ( 1.0 - s.metalness );
	let specF0 = mix( vec3f( 0.04 ) * s.specularIntensity, s.albedo, s.metalness );
	let specF90 = mix( s.specularIntensity, 1.0, s.metalness );
	let rough = clamp( s.roughness, 0.03, 1.0 );
	for ( var i = 0; i < localLights.count; i++ ) {
		let p = localLights.pos[ i ];
		let d = p.xyz - P;
		let d2 = dot( d, d );
		if ( d2 < p.w ) {
			let c = localLights.col[ i ];
			let sd = localLights.dir[ i ];
			let L = d * inverseSqrt( max( d2, 1e-6 ) );
			// smooth range window (1 - (d/r)^4)^2 on the inverse-square law
			let x = d2 / p.w;
			let win = sat( 1.0 - x * x );
			// spot: hot centre, soft edge at the outer cone, faint wide spill
			let spot = localLightsSpotProfile( dot( -L, sd.xyz ), c.w, sd.w );
			// Beer-Lambert over the underwater part of the path (straight, mean sea level): red dies
			// within metres, so what the torch lights far away under water is dim and blue-green
			let r = d2 * inverseSqrt( max( d2, 1e-6 ) );
			let under = sat( ( frame.seaLevel - min( P.y, p.y ) ) / max( abs( p.y - P.y ), 1e-3 ) );
			let Tw = exp( -( frame.waterAbsorption + frame.waterScattering ) * ( r * under ) );
			// the + 0.15 m^2 softens the near field of a lamp's finite size (no hot spot on the post)
			let lightColor = c.xyz * Tw * ( win * win * spot / ( d2 + 0.15 ) );
			let irradiance = max( dot( N, L ), 0.0 ) * lightColor;
#if LOCAL_LIGHTS_CHEAP
			// foliage (heavy overdraw): Lambert only
			( *acc ).directDiffuse += irradiance * diffuseColor * INV_PI;
#else
			( *acc ).directDiffuse += irradiance * diffuseColor * INV_PI;
			( *acc ).directSpecular += irradiance * BRDF_GGX( L, V, N, specF0, specF90, rough );
#if SHEEN
			( *acc ).directSpecular += irradiance * BRDF_Sheen( L, V, N, s.sheenColor, max( s.sheenRoughness, 0.07 ) );
#endif
#endif
		}
	}
#endif
}
`,
} );

SceneLighting.set( 'localLights', localLightsModule );

const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
const smooth = ( x, a, b ) => {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

};

// CPU side: sources and the flashlight, packed every frame.
//   add( { position (live Vector3), color, intensity, range, dir?, cosInner?, cosOuter?, kind, flicker?,
//          nightOnly?, priority?, update? } )
//   intensity: luminous intensity in scene units (illuminance at 1 m); range: cut-off distance (m)
//   nightOnly = false: the source is switched (the ROV's projectors), not scheduled with the dusk
//   priority = true: the source keeps a slot in the pool whatever else is lit (see update)
export class LocalLights {

	constructor() {

		this.sources = [];
		this.enabled = true;
		this.strength = 1; // UI multiplier for the lamps (not the flashlight)
		this.flashlight = {
			on: false, intensity: 55, range: 30,
			color: new THREE.Color( 1.0, 0.71, 0.49 ), // ~4500 K
			cosInner: Math.cos( THREE.MathUtils.degToRad( 9 ) ), cosOuter: Math.cos( THREE.MathUtils.degToRad( 35 ) ),
			position: new THREE.Vector3(), dir: new THREE.Vector3( 0, 0, - 1 ), primed: false,
		};
		this._prio = [];
		this._dusk = [];
		this.time = 0;
		this.active = 0;

	}

	add( src ) {

		src.phase = src.phase ?? Math.random() * 100;
		this.sources.push( src );
		return src;

	}

	toggleFlashlight( on = ! this.flashlight.on ) {

		this.flashlight.on = on;
		this.flashlight.primed = false;
		return on;

	}

	update( camera, dt ) {

		this.time += dt;
		let n = 0;
		FLASH.on.value = this.flashlight.on && this.enabled ? 1 : 0;
		const pos = uPos.array, col = uCol.array, dir = uDir.array;
		const fl = this.flashlight;
		if ( fl.on && this.enabled ) {

			// held a little right of and below the eye, lagging the view slightly
			camera.updateMatrixWorld();
			const e = camera.matrixWorld.elements;
			_r.set( e[ 0 ], e[ 1 ], e[ 2 ] ).normalize();
			_u.set( e[ 4 ], e[ 5 ], e[ 6 ] ).normalize();
			_f.set( - e[ 8 ], - e[ 9 ], - e[ 10 ] ).normalize();
			if ( ! fl.primed ) {

				fl.dir.copy( _f );
				fl.primed = true;

			}

			fl.dir.lerp( _f, 1 - Math.exp( - dt / 0.06 ) ).normalize();
			fl.position.setFromMatrixPosition( camera.matrixWorld ).addScaledVector( _r, 0.2 ).addScaledVector( _u, - 0.22 ).addScaledVector( _f, 0.15 );
			// faint against daylight (the scene's night is exposed far brighter than physical)
			const k = fl.intensity * ( 0.08 + 0.92 * smooth( G.night.value, 0.0, 0.6 ) );
			pos[ 0 ].set( fl.position.x, fl.position.y, fl.position.z, fl.range * fl.range );
			col[ 0 ].set( fl.color.r * k, fl.color.g * k, fl.color.b * k, fl.cosInner );
			dir[ 0 ].set( fl.dir.x, fl.dir.y, fl.dir.z, fl.cosOuter );
			n = 1;
			FLASH.pos.value.copy( fl.position );
			FLASH.dir.value.copy( fl.dir );
			FLASH.col.value.set( fl.color.r * k, fl.color.g * k, fl.color.b * k );
			FLASH.cone.value.set( fl.cosInner, fl.cosOuter );

		}

		// lamps: on from dusk (same ramp as the lantern glass), nearest first. A source flagged
		// nightOnly = false keeps its own switch in broad daylight: the ROV's projectors are lamps of
		// the vehicle, not of the village, and the sun must not be what turns them off.
		const night = smooth( G.night.value, 0.15, 0.75 ) * this.strength;
		if ( this.enabled ) {

			const cp = camera.position;
			const prio = this._prio;
			const dusk = this._dusk;
			prio.length = 0;
			dusk.length = 0;
			for ( const s of this.sources ) {

				if ( s.enabled === false ) continue;
				if ( s.update ) s.update();
				s.d2 = s.position.distanceToSquared( cp );
				( s.nightOnly === false ? prio : dusk ).push( s );

			}

			// the switched spots first, at full strength, daylight or not: the ROV's projectors
			const room = MAX - n;
			const keep = Math.min( prio.length, room );
			for ( let i = 0; i < keep; i ++ ) {

				const s = prio[ i ];
				const k = s.intensity * ( s.scale ?? 1 );
				if ( k > 1e-4 ) packSlot( pos, col, dir, n ++, s, k );

			}

			// then the dusk lamps, nearest first, faded out as they approach the cut (no popping)
			const slots = room - keep;
			if ( night > 0.002 && slots > 0 && dusk.length ) {

				dusk.sort( ( a, b ) => a.d2 - b.d2 );
				const dCut = dusk.length > slots ? Math.sqrt( dusk[ slots ].d2 ) : Infinity;
				for ( let i = 0; i < Math.min( slots, dusk.length ); i ++ ) {

					const s = dusk[ i ];
					const fade = Number.isFinite( dCut ) ? smooth( Math.sqrt( s.d2 ), dCut, dCut * 0.8 ) : 1;
					const fl2 = s.flicker ? 1 + s.flicker * Math.sin( this.time * 9 + s.phase ) * Math.sin( this.time * 5.3 + s.phase * 0.37 ) : 1;
					const k = s.intensity * night * fade * fl2 * ( s.scale ?? 1 );
					if ( k > 1e-4 ) packSlot( pos, col, dir, n ++, s, k );

				}

			}

		}

		uCount.value = n;
		this.active = n;

	}

}

// One slot of the pool: position + range^2, colour x intensity + cos(inner cone), spot axis +
// cos(outer cone). `dir` absent = point light (outer cone -2), no inner cone = -1.5.
function packSlot( pos, col, dir, i, s, k ) {

	const r = s.range;
	pos[ i ].set( s.position.x, s.position.y, s.position.z, r * r );
	col[ i ].set( s.color.r * k, s.color.g * k, s.color.b * k, s.cosInner ?? - 1.5 );
	if ( s.dir ) dir[ i ].set( s.dir.x, s.dir.y, s.dir.z, s.cosOuter ?? - 2 );
	else dir[ i ].set( 0, - 1, 0, - 2 );

}

// A spot light in the pool, with the shape three.js gives it (position, target, intensity,
// distance, angle, penumbra) so the numbers read the same as in a three scene. `angle` is the
// HALF-angle of the cone, as on THREE.SpotLight; `penumbra` softens the edge (0 = hard rim,
// 1 = the whole cone fades from the axis). `distance` is the cut-off range.
// The light follows an Object3D: `mount()` puts the optics at `anchor` and aims through `aim`, both
// in that object's own frame, so an aim point far ahead keeps the beam on the vehicle's own +Z
// without touching the mesh it hangs off.
export class SpotLight {

	constructor( { color = 0xffffff, intensity = 1, distance = 30, angle = Math.PI / 6, penumbra = 0.3 } = {} ) {

		this.position = new THREE.Vector3(); // optics, world (refreshed by update())
		this.target = new THREE.Vector3();   // aim point, world
		this.dir = new THREE.Vector3( 0, 0, 1 );
		this.color = new THREE.Color( color );
		this.intensity = intensity;
		this.range = distance;
		this.angle = angle;
		this.penumbra = penumbra;
		this.cosOuter = Math.cos( angle );
		this.cosInner = Math.cos( angle * ( 1 - Math.min( penumbra, 0.95 ) ) );
		this.kind = 'spot';
		this.on = true;
		this.nightOnly = false; // a switch, not a dusk lamp
		this.priority = true;   // keeps its slot in the pool whatever else is lit
		this.parent = null;
		this.anchor = new THREE.Vector3();
		this.aim = new THREE.Vector3( 0, 0, 1 );
		this._switch = null;

	}

	// on / off: set `on` directly, or follow another state with a callback
	// (the ROV's projectors read RovModel.lightsOn, so the lens and the beam cannot disagree)
	switchTo( read ) {

		this._switch = read;
		return this;

	}

	get enabled() {

		return this._switch ? !! this._switch() : this.on;

	}

	mount( parent, anchor, aim ) {

		this.parent = parent;
		this.anchor.copy( anchor );
		this.aim.copy( aim );
		this.update();
		return this;

	}

	update() {

		const p = this.parent;
		if ( ! p ) return;
		p.updateWorldMatrix( true, false );
		this.position.copy( this.anchor ).applyMatrix4( p.matrixWorld );
		this.target.copy( this.aim ).applyMatrix4( p.matrixWorld );
		this.dir.copy( this.target ).sub( this.position ).normalize();

	}

}

// The ROV's two projectors: one spot per lens, at the coordinates of the optics (model.lampAnchors),
// a cold white thrown straight ahead along the vehicle's own +Z. The mesh of projecteur.glb is left
// exactly as the CAD assembly exported it — the beam is aimed by its target, never by a rotation.
// Narrow and strong on purpose: a pool of light on the bottom, not a glow around the lenses.
const PROJECTOR = {
	color: 0xdfeaff, intensity: 150, distance: 60,
	angle: Math.PI / 6, // half-angle: a 60 deg cone, as THREE.SpotLight counts it
	penumbra: 0.4,      // hot centre, soft rim on the sand
	ahead: 60,          // aim point (m) on the local +Z axis: far enough to be a direction
};

export function addRovLights( lights, model ) {

	const obj = model.group;
	const out = [];
	for ( const local of model.lampAnchors ) {

		const spot = new SpotLight( PROJECTOR );
		spot.switchTo( () => model.lightsOn );         // the lenses and the beams come on together
		const aim = local.clone().setZ( local.z + PROJECTOR.ahead );
		out.push( lights.add( spot.mount( obj, local, aim ) ) );

	}

	return out;

}

// Village lights (Village.getLightSources()): lanterns, lamp posts, path lights, lit windows. Window
// lights sit just outside the pane and only light outward (porches); lanterns flicker a little.
export function addVillageLights( lights, village ) {

	const K = { lantern: 1.5, pathLight: 1.0, window: 0.8 };
	const R = { lantern: 11, pathLight: 7, window: 6 };
	for ( const l of village.getLightSources() ) {

		const kind = l.kind || 'lantern';
		const src = { position: l.position, color: l.color, intensity: l.intensity * ( K[ kind ] ?? 1.2 ), range: R[ kind ] ?? 12, kind };
		if ( kind === 'window' ) {

			// outward normal: away from the nearest building centre
			let best = null, bd = Infinity;
			for ( const b of village.buildings || [] ) {

				const dd = ( b.x - l.position.x ) ** 2 + ( b.z - l.position.z ) ** 2;
				if ( dd < bd ) {

					bd = dd;
					best = b;

				}

			}

			const n = best ? _v.set( l.position.x - best.x, 0, l.position.z - best.z ) : _v.set( 0, 0, 1 );
			if ( n.lengthSq() < 1e-6 ) n.set( 0, 0, 1 );
			n.normalize();
			src.position = l.position.clone().addScaledVector( n, 0.35 );
			src.dir = n.clone();
			src.cosInner = 0.35;
			src.cosOuter = - 0.15;

		} else {

			src.flicker = 0.08;

		}

		lights.add( src );

	}

}
