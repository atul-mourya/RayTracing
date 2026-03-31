import {
	EventDispatcher, DirectionalLight, PointLight, SpotLight, RectAreaLight,
	Object3D, MathUtils
} from 'three';

/**
 * Manages scene lights: add, remove, transfer from mesh scene to WebGPU
 * scene, sync helpers, and update GPU uniform buffers.
 *
 * Extracted from PathTracerApp to keep the facade slim.
 */
export class LightManager extends EventDispatcher {

	/**
	 * @param {import('three').Scene}      scene          - WebGPU light scene
	 * @param {import('../SceneHelpers.js').SceneHelpers} sceneHelpers
	 * @param {import('../Stages/PathTracer.js').PathTracer} pathTracer
	 */
	constructor( scene, sceneHelpers, pathTracer ) {

		super();

		this.scene = scene;
		this.sceneHelpers = sceneHelpers;
		this.pathTracer = pathTracer;

	}

	/**
	 * Adds a light to the scene and updates the path tracer.
	 *
	 * @param {string} type - 'DirectionalLight' | 'PointLight' | 'SpotLight' | 'RectAreaLight'
	 * @returns {Object|null} Light descriptor or null if type is invalid
	 */
	addLight( type ) {

		const defaults = {
			DirectionalLight: { position: [ 1, 1, 1 ], intensity: 1.0, color: '#ffffff' },
			PointLight: { position: [ 0, 2, 0 ], intensity: 100, color: '#ffffff' },
			SpotLight: { position: [ 0, 1, 0 ], intensity: 300, color: '#ffffff', angle: 15 },
			RectAreaLight: { position: [ 0, 2, 0 ], intensity: 500, color: '#ffffff', width: 2, height: 2 }
		};

		const props = defaults[ type ];
		if ( ! props ) return null;

		let light;

		if ( type === 'DirectionalLight' ) {

			light = new DirectionalLight( props.color, props.intensity );
			light.position.fromArray( props.position );

		} else if ( type === 'PointLight' ) {

			light = new PointLight( props.color, props.intensity );
			light.position.fromArray( props.position );

		} else if ( type === 'SpotLight' ) {

			light = new SpotLight( props.color, props.intensity );
			light.position.fromArray( props.position );
			light.angle = MathUtils.degToRad( props.angle );
			const target = new Object3D();
			this.scene.add( target );
			light.target = target;

		} else if ( type === 'RectAreaLight' ) {

			light = new RectAreaLight( props.color, props.intensity, props.width, props.height );
			light.position.fromArray( props.position );
			light.lookAt( 0, 0, 0 );

		}

		const count = this.scene.getObjectsByProperty( 'isLight', true ).length;
		light.name = `${type.replace( 'Light', '' )} ${count + 1}`;
		this.scene.add( light );
		this.updateLights();
		this._syncHelpers();

		return this._buildDescriptor( light );

	}

	/**
	 * Removes a light by UUID.
	 * @param {string} uuid
	 * @returns {boolean}
	 */
	removeLight( uuid ) {

		const light = this.scene.getObjectByProperty( 'uuid', uuid );
		if ( ! light || ! light.isLight ) return false;

		this.sceneHelpers.remove( light );
		if ( light.target ) light.target.removeFromParent();
		light.removeFromParent();
		this.updateLights();
		return true;

	}

	/**
	 * Removes all lights from the scene.
	 */
	clearLights() {

		this.sceneHelpers.clear();
		this._removeAllLights();
		this.updateLights();

	}

	/**
	 * Returns descriptors for all lights in the scene.
	 * @returns {Object[]}
	 */
	getLights() {

		return this.scene.getObjectsByProperty( 'isLight', true ).map( light => this._buildDescriptor( light ) );

	}

	/**
	 * Reprocesses all scene lights and updates the path tracer uniform buffers.
	 */
	updateLights() {

		this.pathTracer?.updateLights();

	}

	/**
	 * Clones lights from the mesh scene into the WebGPU light scene,
	 * then updates GPU uniform buffers.
	 * @param {import('three').Scene} meshScene
	 */
	transferSceneLights( meshScene ) {

		this._removeAllLights();

		const sourceLights = meshScene.getObjectsByProperty( 'isLight', true );

		if ( ! sourceLights || sourceLights.length === 0 ) {

			this.updateLights();
			return;

		}

		for ( const light of sourceLights ) {

			const cloned = light.clone();

			light.updateWorldMatrix( true, false );
			light.getWorldPosition( cloned.position );
			light.getWorldQuaternion( cloned.quaternion );
			light.getWorldScale( cloned.scale );

			if ( cloned.isRectAreaLight ) {

				cloned.width *= cloned.scale.x;
				cloned.height *= cloned.scale.y;
				cloned.scale.set( 1, 1, 1 );

			}

			if ( light.isSpotLight && light.target ) {

				const clonedTarget = new Object3D();
				light.target.updateWorldMatrix( true, false );
				light.target.getWorldPosition( clonedTarget.position );
				this.scene.add( clonedTarget );
				cloned.target = clonedTarget;

			}

			this.scene.add( cloned );

		}

		this.updateLights();
		this._syncHelpers();

	}

	/**
	 * Shows/hides light helpers.
	 * @param {boolean} show
	 */
	setShowLightHelper( show ) {

		this.sceneHelpers.visible = show;

		if ( show ) {

			this._syncHelpers();

		} else {

			this.sceneHelpers.clear();

		}

	}

	// ── Private ───────────────────────────────────────────────────

	/** Syncs helpers in sceneHelpers with current scene lights. */
	_removeAllLights() {

		this.scene.getObjectsByProperty( 'isLight', true ).forEach( light => {

			if ( light.target ) this.scene.remove( light.target );
			this.scene.remove( light );

		} );

	}

	_syncHelpers() {

		if ( ! this.sceneHelpers.visible ) return;
		const lights = this.scene.getObjectsByProperty( 'isLight', true );
		this.sceneHelpers.sync( lights );

	}

	/**
	 * Builds a serialisable descriptor object from a Three.js light.
	 * @param {import('three').Light} light
	 * @returns {Object}
	 */
	_buildDescriptor( light ) {

		let angle = 0;

		if ( light.type === 'SpotLight' && light.angle !== undefined ) {

			angle = MathUtils.radToDeg( light.angle );

		}

		const descriptor = {
			uuid: light.uuid,
			name: light.name,
			type: light.type,
			intensity: light.intensity,
			color: `#${light.color.getHexString()}`,
			position: [ light.position.x, light.position.y, light.position.z ],
			angle
		};

		if ( light.type === 'RectAreaLight' ) {

			descriptor.width = light.width;
			descriptor.height = light.height;
			const dir = light.getWorldDirection( light.position.clone() );
			descriptor.target = [ light.position.x + dir.x, light.position.y + dir.y, light.position.z + dir.z ];

		} else if ( light.type === 'SpotLight' && light.target ) {

			descriptor.target = [ light.target.position.x, light.target.position.y, light.target.position.z ];

		}

		return descriptor;

	}

}
