import { ShaderMaterial, Vector2, Vector3, Matrix4, RGBAFormat, WebGLRenderTarget,
	FloatType,
	NearestFilter
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/Addons.js';
import FragmentShader from '../PathTracer/pathtracer.fs';
import VertexShader from '../PathTracer/pathtracer.vs';
import TriangleSDF from '../../src/TriangleSDF';

class PathTracerPass extends Pass {

	constructor( renderer, scene, camera, width, height ) {

		super();

		this.camera = camera;
		this.width = width;
		this.height = height;
		this.renderer = renderer;

		this.name = 'PathTracerPass';

		// Create two render targets for ping-pong rendering
		this.renderTargetA = new WebGLRenderTarget( width, height, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter
		} );
		this.renderTargetB = this.renderTargetA.clone();

		// Start with A as current and B as previous
		this.currentRenderTarget = this.renderTargetA;
		this.previousRenderTarget = this.renderTargetB;

		this.name = 'PathTracerPass';
		this.material = new ShaderMaterial( {

			name: 'PathTracingShader',

			defines: {
				MAX_SPHERE_COUNT: 0,
				MAX_DIRECTIONAL_LIGHTS: 0
			},

			uniforms: {

				resolution: { value: new Vector2( width, height ) },
				enableEnvironmentLight: { value: true },
				envMap: { value: scene.background },
				envMapIntensity: { value: renderer.toneMappingExposure },

				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },
				focalDistance: { value: 1 },
				aperture: { value: 0.0 },

				directionalLightDirection: { value: scene.getObjectByName( 'directionLight' )?.position.clone().normalize().negate() ?? new Vector3() },
				directionalLightColor: { value: scene.getObjectByName( 'directionLight' )?.color ?? new Vector3() },
				directionalLightIntensity: { value: scene.getObjectByName( 'directionLight' )?.intensity ?? 0 },

				frame: { value: 0 },
				maxBounceCount: { value: 2 },
				numRaysPerPixel: { value: 1 },
				renderMode: { value: 0 },
				tiles: { value: 4 },
				checkeredFrameInterval: { value: 2 },
				previousFrameTexture: { value: null },

				visMode: { value: 0 },
				debugVisScale: { value: 100 },

				spheres: { value: [] },

				diffuseTextures: { value: null },
				diffuseTexSize: { value: new Vector2() },

				triangleTexture: { value: null },
				triangleTexSize: { value: new Vector2() },

				bvhTexture: { value: null },
				bvhTexSize: { value: new Vector2() },

				materialTexture: { value: null },
				materialTexSize: { value: new Vector2() },

			},

			vertexShader: VertexShader,
			fragmentShader: FragmentShader

		} );

		this.fsQuad = new FullScreenQuad( this.material );

		// Create CopyShader material
		this.copyMaterial = new ShaderMaterial( CopyShader );
		this.copyQuad = new FullScreenQuad( this.copyMaterial );

	}

	build( scene ) {

		this.dispose();

		const sdfs = new TriangleSDF( scene );

		this.material.defines = {
			MAX_SPHERE_COUNT: sdfs.spheres.length,
			MAX_DIRECTIONAL_LIGHTS: sdfs.directionalLights.length
		};
		this.material.uniforms.spheres.value = sdfs.spheres;
		this.material.uniforms.diffuseTextures.value = sdfs.diffuseTextures;
		this.material.uniforms.diffuseTexSize.value = sdfs.diffuseTextures ? new Vector2( sdfs.diffuseTextures.image.width, sdfs.diffuseTextures.image.height ) : new Vector2();
		this.material.uniforms.triangleTexture.value = sdfs.triangleTexture;
		this.material.uniforms.triangleTexSize.value = sdfs.triangleTexture ? new Vector2( sdfs.triangleTexture.image.width, sdfs.triangleTexture.image.height ) : new Vector2();
		this.material.uniforms.bvhTexture.value = sdfs.bvhTexture;
		this.material.uniforms.bvhTexSize.value = sdfs.bvhTexture ? new Vector2( sdfs.bvhTexture.image.width, sdfs.bvhTexture.image.height ) : new Vector2();
		this.material.uniforms.materialTexture.value = sdfs.materialTexture;
		this.material.uniforms.materialTexSize.value = sdfs.materialTexture ? new Vector2( sdfs.materialTexture.image.width, sdfs.materialTexture.image.height ) : new Vector2();

	}

	updateLight( dirLight ) {

		this.material.uniforms.directionalLightIntensity.value = dirLight.intensity;
		this.material.uniforms.directionalLightColor.value.copy( dirLight.color );
		this.material.uniforms.directionalLightDirection.value.copy( dirLight.position ).normalize().negate();

	}

	reset() {

		// this.renderer.setRenderTarget( this.renderTargetA );
		// this.renderer.clear();
		// this.renderer.setRenderTarget( this.renderTargetB );
		// this.renderer.clear();

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		this.material.uniforms.resolution.value.set( width, height );
		this.renderTargetA.setSize( width, height );
		this.renderTargetB.setSize( width, height );

	}

	dispose() {

		this.material.uniforms.diffuseTextures.value?.dispose();
		this.material.uniforms.triangleTexture.value?.dispose();
		this.material.uniforms.bvhTexture.value?.dispose();
		this.material.uniforms.materialTexture.value?.dispose();
		this.material.dispose();
		this.fsQuad.dispose();
		this.renderTargetA.dispose();
		this.renderTargetB.dispose();
		this.copyMaterial.dispose();
		this.copyQuad.dispose();

	}

	render( renderer, writeBuffer, /*readBuffer*/ ) {

		if ( ! this.enabled ) return;

		// Update uniforms
		this.material.uniforms.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
		this.material.uniforms.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );
		this.material.uniforms.frame.value ++;

		// Set the previous frame texture
		this.material.uniforms.previousFrameTexture.value = this.previousRenderTarget.texture;

		// Render to the current render target
		renderer.setRenderTarget( this.currentRenderTarget );
		this.fsQuad.render( renderer );

		// Copy the result to the write buffer or screen
		this.copyMaterial.uniforms.tDiffuse.value = this.currentRenderTarget.texture;

		if ( this.renderToScreen ) {

			renderer.setRenderTarget( null );
			this.copyQuad.render( renderer );

		} else {

			renderer.setRenderTarget( writeBuffer );
			if ( this.clear ) renderer.clear();
			this.copyQuad.render( renderer );

		}

		// Swap render targets for next frame
		[ this.currentRenderTarget, this.previousRenderTarget ] = [ this.previousRenderTarget, this.currentRenderTarget ];

	}

}

export default PathTracerPass;
