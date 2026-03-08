// ReSTIR DI - Reservoir-based Spatiotemporal Importance Resampling for Direct Illumination
// TSL shader functions for candidate generation, temporal/spatial reuse, and final shading

import {
	Fn,
	vec2,
	vec3,
	vec4,
	float,
	int,
	uint,
	ivec2,
	uvec2,
	If,
	Loop,
	Break,
	dot,
	normalize,
	length,
	max,
	min,
	sqrt,
	abs,
	clamp,
	select,
	sin,
	cos,
	mat3,
	textureLoad,
	textureStore,
	localId,
	workgroupId,
} from 'three/tsl';

import { RandomValue, wang_hash } from './Random.js';
import {
	getDirectionalLight,
	getAreaLight,
	getPointLight,
	getSpotLight,
	DirectionalLight,
	AreaLight,
	PointLight,
	SpotLight,
	LIGHT_TYPE_DIRECTIONAL,
	LIGHT_TYPE_AREA,
	LIGHT_TYPE_POINT,
	LIGHT_TYPE_SPOT,
} from './LightsCore.js';
import { sampleTriangle } from './EmissiveSampling.js';
import { traverseBVHShadow } from './BVHTraversal.js';
import { traceShadowRay } from './LightsDirect.js';
import { getDatafromStorageBuffer } from './Common.js';

// ================================================================================
// CONSTANTS
// ================================================================================

const LIGHT_TYPE_EMISSIVE = 4;
const EMISSIVE_STRIDE = 2;
const TWO_PI = Math.PI * 2;
const WG_SIZE = 8;
const TEMPORAL_M_CLAMP = 20; // Clamp previous M to 20× current to prevent darkening
export const REC709_LUM = vec3( 0.2126, 0.7152, 0.0722 );

// ================================================================================
// HELPER FUNCTIONS
// ================================================================================

/**
 * Reconstruct world position from G-buffer depth and camera matrices.
 * Mat4 uniforms MUST be passed as Fn parameters for bracket-indexing support.
 */
export const reconstructWorldPos = Fn( ( [ gx, gy, linearDepth, resW, resH, cwm, cpi ] ) => {

	const ndcX = float( gx ).add( 0.5 ).div( resW ).mul( 2.0 ).sub( 1.0 );
	// Y-flip: compute shaders use pixel coords where y=0 at top
	const ndcY = float( gy ).add( 0.5 ).div( resH ).mul( 2.0 ).sub( 1.0 ).negate();

	const rayDirCS = cpi.mul( vec4( ndcX, ndcY, 1.0, 1.0 ) );
	const rayDirWorld = normalize(
		mat3(
			cwm[ 0 ].xyz,
			cwm[ 1 ].xyz,
			cwm[ 2 ].xyz
		).mul( rayDirCS.xyz.div( rayDirCS.w ) )
	);
	const camPos = vec3( cwm[ 3 ] );
	return camPos.add( rayDirWorld.mul( linearDepth ) );

} );

/**
 * Compute simplified target PDF: luminance(Le) × max(cosθ_surface, 0) / dist²
 */
const computeTargetPdf = Fn( ( [ worldPos, surfaceNormal, samplePos, emission ] ) => {

	const toLight = samplePos.sub( worldPos ).toVar();
	const distSq = max( dot( toLight, toLight ), float( 1e-8 ) );
	const dist = sqrt( distSq );
	const lightDir = toLight.div( dist );

	const cosTheta = max( dot( surfaceNormal, lightDir ), float( 0.0 ) );
	const Le = max( dot( emission, REC709_LUM ), float( 0.0 ) );

	return Le.mul( cosTheta ).div( distSq );

} );

/**
 * Initialize RNG state for a pixel, deterministic per frame + pass.
 */
export const initRNG = ( gx, gy, resW, frameCount, passOffset ) => {

	const pixelIdx = uint( gy ).mul( uint( resW ) ).add( uint( gx ) );
	const seed = pixelIdx.mul( uint( 3 ) ).add( uint( passOffset ) ).add( uint( frameCount ).mul( uint( 131071 ) ) );
	return wang_hash( { seed } ).toVar();

};

/**
 * Encode light type + index into a single float.
 * type ∈ {0,1,2,3,4}, index < 100000. Result fits in float32 exact integer range.
 */
