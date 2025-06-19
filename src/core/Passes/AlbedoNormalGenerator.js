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

		this._initializeSize();
		this._createRenderTargets();
		this._createOverrideMaterials();

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

		// Create albedo override material (MeshBasicMaterial)
		this.albedoOverrideMaterial = new MeshBasicMaterial( {
			color: 0xffffff,
			vertexColors: false,
		} );

		// Create normal override material (MeshNormalMaterial)
		this.normalOverrideMaterial = new MeshNormalMaterial();

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

	_prepareMaterialsForAlbedo() {

		// Store original materials and create albedo materials for each mesh
		this.materialBackup = new Map();

		this.scene.traverse( object => {

			if ( ! object.isMesh ) return;
			if ( ! object.material?.visible ) return;

			const originalMaterial = object.material;

			// Store original material reference
			this.materialBackup.set( object, {
				material: originalMaterial,
				visible: object.visible
			} );

			// Create a MeshBasicMaterial that preserves the original material's albedo properties
			const albedoMaterial = new MeshBasicMaterial();

			// Copy diffuse map
			if ( originalMaterial.map ) {

				albedoMaterial.map = originalMaterial.map;
				albedoMaterial.map.needsUpdate = true;

			}

			// Copy diffuse color
			if ( originalMaterial.color ) {

				albedoMaterial.color.copy( originalMaterial.color );

			} else {

				albedoMaterial.color.setHex( 0xffffff );

			}

			// Copy transparency settings
			if ( originalMaterial.transparent !== undefined ) {

				albedoMaterial.transparent = originalMaterial.transparent;

			}

			if ( originalMaterial.opacity !== undefined ) {

				albedoMaterial.opacity = originalMaterial.opacity;

			}

			// Copy UV transform properties
			if ( originalMaterial.map ) {

				if ( originalMaterial.map.offset ) {

					albedoMaterial.map.offset.copy( originalMaterial.map.offset );

				}

				if ( originalMaterial.map.repeat ) {

					albedoMaterial.map.repeat.copy( originalMaterial.map.repeat );

				}

				if ( originalMaterial.map.rotation !== undefined ) {

					albedoMaterial.map.rotation = originalMaterial.map.rotation;

				}

				if ( originalMaterial.map.center ) {

					albedoMaterial.map.center.copy( originalMaterial.map.center );

				}

			}

			// Apply the albedo material to the mesh
			object.material = albedoMaterial;

		} );

	}



	_restoreOriginalMaterials() {

		// Restore all original materials and properties
		if ( this.materialBackup ) {

			for ( const [ object, backup ] of this.materialBackup ) {

				if ( object.isMesh ) {

					object.material = backup.material;
					object.visible = backup.visible;

				}

			}

			this.materialBackup.clear();

		}

		// Restore original scene override material
		this.scene.overrideMaterial = this.originalOverrideMaterial;

	}

	_renderAlbedo() {

		this._prepareMaterialsForAlbedo();

		// Don't use scene override since we've set individual materials per mesh
		// that preserve the original material properties

		// Render to albedo target
		this.renderer.setRenderTarget( this.albedoTarget );
		this.renderer.render( this.scene, this.camera );

		// Clean up temporary albedo materials
		this.scene.traverse( object => {

			if ( object.isMesh ) {

				// Dispose the temporary albedo material we created
				if ( object.material && object.material !== this.materialBackup.get( object )?.material ) {

					object.material.dispose();

				}

			}

		} );

		return this._readRenderTarget( this.albedoTarget );

	}



	_prepareMaterialsForNormal() {

		// Store original materials and create normal materials for each mesh
		if ( ! this.materialBackup ) {

			this.materialBackup = new Map();

		}

		this.scene.traverse( object => {

			if ( ! object.isMesh ) return;
			if ( ! object.material?.visible ) return;

			// Get the ORIGINAL material from backup, not the current material
			const originalMaterial = this.materialBackup.has( object )
				? this.materialBackup.get( object ).material
				: object.material;

			// Store original material if not already stored (in case albedo was called first)
			if ( ! this.materialBackup.has( object ) ) {

				this.materialBackup.set( object, {
					material: originalMaterial,
					visible: object.visible
				} );

			}

			// Check what we have to work with
			const hasNormalMap = !! originalMaterial.normalMap;
			let hasTangents = !! object.geometry.attributes.tangent;
			const hasNormals = !! object.geometry.attributes.normal;
			const hasUVs = !! object.geometry.attributes.uv;

			// If we have a normal map but no tangents, compute them efficiently on CPU
			if ( hasNormalMap && ! hasTangents && hasUVs && hasNormals ) {

				console.log( `Computing missing tangents for ${object.name}` );

				try {

					// Manual tangent computation (more efficient than per-fragment)
					const geometry = object.geometry;
					const positions = geometry.attributes.position.array;
					const normals = geometry.attributes.normal.array;
					const uvs = geometry.attributes.uv.array;
					const indices = geometry.index ? geometry.index.array : null;

					const vertexCount = positions.length / 3;
					const tangents = new Float32Array( vertexCount * 4 );

					// Initialize tangents to zero
					tangents.fill( 0 );

					// Get triangle count
					const triangleCount = indices ? indices.length / 3 : vertexCount / 3;

					// Compute tangents for each triangle
					for ( let i = 0; i < triangleCount; i ++ ) {

						// Get vertex indices
						let i0, i1, i2;
						if ( indices ) {

							i0 = indices[ i * 3 ];
							i1 = indices[ i * 3 + 1 ];
							i2 = indices[ i * 3 + 2 ];

						} else {

							i0 = i * 3;
							i1 = i * 3 + 1;
							i2 = i * 3 + 2;

						}

						// Get positions
						const v0x = positions[ i0 * 3 ], v0y = positions[ i0 * 3 + 1 ], v0z = positions[ i0 * 3 + 2 ];
						const v1x = positions[ i1 * 3 ], v1y = positions[ i1 * 3 + 1 ], v1z = positions[ i1 * 3 + 2 ];
						const v2x = positions[ i2 * 3 ], v2y = positions[ i2 * 3 + 1 ], v2z = positions[ i2 * 3 + 2 ];

						// Get UVs
						const u0 = uvs[ i0 * 2 ], v0 = uvs[ i0 * 2 + 1 ];
						const u1 = uvs[ i1 * 2 ], v1 = uvs[ i1 * 2 + 1 ];
						const u2 = uvs[ i2 * 2 ], v2 = uvs[ i2 * 2 + 1 ];

						// Calculate edge vectors
						const deltaPos1x = v1x - v0x, deltaPos1y = v1y - v0y, deltaPos1z = v1z - v0z;
						const deltaPos2x = v2x - v0x, deltaPos2y = v2y - v0y, deltaPos2z = v2z - v0z;
						const deltaUV1x = u1 - u0, deltaUV1y = v1 - v0;
						const deltaUV2x = u2 - u0, deltaUV2y = v2 - v0;

						// Calculate tangent
						const r = 1.0 / ( deltaUV1x * deltaUV2y - deltaUV1y * deltaUV2x );
						const tangentx = ( deltaPos1x * deltaUV2y - deltaPos2x * deltaUV1y ) * r;
						const tangenty = ( deltaPos1y * deltaUV2y - deltaPos2y * deltaUV1y ) * r;
						const tangentz = ( deltaPos1z * deltaUV2y - deltaPos2z * deltaUV1y ) * r;

						// Accumulate tangent for each vertex of the triangle
						[ i0, i1, i2 ].forEach( idx => {

							tangents[ idx * 4 ] += tangentx;
							tangents[ idx * 4 + 1 ] += tangenty;
							tangents[ idx * 4 + 2 ] += tangentz;
							tangents[ idx * 4 + 3 ] = 1.0; // handedness

						} );

					}

					// Normalize accumulated tangents
					for ( let i = 0; i < vertexCount; i ++ ) {

						const idx = i * 4;
						const tx = tangents[ idx ];
						const ty = tangents[ idx + 1 ];
						const tz = tangents[ idx + 2 ];
						const length = Math.sqrt( tx * tx + ty * ty + tz * tz );
						if ( length > 0 ) {

							tangents[ idx ] = tx / length;
							tangents[ idx + 1 ] = ty / length;
							tangents[ idx + 2 ] = tz / length;

						}

					}

					geometry.setAttribute( 'tangent', new BufferAttribute( tangents, 4 ) );
					hasTangents = true;
					console.log( `  - Successfully computed tangents` );

				} catch ( error ) {

					console.warn( `  - Failed to compute tangents for ${object.name}:`, error );

				}

			}

			console.log( `Creating normal material for ${object.name}: normalMap=${hasNormalMap}, tangents=${hasTangents}` );

			// Create custom shader material that properly applies normal maps
			const normalMaterial = new ShaderMaterial( {
				uniforms: {
					normalMap: { value: hasNormalMap ? originalMaterial.normalMap : null },
					normalScale: { value: originalMaterial.normalScale || new Vector2( 1, 1 ) }
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
				`,
				side: originalMaterial.side || 0
			} );

			// Apply the normal material to the mesh
			object.material = normalMaterial;

		} );

	}

	_renderNormal() {

		this._prepareMaterialsForNormal();

		// Don't use scene override since we've set individual materials per mesh
		// that preserve the original material's normal properties

		// Render to normal target
		this.renderer.setRenderTarget( this.normalTarget );
		this.renderer.render( this.scene, this.camera );

		// Clean up temporary normal materials
		this.scene.traverse( object => {

			if ( object.isMesh ) {

				// Dispose the temporary normal material we created
				const currentMaterial = object.material;
				const originalMaterial = this.materialBackup.get( object )?.material;

				if ( currentMaterial && currentMaterial !== originalMaterial ) {

					currentMaterial.dispose();

				}

			}

		} );

		return this._readRenderTarget( this.normalTarget );

	}

	// Debug method to check material and geometry properties
	debugMaterialAndGeometry() {

		console.log( '=== AlbedoNormalGenerator Debug ===' );

		this.scene.traverse( object => {

			if ( ! object.isMesh ) return;

			const material = object.material;
			const geometry = object.geometry;

			console.log( `Object: ${object.name || 'unnamed'}` );
			console.log( `  - Has normal map: ${!! material.normalMap}` );
			console.log( `  - Has tangents: ${!! geometry.attributes.tangent}` );
			console.log( `  - Has normals: ${!! geometry.attributes.normal}` );
			console.log( `  - Has UVs: ${!! geometry.attributes.uv}` );

			if ( material.normalMap ) {

				console.log( `  - Normal map size: ${material.normalMap.image?.width}x${material.normalMap.image?.height}` );
				console.log( `  - Normal scale: ${material.normalScale?.x}, ${material.normalScale?.y}` );

			}

			if ( geometry.attributes.tangent ) {

				console.log( `  - Tangent count: ${geometry.attributes.tangent.count}` );

			}

		} );

	}

	generateMaps() {

		const currentRenderTarget = this.renderer.getRenderTarget();

		try {

			// Debug material and geometry properties
			this.debugMaterialAndGeometry();

			// Generate albedo map
			const albedoData = this._renderAlbedo();

			// Generate normal map
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

	_readRenderTarget( renderTarget ) {

		const gl = this.renderer.getContext();
		const bufferSize = this.width * this.height * 4;

		// Create a new Float32Array for each read operation
		const floatBuffer = new Float32Array( bufferSize );

		// Read pixels from the render target
		gl.readPixels( 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, floatBuffer );

		return new ImageData(
			this._convertToUint8( floatBuffer ),
			this.width,
			this.height
		);

	}

	_convertToUint8( floatBuffer ) {

		const bufferSize = floatBuffer.length;
		const data = new Uint8ClampedArray( bufferSize );
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

	visualizeImageDataInTarget( imageData, target, renderer ) {

		if ( ! imageData || ! target || ! renderer ) return;

		// Create a temporary canvas to draw the image data
		const canvas = document.createElement( 'canvas' );
		canvas.width = imageData.width;
		canvas.height = imageData.height;
		const ctx = canvas.getContext( '2d' );
		ctx.putImageData( imageData, 0, 0 );

		// Create a texture from the canvas
		const texture = new CanvasTexture( canvas );
		texture.needsUpdate = true;

		// Create a full-screen quad to render the texture to the target
		const material = new MeshBasicMaterial( { map: texture } );
		const quad = new Mesh(
			new PlaneGeometry( 2, 2 ),
			material
		);

		const scene = new Scene();
		const camera = new OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
		scene.add( quad );

		// Render to the target
		const prevTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( target );
		renderer.render( scene, camera );
		renderer.setRenderTarget( prevTarget );

		// Cleanup
		material.dispose();
		texture.dispose();
		quad.geometry.dispose();

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

		this.albedoTarget?.dispose();
		this.normalTarget?.dispose();
		this.albedoOverrideMaterial?.dispose();
		this.normalOverrideMaterial?.dispose();

		// Clear references
		if ( this.materialBackup ) {

			this.materialBackup.clear();

		}

		// Dispose debug targets
		this.albedoDebugTarget?.dispose();
		this.normalDebugTarget?.dispose();

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
