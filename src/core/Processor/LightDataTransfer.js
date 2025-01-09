import { Vector3, Quaternion } from 'three';

export class LightDataTransfer {

	constructor() {

		this.lightData = {
			directional: [],
			rectArea: []
		};

	}

	clear() {

		this.lightData.directional = [];
		this.lightData.rectArea = [];

	}

	addDirectionalLight( light ) {

		if ( light.intensity <= 0.0 ) return; // Skip zero intensity lights
		// Convert world position to direction
		light.updateMatrixWorld();
		const position = light.getWorldPosition( new Vector3() );

		// Push exactly DIRECTIONAL_LIGHT_SIZE components
		this.lightData.directional.push(
			position.x, position.y, position.z, // position (3)
			light.color.r, light.color.g, light.color.b, // color (3)
			light.intensity // intensity (1)
		);

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

		// Push exactly AREA_LIGHT_SIZE components
		this.lightData.rectArea.push(
			position.x, position.y, position.z, // position (3)
			u.x, u.y, u.z, // u vector (3)
			v.x, v.y, v.z, // v vector (3)
			light.color.r, light.color.g, light.color.b, // color (3)
			light.intensity // intensity (1)
		);

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

		scene.traverse( ( object ) => {

			if ( object.isDirectionalLight ) {

				this.addDirectionalLight( object );

			} else if ( object.isRectAreaLight ) {

				this.addRectAreaLight( object );

			}

		} );

		this.updateShaderUniforms( material );

	}

}
