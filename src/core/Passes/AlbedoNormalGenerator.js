import {
	WebGLRenderTarget,
	LinearFilter,
	RGBAFormat,
	FloatType,
	RawShaderMaterial,
	GLSL3,
	Matrix3,
	NoBlending,
	Color
} from 'three';

export class AlbedoNormalGenerator {

	constructor( scene, camera, renderer ) {

		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;

		// Use Map instead of WeakMap for better performance with iteration
		this.originalMaterials = new Map();
		this.originalOverrideMaterial = scene.overrideMaterial;

		// Pre-allocate reusable objects
		this._tempMatrix3 = new Matrix3();
		this._tempColor = new Color();
		this._reusableBuffer = null;
		this._reusableUint8Buffer = null;

		this._initializeSize();
		this._createSharedMaterial();
		this._createRenderTargets();

	}

	_initializeSize() {

		const { domElement, getPixelRatio } = this.renderer;
		const pixelRatio = getPixelRatio();

		this.width = Math.floor( domElement.width * pixelRatio );
		this.height = Math.floor( domElement.height * pixelRatio );

		if ( this.width <= 0 || this.height <= 0 ) {

			throw new Error( `Invalid dimensions: ${this.width}x${this.height}. Width and height must be positive.` );

		}

	}

	_createSharedMaterial() {

		// Create a single shared material instead of cloning for each mesh
		this.mrtMaterial = new RawShaderMaterial( {
			uniforms: {
				tDiffuse: { value: null },
				useTexture: { value: 0 },
				color: { value: new Color( 1, 1, 1 ) },
				uvTransform: { value: new Matrix3() }
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
					// Albedo output
					albedoOut = useTexture == 1 
						? texture(tDiffuse, vUv)
						: vec4(color, 1.0);
					
					// Normal output (pack to [0,1] range)
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

		const targetOptions = {
			type: FloatType,
			format: RGBAFormat,
			depthBuffer: true,
			samples: 4,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			anisotropy: Math.min( 16, this.renderer.capabilities.getMaxAnisotropy() )
		};

		this.multiTarget = new WebGLRenderTarget( this.width, this.height, {
			count: 2,
			...targetOptions
		} );

		// Configure textures with names for debugging
		this.multiTarget.textures[ 0 ].name = 'albedo';
		this.multiTarget.textures[ 1 ].name = 'normal';

	}

	_updateMaterialUniforms( mesh ) {

		const { material: originalMaterial } = mesh;
		const { uniforms } = this.mrtMaterial;

		// Update texture and color uniforms
		const map = originalMaterial.map;
		uniforms.tDiffuse.value = map || null;
		uniforms.useTexture.value = map ? 1 : 0;

		if ( map ) {

			this._updateUVTransform( map, uniforms.uvTransform.value );

		} else {

			uniforms.color.value.copy( originalMaterial.color || this._tempColor.setHex( 0xffffff ) );

		}

	}

	_updateUVTransform( texture, uvTransform ) {

		const { offset, repeat, rotation, center } = texture;
		uvTransform.setUvTransform(
			offset.x, offset.y,
			repeat.x, repeat.y,
			rotation,
			center.x, center.y
		);

	}

	applyAlbedoMaterial() {

		// Store original materials and apply shared MRT material
		this.scene.traverse( object => {

			if ( ! object.isMesh ) return;

			this.originalMaterials.set( object, object.material );
			this._updateMaterialUniforms( object );
			object.material = this.mrtMaterial;

		} );

	}

	restoreOriginalMaterials() {

		// Restore all original materials efficiently
		for ( const [ object, originalMaterial ] of this.originalMaterials ) {

			if ( object.isMesh ) {

				object.material = originalMaterial;

			}

		}

		this.originalMaterials.clear();
		this.scene.overrideMaterial = this.originalOverrideMaterial;

	}

	generateMaps() {

		const currentRenderTarget = this.renderer.getRenderTarget();

		try {

			// Apply materials and render
			this.applyAlbedoMaterial();
			this.renderer.setRenderTarget( this.multiTarget );
			this.renderer.render( this.scene, this.camera );

			// Read both attachments
			return {
				albedo: this._readRenderTarget( 0 ),
				normal: this._readRenderTarget( 1 )
			};

		} finally {

			// Ensure cleanup happens even if errors occur
			this.restoreOriginalMaterials();
			this.renderer.setRenderTarget( currentRenderTarget );

		}

	}

	_readRenderTarget( attachmentIndex ) {

		const gl = this.renderer.getContext();
		const bufferSize = this.width * this.height * 4;

		// Reuse buffer to avoid constant allocations
		if ( ! this._reusableBuffer || this._reusableBuffer.length !== bufferSize ) {

			this._reusableBuffer = new Float32Array( bufferSize );

		}

		// Manage GL read buffer state
		const prevReadBuffer = gl.getParameter( gl.READ_BUFFER );

		try {

			gl.readBuffer( gl.COLOR_ATTACHMENT0 + attachmentIndex );
			gl.readPixels( 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, this._reusableBuffer );

			return new ImageData(
				this._convertToUint8( this._reusableBuffer ),
				this.width,
				this.height
			);

		} finally {

			gl.readBuffer( prevReadBuffer );

		}

	}

	_convertToUint8( floatBuffer ) {

		const bufferSize = floatBuffer.length;

		// Reuse Uint8 buffer to avoid allocations
		if ( ! this._reusableUint8Buffer || this._reusableUint8Buffer.length !== bufferSize ) {

			this._reusableUint8Buffer = new Uint8ClampedArray( bufferSize );

		}

		const data = this._reusableUint8Buffer;
		const rowSize = this.width * 4;

		// Flip Y-axis and convert to Uint8 in one pass
		for ( let y = 0; y < this.height; y ++ ) {

			const flippedY = this.height - y - 1;
			const sourceOffset = y * rowSize;
			const targetOffset = flippedY * rowSize;

			for ( let x = 0; x < rowSize; x ++ ) {

				data[ targetOffset + x ] = Math.min( 255, Math.max( 0, floatBuffer[ sourceOffset + x ] * 255 ) ) | 0;

			}

		}

		return data;

	}

	setSize( width, height ) {

		if ( width <= 0 || height <= 0 ) {

			throw new Error( `Invalid dimensions: ${width}x${height}` );

		}

		this.width = width;
		this.height = height;
		this.multiTarget.setSize( width, height );

		// Clear reusable buffers to force reallocation with new size
		this._reusableBuffer = null;
		this._reusableUint8Buffer = null;

	}

	dispose() {

		this.restoreOriginalMaterials();
		this.multiTarget?.dispose();
		this.mrtMaterial?.dispose();

		// Clear references
		this._reusableBuffer = null;
		this._reusableUint8Buffer = null;
		this.originalMaterials.clear();

	}

}

// Utility function for canvas rendering with error handling
export function renderImageDataToCanvas( imageData, canvasId ) {

	if ( ! imageData || ! canvasId ) {

		throw new Error( 'imageData and canvasId are required' );

	}

	let canvas = document.getElementById( canvasId );

	if ( ! canvas ) {

		canvas = document.createElement( 'canvas' );
		canvas.id = canvasId;
		document.body.appendChild( canvas );

	}

	canvas.width = imageData.width;
	canvas.height = imageData.height;

	const ctx = canvas.getContext( '2d' );
	ctx.putImageData( imageData, 0, 0 );

	return canvas;

}