const packLightId = ( lightType, lightIndex ) => {

	return float( lightType ).mul( 100000.0 ).add( float( lightIndex ) );

};

/**
 * Decode light type and index from packed float.
 */
const unpackLightType = ( packed ) => {

	return int( packed.div( 100000.0 ) );

};

const unpackLightIndex = ( packed ) => {

	return int( packed.sub( float( unpackLightType( packed ) ).mul( 100000.0 ) ) );

};

// ================================================================================
// EMISSIVE TRIANGLE CDF BINARY SEARCH (duplicated from EmissiveSampling.js since
// it's not exported — the original is module-private)
// ================================================================================

const binarySearchCDF = Fn( ( [ emissiveTriangleBuffer, emissiveTriangleCount, rand ] ) => {

	const lo = int( 0 ).toVar();
	const hi = emissiveTriangleCount.sub( 1 ).toVar();

	Loop( lo.lessThan( hi ), () => {

		const mid = lo.add( hi ).div( 2 ).toVar();
		const cdfVal = emissiveTriangleBuffer.element( mid.mul( EMISSIVE_STRIDE ) ).b;

		If( cdfVal.lessThan( rand ), () => {

			lo.assign( mid.add( 1 ) );

		} ).Else( () => {

			hi.assign( mid );

		} );

	} );

	return lo;

} );

// ================================================================================
// PASS 1: INITIAL RIS + TEMPORAL REUSE
// ================================================================================

/**
 * Build the compute Fn for Pass 1: candidate generation with WRS + temporal merge.
 * Returns a TSL Fn() that can be compiled via .compute().
 */
