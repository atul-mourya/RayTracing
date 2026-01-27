import { Fn, vec3, vec4, float, uniform, int, Loop, If, texture, uv, min, max, Break } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu';
import { DataTexture, FloatType, RGBAFormat, NearestFilter, Vector2, Matrix4 } from 'three';

/**
 * Visualization modes for hit test display.
 */
export const VIS_MODE = {
	NORMALS: 0,
	DISTANCE: 1,
	MATERIAL_ID: 2,
	BVH_HEATMAP: 3
};

/**
 * BVH node data layout constants.
 * Each BVH node uses 3 vec4s (12 floats):
 * - Vec4 0: boundsMin.xyz + leftChild.w
 * - Vec4 1: boundsMax.xyz + rightChild.w
 * - Vec4 2: triangleOffset.x + triangleCount.y + padding.zw
 */
const BVH_VEC4_PER_NODE = 3;

/**
 * Triangle data layout constants.
 * Each triangle uses 8 vec4s (32 floats).
 */
const TRI_VEC4_PER_TRIANGLE = 8;

/**
 * Maximum BVH traversal stack depth.
 * 32 levels supports trees with billions of nodes.
 */
const MAX_STACK_DEPTH = 32;

/**
 * Hit Test Visualization Stage with BVH Traversal.
 * Renders ray-scene intersections using stack-based BVH acceleration.
 */
export class HitTestStage {

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

		// Uniforms
		this.visMode = uniform( VIS_MODE.NORMALS );
		this.maxDistance = uniform( 20.0 );

		// Rendering objects
		this.material = null;
		this.quad = null;

		// Camera uniforms (set during setupMaterial)
		this.cameraWorldMatrix = null;
		this.cameraProjectionMatrixInverse = null;

