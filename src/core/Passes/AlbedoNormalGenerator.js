import {
	WebGLRenderTarget,
	LinearFilter,
	RGBAFormat,
	FloatType,
	MeshBasicMaterial,
	MeshNormalMaterial,
	ShaderMaterial,
	Color,
	Vector2,
	CanvasTexture,
	Mesh,
	PlaneGeometry,
	Scene,
	OrthographicCamera,
	BufferAttribute
} from 'three';
import RenderTargetHelper from '../../lib/RenderTargetHelper.js';

export class AlbedoNormalGenerator {

	constructor( scene, camera, renderer ) {

		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;

		// Store original scene override material
		this.originalOverrideMaterial = scene.overrideMaterial;

		// Pre-allocate reusable objects
		this._tempColor = new Color();

		// Performance optimizations: Caching and object pooling
		this._materialCache = new Map(); // Cache materials by object UUID
		this._tangentCache = new Map(); // Cache computed tangents
		this._bufferPool = []; // Pool for Float32Array buffers
		this._uint8Pool = []; // Pool for Uint8ClampedArray buffers

		// Pre-compiled shader materials
		this._normalShaderCache = new Map();

		// Batch processing arrays
		this._meshBatch = [];
		this._materialBackup = new Map();

		this._initializeSize();
		this._createRenderTargets();
		this._createOverrideMaterials();
		this._precompileShaders();

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

	_createOverrideMaterials() {

		// Create albedo override material (MeshBasicMaterial) - reusable
		this.albedoOverrideMaterial = new MeshBasicMaterial( {
			color: 0xffffff,
			vertexColors: false,
		} );

		// Create normal override material (MeshNormalMaterial) - reusable
		this.normalOverrideMaterial = new MeshNormalMaterial();

	}

	_precompileShaders() {

		// Pre-compile common shader combinations to avoid runtime compilation
		const shaderVariants = [
			{ hasTangents: true, hasNormalMap: true },
			{ hasTangents: false, hasNormalMap: true },
			{ hasTangents: true, hasNormalMap: false },
			{ hasTangents: false, hasNormalMap: false }
		];

		shaderVariants.forEach( variant => {

			const key = `${variant.hasTangents ? 'T' : ''}${variant.hasNormalMap ? 'N' : ''}`;
			this._normalShaderCache.set( key, this._createNormalShaderMaterial( variant.hasTangents, variant.hasNormalMap ) );

		} );

	}

	_createNormalShaderMaterial( hasTangents, hasNormalMap ) {

		return new ShaderMaterial( {
			uniforms: {
				normalMap: { value: null },
				normalScale: { value: new Vector2( 1, 1 ) }
			},
			vertexShader: `
				${hasTangents ? 'attribute vec4 tangent;' : ''}
				
				varying vec3 vNormal;
				varying vec2 vUv;
				${hasTangents ? `
					varying vec3 vTangent;
					varying vec3 vBitangent;
				` : ''}
				
				void main() {
					vUv = uv;
					vNormal = normalize(normalMatrix * normal);
					
					${hasTangents ? `
						vTangent = normalize(normalMatrix * tangent.xyz);
						vBitangent = normalize(cross(vNormal, vTangent) * tangent.w);
					` : ''}
					
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: `
				precision highp float;
				
				varying vec3 vNormal;
				varying vec2 vUv;
				${hasTangents ? `
					varying vec3 vTangent;
					varying vec3 vBitangent;
				` : ''}
				
				${hasNormalMap ? 'uniform sampler2D normalMap;' : ''}
				${hasNormalMap ? 'uniform vec2 normalScale;' : ''}
				
				void main() {
					vec3 normal = normalize(vNormal);
					
					${hasNormalMap && hasTangents ? `
						// Apply normal mapping using tangent space
						vec3 normalMapSample = texture2D(normalMap, vUv).xyz;
						vec3 normalMapVector = normalize(normalMapSample * 2.0 - 1.0);
						
						// Apply normal scale
						normalMapVector.xy *= normalScale;
						normalMapVector = normalize(normalMapVector);
						
						// Build TBN matrix and transform to world space
						vec3 T = normalize(vTangent);
						vec3 B = normalize(vBitangent);  
						vec3 N = normalize(vNormal);
						mat3 TBN = mat3(T, B, N);
						
						normal = normalize(TBN * normalMapVector);
					` : ''}
					
					// Output normal in [0,1] range (standard normal map format)
					gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
				}
			`
		} );

	}

	_createRenderTargets() {

		const targetOptions = {
			type: FloatType,
			format: RGBAFormat,
			depthBuffer: true,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			anisotropy: Math.min( 16, this.renderer.capabilities.getMaxAnisotropy() )
		};

		this.albedoTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.normalTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );

		// Configure textures with names for debugging
		this.albedoTarget.texture.name = 'albedo';
		this.normalTarget.texture.name = 'normal';

	}

	_createDebugTargets() {

		// Create debug render targets for visualization
		const debugOptions = {
			type: FloatType,
			format: RGBAFormat,
			depthBuffer: false,
			minFilter: LinearFilter,
			magFilter: LinearFilter
		};

		this.albedoDebugTarget = new WebGLRenderTarget( this.width, this.height, debugOptions );
		this.normalDebugTarget = new WebGLRenderTarget( this.width, this.height, debugOptions );

		this.albedoDebugTarget.texture.name = 'albedo-debug';
		this.normalDebugTarget.texture.name = 'normal-debug';

	}

	// OPTIMIZED: Single scene traversal to collect all meshes and analyze requirements
	_analyzeMeshes() {

		this._meshBatch.length = 0; // Clear previous batch

		this.scene.traverse( object => {

			if ( ! object.isMesh || ! object.material?.visible ) return;

			const material = object.material;
			const geometry = object.geometry;
			const uuid = object.uuid;

			// Analyze mesh properties once
			const meshData = {
				object,
				material,
				geometry,
				uuid,
				hasNormalMap: !! material.normalMap,
				hasTangents: !! geometry.attributes.tangent,
				hasNormals: !! geometry.attributes.normal,
				hasUVs: !! geometry.attributes.uv,
				needsTangents: false
			};

			// Determine if tangents need to be computed
			meshData.needsTangents = meshData.hasNormalMap && ! meshData.hasTangents && meshData.hasUVs && meshData.hasNormals;

			this._meshBatch.push( meshData );

		} );

	}

	// OPTIMIZED: Compute tangents only once and cache them
	_ensureTangents( meshData ) {

		if ( ! meshData.needsTangents ) return;

		const { object, geometry, uuid } = meshData;

		// Check cache first
		if ( this._tangentCache.has( uuid ) ) {

			geometry.setAttribute( 'tangent', this._tangentCache.get( uuid ) );
			meshData.hasTangents = true;
			return;

		}

		console.log( `Computing tangents for ${object.name || 'unnamed'}` );

		try {

			const tangentAttribute = this._computeTangentsOptimized( geometry );
			geometry.setAttribute( 'tangent', tangentAttribute );
			this._tangentCache.set( uuid, tangentAttribute );
			meshData.hasTangents = true;

		} catch ( error ) {

			console.warn( `Failed to compute tangents for ${object.name}:`, error );

		}

	}

	// OPTIMIZED: More efficient tangent computation with vectorized operations
	_computeTangentsOptimized( geometry ) {

		const positions = geometry.attributes.position.array;
		const normals = geometry.attributes.normal.array;
		const uvs = geometry.attributes.uv.array;
		const indices = geometry.index ? geometry.index.array : null;

		const vertexCount = positions.length / 3;
		const tangents = new Float32Array( vertexCount * 4 );

		// Use typed arrays for better performance
		const triangleCount = indices ? indices.length / 3 : vertexCount / 3;

		// Vectorized tangent computation
		for ( let i = 0; i < triangleCount; i ++ ) {

			const i0 = indices ? indices[ i * 3 ] : i * 3;
			const i1 = indices ? indices[ i * 3 + 1 ] : i * 3 + 1;
			const i2 = indices ? indices[ i * 3 + 2 ] : i * 3 + 2;

			// Batch array access
			const v0x = positions[ i0 * 3 ], v0y = positions[ i0 * 3 + 1 ], v0z = positions[ i0 * 3 + 2 ];
			const v1x = positions[ i1 * 3 ], v1y = positions[ i1 * 3 + 1 ], v1z = positions[ i1 * 3 + 2 ];
			const v2x = positions[ i2 * 3 ], v2y = positions[ i2 * 3 + 1 ], v2z = positions[ i2 * 3 + 2 ];

			const u0 = uvs[ i0 * 2 ], v0 = uvs[ i0 * 2 + 1 ];
			const u1 = uvs[ i1 * 2 ], v1 = uvs[ i1 * 2 + 1 ];
			const u2 = uvs[ i2 * 2 ], v2 = uvs[ i2 * 2 + 1 ];

			// Edge vectors
			const deltaPos1x = v1x - v0x, deltaPos1y = v1y - v0y, deltaPos1z = v1z - v0z;
			const deltaPos2x = v2x - v0x, deltaPos2y = v2y - v0y, deltaPos2z = v2z - v0z;
			const deltaUV1x = u1 - u0, deltaUV1y = v1 - v0;
			const deltaUV2x = u2 - u0, deltaUV2y = v2 - v0;

			const denom = deltaUV1x * deltaUV2y - deltaUV1y * deltaUV2x;
			const r = denom !== 0 ? 1.0 / denom : 0;

			const tangentx = ( deltaPos1x * deltaUV2y - deltaPos2x * deltaUV1y ) * r;
			const tangenty = ( deltaPos1y * deltaUV2y - deltaPos2y * deltaUV1y ) * r;
			const tangentz = ( deltaPos1z * deltaUV2y - deltaPos2z * deltaUV1y ) * r;

			// Accumulate for all three vertices
			const vertices = [ i0, i1, i2 ];
			for ( let j = 0; j < 3; j ++ ) {

				const idx = vertices[ j ] * 4;
				tangents[ idx ] += tangentx;
				tangents[ idx + 1 ] += tangenty;
				tangents[ idx + 2 ] += tangentz;
				tangents[ idx + 3 ] = 1.0;

			}

		}

		// Normalize tangents
		for ( let i = 0; i < vertexCount; i ++ ) {

			const idx = i * 4;
			const tx = tangents[ idx ];
			const ty = tangents[ idx + 1 ];
			const tz = tangents[ idx + 2 ];
			const length = Math.sqrt( tx * tx + ty * ty + tz * tz );

			if ( length > 0 ) {

				const invLength = 1.0 / length;
				tangents[ idx ] = tx * invLength;
				tangents[ idx + 1 ] = ty * invLength;
				tangents[ idx + 2 ] = tz * invLength;

			}

		}

		return new BufferAttribute( tangents, 4 );

	}

	// OPTIMIZED: Create or reuse albedo materials with caching
	_createAlbedoMaterial( originalMaterial, uuid ) {

		// Check cache first
		let cacheKey = `albedo_${uuid}`;
		if ( this._materialCache.has( cacheKey ) ) {

			return this._materialCache.get( cacheKey );

		}

		const albedoMaterial = new MeshBasicMaterial();

		// Copy properties efficiently
		if ( originalMaterial.map ) {

			albedoMaterial.map = originalMaterial.map;

		}

		albedoMaterial.color.copy( originalMaterial.color || this._tempColor.setHex( 0xffffff ) );

		if ( originalMaterial.transparent !== undefined ) {

			albedoMaterial.transparent = originalMaterial.transparent;

		}

		if ( originalMaterial.opacity !== undefined ) {

			albedoMaterial.opacity = originalMaterial.opacity;

		}

		// Cache the material
		this._materialCache.set( cacheKey, albedoMaterial );

		return albedoMaterial;

	}

	// OPTIMIZED: Create or reuse normal materials with pre-compiled shaders
	_createNormalMaterial( originalMaterial, meshData ) {

		const { uuid, hasTangents, hasNormalMap } = meshData;
		const cacheKey = `normal_${uuid}_${hasTangents ? 'T' : ''}_${hasNormalMap ? 'N' : ''}`;

		// Check cache first
		if ( this._materialCache.has( cacheKey ) ) {

			const cachedMaterial = this._materialCache.get( cacheKey );

			// Update uniforms if needed
			if ( hasNormalMap ) {

				cachedMaterial.uniforms.normalMap.value = originalMaterial.normalMap;
				cachedMaterial.uniforms.normalScale.value.copy( originalMaterial.normalScale || this._tempVector2 );

			}

			return cachedMaterial;

		}

		// Get pre-compiled shader
		const shaderKey = `${hasTangents ? 'T' : ''}${hasNormalMap ? 'N' : ''}`;
		const baseShader = this._normalShaderCache.get( shaderKey );

		// Clone the shader material
		const normalMaterial = baseShader.clone();

		// Set uniforms
		if ( hasNormalMap ) {

			normalMaterial.uniforms.normalMap.value = originalMaterial.normalMap;
			normalMaterial.uniforms.normalScale.value.copy( originalMaterial.normalScale || new Vector2( 1, 1 ) );

		}

		normalMaterial.side = originalMaterial.side || 0;

		// Cache the material
		this._materialCache.set( cacheKey, normalMaterial );

		return normalMaterial;

	}

	_prepareMaterialsForAlbedo() {

		this._analyzeMeshes(); // Single traversal
		this._materialBackup.clear();

		this._meshBatch.forEach( meshData => {

			const { object, material: originalMaterial, uuid } = meshData;

			// Store original material
			this._materialBackup.set( object, {
				material: originalMaterial,
				visible: object.visible
			} );

			// Create or get cached albedo material
			const albedoMaterial = this._createAlbedoMaterial( originalMaterial, uuid );
			object.material = albedoMaterial;

		} );

	}

	_prepareMaterialsForNormal() {

		// Reuse existing mesh analysis if available
		if ( this._meshBatch.length === 0 ) {

			this._analyzeMeshes();

		}

		// Ensure all meshes have tangents if needed
		this._meshBatch.forEach( meshData => {

			this._ensureTangents( meshData );

		} );

		this._meshBatch.forEach( meshData => {

			const { object, material: originalMaterial } = meshData;

			// Get original material from backup if available
			const backup = this._materialBackup.get( object );
			const actualOriginalMaterial = backup ? backup.material : originalMaterial;

			// Store original material if not already stored
			if ( ! backup ) {

				this._materialBackup.set( object, {
					material: actualOriginalMaterial,
					visible: object.visible
				} );

			}

			// Update mesh data with actual material
			meshData.hasNormalMap = !! actualOriginalMaterial.normalMap;

			// Create or get cached normal material
			const normalMaterial = this._createNormalMaterial( actualOriginalMaterial, meshData );
			object.material = normalMaterial;

		} );

	}

	_restoreOriginalMaterials() {

		// Restore all original materials efficiently
		for ( const [ object, backup ] of this._materialBackup ) {

			if ( object.isMesh ) {

				object.material = backup.material;
				object.visible = backup.visible;

			}

		}

		this._materialBackup.clear();
		this.scene.overrideMaterial = this.originalOverrideMaterial;

	}

	_renderAlbedo() {

		this._prepareMaterialsForAlbedo();

		// Render to albedo target
		this.renderer.setRenderTarget( this.albedoTarget );
		this.renderer.render( this.scene, this.camera );

		return this._readRenderTarget( this.albedoTarget );

	}

	_renderNormal() {

		this._prepareMaterialsForNormal();

		// Render to normal target
		this.renderer.setRenderTarget( this.normalTarget );
		this.renderer.render( this.scene, this.camera );

		return this._readRenderTarget( this.normalTarget );

	}

	generateMaps() {

		const currentRenderTarget = this.renderer.getRenderTarget();

		try {

			const albedoData = this._renderAlbedo();
			const normalData = this._renderNormal();

			return {
				albedo: albedoData,
				normal: normalData
			};

		} finally {

			// Ensure cleanup happens even if errors occur
			this._restoreOriginalMaterials();
			this.renderer.setRenderTarget( currentRenderTarget );

		}

	}

	// OPTIMIZED: Reuse buffers from pool
	_getFloatBuffer( size ) {

		const buffer = this._bufferPool.pop();
		return buffer && buffer.length >= size ? buffer : new Float32Array( size );

	}

	_returnFloatBuffer( buffer ) {

		if ( this._bufferPool.length < 5 ) { // Limit pool size

			this._bufferPool.push( buffer );

		}

	}

	_getUint8Buffer( size ) {

		// Look for a buffer of the exact size first, then one that's large enough
		for ( let i = this._uint8Pool.length - 1; i >= 0; i -- ) {

			const buffer = this._uint8Pool[ i ];
			if ( buffer.length === size ) {

				return this._uint8Pool.splice( i, 1 )[ 0 ]; // Remove and return exact match

			}

		}

		// If no exact match, look for one that's large enough
		for ( let i = this._uint8Pool.length - 1; i >= 0; i -- ) {

			const buffer = this._uint8Pool[ i ];
			if ( buffer.length >= size ) {

				return this._uint8Pool.splice( i, 1 )[ 0 ]; // Remove and return oversized buffer

			}

		}

		// Create new buffer if none available
		return new Uint8ClampedArray( size );

	}

	_returnUint8Buffer( buffer ) {

		if ( this._uint8Pool.length < 5 ) { // Limit pool size

			this._uint8Pool.push( buffer );

		}

	}

	_readRenderTarget( renderTarget ) {

		const gl = this.renderer.getContext();
		const bufferSize = this.width * this.height * 4;

		// Get buffer from pool
		const floatBuffer = this._getFloatBuffer( bufferSize );

		// Read pixels from the render target
		gl.readPixels( 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, floatBuffer );

		const uint8Data = this._convertToUint8( floatBuffer );

		// Return buffer to pool
		this._returnFloatBuffer( floatBuffer );

		return new ImageData( uint8Data, this.width, this.height );

	}

	_convertToUint8( floatBuffer ) {

		const expectedSize = this.width * this.height * 4;
		const bufferSize = floatBuffer.length;
		const data = this._getUint8Buffer( expectedSize ); // Request exact size needed
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

		// Ensure the returned array is exactly the right size for ImageData
		// If the pooled buffer is larger, create a properly sized view
		if ( data.length !== expectedSize ) {

			return new Uint8ClampedArray( data.buffer, 0, expectedSize );

		}

		return data;

	}

	createDebugHelpers( renderer, showAlbedo = true, showNormal = true ) {

		if ( ! this.albedoDebugTarget || ! this.normalDebugTarget ) {

			this._createDebugTargets();

		}

		const helpers = {};

		if ( showAlbedo ) {

			helpers.albedo = RenderTargetHelper( renderer, this.albedoDebugTarget, {
				width: 250,
				height: 250,
				position: 'bottom-right',
				theme: 'dark',
				title: 'Albedo',
				autoUpdate: false
			} );

		}

		if ( showNormal ) {

			helpers.normal = RenderTargetHelper( renderer, this.normalDebugTarget, {
				width: 250,
				height: 250,
				position: 'bottom-left',
				theme: 'dark',
				title: 'Normal',
				autoUpdate: false
			} );

		}

		return helpers;

	}

	// OPTIMIZED: Reuse quad and materials for visualization
	_ensureVisualizationQuad() {

		if ( ! this._visualizationQuad ) {

			this._visualizationQuad = {
				geometry: new PlaneGeometry( 2, 2 ),
				material: new MeshBasicMaterial(),
				mesh: null,
				scene: new Scene(),
				camera: new OrthographicCamera( - 1, 1, 1, - 1, 0, 1 )
			};

			this._visualizationQuad.mesh = new Mesh( this._visualizationQuad.geometry, this._visualizationQuad.material );
			this._visualizationQuad.scene.add( this._visualizationQuad.mesh );

		}

	}

	visualizeImageDataInTarget( imageData, target, renderer ) {

		if ( ! imageData || ! target || ! renderer ) return;

		this._ensureVisualizationQuad();

		// Create texture from canvas (cached if same image)
		const canvas = document.createElement( 'canvas' );
		canvas.width = imageData.width;
		canvas.height = imageData.height;
		const ctx = canvas.getContext( '2d' );
		ctx.putImageData( imageData, 0, 0 );

		const texture = new CanvasTexture( canvas );
		texture.needsUpdate = true;

		// Update material map
		const oldMap = this._visualizationQuad.material.map;
		this._visualizationQuad.material.map = texture;
		this._visualizationQuad.material.needsUpdate = true;

		// Render to target
		const prevTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( target );
		renderer.render( this._visualizationQuad.scene, this._visualizationQuad.camera );
		renderer.setRenderTarget( prevTarget );

		// Cleanup old texture
		if ( oldMap ) {

			oldMap.dispose();

		}

		texture.dispose();

	}

	setSize( width, height ) {

		if ( width <= 0 || height <= 0 ) {

			throw new Error( `Invalid dimensions: ${width}x${height}` );

		}

		this.width = width;
		this.height = height;

		this.albedoTarget.setSize( width, height );
		this.normalTarget.setSize( width, height );

		// Update debug targets if they exist
		if ( this.albedoDebugTarget ) {

			this.albedoDebugTarget.setSize( width, height );

		}

		if ( this.normalDebugTarget ) {

			this.normalDebugTarget.setSize( width, height );

		}

	}

	dispose() {

		this._restoreOriginalMaterials();

		// Dispose render targets
		this.albedoTarget?.dispose();
		this.normalTarget?.dispose();
		this.albedoDebugTarget?.dispose();
		this.normalDebugTarget?.dispose();

		// Dispose override materials
		this.albedoOverrideMaterial?.dispose();
		this.normalOverrideMaterial?.dispose();

		// Dispose cached materials
		for ( const material of this._materialCache.values() ) {

			material.dispose();

		}

		this._materialCache.clear();

		// Dispose cached shaders
		for ( const shader of this._normalShaderCache.values() ) {

			shader.dispose();

		}

		this._normalShaderCache.clear();

		// Clear caches
		this._tangentCache.clear();
		this._materialBackup.clear();

		// Dispose visualization quad
		if ( this._visualizationQuad ) {

			this._visualizationQuad.geometry.dispose();
			this._visualizationQuad.material.dispose();

		}

		// Clear arrays
		this._meshBatch.length = 0;
		this._bufferPool.length = 0;
		this._uint8Pool.length = 0;

	}

}

