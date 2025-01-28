import {
	WebGLRenderTarget,
	LinearFilter,
	RGBAFormat,
	FloatType,
	MeshNormalMaterial,
	RawShaderMaterial,
	GLSL3,
	Texture,
	Matrix3,
	NoBlending
} from 'three';

export class AlbedoNormalGenerator {

	constructor( scene, camera, renderer ) {

		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;
		this.originalMaterials = new WeakMap();
		this.originalOverrideMaterial = scene.overrideMaterial;

		this._initializeSize();
		this._createMaterials();
		this._createRenderTargets();

	}

	_initializeSize() {

		const pixelRatio = this.renderer.getPixelRatio();
		this.width = Math.floor( this.renderer.domElement.width * pixelRatio );
		this.height = Math.floor( this.renderer.domElement.height * pixelRatio );

		if ( this.width <= 0 || this.height <= 0 ) {

			throw new Error( 'Invalid dimensions: width and height must be positive integers' );

		}

	}

	_createMaterials() {

		// Normal material with optimized settings
		this.normalMaterial = new MeshNormalMaterial( {
			blending: NoBlending,
			depthTest: true,
			depthWrite: true
		} );

		// Albedo material with optimized settings
		this.albedoMaterial = new RawShaderMaterial( {
			uniforms: {
				tDiffuse: { value: null },
				uvTransform: { value: new Matrix3() }
			},
			vertexShader: `
                in vec3 position;
                in vec2 uv;
                out vec2 vUv;
                uniform mat3 uvTransform;
                uniform mat4 modelViewMatrix;
                uniform mat4 projectionMatrix;
                
                void main() {
                    vUv = (uvTransform * vec3(uv, 1.0)).xy;
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
			glslVersion: GLSL3,
			blending: NoBlending,
			depthTest: true,
			depthWrite: true
		} );

	}

	_createRenderTargets() {

		const options = {
			type: FloatType,
			format: RGBAFormat,
			depthBuffer: true,
			samples: 4,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			anisotropy: 16
		};

		this.albedoTarget = new WebGLRenderTarget( this.width, this.height, options );
		this.normalTarget = new WebGLRenderTarget( this.width, this.height, options );

	}

	applyAlbedoMaterial() {

		this.scene.traverse( object => {

			if ( ! object.isMesh ) return;

			this.originalMaterials.set( object, object.material );
			const material = this.albedoMaterial.clone();
			const map = object.material.map;

			material.uniforms = {
				tDiffuse: { value: map || new Texture() },
				uvTransform: { value: new Matrix3() }
			};

			if ( map ) {

				const uvTransform = material.uniforms.uvTransform.value;
				uvTransform.setUvTransform(
					map.offset.x,
					map.offset.y,
					map.repeat.x,
					map.repeat.y,
					map.rotation,
					map.center.x,
					map.center.y
				);

				Object.assign( material.uniforms.tDiffuse.value, {
					wrapS: map.wrapS,
					wrapT: map.wrapT,
					flipY: map.flipY,
					needsUpdate: true
				} );

			}

			object.material = material;

		} );

	}

	restoreOriginalMaterials() {

		this.scene.traverse( object => {

			if ( object.isMesh && this.originalMaterials.has( object ) ) {

				object.material = this.originalMaterials.get( object );

			}

		} );
		this.scene.overrideMaterial = this.originalOverrideMaterial;

	}

	generateMaps() {

		const result = {};
		const currentRenderTarget = this.renderer.getRenderTarget();

		// Render albedo
		this.applyAlbedoMaterial();
		this.renderer.setRenderTarget( this.albedoTarget );
		this.renderer.render( this.scene, this.camera );
		result.albedo = this._readRenderTarget( this.albedoTarget );

		// Render normal
		this.scene.overrideMaterial = this.normalMaterial;
		this.renderer.setRenderTarget( this.normalTarget );
		this.renderer.render( this.scene, this.camera );
		result.normal = this._readRenderTarget( this.normalTarget );

		// Cleanup
		this.restoreOriginalMaterials();
		this.renderer.setRenderTarget( currentRenderTarget );

		return result;

	}

	_readRenderTarget( renderTarget ) {

		const buffer = new Float32Array( this.width * this.height * 4 );
		this.renderer.readRenderTargetPixels( renderTarget, 0, 0, this.width, this.height, buffer );
		return new ImageData( this._convertToUint8( buffer ), this.width, this.height );

	}

	_convertToUint8( buffer ) {

		const data = new Uint8ClampedArray( buffer.length );
		const size = this.width * 4;

		for ( let y = 0; y < this.height; y ++ ) {

			const invertedY = this.height - y - 1;
			const sourceOffset = y * size;
			const targetOffset = invertedY * size;

			for ( let x = 0; x < size; x ++ ) {

				data[ targetOffset + x ] = Math.floor( buffer[ sourceOffset + x ] * 255 );

			}

		}

		return data;

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;
		this.albedoTarget.setSize( width, height );
		this.normalTarget.setSize( width, height );

	}

	dispose() {

		this.albedoTarget.dispose();
		this.normalTarget.dispose();
		this.albedoMaterial.dispose();
		this.normalMaterial.dispose();

	}

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

	if ( albedoImageData ) {

		renderImageDataToCanvas( albedoImageData, 'debugAlbedoCanvas' );

	}

	if ( normalImageData ) {

		renderImageDataToCanvas( normalImageData, 'debugNormalCanvas' );

	}

}