export function buildCandidateGenAndTemporalCompute( {
	normalDepthTexNode, motionTexNode,
	prevSampleTexNode, prevWeightTexNode,
	reservoirASampleTex, reservoirAWeightTex,
	emissiveTriBuffer, emissiveTriCount, emissivePower,
	triangleBuffer,
	dirLightsBuffer, numDirLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
	cameraWorldMatrix, cameraProjInverse,
	resW, resH, frameCount, numCandidates,
} ) {

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.greaterThanEqual( int( resW ) ).or( gy.greaterThanEqual( int( resH ) ) ), () => {

			return;

		} );

		// Read G-buffer
		const nd = textureLoad( normalDepthTexNode, ivec2( gx, gy ) ).toVar();
		const linearDepth = nd.w.toVar();

		// Background pixel — write zero reservoir
		If( linearDepth.greaterThanEqual( float( 1e9 ) ), () => {

			textureStore( reservoirASampleTex, uvec2( uint( gx ), uint( gy ) ), vec4( 0.0 ) ).toWriteOnly();
			textureStore( reservoirAWeightTex, uvec2( uint( gx ), uint( gy ) ), vec4( 0.0 ) ).toWriteOnly();
			return;

		} );

		// Decode surface normal
		const surfaceNormal = normalize( nd.xyz.mul( 2.0 ).sub( 1.0 ) ).toVar();

		// Reconstruct world position (pass mat4s as Fn params for bracket indexing)
		const worldPos = vec3( reconstructWorldPos(
			gx, gy, linearDepth, resW, resH, cameraWorldMatrix, cameraProjInverse
		) ).toVar();

		// Initialize RNG
		const rngState = initRNG( gx, gy, resW, frameCount, 0 );

		// ─── WEIGHTED RESERVOIR SAMPLING ───
		const wSum = float( 0.0 ).toVar();
		const M = float( 0.0 ).toVar();
		const bestSamplePos = vec3( 0.0 ).toVar();
		const bestPackedId = float( 0.0 ).toVar();
		const bestTargetPdf = float( 0.0 ).toVar();
		const bestEmission = vec3( 0.0 ).toVar();

		// Count total discrete lights
		const totalDiscreteLights = numDirLights.add( numAreaLights ).add( numPointLights ).add( numSpotLights ).toVar();

		// Compute relative power: emissive vs discrete
		// Use emissivePower for emissive triangles; estimate discrete power as count * 10 (rough heuristic)
		const discretePowerEstimate = float( totalDiscreteLights ).mul( 10.0 ).toVar();
		const totalPowerEstimate = max( emissivePower.add( discretePowerEstimate ), float( 1e-8 ) ).toVar();
		const emissiveProb = select(
			emissiveTriCount.greaterThan( int( 0 ) ),
			emissivePower.div( totalPowerEstimate ),
			float( 0.0 )
		).toVar();

		// Stream candidates through WRS
		Loop( { start: int( 0 ), end: numCandidates, type: 'int', condition: '<' }, () => {

			const candSamplePos = vec3( 0.0 ).toVar();
			const candEmission = vec3( 0.0 ).toVar();
			const candSourcePdf = float( 0.0 ).toVar();
			const candPackedId = float( 0.0 ).toVar();
			const candValid = int( 0 ).toVar();

			const randCategory = RandomValue( rngState ).toVar();

			// ─── EMISSIVE TRIANGLE CANDIDATE ───
			If( randCategory.lessThan( emissiveProb ).and( emissiveTriCount.greaterThan( int( 0 ) ) ), () => {

				const randCDF = RandomValue( rngState ).toVar();
				const emissiveIndex = int( binarySearchCDF( emissiveTriBuffer, emissiveTriCount, randCDF ) ).toVar();

				const baseIdx = emissiveIndex.mul( EMISSIVE_STRIDE );
				const emissiveData0 = emissiveTriBuffer.element( baseIdx ).toVar();
				const emissiveData1 = emissiveTriBuffer.element( baseIdx.add( 1 ) ).toVar();

				const triIndex = int( emissiveData0.r );
				const selectionPdf = emissiveData0.a; // Pre-stored in buffer
				const emission = emissiveData1.xyz;
				const triArea = emissiveData1.w;

				// Fetch triangle vertex positions (stride=8 vec4s per triangle)
				const pos0 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 0 ), int( 8 ) ).toVar();
				const pos1 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 1 ), int( 8 ) ).toVar();
				const pos2 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 2 ), int( 8 ) ).toVar();

				// Sample point on triangle (area sampling for simplicity in V1)
				const xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );
				const samplePt = vec3( sampleTriangle( pos0.xyz, pos1.xyz, pos2.xyz, xi ) ).toVar();

				// Source PDF = selectionPdf / area (area sampling measure)
				const srcPdf = selectionPdf.div( max( triArea, float( 1e-8 ) ) ).toVar();

				// Category selection PDF
				srcPdf.mulAssign( emissiveProb );

				candSamplePos.assign( samplePt );
				candEmission.assign( emission );
				candSourcePdf.assign( srcPdf );
				candPackedId.assign( packLightId( LIGHT_TYPE_EMISSIVE, emissiveIndex ) );
				candValid.assign( int( 1 ) );

			} ).ElseIf( totalDiscreteLights.greaterThan( int( 0 ) ), () => {

				// ─── DISCRETE LIGHT CANDIDATE ───
				// Uniform random selection among all discrete lights
				const discreteProb = float( 1.0 ).sub( emissiveProb ).toVar();
				const randLight = RandomValue( rngState ).mul( float( totalDiscreteLights ) ).toVar();
				const selectedIdx = int( randLight ).toVar();
				const uniformPdf = float( 1.0 ).div( max( float( totalDiscreteLights ), float( 1.0 ) ) ).toVar();

				// Selection PDF includes category probability
				uniformPdf.mulAssign( discreteProb );

				const currentBase = int( 0 ).toVar();

				// ─── Directional lights ───
				If( selectedIdx.greaterThanEqual( currentBase ).and( selectedIdx.lessThan( currentBase.add( numDirLights ) ) ), () => {

					const li = selectedIdx.sub( currentBase );
					const light = DirectionalLight.wrap( getDirectionalLight( dirLightsBuffer, li ) );
					const dir = normalize( light.direction );

					// Directional: sample position far away along light direction
					candSamplePos.assign( worldPos.add( dir.mul( 1e6 ) ) );
					candEmission.assign( light.color.mul( light.intensity ) );
					// PDF for directional is special (delta distribution), use uniform selection only
					candSourcePdf.assign( uniformPdf );
					candPackedId.assign( packLightId( LIGHT_TYPE_DIRECTIONAL, li ) );
					candValid.assign( int( 1 ) );

				} );

				currentBase.addAssign( numDirLights );

				// ─── Area lights ───
				If( selectedIdx.greaterThanEqual( currentBase ).and( selectedIdx.lessThan( currentBase.add( numAreaLights ) ) ), () => {

					const li = selectedIdx.sub( currentBase );
					const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, li ) );

					// Sample random point on area light
					const ruv = vec2( RandomValue( rngState ), RandomValue( rngState ) );
					const samplePt = light.position
						.add( light.u.mul( ruv.x.sub( 0.5 ) ) )
						.add( light.v.mul( ruv.y.sub( 0.5 ) ) )
						.toVar();

					candSamplePos.assign( samplePt );
					candEmission.assign( light.color.mul( light.intensity ) );
					// PDF = uniformSelection / area
					candSourcePdf.assign( uniformPdf.div( max( light.area, float( 1e-8 ) ) ) );
					candPackedId.assign( packLightId( LIGHT_TYPE_AREA, li ) );
					candValid.assign( select( light.area.greaterThan( 0.0 ), int( 1 ), int( 0 ) ) );

				} );

				currentBase.addAssign( numAreaLights );

				// ─── Point lights ───
				If( selectedIdx.greaterThanEqual( currentBase ).and( selectedIdx.lessThan( currentBase.add( numPointLights ) ) ), () => {

					const li = selectedIdx.sub( currentBase );
					const light = PointLight.wrap( getPointLight( pointLightsBuffer, li ) );

					candSamplePos.assign( light.position );
					candEmission.assign( light.color.mul( light.intensity ) );
					// Delta distribution — use uniform PDF
					candSourcePdf.assign( uniformPdf );
					candPackedId.assign( packLightId( LIGHT_TYPE_POINT, li ) );
					candValid.assign( int( 1 ) );

				} );

				currentBase.addAssign( numPointLights );

				// ─── Spot lights ───
				If( selectedIdx.greaterThanEqual( currentBase ).and( selectedIdx.lessThan( currentBase.add( numSpotLights ) ) ), () => {

					const li = selectedIdx.sub( currentBase );
					const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, li ) );

					candSamplePos.assign( light.position );
					candEmission.assign( light.color.mul( light.intensity ) );
					candSourcePdf.assign( uniformPdf );
					candPackedId.assign( packLightId( LIGHT_TYPE_SPOT, li ) );
					candValid.assign( int( 1 ) );

				} );

			} );

			// ─── WRS UPDATE ───
			If( candValid.greaterThan( int( 0 ) ).and( candSourcePdf.greaterThan( float( 0.0 ) ) ), () => {

				const targetPdf = float( computeTargetPdf( worldPos, surfaceNormal, candSamplePos, candEmission ) ).toVar();

				If( targetPdf.greaterThan( float( 0.0 ) ), () => {

					const weight = targetPdf.div( candSourcePdf );
					wSum.addAssign( weight );
					M.addAssign( 1.0 );

					// Accept with probability weight / wSum
					If( RandomValue( rngState ).mul( wSum ).lessThan( weight ), () => {

						bestSamplePos.assign( candSamplePos );
						bestPackedId.assign( candPackedId );
						bestTargetPdf.assign( targetPdf );
						bestEmission.assign( candEmission );

					} );

				} );

			} );

		} );

		// ─── TEMPORAL REUSE ───
		If( frameCount.greaterThan( int( 0 ) ), () => {

			const motion = textureLoad( motionTexNode, ivec2( gx, gy ) ).toVar();

			// Valid motion vector
			If( motion.w.greaterThan( 0.5 ), () => {

				const prevX = int( float( gx ).sub( motion.x.mul( float( resW ) ) ) );
				const prevY = int( float( gy ).sub( motion.y.mul( float( resH ) ) ) );

				// Bounds check
				If( prevX.greaterThanEqual( int( 0 ) ).and( prevX.lessThan( int( resW ) ) )
					.and( prevY.greaterThanEqual( int( 0 ) ) ).and( prevY.lessThan( int( resH ) ) ), () => {

					const prevSample = textureLoad( prevSampleTexNode, ivec2( prevX, prevY ) ).toVar();
					const prevWeight = textureLoad( prevWeightTexNode, ivec2( prevX, prevY ) ).toVar();

					const prevM = prevWeight.y.toVar();

					If( prevM.greaterThan( float( 0.0 ) ), () => {

						// Clamp M to prevent unbounded accumulation
						const clampedM = min( prevM, M.mul( float( TEMPORAL_M_CLAMP ) ) ).toVar();

						// Re-evaluate target PDF at current pixel for the temporal sample
						const prevSamplePos = prevSample.xyz;
						const temporalTargetPdf = float( computeTargetPdf(
							worldPos, surfaceNormal, prevSamplePos, bestEmission
						) ).toVar();

						// For temporal, we approximate emission of prev sample with current best
						// This is biased but acceptable for V1
						If( temporalTargetPdf.greaterThan( float( 0.0 ) ), () => {

							const temporalWeight = clampedM.mul( temporalTargetPdf );
							wSum.addAssign( temporalWeight );
							M.addAssign( clampedM );

							If( RandomValue( rngState ).mul( wSum ).lessThan( temporalWeight ), () => {

								bestSamplePos.assign( prevSamplePos );
								bestPackedId.assign( prevSample.w );
								bestTargetPdf.assign( temporalTargetPdf );

							} );

						} );

					} );

				} );

			} );

		} );

		// Compute output weight W
		const W = select(
			bestTargetPdf.greaterThan( float( 0.0 ) ).and( M.greaterThan( float( 0.0 ) ) ),
			wSum.div( M.mul( bestTargetPdf ) ),
			float( 0.0 )
		).toVar();

		// Write reservoir to A
		textureStore(
			reservoirASampleTex,
			uvec2( uint( gx ), uint( gy ) ),
			vec4( bestSamplePos, bestPackedId )
		).toWriteOnly();

		textureStore(
			reservoirAWeightTex,
			uvec2( uint( gx ), uint( gy ) ),
			vec4( wSum, M, W, bestTargetPdf )
		).toWriteOnly();

	} );

	return computeFn;

}

