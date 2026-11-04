import * as THREE from '../engine/index.js';

const _v2 = new THREE.Vector2();

// Right-click menu on the ROV. A contextmenu listener casts the camera ray through the pointer
// (engine Raycaster, triangle-exact) against the ROV's own meshes; a hit opens an absolutely
// positioned HTML menu at the cursor.
//
//   const menu = new RovMenu( { camera, canvas, onDive, onFree, onExit } );
//   menu.attach( app.rovCtl );      // after the ROV exists
//
// The items are fixed by the bench: dive into the onboard camera, or fly free around the frame.
export class RovMenu {

	constructor( { camera, canvas, onDive, onFree, onExit, onLights } ) {

		this.camera = camera;
		this.canvas = canvas;
		this.onDive = onDive;
		this.onFree = onFree;
		this.onExit = onExit;
		this.onLights = onLights;

		this.rov = null;
		this.raycaster = new THREE.Raycaster();
		this.el = null;
		this.open = false;

		this._onContext = ( e ) => this._context( e );
		this._onDown = ( e ) => {

			if ( this.el && this.el.contains( e.target ) ) return;
			this.close();

		};
		this._onKey = ( e ) => {

			if ( e.key === 'Escape' ) this.close();

		};

		window.addEventListener( 'contextmenu', this._onContext, true );
		window.addEventListener( 'pointerdown', this._onDown, true );
		window.addEventListener( 'keydown', this._onKey, true );

	}

	attach( rov ) {

		this.rov = rov;

	}

	dispose() {

		window.removeEventListener( 'contextmenu', this._onContext, true );
		window.removeEventListener( 'pointerdown', this._onDown, true );
		window.removeEventListener( 'keydown', this._onKey, true );
		this.close();

	}

	// is the ROV under the pointer? (NDC from the canvas rect, so CSS scaling is handled)
	pick( clientX, clientY ) {

		if ( ! this.rov || ! this.rov.model ) return null;
		const r = this.canvas.getBoundingClientRect();
		if ( ! r.width || ! r.height ) return null;
		_v2.set(
			( ( clientX - r.left ) / r.width ) * 2 - 1,
			- ( ( clientY - r.top ) / r.height ) * 2 + 1,
		);
		this.raycaster.setFromCamera( _v2, this.camera );
		const hits = this.raycaster.intersectObject( this.rov.model.group, true );
		return hits.length ? hits[ 0 ] : null;

	}

	_context( e ) {

		// the browser menu is already suppressed by the input layer; ours replaces it when the
		// pointer is actually on the ROV
		e.preventDefault();
		const hit = this.pick( e.clientX, e.clientY );
		if ( ! hit ) {

			this.close();
			return;

		}

		this.openAt( e.clientX, e.clientY );

	}

	openAt( x, y ) {

		this.close();
		const items = [];
		const driving = this.rov && this.rov.driven;
		items.push( { label: 'Plonger (Vue Interne)', hint: 'C', run: this.onDive } );
		items.push( { label: 'Caméra Libre', hint: 'F', run: this.onFree } );
		if ( driving ) items.push( { label: 'Sortir du ROV', hint: 'E', run: this.onExit } );
		const lights = this.rov && this.rov.model.lightsOn;
		items.push( { label: lights ? 'Projecteurs : off' : 'Projecteurs : on', hint: 'L', run: this.onLights } );

		const el = document.createElement( 'div' );
		el.className = 'tw-rov-menu';
		el.setAttribute( 'role', 'menu' );
		el.style.left = x + 'px';
		el.style.top = y + 'px';

		const head = document.createElement( 'div' );
		head.className = 'tw-rov-menu-head';
		head.textContent = 'ROV · bob_rov_3D';
		el.appendChild( head );

		for ( const it of items ) {

			if ( ! it.run ) continue;
			const b = document.createElement( 'button' );
			b.type = 'button';
			b.className = 'tw-rov-menu-item';
			b.setAttribute( 'role', 'menuitem' );
			const span = document.createElement( 'span' );
			span.textContent = it.label;
			b.appendChild( span );
			if ( it.hint ) {

				const k = document.createElement( 'kbd' );
				k.textContent = it.hint;
				b.appendChild( k );

			}

			b.addEventListener( 'click', ( ev ) => {

				ev.preventDefault();
				ev.stopPropagation();
				this.close();
				it.run();

			} );
			el.appendChild( b );

		}

		document.body.appendChild( el );
		this.el = el;
		this.open = true;

		// keep the panel inside the window
		const b = el.getBoundingClientRect();
		const pad = 8;
		let nx = x, ny = y;
		if ( x + b.width + pad > window.innerWidth ) nx = Math.max( pad, x - b.width );
		if ( y + b.height + pad > window.innerHeight ) ny = Math.max( pad, y - b.height );
		el.style.left = nx + 'px';
		el.style.top = ny + 'px';

	}

	close() {

		if ( this.el && this.el.parentNode ) this.el.parentNode.removeChild( this.el );
		this.el = null;
		this.open = false;

	}

}
