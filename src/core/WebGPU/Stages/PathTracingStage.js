import { Fn, vec3, vec4, float, uniform, int, uint, Loop, If, texture, uv, min, max, Break } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu';
import { DataTexture, FloatType, HalfFloatType, RGBAFormat, NearestFilter, LinearFilter, Vector2, Matrix4 } from 'three';
import { initRNG, randomFloat, pcgHash } from '../TSL/Random.js';
import { fresnelSchlick, distributionGGX, geometrySmith } from '../TSL/BSDF.js';
import { directionToEquirectUV } from '../TSL/Environment.js';

const PI = Math.PI;
const PI_INV = 1.0 / PI;

/**
 * BVH node data layout constants.
 */
const BVH_VEC4_PER_NODE = 3;

/**
 * Triangle data layout constants.
 */
const TRI_VEC4_PER_TRIANGLE = 8;

/**
 * Material texture layout (27 pixels per material).
 */
const PIXELS_PER_MATERIAL = 27;

/**
 * Path Tracing Stage for WebGPU.
 * Implements multi-bounce Monte Carlo path tracing with:
 * - BVH-accelerated ray traversal
 * - GGX/Diffuse BSDF sampling
 * - Environment lighting
 * - Progressive accumulation
 */
export class PathTracingStage {

	/**
	 * @param {WebGPURenderer} renderer - Three.js WebGPU renderer
	 * @param {PerspectiveCamera} camera - Three.js camera
	 */
	constructor( renderer, camera ) {

		this.renderer = renderer;
		this.camera = camera;

		// Data textures
		this.triangleTexture = null;
		this.triangleTexSize = new Vector2();
		this.triangleCount = 0;

		this.bvhTexture = null;
		this.bvhTexSize = new Vector2();
		this.bvhNodeCount = 0;

		this.materialTexture = null;
		this.materialTexSize = new Vector2();
		this.materialCount = 0;

		this.environmentTexture = null;
		this.envTexSize = new Vector2();

		// Accumulation render targets (ping-pong)
		this.renderTargetA = null;
		this.renderTargetB = null;
		this.currentTarget = 0; // 0 = A, 1 = B
		this.renderWidth = 0;
		this.renderHeight = 0;

		// Uniforms
		this.frame = uniform( uint( 0 ) );
		this.maxBounces = uniform( 4 );
		this.samplesPerPixel = uniform( 1 );
		this.environmentIntensity = uniform( 1.0 );
		this.enableAccumulation = uniform( 1 );

		// Camera uniforms
		this.cameraWorldMatrix = null;
		this.cameraProjectionMatrixInverse = null;

		// Rendering
		this.pathTraceMaterial = null; // Path tracing pass
		this.displayMaterial = null;   // Display pass (copy to screen)
		this.pathTraceQuad = null;
		this.displayQuad = null;

		this.isReady = false;
		this.useBVH = false;
		this.frameCount = 0;

	}

	/**
	 * Sets the triangle data texture.
	 */
	setTriangleTexture( triangleTex ) {

		if ( ! triangleTex ) return;

		this.triangleTexture = triangleTex;
		this.triangleTexSize.set( triangleTex.image.width, triangleTex.image.height );
		const totalVec4s = triangleTex.image.width * triangleTex.image.height;
		this.triangleCount = Math.floor( totalVec4s / TRI_VEC4_PER_TRIANGLE );

		console.log( `PathTracingStage: ${this.triangleCount} triangles` );

	}

	/**
	 * Sets the BVH data texture.
	 */
	setBVHTexture( bvhTex ) {

		if ( ! bvhTex ) return;

		this.bvhTexture = bvhTex;
		this.bvhTexSize.set( bvhTex.image.width, bvhTex.image.height );
		const totalVec4s = bvhTex.image.width * bvhTex.image.height;
		this.bvhNodeCount = Math.floor( totalVec4s / BVH_VEC4_PER_NODE );
		this.useBVH = true;

		console.log( `PathTracingStage: ${this.bvhNodeCount} BVH nodes` );

	}

