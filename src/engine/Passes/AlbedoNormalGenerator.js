import {
	WebGLRenderTarget,
	NearestFilter,
	RGBAFormat,
	FloatType,
	MeshNormalMaterial,
	RawShaderMaterial,
	GLSL3,
	Texture
} from 'three';

export function generateAlbedoAndNormalMaps( scene, camera, renderer ) {

	const width = renderer.domElement.width;
	const height = renderer.domElement.height;

	// Create render targets for albedo and normal
	const albedoTarget = new WebGLRenderTarget( width, height, {
		minFilter: NearestFilter,
		magFilter: NearestFilter,
		type: FloatType,
		format: RGBAFormat,
	} );

	const normalTarget = new WebGLRenderTarget( width, height, {
		minFilter: NearestFilter,
		magFilter: NearestFilter,
		type: FloatType,
		format: RGBAFormat,
	} );

	// Store original materials and override material
	const originalMaterials = new Map();
	const originalOverrideMaterial = scene.overrideMaterial;

	// Albedo pass
	const albedoMaterial = new RawShaderMaterial( {
		vertexShader: `
            in vec3 position;
            in vec2 uv;
            out vec2 vUv;
            uniform mat4 modelViewMatrix;
            uniform mat4 projectionMatrix;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
		fragmentShader: `
            precision highp float;
            uniform sampler2D tDiffuse;
            in vec2 vUv;
            out vec4 fragColor;
            void main() {
                fragColor = texture(tDiffuse, vUv);
            }
        `,
		glslVersion: GLSL3
	} );

	scene.traverse( ( object ) => {

		if ( object.isMesh ) {

			originalMaterials.set( object, object.material );
			const material = albedoMaterial.clone();
			material.uniforms = {
				tDiffuse: { value: object.material.map || new Texture() }
			};
			object.material = material;

		}

	} );

	// Render albedo
	renderer.setRenderTarget( albedoTarget );
	renderer.render( scene, camera );

	// Normal pass
	scene.overrideMaterial = new MeshNormalMaterial();

	// Render normal
	renderer.setRenderTarget( normalTarget );
	renderer.render( scene, camera );

	// Restore original materials and override material
	scene.traverse( ( object ) => {

		if ( object.isMesh && originalMaterials.has( object ) ) {

			object.material = originalMaterials.get( object );

		}

	} );
	scene.overrideMaterial = originalOverrideMaterial;

	// Read pixel data from render targets
	const albedoBuffer = new Float32Array( width * height * 4 );
	const normalBuffer = new Float32Array( width * height * 4 );

	renderer.readRenderTargetPixels( albedoTarget, 0, 0, width, height, albedoBuffer );
	renderer.readRenderTargetPixels( normalTarget, 0, 0, width, height, normalBuffer );

	// Convert float buffers to Uint8 for ImageData
	const albedoData = new Uint8ClampedArray( albedoBuffer.length );
	const normalData = new Uint8ClampedArray( normalBuffer.length );

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const sourceIndex = ( y * width + x ) * 4;
			const targetIndex = ( ( height - y - 1 ) * width + x ) * 4;

			for ( let i = 0; i < 4; i ++ ) {

				albedoData[ targetIndex + i ] = Math.floor( albedoBuffer[ sourceIndex + i ] * 255 );
				normalData[ targetIndex + i ] = Math.floor( normalBuffer[ sourceIndex + i ] * 255 );

			}

		}

	}

	// Create ImageData objects
	const albedoImageData = new ImageData( albedoData, width, height );
	const normalImageData = new ImageData( normalData, width, height );

	// Clean up
	albedoTarget.dispose();
	normalTarget.dispose();

	// Reset render target
	renderer.setRenderTarget( null );

	return {
		albedo: albedoImageData,
		normal: normalImageData
	};

}

export function renderImageDataToCanvas( imageData, canvasId ) {

	const canvas = document.getElementById( canvasId ) || document.createElement( 'canvas' );
	canvas.width = imageData.width;
	canvas.height = imageData.height;
	const ctx = canvas.getContext( '2d' );
	ctx.putImageData( imageData, 0, 0 );

	if ( ! document.getElementById( canvasId ) ) {

		canvas.id = canvasId;
		document.body.appendChild( canvas );

	}

}

export function debugGeneratedMaps( albedoImageData, normalImageData ) {

	renderImageDataToCanvas( albedoImageData, 'debugAlbedoCanvas' );
	renderImageDataToCanvas( normalImageData, 'debugNormalCanvas' );

}
