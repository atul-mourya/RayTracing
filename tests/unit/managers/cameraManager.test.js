import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock( 'three', () => {

	class EventDispatcher {

		constructor() { this._listeners = {}; }
		addEventListener( t, l ) { ( this._listeners[ t ] ||= [] ).push( l ); }
		removeEventListener( t, l ) { if ( this._listeners[ t ] ) { const i = this._listeners[ t ].indexOf( l ); if ( i > - 1 ) this._listeners[ t ].splice( i, 1 ); } }
		dispatchEvent( e ) { ( this._listeners[ e.type ] || [] ).forEach( l => l( e ) ); }

	}

	return {
		EventDispatcher,
		Vector3: class { constructor( x = 0, y = 0, z = 0 ) { this.x = x; this.y = y; this.z = z; } copy( v ) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } subVectors( a, b ) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; } normalize() { return this; } multiplyScalar() { return this; } add() { return this; } length() { return 1; } },
	};

} );

import { CameraManager } from '@/core/managers/CameraManager.js';

function createMockCamera( name = '' ) {

	return {
		name,
		position: { x: 0, y: 0, z: 5, copy: vi.fn(), clone: vi.fn( function () { return { ...this }; } ) },
		rotation: { copy: vi.fn(), clone: vi.fn( function () { return { ...this }; } ) },
		fov: 50,
		near: 0.1,
		far: 1000,
		aspect: 1.5,
		updateProjectionMatrix: vi.fn(),
		lookAt: vi.fn(),
	};

}

function createMockControls() {

	return {
		target: { x: 0, y: 0, z: 0, copy: vi.fn(), clone: vi.fn( function () { return { ...this }; } ) },
		update: vi.fn(),
		enabled: true,
	};

}

describe( 'CameraManager', () => {

	let manager, camera, controls;

	beforeEach( () => {

		camera = createMockCamera();
		controls = createMockControls();
		manager = new CameraManager( camera, controls, null );

	} );

	// ── constructor ───────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'stores camera and controls', () => {

			expect( manager.camera ).toBe( camera );
			expect( manager.controls ).toBe( controls );

		} );

		it( 'initializes with default camera in cameras list', () => {

			expect( manager.cameras ).toHaveLength( 1 );
			expect( manager.cameras[ 0 ] ).toBe( camera );

		} );

		it( 'starts at camera index 0', () => {

			expect( manager.currentCameraIndex ).toBe( 0 );

		} );

		it( 'initializes AF state', () => {

			expect( manager.afScreenPoint ).toEqual( { x: 0.5, y: 0.5 } );

		} );

	} );

	// ── setCameras ────────────────────────────────────────────

	describe( 'setCameras', () => {

		it( 'replaces camera list', () => {

			const cam2 = createMockCamera( 'ModelCam' );
			manager.setCameras( [ camera, cam2 ] );
			expect( manager.cameras ).toHaveLength( 2 );

		} );

	} );

	// ── getCameraNames ────────────────────────────────────────

	describe( 'getCameraNames', () => {

		it( 'returns ["Default Camera"] for single camera', () => {

			expect( manager.getCameraNames() ).toEqual( [ 'Default Camera' ] );

		} );

		it( 'returns named cameras', () => {

			const cam2 = createMockCamera( 'Front' );
			manager.setCameras( [ camera, cam2 ] );

			const names = manager.getCameraNames();
			expect( names[ 0 ] ).toBe( 'Default Camera' );
			expect( names[ 1 ] ).toBe( 'Front' );

		} );

		it( 'uses "Camera N" for unnamed cameras', () => {

			const cam2 = createMockCamera( '' );
			manager.setCameras( [ camera, cam2 ] );

			const names = manager.getCameraNames();
			expect( names[ 1 ] ).toBe( 'Camera 1' );

		} );

		it( 'handles empty cameras list', () => {

			manager.cameras = [];
			expect( manager.getCameraNames() ).toEqual( [ 'Default Camera' ] );

		} );

		it( 'handles null cameras', () => {

			manager.cameras = null;
			expect( manager.getCameraNames() ).toEqual( [ 'Default Camera' ] );

		} );

	} );

	// ── switchCamera guard ────────────────────────────────────

	describe( 'switchCamera', () => {

		it( 'returns early for empty cameras', () => {

			manager.cameras = [];
			// Should not throw
			expect( () => manager.switchCamera( 0, 5, vi.fn(), vi.fn() ) ).not.toThrow();

		} );

		it( 'returns early for null cameras', () => {

			manager.cameras = null;
			expect( () => manager.switchCamera( 0, 5, vi.fn(), vi.fn() ) ).not.toThrow();

		} );

	} );

} );
