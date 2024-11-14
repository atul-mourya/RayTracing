import {
	WebGLRenderTarget,
	NearestFilter,
	RGBAFormat,
	FloatType,
	MeshNormalMaterial,
	RawShaderMaterial,
	GLSL3,
	Texture,
	DataTexture
} from 'three';

export class AlbedoNormalGenerator {

	constructor( scene, camera, renderer ) {

		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;
		this.width = renderer.domElement.width * renderer.getPixelRatio();
		this.height = renderer.domElement.height * renderer.getPixelRatio();

		this.generateAlbedoMap = true;
		this.generateNormalMap = true;

		this.albedoTarget = this.createRenderTarget();
		this.normalTarget = this.createRenderTarget();

		this.albedoMaterial = this.createAlbedoMaterial();
		this.normalMaterial = new MeshNormalMaterial();
		this.originalMaterials = new WeakMap();
		this.originalOverrideMaterial = scene.overrideMaterial;

		// Pre-allocate buffers
		this.albedoBuffer = new Float32Array( this.width * this.height * 4 );
		this.normalBuffer = new Float32Array( this.width * this.height * 4 );
		this.albedoData = new Uint8ClampedArray( this.width * this.height * 4 );
		this.normalData = new Uint8ClampedArray( this.width * this.height * 4 );

		// Pre-create ImageData objects
		this.albedoImageData = new ImageData( this.albedoData, this.width, this.height );
		this.normalImageData = new ImageData( this.normalData, this.width, this.height );

		// Create DataTextures for efficient GPU upload
		this.albedoDataTexture = new DataTexture( this.albedoData, this.width, this.height, RGBAFormat );
		this.normalDataTexture = new DataTexture( this.normalData, this.width, this.height, RGBAFormat );

	}

	createRenderTarget() {

		return new WebGLRenderTarget( this.width, this.height, {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			type: FloatType,
			format: RGBAFormat,
		} );

	}

	createAlbedoMaterial() {

		return new RawShaderMaterial( {
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

	}

	applyAlbedoMaterial() {

		this.scene.traverse( ( object ) => {

			if ( object.isMesh ) {

				this.originalMaterials.set( object, object.material );
				const material = this.albedoMaterial.clone();
				material.uniforms = {
					tDiffuse: { value: object.material.map || new Texture() }
				};
				object.material = material;

			}

		} );

	}

	restoreOriginalMaterials() {

		this.scene.traverse( ( object ) => {

			if ( object.isMesh && this.originalMaterials.has( object ) ) {

				object.material = this.originalMaterials.get( object );

			}

		} );
		this.scene.overrideMaterial = this.originalOverrideMaterial;

	}

	renderAlbedo() {

		this.applyAlbedoMaterial();
		this.renderer.setRenderTarget( this.albedoTarget );
		this.renderer.render( this.scene, this.camera );

	}

	renderNormal() {

		this.scene.overrideMaterial = this.normalMaterial;
		this.renderer.setRenderTarget( this.normalTarget );
		this.renderer.render( this.scene, this.camera );

	}

	readPixelData( renderTarget ) {

		const buffer = new Float32Array( this.width * this.height * 4 );
		this.renderer.readRenderTargetPixels( renderTarget, 0, 0, this.width, this.height, buffer );
		return buffer;

	}

	convertToUint8( buffer ) {

		const data = new Uint8ClampedArray( buffer.length );
		for ( let y = 0; y < this.height; y ++ ) {

			for ( let x = 0; x < this.width; x ++ ) {

				const sourceIndex = ( y * this.width + x ) * 4;
				const targetIndex = ( ( this.height - y - 1 ) * this.width + x ) * 4;
				for ( let i = 0; i < 4; i ++ ) {

					data[ targetIndex + i ] = Math.floor( buffer[ sourceIndex + i ] * 255 );

				}

			}

		}

		return data;

	}

	generateMaps() {

		const result = {};

		if ( this.generateAlbedoMap ) {

			this.renderAlbedo();
			const albedoBuffer = this.readPixelData( this.albedoTarget );
			const albedoData = this.convertToUint8( albedoBuffer );
			result.albedo = new ImageData( albedoData, this.width, this.height );

		}

		if ( this.generateNormalMap ) {

			this.renderNormal();
			const normalBuffer = this.readPixelData( this.normalTarget );
			const normalData = this.convertToUint8( normalBuffer );
			result.normal = new ImageData( normalData, this.width, this.height );

		}

		this.restoreOriginalMaterials();
		this.renderer.setRenderTarget( null );

		return result;

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		if ( this.generateAlbedoMap ) {

			this.albedoTarget.setSize( width, height );

		}

		if ( this.generateNormalMap ) {

			this.normalTarget.setSize( width, height );

		}

	}

	dispose() {

		if ( this.generateAlbedoMap ) {

			this.albedoTarget.dispose();

		}

		if ( this.generateNormalMap ) {

			this.normalTarget.dispose();

		}

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