	/**
	 * Sets the material data texture.
	 */
	setMaterialTexture( materialTex ) {

		if ( ! materialTex ) return;

		this.materialTexture = materialTex;
		this.materialTexSize.set( materialTex.image.width, materialTex.image.height );
		const totalPixels = materialTex.image.width * materialTex.image.height;
		this.materialCount = Math.floor( totalPixels / PIXELS_PER_MATERIAL );

		console.log( `PathTracingStage: ${this.materialCount} materials (${materialTex.image.width}x${materialTex.image.height})` );

		// Debug: Log first material's data
		if ( materialTex.image?.data && this.materialCount > 0 ) {

			const data = materialTex.image.data;
			const pixelsPerMat = PIXELS_PER_MATERIAL;
			// First material, first pixel (color.rgb, metalness)
			const idx = 0;
			const r = data[ idx * 4 ];
			const g = data[ idx * 4 + 1 ];
			const b = data[ idx * 4 + 2 ];
			const metalness = data[ idx * 4 + 3 ];
			console.log( `  Material 0: color=(${r.toFixed( 3 )}, ${g.toFixed( 3 )}, ${b.toFixed( 3 )}), metalness=${metalness.toFixed( 3 )}` );

			// Second pixel (emissive.rgb, roughness)
			const idx2 = 1;
			const roughness = data[ idx2 * 4 + 3 ];
			console.log( `  Material 0: roughness=${roughness.toFixed( 3 )}` );

		}

	}

	/**
	 * Sets the environment map texture.
	 */
	setEnvironmentTexture( envTex ) {

		if ( ! envTex ) return;

		this.environmentTexture = envTex;
		this.envTexSize.set( envTex.image.width, envTex.image.height );

		console.log( `PathTracingStage: Environment map ${envTex.image.width}x${envTex.image.height}` );

	}

	/**
	 * Creates render targets for accumulation.
	 */
	createRenderTargets( width, height ) {

		// Dispose old targets
		if ( this.renderTargetA ) this.renderTargetA.dispose();
		if ( this.renderTargetB ) this.renderTargetB.dispose();

		this.renderWidth = width;
		this.renderHeight = height;

		const targetOptions = {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		};

		this.renderTargetA = new RenderTarget( width, height, targetOptions );
		this.renderTargetB = new RenderTarget( width, height, targetOptions );

		console.log( `PathTracingStage: Created ${width}x${height} render targets` );

	}