// ================================================================================
// PASS 2: SPATIAL REUSE
// ================================================================================

/**
 * Build the compute Fn for Pass 2: spatial resampling from neighbors.
 */
export function buildSpatialReuseCompute( {
	normalDepthTexNode,
	readSampleTexNode, readWeightTexNode,
	reservoirBSampleTex, reservoirBWeightTex,
	cameraWorldMatrix, cameraProjInverse,
	resW, resH, frameCount, spatialRadius, spatialNeighbors,
	normalThreshold, depthThreshold,
} ) {

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.greaterThanEqual( int( resW ) ).or( gy.greaterThanEqual( int( resH ) ) ), () => {

			return;

		} );

		// Read G-buffer
		const nd = textureLoad( normalDepthTexNode, ivec2( gx, gy ) ).toVar();
		const linearDepth = nd.w.toVar();

		// Background — pass through zero
		If( linearDepth.greaterThanEqual( float( 1e9 ) ), () => {

			textureStore( reservoirBSampleTex, uvec2( uint( gx ), uint( gy ) ), vec4( 0.0 ) ).toWriteOnly();
			textureStore( reservoirBWeightTex, uvec2( uint( gx ), uint( gy ) ), vec4( 0.0 ) ).toWriteOnly();
			return;

		} );

		const surfaceNormal = normalize( nd.xyz.mul( 2.0 ).sub( 1.0 ) ).toVar();
		const worldPos = vec3( reconstructWorldPos(
			gx, gy, linearDepth, resW, resH, cameraWorldMatrix, cameraProjInverse
		) ).toVar();

		// Read current pixel's reservoir from A
		const currentSample = textureLoad( readSampleTexNode, ivec2( gx, gy ) ).toVar();
		const currentWeight = textureLoad( readWeightTexNode, ivec2( gx, gy ) ).toVar();

		// Initialize with current reservoir
		const wSum = currentWeight.x.toVar();
		const M = currentWeight.y.toVar();
		const bestSample = currentSample.toVar();
		const bestTargetPdf = currentWeight.w.toVar();

		const rngState = initRNG( gx, gy, resW, frameCount, 1000 );

		// Sample spatial neighbors
		Loop( { start: int( 0 ), end: spatialNeighbors, type: 'int', condition: '<' }, () => {

			// Random offset within disk
			const angle = RandomValue( rngState ).mul( float( TWO_PI ) );
			const r = sqrt( RandomValue( rngState ) ).mul( spatialRadius );
			const nx = gx.add( int( cos( angle ).mul( r ) ) );
			const ny = gy.add( int( sin( angle ).mul( r ) ) );

			// Bounds check
			If( nx.greaterThanEqual( int( 0 ) ).and( nx.lessThan( int( resW ) ) )
				.and( ny.greaterThanEqual( int( 0 ) ) ).and( ny.lessThan( int( resH ) ) ), () => {

				// Geometric similarity check
				const neighborND = textureLoad( normalDepthTexNode, ivec2( nx, ny ) ).toVar();
				const neighborNormal = normalize( neighborND.xyz.mul( 2.0 ).sub( 1.0 ) );
				const neighborDepth = neighborND.w;

				const normalSimilarity = dot( surfaceNormal, neighborNormal );
				const depthDiff = abs( linearDepth.sub( neighborDepth ) ).div( max( linearDepth, float( 0.001 ) ) );

				If( normalSimilarity.greaterThan( normalThreshold )
					.and( depthDiff.lessThan( depthThreshold ) )
					.and( neighborDepth.lessThan( float( 1e9 ) ) ), () => {

					// Read neighbor's reservoir from A
					const neighborSample = textureLoad( readSampleTexNode, ivec2( nx, ny ) ).toVar();
					const neighborWeight = textureLoad( readWeightTexNode, ivec2( nx, ny ) ).toVar();
					const neighborM = neighborWeight.y;

					If( neighborM.greaterThan( float( 0.0 ) ), () => {

						// Re-evaluate target PDF at current pixel for neighbor's sample
						// Use a dummy emission estimate (the actual emission cancels in the W computation)
						// For biased resampling, we use the geometric target PDF
						const neighborSamplePos = neighborSample.xyz;
						const toLight = neighborSamplePos.sub( worldPos );
						const distSq = max( dot( toLight, toLight ), float( 1e-8 ) );
						const cosTheta = max( dot( surfaceNormal, normalize( toLight ) ), float( 0.0 ) );
						// Approximate target PDF using geometric term only (Le unknown from neighbor)
						// Use neighbor's stored targetPdf as proxy (biased but effective)
						const neighborTargetPdf = neighborWeight.w;

						If( neighborTargetPdf.greaterThan( float( 0.0 ) ).and( cosTheta.greaterThan( float( 0.0 ) ) ), () => {

							const spatialWeight = neighborM.mul( neighborTargetPdf );
							wSum.addAssign( spatialWeight );
							M.addAssign( neighborM );

							If( RandomValue( rngState ).mul( wSum ).lessThan( spatialWeight ), () => {

								bestSample.assign( neighborSample );
								bestTargetPdf.assign( neighborTargetPdf );

							} );

						} );

					} );

				} );

			} );

		} );

		// Compute final W
		const W = select(
			bestTargetPdf.greaterThan( float( 0.0 ) ).and( M.greaterThan( float( 0.0 ) ) ),
			wSum.div( M.mul( bestTargetPdf ) ),
			float( 0.0 )
		).toVar();

		// Write to ReservoirB
		textureStore(
			reservoirBSampleTex,
			uvec2( uint( gx ), uint( gy ) ),
			bestSample
		).toWriteOnly();

		textureStore(
			reservoirBWeightTex,
			uvec2( uint( gx ), uint( gy ) ),
			vec4( wSum, M, W, bestTargetPdf )
		).toWriteOnly();

	} );

	return computeFn;

}

