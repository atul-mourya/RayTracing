import { Vector3, Quaternion } from 'three';

export class LightDataTransfer {

	constructor() {

		this.lightData = {
			directional: [],
			rectArea: []
		};

		// Cache for preprocessed lights
		this.directionalLightCache = [];
		this.areaLightCache = [];

	}

	clear() {

		this.lightData.directional = [];
		this.lightData.rectArea = [];
		this.directionalLightCache = [];
		this.areaLightCache = [];

	}

	calculateLightImportance( light, type = 'directional' ) {

		// Calculate luminance-weighted importance
		const luminance = 0.2126 * light.color.r + 0.7152 * light.color.g + 0.0722 * light.color.b;
		let importance = light.intensity * luminance;

		// Area lights get additional importance based on size
		if ( type === 'area' ) {

			const area = light.width * light.height;
			importance *= Math.sqrt( area ); // Larger lights are more important

		}

		return importance;

	}

	addDirectionalLight( light ) {

		if ( light.intensity <= 0.0 ) return; // Skip zero intensity lights

		// Convert world position to direction
		light.updateMatrixWorld();
		const position = light.getWorldPosition( new Vector3() );

		// Calculate importance for sorting
		const importance = this.calculateLightImportance( light, 'directional' );

		// Get angle parameter from light (default to 0 for sharp shadows)
		// You can add this as a custom property to your DirectionalLight
		const angle = light.userData.angle || light.angle || 0.0; // In radians

		// Store in cache with importance
		this.directionalLightCache.push( {
			data: [
				position.x, position.y, position.z, // position (3)
				light.color.r, light.color.g, light.color.b, // color (3)
				light.intensity, // intensity (1)
				angle // angular diameter in radians (1)
			],
			importance: importance,
			light: light
		} );

	}

	addRectAreaLight( light ) {

		if ( light.intensity <= 0.0 ) return; // Skip zero intensity lights

		light.updateMatrixWorld();

		const position = light.getWorldPosition( new Vector3() );
		const worldQuaternion = light.getWorldQuaternion( new Quaternion() );
		const worldScale = light.getWorldScale( new Vector3() );
		const width = light.width * worldScale.x * 0.5;
		const height = light.height * worldScale.y * 0.5;

		let u = new Vector3( width, 0, 0 ).applyQuaternion( worldQuaternion );
		let v = new Vector3( 0, height, 0 ).applyQuaternion( worldQuaternion );

		// Calculate importance for sorting
		const importance = this.calculateLightImportance( light, 'area' );

		// Store in cache with importance
		this.areaLightCache.push( {
			data: [
				position.x, position.y, position.z, // position (3)
				u.x, u.y, u.z, // u vector (3)
				v.x, v.y, v.z, // v vector (3)
				light.color.r, light.color.g, light.color.b, // color (3)
				light.intensity // intensity (1)
			],
			importance: importance,
			light: light
		} );

	}

	preprocessLights() {

		// Sort directional lights by importance (highest first)
		this.directionalLightCache.sort( ( a, b ) => b.importance - a.importance );

		// Sort area lights by importance (highest first)
		this.areaLightCache.sort( ( a, b ) => b.importance - a.importance );

		// Flatten sorted data arrays
		this.lightData.directional = [];
		this.lightData.rectArea = [];

		this.directionalLightCache.forEach( lightCache => {

			this.lightData.directional.push( ...lightCache.data );

		} );

		this.areaLightCache.forEach( lightCache => {

			this.lightData.rectArea.push( ...lightCache.data );

		} );

		if ( this.areaLightCache.length > 0 ) {

			console.log( `Preprocessed ${this.areaLightCache.length} area lights by importance` );

		}

	}

	updateShaderUniforms( material ) {

		// Use size constants to calculate counts
		const directionalCount = this.lightData.directional.length;
		const areaCount = this.lightData.rectArea.length;

		// Update light counts in shader defines
		material.defines.MAX_DIRECTIONAL_LIGHTS = directionalCount;
		material.defines.MAX_AREA_LIGHTS = areaCount;

		// Update uniforms with type arrays
		material.uniforms.directionalLights.value = new Float32Array( this.lightData.directional );
		material.uniforms.areaLights.value = new Float32Array( this.lightData.rectArea );

		material.needsUpdate = true;

	}

	processSceneLights( scene, material ) {

		this.clear();

		// Collect all lights first
		scene.traverse( ( object ) => {

			if ( object.isDirectionalLight ) {

				this.addDirectionalLight( object );

			} else if ( object.isRectAreaLight ) {

				this.addRectAreaLight( object );

			}

		} );

		// Preprocess lights by importance
		this.preprocessLights();

		// Update shader uniforms
		this.updateShaderUniforms( material );

	}

	// Method to get light importance data for debugging
	getLightStatistics() {

		return {
			directionalLights: this.directionalLightCache.map( cache => ( {
				intensity: cache.light.intensity,
				importance: cache.importance,
				color: cache.light.color
			} ) ),
			areaLights: this.areaLightCache.map( cache => ( {
				intensity: cache.light.intensity,
				importance: cache.importance,
				color: cache.light.color,
				size: cache.light.width * cache.light.height
			} ) )
		};

	}

}