	/**
	 * Creates the path tracing material and quad.
	 */
	setupMaterial() {

		if ( ! this.triangleTexture ) {

			console.error( 'PathTracingStage: Triangle data required' );
			return;

		}

		// Create render targets if not already created
		const canvas = this.renderer.domElement;
		const width = Math.max( 1, canvas.width || 800 );
		const height = Math.max( 1, canvas.height || 600 );

		if ( this.renderWidth !== width || this.renderHeight !== height || ! this.renderTargetA ) {

			this.createRenderTargets( width, height );

		}

		// Camera uniforms
		const cameraWorldMatrix = uniform( new Matrix4() );
		const cameraProjectionMatrixInverse = uniform( new Matrix4() );
		this.cameraWorldMatrix = cameraWorldMatrix;
		this.cameraProjectionMatrixInverse = cameraProjectionMatrixInverse;

		// Texture access
		const triTex = texture( this.triangleTexture );
		const triTexSize = uniform( this.triangleTexSize );

		const bvhTex = this.useBVH ? texture( this.bvhTexture ) : null;
		const bvhTexSize = this.useBVH ? uniform( this.bvhTexSize ) : null;

		const hasMaterials = this.materialTexture !== null;
		const matTex = hasMaterials ? texture( this.materialTexture ) : null;
		const matTexSize = hasMaterials ? uniform( this.materialTexSize ) : null;

		const hasEnv = this.environmentTexture !== null;
		const envTex = hasEnv ? texture( this.environmentTexture ) : null;

		// Capture uniforms for shader
		const frameUniform = this.frame;
		const maxBouncesUniform = this.maxBounces;
		const envIntensityUniform = this.environmentIntensity;
		const useBVHTraversal = this.useBVH;

		// Texture read helpers
		const readTriVec4 = ( index ) => {

			const texWidth = triTexSize.x;
			const floatIndex = float( index );
			const x = floatIndex.mod( texWidth ).add( 0.5 ).div( texWidth );
			const y = floatIndex.div( texWidth ).floor().add( 0.5 ).div( triTexSize.y );
			return triTex.sample( vec4( x, y, 0, 0 ).xy );

		};

		const readBVHVec4 = useBVHTraversal ? ( index ) => {

			const texWidth = bvhTexSize.x;
			const floatIndex = float( index );
			const x = floatIndex.mod( texWidth ).add( 0.5 ).div( texWidth );
			const y = floatIndex.div( texWidth ).floor().add( 0.5 ).div( bvhTexSize.y );
			return bvhTex.sample( vec4( x, y, 0, 0 ).xy );

		} : null;

		const readMatPixel = hasMaterials ? ( pixelIndex ) => {

			const texWidth = matTexSize.x;
			const floatIndex = float( pixelIndex );
			const x = floatIndex.mod( texWidth ).add( 0.5 ).div( texWidth );
			const y = floatIndex.div( texWidth ).floor().add( 0.5 ).div( matTexSize.y );
			return matTex.sample( vec4( x, y, 0, 0 ).xy );

		} : null;

		// Ray-triangle intersection (Moller-Trumbore)
		const intersectTriangle = ( rayOrigin, rayDir, posA, posB, posC, closestT ) => {

			const edge1 = posB.sub( posA );
			const edge2 = posC.sub( posA );
			const h = rayDir.cross( edge2 );
			const a = edge1.dot( h );

			const EPSILON = float( 1e-7 );

			const f = float( 1.0 ).div( a );
			const s = rayOrigin.sub( posA );
			const u = f.mul( s.dot( h ) );
			const q = s.cross( edge1 );
			const v = f.mul( rayDir.dot( q ) );
			const t = f.mul( edge2.dot( q ) );

			const validA = a.abs().greaterThan( EPSILON );
			const validU = u.greaterThanEqual( 0.0 ).and( u.lessThanEqual( 1.0 ) );
			const validV = v.greaterThanEqual( 0.0 ).and( u.add( v ).lessThanEqual( 1.0 ) );
			const validT = t.greaterThan( EPSILON ).and( t.lessThan( closestT ) );

			return {
				hit: validA.and( validU ).and( validV ).and( validT ),
				t,
				u,
				v,
				w: float( 1.0 ).sub( u ).sub( v )
			};

		};

		// Ray-AABB intersection
		const intersectAABB = ( rayOrigin, invDir, boxMin, boxMax ) => {

			const t1 = boxMin.sub( rayOrigin ).mul( invDir );
			const t2 = boxMax.sub( rayOrigin ).mul( invDir );

			const tMin = min( t1, t2 );
			const tMax = max( t1, t2 );

			const dstNear = max( max( tMin.x, tMin.y ), tMin.z );
			const dstFar = min( min( tMax.x, tMax.y ), tMax.z );

			const hit = dstFar.greaterThanEqual( max( dstNear, float( 0.0 ) ) );
			return hit.select( max( dstNear, float( 0.0 ) ), float( 1e20 ) );

		};

		// Main path tracing shader
		const pathTracingShader = Fn( () => {

			// Get pixel coordinates
			const screenUV = uv();
			const ndc = screenUV.mul( 2.0 ).sub( 1.0 );

			// Negate Y for WebGPU coordinate system
			const clipPos = vec4( ndc.x, ndc.y.negate(), float( - 1.0 ), float( 1.0 ) );
			const viewPos = cameraProjectionMatrixInverse.mul( clipPos );
			const viewDir = viewPos.xyz.div( viewPos.w );

			const worldDirRaw = cameraWorldMatrix.mul( vec4( viewDir, 0.0 ) ).xyz;
			const initialRayDir = worldDirRaw.normalize();

			const initialRayOrigin = vec3(
				cameraWorldMatrix.element( 3 ).x,
				cameraWorldMatrix.element( 3 ).y,
				cameraWorldMatrix.element( 3 ).z
			);

			// Initialize RNG
			const pixelX = int( screenUV.x.mul( 1920.0 ) );
			const pixelY = int( screenUV.y.mul( 1080.0 ) );
			const rngState = initRNG( pixelX, pixelY, frameUniform ).toVar( 'rngState' );

			// Path tracing state
			const rayOrigin = initialRayOrigin.toVar( 'rayOrigin' );
			const rayDir = initialRayDir.toVar( 'rayDir' );
			const throughput = vec3( 1.0 ).toVar( 'throughput' );
			const radiance = vec3( 0.0 ).toVar( 'radiance' );

			// Inverse direction for AABB tests
			const EPSILON = float( 1e-8 );

			// BVH traversal stack (using individual variables)
			const stackPtr = int( 0 ).toVar( 'stackPtr' );
			const s0 = int( 0 ).toVar( 's0' );
			const s1 = int( 0 ).toVar( 's1' );
			const s2 = int( 0 ).toVar( 's2' );
			const s3 = int( 0 ).toVar( 's3' );
			const s4 = int( 0 ).toVar( 's4' );
			const s5 = int( 0 ).toVar( 's5' );
			const s6 = int( 0 ).toVar( 's6' );
			const s7 = int( 0 ).toVar( 's7' );
			const s8 = int( 0 ).toVar( 's8' );
			const s9 = int( 0 ).toVar( 's9' );
			const s10 = int( 0 ).toVar( 's10' );
			const s11 = int( 0 ).toVar( 's11' );
			const s12 = int( 0 ).toVar( 's12' );
			const s13 = int( 0 ).toVar( 's13' );
			const s14 = int( 0 ).toVar( 's14' );
			const s15 = int( 0 ).toVar( 's15' );

			const readStack = ( ptr ) => {

				return ptr.equal( 0 ).select( s0,
					ptr.equal( 1 ).select( s1,
						ptr.equal( 2 ).select( s2,
							ptr.equal( 3 ).select( s3,
								ptr.equal( 4 ).select( s4,
									ptr.equal( 5 ).select( s5,
										ptr.equal( 6 ).select( s6,
											ptr.equal( 7 ).select( s7,
												ptr.equal( 8 ).select( s8,
													ptr.equal( 9 ).select( s9,
														ptr.equal( 10 ).select( s10,
															ptr.equal( 11 ).select( s11,
																ptr.equal( 12 ).select( s12,
																	ptr.equal( 13 ).select( s13,
																		ptr.equal( 14 ).select( s14, s15 )
																	)
																)
															)
														)
													)
												)
											)
										)
									)
								)
							)
						)
					)
				);

			};

			const writeStack = ( ptr, value ) => {

				If( ptr.equal( 0 ), () => s0.assign( value ) );
				If( ptr.equal( 1 ), () => s1.assign( value ) );
				If( ptr.equal( 2 ), () => s2.assign( value ) );
				If( ptr.equal( 3 ), () => s3.assign( value ) );
				If( ptr.equal( 4 ), () => s4.assign( value ) );
				If( ptr.equal( 5 ), () => s5.assign( value ) );
				If( ptr.equal( 6 ), () => s6.assign( value ) );
				If( ptr.equal( 7 ), () => s7.assign( value ) );
				If( ptr.equal( 8 ), () => s8.assign( value ) );
				If( ptr.equal( 9 ), () => s9.assign( value ) );
				If( ptr.equal( 10 ), () => s10.assign( value ) );
				If( ptr.equal( 11 ), () => s11.assign( value ) );
				If( ptr.equal( 12 ), () => s12.assign( value ) );
				If( ptr.equal( 13 ), () => s13.assign( value ) );
				If( ptr.equal( 14 ), () => s14.assign( value ) );
				If( ptr.equal( 15 ), () => s15.assign( value ) );

			};

			// Path tracing bounce loop
			Loop( maxBouncesUniform, ( { i: bounceIndex } ) => {

				// Hit test variables
				const closestT = float( 1e20 ).toVar( 'closestT' );
				const hitNormal = vec3( 0, 1, 0 ).toVar( 'hitNormal' );
				const didHit = int( 0 ).toVar( 'didHit' );
				const hitMaterialIndex = int( 0 ).toVar( 'hitMaterialIndex' );
				const hitU = float( 0.0 ).toVar( 'hitU' );
				const hitV = float( 0.0 ).toVar( 'hitV' );

				// Compute inverse direction
				const invDir = vec3(
					float( 1.0 ).div( rayDir.x.abs().greaterThan( EPSILON ).select( rayDir.x, EPSILON ) ),
					float( 1.0 ).div( rayDir.y.abs().greaterThan( EPSILON ).select( rayDir.y, EPSILON ) ),
					float( 1.0 ).div( rayDir.z.abs().greaterThan( EPSILON ).select( rayDir.z, EPSILON ) )
				);

				if ( useBVHTraversal ) {

					// BVH traversal
					stackPtr.assign( 1 );
					s0.assign( 0 );

					Loop( int( 256 ), () => {

						If( stackPtr.lessThanEqual( 0 ), () => Break() );

						stackPtr.subAssign( 1 );
						const nodeIndex = readStack( stackPtr ).toVar( 'nodeIndex' );

						const baseIdx = nodeIndex.mul( BVH_VEC4_PER_NODE );
						const node0 = readBVHVec4( baseIdx );
						const node1 = readBVHVec4( baseIdx.add( 1 ) );
						const node2 = readBVHVec4( baseIdx.add( 2 ) );

						const boundsMin = node0.xyz;
						const leftChild = int( node0.w );
						const boundsMax = node1.xyz;
						const rightChild = int( node1.w );
						const triangleOffset = int( node2.x );
						const triangleCountNode = int( node2.y );

						const aabbDist = intersectAABB( rayOrigin, invDir, boundsMin, boundsMax );

						If( aabbDist.lessThan( closestT ), () => {

							If( leftChild.lessThan( 0 ), () => {

								Loop( triangleCountNode, ( { i: triIdx } ) => {

									const globalTriIdx = triangleOffset.add( triIdx );
									const triBaseIdx = globalTriIdx.mul( TRI_VEC4_PER_TRIANGLE );

									const posA = readTriVec4( triBaseIdx ).xyz;
									const posB = readTriVec4( triBaseIdx.add( 1 ) ).xyz;
									const posC = readTriVec4( triBaseIdx.add( 2 ) ).xyz;

									const result = intersectTriangle( rayOrigin, rayDir, posA, posB, posC, closestT );

									If( result.hit, () => {

										closestT.assign( result.t );
										didHit.assign( 1 );
										hitU.assign( result.u );
										hitV.assign( result.v );

										const normA = readTriVec4( triBaseIdx.add( 3 ) ).xyz;
										const normB = readTriVec4( triBaseIdx.add( 4 ) ).xyz;
										const normC = readTriVec4( triBaseIdx.add( 5 ) ).xyz;

										const interpNormal = normA.mul( result.w )
											.add( normB.mul( result.u ) )
											.add( normC.mul( result.v ) );
										hitNormal.assign( interpNormal.normalize() );

										const uvCMat = readTriVec4( triBaseIdx.add( 7 ) );
										hitMaterialIndex.assign( int( uvCMat.z ) );

									} );

								} );

							} ).Else( () => {

								If( stackPtr.lessThan( 16 ), () => {

									writeStack( stackPtr, rightChild );
									stackPtr.addAssign( 1 );

								} );

								If( stackPtr.lessThan( 16 ), () => {

									writeStack( stackPtr, leftChild );
									stackPtr.addAssign( 1 );

								} );

							} );

						} );

					} );

				} else {

					// Linear traversal fallback
					const maxTris = int( Math.min( this.triangleCount, 1000 ) );

					Loop( maxTris, ( { i } ) => {

						const baseIdx = i.mul( TRI_VEC4_PER_TRIANGLE );

						const posA = readTriVec4( baseIdx ).xyz;
						const posB = readTriVec4( baseIdx.add( 1 ) ).xyz;
						const posC = readTriVec4( baseIdx.add( 2 ) ).xyz;

						const result = intersectTriangle( rayOrigin, rayDir, posA, posB, posC, closestT );

						If( result.hit, () => {

							closestT.assign( result.t );
							didHit.assign( 1 );
							hitU.assign( result.u );
							hitV.assign( result.v );

							const normA = readTriVec4( baseIdx.add( 3 ) ).xyz;
							const normB = readTriVec4( baseIdx.add( 4 ) ).xyz;
							const normC = readTriVec4( baseIdx.add( 5 ) ).xyz;

							const interpNormal = normA.mul( result.w )
								.add( normB.mul( result.u ) )
								.add( normC.mul( result.v ) );
							hitNormal.assign( interpNormal.normalize() );

							const uvCMat = readTriVec4( baseIdx.add( 7 ) );
							hitMaterialIndex.assign( int( uvCMat.z ) );

						} );

					} );

				}

				// Process hit or miss
				If( didHit.equal( 1 ), () => {

					// Hit point
					const hitPoint = rayOrigin.add( rayDir.mul( closestT ) );

					// Ensure normal faces the camera
					const faceNormal = hitNormal.dot( rayDir ).lessThan( 0.0 ).select( hitNormal, hitNormal.negate() );

					// Get material properties
					let matColor = vec3( 0.8 );
					let matRoughness = float( 0.5 );
					let matMetalness = float( 0.0 );
					let matEmissive = vec3( 0.0 );
					let matIOR = float( 1.5 );

					if ( hasMaterials ) {

						const matBasePixel = hitMaterialIndex.mul( PIXELS_PER_MATERIAL );
						const pixel1 = readMatPixel( matBasePixel );
						const pixel2 = readMatPixel( matBasePixel.add( 1 ) );
						const pixel3 = readMatPixel( matBasePixel.add( 2 ) );

						matColor = pixel1.xyz;
						matMetalness = pixel1.w;
						matEmissive = pixel2.xyz.mul( pixel3.w ); // emissive * intensity
						matRoughness = pixel2.w;
						matIOR = pixel3.x;

					}

					// Add emissive contribution
					radiance.addAssign( throughput.mul( matEmissive ) );

					// Russian roulette (after first 2 bounces)
					If( bounceIndex.greaterThan( 2 ), () => {

						const maxThroughput = max( throughput.x, max( throughput.y, throughput.z ) );
						const rrProb = maxThroughput.clamp( 0.1, 0.95 );
						const rrSample = randomFloat( rngState );

						If( rrSample.greaterThan( rrProb ), () => {

							// Terminate path
							throughput.assign( vec3( 0.0 ) );

						} ).Else( () => {

							// Boost throughput to compensate
							throughput.divAssign( rrProb );

						} );

					} );

					// Only continue if throughput is significant
					If( max( throughput.x, max( throughput.y, throughput.z ) ).greaterThan( 0.001 ), () => {

						// Compute F0 (base reflectance)
						const dielectricF0 = matIOR.sub( 1.0 ).div( matIOR.add( 1.0 ) );
						const dielectricF0Sq = dielectricF0.mul( dielectricF0 );
						const F0 = vec3( dielectricF0Sq ).mix( matColor, matMetalness );

						// View direction (pointing away from surface)
						const V = rayDir.negate();
						const N = faceNormal;

						// Build TBN (tangent, bitangent, normal) for hemisphere sampling
						const upAlt = vec3( 1.0, 0.0, 0.0 );
						const up = vec3( 0.0, 1.0, 0.0 );
						const useAlt = N.y.abs().greaterThan( 0.999 );
						const helper = useAlt.select( upAlt, up );
						const T = helper.cross( N ).normalize();
						const B = N.cross( T );

						// Probability of sampling diffuse vs specular
						const specularWeight = matMetalness.add( float( 1.0 ).sub( matRoughness ) ).mul( 0.5 ).clamp( 0.1, 0.9 );
						const diffuseWeight = float( 1.0 ).sub( specularWeight );

						// Random choice
						const xi = randomFloat( rngState );
						const chooseDiffuse = xi.lessThan( diffuseWeight );

						// === DIFFUSE SAMPLING (cosine-weighted hemisphere) ===
						const u1Diff = randomFloat( rngState );
						const u2Diff = randomFloat( rngState );

						const rDiff = u1Diff.sqrt();
						const phiDiff = u2Diff.mul( float( 2.0 * PI ) );

						const xDiff = rDiff.mul( phiDiff.cos() );
						const yDiff = rDiff.mul( phiDiff.sin() );
						const zDiff = float( 1.0 ).sub( u1Diff ).sqrt();

						const diffuseLocalDir = vec3( xDiff, yDiff, zDiff );
						const diffuseDir = T.mul( diffuseLocalDir.x ).add( B.mul( diffuseLocalDir.y ) ).add( N.mul( diffuseLocalDir.z ) ).normalize();

						// === SPECULAR SAMPLING (GGX importance sampling) ===
						const u1Spec = randomFloat( rngState );
						const u2Spec = randomFloat( rngState );

						const alpha = matRoughness.mul( matRoughness );
						const alpha2 = alpha.mul( alpha );

						const phiSpec = u1Spec.mul( float( 2.0 * PI ) );
						const cosThetaSpec = float( 1.0 ).sub( u2Spec ).div( u2Spec.mul( alpha2.sub( 1.0 ) ).add( 1.0 ) ).sqrt();
						const sinThetaSpec = float( 1.0 ).sub( cosThetaSpec.mul( cosThetaSpec ) ).sqrt().max( 0.0 );

						// Half vector in tangent space
						const HlocalX = sinThetaSpec.mul( phiSpec.cos() );
						const HlocalY = sinThetaSpec.mul( phiSpec.sin() );
						const HlocalZ = cosThetaSpec;

						const H = T.mul( HlocalX ).add( B.mul( HlocalY ) ).add( N.mul( HlocalZ ) ).normalize();

						// Reflect V around H to get specular direction
						const VdotH = V.dot( H ).max( 0.001 );
						const specularDir = H.mul( VdotH.mul( 2.0 ) ).sub( V ).normalize();

						// Choose direction based on random selection
						const sampledDir = chooseDiffuse.select( diffuseDir, specularDir );

						// Compute BRDF and PDF for the chosen direction
						const NoL = N.dot( sampledDir ).max( 0.001 );
						const NoV = N.dot( V ).max( 0.001 );

						// Fresnel for the sampled direction
						const Hfinal = V.add( sampledDir ).normalize();
						const VoHfinal = V.dot( Hfinal ).max( 0.001 );
						const NoHfinal = N.dot( Hfinal ).max( 0.001 );
						const F = fresnelSchlick( VoHfinal, F0 );

						// Diffuse BRDF (Lambertian, reduced by Fresnel and metalness)
						const kD = vec3( 1.0 ).sub( F ).mul( float( 1.0 ).sub( matMetalness ) );
						const diffuseBRDF = kD.mul( matColor ).mul( float( PI_INV ) );

						// Specular BRDF (GGX microfacet)
						const D = distributionGGX( NoHfinal, matRoughness );
						const G = geometrySmith( NoV, NoL, matRoughness );
						const specDenom = NoV.mul( NoL ).mul( 4.0 ).max( 0.001 );
						const specularBRDF = F.mul( D ).mul( G ).div( specDenom );

						// Combined BRDF
						const brdf = diffuseBRDF.add( specularBRDF );

						// PDF for each sampling strategy
						const diffusePDF = NoL.mul( float( PI_INV ) ).max( 0.001 );
						const NoHspec = N.dot( H ).max( 0.001 );
						const Dspec = distributionGGX( NoHspec, matRoughness );
						const specularPDF = Dspec.mul( NoHspec ).div( VdotH.mul( 4.0 ) ).max( 0.001 );

						// Combined PDF (MIS)
						const pdf = chooseDiffuse.select(
							diffusePDF.mul( diffuseWeight ).add( specularPDF.mul( specularWeight ) ),
							specularPDF.mul( specularWeight ).add( diffusePDF.mul( diffuseWeight ) )
						).max( 0.001 );

						// Update throughput: BRDF * cos(theta) / PDF
						throughput.mulAssign( brdf.mul( NoL ).div( pdf ) );

						// Setup next ray
						rayOrigin.assign( hitPoint.add( faceNormal.mul( 0.001 ) ) );
						rayDir.assign( sampledDir );

					} );

				} ).Else( () => {

					// Miss - sample environment
					if ( hasEnv ) {

						const envUV = directionToEquirectUV( rayDir );
						const envColor = envTex.sample( envUV ).xyz.mul( envIntensityUniform );
						radiance.addAssign( throughput.mul( envColor ) );

					} else {

						// Simple sky gradient
						const t = rayDir.y.mul( 0.5 ).add( 0.5 );
						const skyColor = vec3( 0.5, 0.7, 1.0 ).mix( vec3( 1.0 ), t );
						radiance.addAssign( throughput.mul( skyColor ) );

					}

					// End path
					throughput.assign( vec3( 0.0 ) );

				} );

				// Early exit if throughput is zero
				If( max( throughput.x, max( throughput.y, throughput.z ) ).lessThan( 0.001 ), () => {

					Break();

				} );

			} );

			// Clamp fireflies
			const maxRadiance = max( radiance.x, max( radiance.y, radiance.z ) );
			const fireflyClamp = float( 10.0 );
			If( maxRadiance.greaterThan( fireflyClamp ), () => {

				radiance.mulAssign( fireflyClamp.div( maxRadiance ) );

			} );

			return vec4( radiance, 1.0 );

		} );

		// Create path tracing material (for direct rendering without accumulation)
		this.pathTraceMaterial = new MeshBasicNodeMaterial();
		this.pathTraceMaterial.colorNode = pathTracingShader();
		this.pathTraceQuad = new QuadMesh( this.pathTraceMaterial );

		// Create texture nodes for render targets
		// We'll switch these textures each frame for ping-pong
		const prevFrameTex = texture( this.renderTargetA.texture );
		this.prevFrameTexNode = prevFrameTex;

		// Accumulation shader - blends current frame with previous
		const accumulationShader = Fn( () => {

			const screenUV = uv();

			// Sample current path traced result
			const currentColor = pathTracingShader();

			// Sample previous accumulated result
			const prevColor = prevFrameTex.uv( screenUV );

			// Blend based on frame count
			// accumulated = (previous * frameCount + current) / (frameCount + 1)
			// which simplifies to: lerp(previous, current, 1.0 / (frameCount + 1))
			const frameNum = float( frameUniform ).add( 1.0 );
			const weight = float( 1.0 ).div( frameNum );

			// Linear blend
			const accumulated = prevColor.xyz.mul( float( 1.0 ).sub( weight ) ).add( currentColor.xyz.mul( weight ) );

			return vec4( accumulated, 1.0 );

		} );

		// Create accumulation material
		this.accumMaterial = new MeshBasicNodeMaterial();
		this.accumMaterial.colorNode = accumulationShader();
		this.accumQuad = new QuadMesh( this.accumMaterial );

		// Display texture node
		const displayTex = texture( this.renderTargetA.texture );
		this.displayTexNode = displayTex;

		// Display shader - just samples and outputs the accumulated texture
		const displayShader = Fn( () => {

			const screenUV = uv();
			const color = displayTex.uv( screenUV );
			return vec4( color.xyz, 1.0 );

		} );

		// Create display material
		this.displayMaterial = new MeshBasicNodeMaterial();
		this.displayMaterial.colorNode = displayShader();
		this.displayQuad = new QuadMesh( this.displayMaterial );

		this.isReady = true;

		console.log( 'PathTracingStage: Material setup complete with accumulation' );

	}