		this.isReady = false;
		this.useBVH = false;

	}

	/**
	 * Sets the triangle data texture directly from the existing PathTracerApp.
	 *
	 * @param {DataTexture} triangleTex - Triangle data texture
	 */
	setTriangleTexture( triangleTex ) {

		if ( ! triangleTex ) {

			console.warn( 'HitTestStage: No triangle texture provided' );
			return;

		}

		this.triangleTexture = triangleTex;
		this.triangleTexSize.set( triangleTex.image.width, triangleTex.image.height );

		const totalVec4s = triangleTex.image.width * triangleTex.image.height;
		this.triangleCount = Math.floor( totalVec4s / TRI_VEC4_PER_TRIANGLE );

		console.log( `HitTestStage: Triangle texture ${triangleTex.image.width}x${triangleTex.image.height}, ${this.triangleCount} triangles` );

	}

	/**
	 * Sets the BVH data texture from the existing PathTracerApp.
	 *
	 * @param {DataTexture} bvhTex - BVH data texture
	 */
	setBVHTexture( bvhTex ) {

		if ( ! bvhTex ) {

			console.warn( 'HitTestStage: No BVH texture provided' );
			return;

		}

		this.bvhTexture = bvhTex;
		this.bvhTexSize.set( bvhTex.image.width, bvhTex.image.height );

		const totalVec4s = bvhTex.image.width * bvhTex.image.height;
		this.bvhNodeCount = Math.floor( totalVec4s / BVH_VEC4_PER_NODE );
		this.useBVH = true;

		console.log( `HitTestStage: BVH texture ${bvhTex.image.width}x${bvhTex.image.height}, ${this.bvhNodeCount} nodes` );

	}

	/**
	 * Sets triangle data from a Float32Array by creating a texture.
	 *
	 * @param {Float32Array} triangleFloat32Array - Triangle vertex data
	 */
	setTriangleData( triangleFloat32Array ) {

		if ( ! triangleFloat32Array || triangleFloat32Array.length === 0 ) {

			console.warn( 'HitTestStage: Empty triangle data provided' );
			return;

		}

		const vec4Count = triangleFloat32Array.length / 4;
		const width = Math.min( 4096, Math.ceil( Math.sqrt( vec4Count ) ) );
		const height = Math.ceil( vec4Count / width );

		const paddedSize = width * height * 4;
		let data = triangleFloat32Array;

		if ( triangleFloat32Array.length < paddedSize ) {

			data = new Float32Array( paddedSize );
			data.set( triangleFloat32Array );

		}

		this.triangleTexture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		this.triangleTexture.minFilter = NearestFilter;
		this.triangleTexture.magFilter = NearestFilter;
		this.triangleTexture.needsUpdate = true;

		this.triangleTexSize.set( width, height );
		this.triangleCount = Math.floor( vec4Count / TRI_VEC4_PER_TRIANGLE );

		console.log( `HitTestStage: Created triangle texture ${width}x${height}, ${this.triangleCount} triangles` );

	}

	/**
	 * Creates the visualization material and quad.
	 * Uses BVH traversal if BVH texture is available, otherwise falls back to linear search.
	 */
	setupMaterial() {

		if ( ! this.triangleTexture ) {

			console.error( 'HitTestStage: Cannot setup material without triangle data' );
			return;

		}

		// Camera uniforms for ray generation
		const cameraWorldMatrix = uniform( new Matrix4() );
		const cameraProjectionMatrixInverse = uniform( new Matrix4() );

		this.cameraWorldMatrix = cameraWorldMatrix;
		this.cameraProjectionMatrixInverse = cameraProjectionMatrixInverse;

		// Triangle texture access
		const triTex = texture( this.triangleTexture );
		const triTexSize = uniform( this.triangleTexSize );

		// BVH texture access (if available)
		const bvhTex = this.useBVH ? texture( this.bvhTexture ) : null;
		const bvhTexSize = this.useBVH ? uniform( this.bvhTexSize ) : null;

		// Capture values for shader
		const maxDistanceUniform = this.maxDistance;
		const visModeUniform = this.visMode;
		const useBVHTraversal = this.useBVH;

		// Helper to read vec4 from triangle texture by linear index
		const readTriVec4 = ( index ) => {

			const texWidth = triTexSize.x;
			const floatIndex = float( index );
			const x = floatIndex.mod( texWidth ).add( 0.5 ).div( texWidth );
			const y = floatIndex.div( texWidth ).floor().add( 0.5 ).div( triTexSize.y );
			return triTex.sample( vec4( x, y, 0, 0 ).xy );

		};

		// Helper to read vec4 from BVH texture by linear index
		const readBVHVec4 = useBVHTraversal ? ( index ) => {

			const texWidth = bvhTexSize.x;
			const floatIndex = float( index );
			const x = floatIndex.mod( texWidth ).add( 0.5 ).div( texWidth );
			const y = floatIndex.div( texWidth ).floor().add( 0.5 ).div( bvhTexSize.y );
			return bvhTex.sample( vec4( x, y, 0, 0 ).xy );

		} : null;

		// Moller-Trumbore ray-triangle intersection (returns t, u, v, hit)
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

		// Ray-AABB intersection (returns distance, 1e20 if miss)
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

		// Create hit test shader
		const hitTestShader = Fn( () => {

			// Generate camera ray
			const screenUV = uv();
			const ndc = screenUV.mul( 2.0 ).sub( 1.0 );

			// Negate Y to fix WebGPU coordinate system (Y=0 at top vs bottom in WebGL)
			const clipPos = vec4( ndc.x, ndc.y.negate(), float( - 1.0 ), float( 1.0 ) );
			const viewPos = cameraProjectionMatrixInverse.mul( clipPos );
			const viewDir = viewPos.xyz.div( viewPos.w );

			const worldDirRaw = cameraWorldMatrix.mul( vec4( viewDir, 0.0 ) ).xyz;
			const rayDir = worldDirRaw.normalize();

			const rayOrigin = vec3(
				cameraWorldMatrix.element( 3 ).x,
				cameraWorldMatrix.element( 3 ).y,
				cameraWorldMatrix.element( 3 ).z
			);

			// Inverse direction for AABB tests (with epsilon to avoid division by zero)
			const EPSILON = float( 1e-8 );
			const invDir = vec3(
				float( 1.0 ).div( rayDir.x.abs().greaterThan( EPSILON ).select( rayDir.x, EPSILON ) ),
				float( 1.0 ).div( rayDir.y.abs().greaterThan( EPSILON ).select( rayDir.y, EPSILON ) ),
				float( 1.0 ).div( rayDir.z.abs().greaterThan( EPSILON ).select( rayDir.z, EPSILON ) )
			);

			// Output variables
			const closestT = float( 1e20 ).toVar( 'closestT' );
			const hitNormal = vec3( 0, 1, 0 ).toVar( 'hitNormal' );
			const didHit = int( 0 ).toVar( 'didHit' );
			const hitMaterialIndex = int( - 1 ).toVar( 'hitMaterialIndex' );
			const triangleTests = int( 0 ).toVar( 'triangleTests' );
			const boxTests = int( 0 ).toVar( 'boxTests' );

			if ( useBVHTraversal ) {

				// Stack-based BVH traversal
				// Using a simple iterative approach with stack encoded in variables
				// TSL limitation: we use a fixed-iteration loop with manual stack management

				// Stack for node indices (using multiple vars for simplicity)
				// We'll use a single large loop with a stack pointer

				const stackPtr = int( 0 ).toVar( 'stackPtr' );

				// Use individual variables for stack entries
				// This is verbose but necessary due to TSL limitations
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

				// Helper to read from stack (inline selection)
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

				// Push root node (index 0)
				s0.assign( 0 );
				stackPtr.assign( 1 );

				// Traverse BVH (max iterations to prevent infinite loops)
				const maxIterations = int( 256 );

				Loop( maxIterations, () => {

					// Check if stack is empty
					If( stackPtr.lessThanEqual( 0 ), () => {

						Break();

					} );

					// Pop node from stack
					stackPtr.subAssign( 1 );
					const nodeIndex = readStack( stackPtr ).toVar( 'nodeIndex' );

					// Read BVH node data (3 vec4s per node)
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

					// Test AABB intersection
					boxTests.addAssign( 1 );
					const aabbDist = intersectAABB( rayOrigin, invDir, boundsMin, boundsMax );

					If( aabbDist.lessThan( closestT ), () => {

						// Check if leaf node (leftChild < 0)
						If( leftChild.lessThan( 0 ), () => {

							// Leaf node: test triangles
							Loop( triangleCountNode, ( { i: triIdx } ) => {

								const globalTriIdx = triangleOffset.add( triIdx );
								const triBaseIdx = globalTriIdx.mul( TRI_VEC4_PER_TRIANGLE );

								// Read triangle positions
								const posA = readTriVec4( triBaseIdx ).xyz;
								const posB = readTriVec4( triBaseIdx.add( 1 ) ).xyz;
								const posC = readTriVec4( triBaseIdx.add( 2 ) ).xyz;

								triangleTests.addAssign( 1 );

								const result = intersectTriangle( rayOrigin, rayDir, posA, posB, posC, closestT );

								If( result.hit, () => {

									closestT.assign( result.t );
									didHit.assign( 1 );

									// Read and interpolate normals
									const normA = readTriVec4( triBaseIdx.add( 3 ) ).xyz;
									const normB = readTriVec4( triBaseIdx.add( 4 ) ).xyz;
									const normC = readTriVec4( triBaseIdx.add( 5 ) ).xyz;

									const interpNormal = normA.mul( result.w )
										.add( normB.mul( result.u ) )
										.add( normC.mul( result.v ) );
									hitNormal.assign( interpNormal.normalize() );

									// Read material index
									const uvCMat = readTriVec4( triBaseIdx.add( 7 ) );
									hitMaterialIndex.assign( int( uvCMat.z ) );

								} );

							} );

						} ).Else( () => {

							// Interior node: push children onto stack
							// Push far child first, then near child (so near is processed first)
							// For simplicity, we just push both children

							If( stackPtr.lessThan( 16 ), () => {

								// Push right child
								If( stackPtr.equal( 0 ), () => {

									s0.assign( rightChild );

								} );
								If( stackPtr.equal( 1 ), () => {

									s1.assign( rightChild );

								} );
								If( stackPtr.equal( 2 ), () => {

									s2.assign( rightChild );

								} );
								If( stackPtr.equal( 3 ), () => {

									s3.assign( rightChild );

								} );
								If( stackPtr.equal( 4 ), () => {

									s4.assign( rightChild );

								} );
								If( stackPtr.equal( 5 ), () => {

									s5.assign( rightChild );

								} );
								If( stackPtr.equal( 6 ), () => {

									s6.assign( rightChild );

								} );
								If( stackPtr.equal( 7 ), () => {

									s7.assign( rightChild );

								} );
								If( stackPtr.equal( 8 ), () => {

									s8.assign( rightChild );

								} );
								If( stackPtr.equal( 9 ), () => {

									s9.assign( rightChild );

								} );
								If( stackPtr.equal( 10 ), () => {

									s10.assign( rightChild );

								} );
								If( stackPtr.equal( 11 ), () => {

									s11.assign( rightChild );

								} );
								If( stackPtr.equal( 12 ), () => {

									s12.assign( rightChild );

								} );
								If( stackPtr.equal( 13 ), () => {

									s13.assign( rightChild );

								} );
								If( stackPtr.equal( 14 ), () => {

									s14.assign( rightChild );

								} );
								If( stackPtr.equal( 15 ), () => {

									s15.assign( rightChild );

								} );
								stackPtr.addAssign( 1 );

							} );

							If( stackPtr.lessThan( 16 ), () => {

								// Push left child
								If( stackPtr.equal( 0 ), () => {

									s0.assign( leftChild );

								} );
								If( stackPtr.equal( 1 ), () => {

									s1.assign( leftChild );

								} );
								If( stackPtr.equal( 2 ), () => {

									s2.assign( leftChild );

								} );
								If( stackPtr.equal( 3 ), () => {

									s3.assign( leftChild );

								} );
								If( stackPtr.equal( 4 ), () => {

									s4.assign( leftChild );

								} );
								If( stackPtr.equal( 5 ), () => {

									s5.assign( leftChild );

								} );
								If( stackPtr.equal( 6 ), () => {

									s6.assign( leftChild );

								} );
								If( stackPtr.equal( 7 ), () => {

									s7.assign( leftChild );

								} );
								If( stackPtr.equal( 8 ), () => {

									s8.assign( leftChild );

								} );
								If( stackPtr.equal( 9 ), () => {

									s9.assign( leftChild );

								} );
								If( stackPtr.equal( 10 ), () => {

									s10.assign( leftChild );

								} );
								If( stackPtr.equal( 11 ), () => {

									s11.assign( leftChild );

								} );
								If( stackPtr.equal( 12 ), () => {

									s12.assign( leftChild );

								} );
								If( stackPtr.equal( 13 ), () => {

									s13.assign( leftChild );

								} );
								If( stackPtr.equal( 14 ), () => {

									s14.assign( leftChild );

								} );
								If( stackPtr.equal( 15 ), () => {

									s15.assign( leftChild );

								} );
								stackPtr.addAssign( 1 );

							} );

						} );

					} );

				} );

			} else {

				// Fallback: Linear search through triangles (no BVH)
				const maxTris = int( Math.min( this.triangleCount, 1000 ) );

				Loop( maxTris, ( { i } ) => {

					const baseIdx = i.mul( TRI_VEC4_PER_TRIANGLE );

					const posA = readTriVec4( baseIdx ).xyz;
					const posB = readTriVec4( baseIdx.add( 1 ) ).xyz;
					const posC = readTriVec4( baseIdx.add( 2 ) ).xyz;

					triangleTests.addAssign( 1 );

					const result = intersectTriangle( rayOrigin, rayDir, posA, posB, posC, closestT );

					If( result.hit, () => {

						closestT.assign( result.t );
						didHit.assign( 1 );

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

			// Visualization output
			const normalVis = hitNormal.mul( 0.5 ).add( 0.5 );
			const distanceVis = vec3( closestT.div( maxDistanceUniform ).clamp( 0, 1 ) );

			// BVH heatmap: visualize triangle tests (green = few, red = many)
			const heatmapVal = float( triangleTests ).div( 100.0 ).clamp( 0, 1 );
			const heatmapVis = vec3( heatmapVal, float( 1.0 ).sub( heatmapVal ), 0.0 );

			// Material ID visualization
			const matIdNorm = float( hitMaterialIndex ).div( 10.0 ).mod( 1.0 );
			const materialVis = vec3(
				matIdNorm.mul( 7.0 ).mod( 1.0 ),
				matIdNorm.mul( 13.0 ).mod( 1.0 ),
				matIdNorm.mul( 23.0 ).mod( 1.0 )
			);

			// Select visualization based on mode
			const color = visModeUniform.equal( 0 ).select( normalVis,
				visModeUniform.equal( 1 ).select( distanceVis,
					visModeUniform.equal( 2 ).select( materialVis, heatmapVis )
				)
			);

			return didHit.equal( 1 ).select(
				vec4( color, 1.0 ),
				vec4( 0.1, 0.1, 0.15, 1.0 )
			);

		} );

		// Create material
		this.material = new MeshBasicNodeMaterial();
		this.material.colorNode = hitTestShader();

		// Create fullscreen quad
		this.quad = new QuadMesh( this.material );

		this.isReady = true;

		console.log( `HitTestStage: Material setup complete (BVH: ${this.useBVH})` );

	}

	/**
	 * Renders the hit test visualization.
	 */
	render() {

		if ( ! this.isReady ) return;

		// Update camera uniforms
		this.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
		this.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

		this.quad.render( this.renderer );

	}

	/**
	 * Sets the visualization mode.
	 * @param {number} mode - VIS_MODE value
	 */
	setVisMode( mode ) {

		this.visMode.value = mode;

	}

	/**
	 * Sets the maximum distance for distance visualization.
	 * @param {number} distance - Maximum distance value
	 */
	setMaxDistance( distance ) {

		this.maxDistance.value = distance;

	}

	/**
	 * Disposes of GPU resources.
	 */
	dispose() {

		if ( this.material ) this.material.dispose();
		this.triangleTexture = null;
		this.bvhTexture = null;
		this.isReady = false;

	}

}
