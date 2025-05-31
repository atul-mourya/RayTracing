import {
	WebGLRenderTarget,
	LinearFilter,
	RGBAFormat,
	FloatType,
	RawShaderMaterial,
	GLSL3,
	Texture,
	Matrix3,
	Matrix4,
	NoBlending,
	Color
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

		this.mrtMaterial = new RawShaderMaterial( {
			uniforms: {
				tDiffuse: { value: null },
				useTexture: { value: 0 },
				color: { value: new Color( 1, 1, 1 ) },
				uvTransform: { value: new Matrix3() },
				modelViewMatrix: { value: new Matrix4() },
				projectionMatrix: { value: new Matrix4() },
				normalMatrix: { value: new Matrix3() }
			},
			vertexShader: `
				in vec3 position;
				in vec2 uv;
				in vec3 normal;
				out vec2 vUv;
				out vec3 vNormal;
				uniform mat3 uvTransform;
				uniform mat4 modelViewMatrix;
				uniform mat4 projectionMatrix;
				uniform mat3 normalMatrix;
				
				void main() {
					vUv = (uvTransform * vec3(uv, 1.0)).xy;
					vNormal = normalize(normalMatrix * normal);
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: `
				precision highp float;
				in vec2 vUv;
				in vec3 vNormal;
				uniform sampler2D tDiffuse;
				uniform vec3 color;
				uniform int useTexture;
				layout(location = 0) out vec4 albedoOut;
				layout(location = 1) out vec4 normalOut;
				
				void main() {
					// Albedo
					if (useTexture == 1) {
						albedoOut = texture(tDiffuse, vUv);
					} else {
						albedoOut = vec4(color, 1.0);
					}
					// Normal (packed to [0,1])
					normalOut = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0);
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

		this.multiTarget = new WebGLRenderTarget( this.width, this.height, { count: 2 } );
		this.multiTarget.textures.forEach( ( texture ) => {

			texture.type = options.type;
			texture.format = options.format;
			texture.minFilter = options.minFilter;
			texture.magFilter = options.magFilter;
			texture.anisotropy = options.anisotropy;

		} );
		this.multiTarget.depthBuffer = options.depthBuffer;
		this.multiTarget.samples = options.samples;
		this.multiTarget.textures[ 0 ].name = 'albedo';
		this.multiTarget.textures[ 1 ].name = 'normal';

	}

	applyAlbedoMaterial() {

		this.scene.traverse( object => {

			if ( ! object.isMesh ) return;

			this.originalMaterials.set( object, object.material );
			const material = this.mrtMaterial.clone();
			const originalMaterial = object.material;
			const map = originalMaterial.map;

			// Initialize uniforms
			material.uniforms = {
				tDiffuse: { value: map || new Texture() },
				useTexture: { value: map ? 1 : 0 },
				color: { value: new Color() },
				uvTransform: { value: new Matrix3() },
				modelViewMatrix: { value: object.modelViewMatrix },
				projectionMatrix: { value: this.camera.projectionMatrix },
				normalMatrix: { value: new Matrix3().getNormalMatrix( object.matrixWorld ) }
			};

			// Handle UV transform
			if ( map ) {

				const uvTransform = material.uniforms.uvTransform.value;
				uvTransform.setUvTransform(
					map.offset.x, map.offset.y,
					map.repeat.x, map.repeat.y,
					map.rotation, map.center.x, map.center.y
				);

			} else {

				material.uniforms.color.value.copy( originalMaterial.color || new Color( 1, 1, 1 ) );

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

		// Render to MRT
		this.applyAlbedoMaterial();
		this.renderer.setRenderTarget( this.multiTarget );
		this.renderer.render( this.scene, this.camera );

		// Read albedo and normal from attachments
		result.albedo = this._readRenderTarget( 0 );
		result.normal = this._readRenderTarget( 1 );

		// Cleanup
		this.restoreOriginalMaterials();
		this.renderer.setRenderTarget( currentRenderTarget );

		return result;

	}

	_readRenderTarget( attachmentIndex ) {

		const gl = this.renderer.getContext();
		const buffer = new Float32Array( this.width * this.height * 4 );

		// Save current read buffer state
		const prevReadBuffer = gl.getParameter( gl.READ_BUFFER );

		// Set read buffer to the desired attachment
		gl.readBuffer( gl.COLOR_ATTACHMENT0 + attachmentIndex );

		// Read pixels from the currently bound framebuffer (already set by Three.js)
		gl.readPixels( 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, buffer );

		// Restore previous read buffer state
		gl.readBuffer( prevReadBuffer );

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
		this.multiTarget.setSize( width, height );

	}

	dispose() {

		this.multiTarget.dispose(); // Dispose MRT
		this.mrtMaterial.dispose(); // Dispose the MRT material

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