	/**
	 * Renders the path tracing pass with accumulation.
	 */
	render() {

		if ( ! this.isReady ) return;

		// Check if render targets need resize
		const canvas = this.renderer.domElement;
		const width = canvas.width;
		const height = canvas.height;

		if ( width !== this.renderWidth || height !== this.renderHeight ) {

			this.createRenderTargets( width, height );
			this.frameCount = 0;

		}

		// Update camera
		this.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
		this.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

		// Update frame uniform
		this.frame.value = this.frameCount;

		// Determine read and write targets (ping-pong)
		const readTarget = this.currentTarget === 0 ? this.renderTargetA : this.renderTargetB;
		const writeTarget = this.currentTarget === 0 ? this.renderTargetB : this.renderTargetA;

		// Update previous frame texture node to read from the read target
		if ( this.prevFrameTexNode ) {

			this.prevFrameTexNode.value = readTarget.texture;

		}

		// Render accumulation pass to write target
		this.renderer.setRenderTarget( writeTarget );
		this.accumQuad.render( this.renderer );

		// Update display texture node to show the write target
		if ( this.displayTexNode ) {

			this.displayTexNode.value = writeTarget.texture;

		}

		// Render display pass to screen
		this.renderer.setRenderTarget( null );
		this.displayQuad.render( this.renderer );

		// Swap targets for next frame
		this.currentTarget = 1 - this.currentTarget;

		this.frameCount ++;

	}