// ================================================================================
// PASS 3: FINAL SHADING
// ================================================================================

/**
 * Build the compute Fn for Pass 3: evaluate final contribution using reservoir sample.
 */
export function buildFinalShadingCompute( {
	normalDepthTexNode, albedoTexNode,
	finalSampleTexNode, finalWeightTexNode,
	outputTex,
	bvhBuffer, triangleBuffer, materialBuffer,
	emissiveTriBuffer,
	dirLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
	cameraWorldMatrix, cameraProjInverse,
	resW, resH, frameCount,
} ) {

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.greaterThanEqual( int( resW ) ).or( gy.greaterThanEqual( int( resH ) ) ), () => {

			return;

		} );

		// Read G-buffer
		const nd = textureLoad( normalDepthTexNode, ivec2( gx, gy ) ).toVar();
		const linearDepth = nd.w;

		// Background
		If( linearDepth.greaterThanEqual( float( 1e9 ) ), () => {

			textureStore( outputTex, uvec2( uint( gx ), uint( gy ) ), vec4( 0.0, 0.0, 0.0, 1.0 ) ).toWriteOnly();
			return;

		} );

		const surfaceNormal = normalize( nd.xyz.mul( 2.0 ).sub( 1.0 ) ).toVar();
		const worldPos = vec3( reconstructWorldPos(
			gx, gy, linearDepth, resW, resH, cameraWorldMatrix, cameraProjInverse
		) ).toVar();

		const albedo = textureLoad( albedoTexNode, ivec2( gx, gy ) ).xyz.toVar();

		// Read reservoir
		const resSample = textureLoad( finalSampleTexNode, ivec2( gx, gy ) ).toVar();
		const resWeight = textureLoad( finalWeightTexNode, ivec2( gx, gy ) ).toVar();

		const W = resWeight.z;

		If( W.lessThanEqual( float( 0.0 ) ), () => {

			textureStore( outputTex, uvec2( uint( gx ), uint( gy ) ), vec4( 0.0, 0.0, 0.0, 1.0 ) ).toWriteOnly();
			return;

		} );

		const samplePos = resSample.xyz;
		const packedId = resSample.w;

		// Compute light direction and distance
		const toLight = samplePos.sub( worldPos ).toVar();
		const distSq = max( dot( toLight, toLight ), float( 1e-8 ) );
		const dist = sqrt( distSq );
		const lightDir = toLight.div( dist ).toVar();

		const NdotL = max( dot( surfaceNormal, lightDir ), float( 0.0 ) ).toVar();

		// ─── Re-evaluate emission from packed light ID ───
		const Le = vec3( 0.0 ).toVar();
		const lightType = unpackLightType( packedId );
		const lightIndex = unpackLightIndex( packedId );

		If( lightType.equal( int( LIGHT_TYPE_EMISSIVE ) ), () => {

			// Read emission from emissive buffer
			const baseIdx = lightIndex.mul( EMISSIVE_STRIDE );
			const emData1 = emissiveTriBuffer.element( baseIdx.add( 1 ) );
			Le.assign( emData1.xyz );

		} ).ElseIf( lightType.equal( int( LIGHT_TYPE_DIRECTIONAL ) ), () => {

			const light = DirectionalLight.wrap( getDirectionalLight( dirLightsBuffer, lightIndex ) );
			Le.assign( light.color.mul( light.intensity ) );

		} ).ElseIf( lightType.equal( int( LIGHT_TYPE_AREA ) ), () => {

			const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, lightIndex ) );
			Le.assign( light.color.mul( light.intensity ) );

		} ).ElseIf( lightType.equal( int( LIGHT_TYPE_POINT ) ), () => {

			const light = PointLight.wrap( getPointLight( pointLightsBuffer, lightIndex ) );
			// Point light: apply inverse square attenuation
			Le.assign( light.color.mul( light.intensity ).div( max( distSq, float( 1.0 ) ) ) );

		} ).ElseIf( lightType.equal( int( LIGHT_TYPE_SPOT ) ), () => {

			const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, lightIndex ) );
			Le.assign( light.color.mul( light.intensity ).div( max( distSq, float( 1.0 ) ) ) );

		} );

		// ─── Shadow ray ───
		const rngState = initRNG( gx, gy, resW, frameCount, 2000 );

		// Simple normal-based offset for shadow ray origin
		const shadowOrigin = worldPos.add( surfaceNormal.mul( max( float( 1e-4 ), length( worldPos ).mul( 1e-6 ) ) ) ).toVar();
		const shadowDist = dist.sub( float( 0.002 ) );

		const visibility = float( traceShadowRay(
			shadowOrigin, lightDir, shadowDist, rngState,
			traverseBVHShadow,
			bvhBuffer, triangleBuffer, materialBuffer,
		) ).toVar();

		// ─── Lambertian BRDF: albedo / π ───
		const brdf = albedo.div( float( Math.PI ) );

		// Final estimator: Lo = Le × BRDF × cos(θ) × W × visibility
		const Lo = Le.mul( brdf ).mul( NdotL ).mul( W ).mul( visibility ).toVar();

		// Clamp to prevent fireflies
		const maxComponent = max( Lo.x, max( Lo.y, Lo.z ) );
		If( maxComponent.greaterThan( float( 100.0 ) ), () => {

			Lo.mulAssign( float( 100.0 ).div( maxComponent ) );

		} );

		textureStore(
			outputTex,
			uvec2( uint( gx ), uint( gy ) ),
			vec4( Lo, 1.0 )
		).toWriteOnly();

	} );

	return computeFn;

}