	/**
	 * Resets the accumulation.
	 */
	reset() {

		this.frameCount = 0;
		this.currentTarget = 0;

		// Clear render targets
		if ( this.renderTargetA && this.renderTargetB && this.renderer ) {

			// Store current render target
			const currentRT = this.renderer.getRenderTarget();

			// Clear both targets
			this.renderer.setRenderTarget( this.renderTargetA );
			this.renderer.clear( true, false, false );
			this.renderer.setRenderTarget( this.renderTargetB );
			this.renderer.clear( true, false, false );

			// Restore original render target
			this.renderer.setRenderTarget( currentRT );

		}

	}

	/**
	 * Sets the maximum number of bounces.
	 */
	setMaxBounces( bounces ) {

		this.maxBounces.value = bounces;

	}

	/**
	 * Sets the environment intensity.
	 */
	setEnvironmentIntensity( intensity ) {

		this.environmentIntensity.value = intensity;

	}

	/**
	 * Disposes of GPU resources.
	 */
	dispose() {

		if ( this.pathTraceMaterial ) this.pathTraceMaterial.dispose();
		if ( this.accumMaterial ) this.accumMaterial.dispose();
		if ( this.displayMaterial ) this.displayMaterial.dispose();
		if ( this.renderTargetA ) this.renderTargetA.dispose();
		if ( this.renderTargetB ) this.renderTargetB.dispose();

		this.triangleTexture = null;
		this.bvhTexture = null;
		this.materialTexture = null;
		this.environmentTexture = null;
		this.isReady = false;

	}

}

