// ReSTIR GI - Reservoir-based Spatiotemporal Importance Resampling for Global Illumination
// Compute-based pipeline stage running 3 passes:
//   Pass 1: Initial BRDF ray trace + secondary shading + temporal reuse → ReservoirA
//   Pass 2: Spatial reuse → ReservoirB
//   Pass 3: Final shading (visibility ray + Lambertian at primary) → output color

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
	dot,
	normalize,
	length,
	max,
	min,
	sqrt,
	abs,
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
import { reconstructWorldPos, initRNG, REC709_LUM } from './ReSTIRDI.js';
import { traverseBVH, traverseBVHShadow } from './BVHTraversal.js';
import { traceShadowRay } from './LightsDirect.js';
import { getDatafromStorageBuffer, MATERIAL_SLOTS } from './Common.js';
import { ImportanceSampleCosine } from './MaterialSampling.js';
import { Ray, HitInfo } from './Struct.js';
import {
	getDirectionalLight,
	getAreaLight,
	getPointLight,
	getSpotLight,
	DirectionalLight,
	AreaLight,
	PointLight,
	SpotLight,
} from './LightsCore.js';
import { sampleTriangle } from './EmissiveSampling.js';

// ================================================================================
// CONSTANTS
// ================================================================================

const TWO_PI = Math.PI * 2;
const PI_INV = 1.0 / Math.PI;
const WG_SIZE = 8;
const TEMPORAL_M_CLAMP = 20;
const EMISSIVE_STRIDE = 2;

// ================================================================================
// HELPER: Binary search CDF (duplicated from EmissiveSampling.js — not exported)
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
// PASS 1: INITIAL SAMPLE + TEMPORAL REUSE
// ================================================================================

export function buildGIInitialAndTemporalCompute( {
	normalDepthTexNode, motionTexNode,
	prevSampleTexNode, prevRadianceTexNode, prevWeightTexNode,
	reservoirASampleTex, reservoirARadianceTex, reservoirAWeightTex,
	bvhBuffer, triangleBuffer, materialBuffer,
	emissiveTriBuffer, emissiveTriCount, emissivePower,
	dirLightsBuffer, numDirLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
	cameraWorldMatrix, cameraProjInverse,
	resW, resH, frameCount,
} ) {

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.greaterThanEqual( int( resW ) ).or( gy.greaterThanEqual( int( resH ) ) ), () => {

			return;

		} );

		const coord = uvec2( uint( gx ), uint( gy ) );

		// Read G-buffer
		const nd = textureLoad( normalDepthTexNode, ivec2( gx, gy ) ).toVar();
		const linearDepth = nd.w.toVar();

		// Background — write zero reservoir
		If( linearDepth.greaterThanEqual( float( 1e9 ) ), () => {

			textureStore( reservoirASampleTex, coord, vec4( 0.0 ) ).toWriteOnly();
			textureStore( reservoirARadianceTex, coord, vec4( 0.0 ) ).toWriteOnly();
			textureStore( reservoirAWeightTex, coord, vec4( 0.0 ) ).toWriteOnly();
			return;

		} );

		const surfaceNormal = normalize( nd.xyz.mul( 2.0 ).sub( 1.0 ) ).toVar();
		const worldPos = vec3( reconstructWorldPos(
			gx, gy, linearDepth, resW, resH, cameraWorldMatrix, cameraProjInverse
		) ).toVar();

		const rngState = initRNG( gx, gy, resW, frameCount, 5000 );

		// ─── GENERATE BRDF-SAMPLED DIRECTION ───
		// Cosine-weighted hemisphere (Lambertian approximation for V1)
		const xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );
		const bounceDir = vec3( ImportanceSampleCosine( { N: surfaceNormal, xi } ) ).toVar();

		// Cosine PDF = NdotL / π — used to importance-correct the initial reservoir weight
		const NdotL_primary = max( dot( surfaceNormal, bounceDir ), float( 0.001 ) ).toVar();
		const cosinePdf = NdotL_primary.mul( float( PI_INV ) ).toVar();

		// ─── TRACE INDIRECT RAY ───
		const rayOffset = surfaceNormal.mul( max( float( 1e-4 ), length( worldPos ).mul( 1e-6 ) ) );
		const indirectRay = Ray( { origin: worldPos.add( rayOffset ), direction: bounceDir } );
		const hitInfo = HitInfo.wrap( traverseBVH( indirectRay, bvhBuffer, triangleBuffer, materialBuffer ) );

		// Reservoir state
		const secondaryPos = vec3( 0.0 ).toVar();
		const secondaryRadiance = vec3( 0.0 ).toVar();
		const wSum = float( 0.0 ).toVar();
		const M = float( 0.0 ).toVar();
		const targetPdf = float( 0.0 ).toVar();

		// ─── SHADE SECONDARY SURFACE ───
		If( hitInfo.didHit, () => {

			secondaryPos.assign( hitInfo.hitPoint );
			const secNormal = hitInfo.normal.toVar();
			const matIdx = hitInfo.materialIndex;

			// Read material: data0 = color, data1 = emissive/roughness, data2 = ior/transmission/emissiveIntensity
			const data0 = getDatafromStorageBuffer( materialBuffer, matIdx, int( 0 ), int( MATERIAL_SLOTS ) ).toVar();
			const data1 = getDatafromStorageBuffer( materialBuffer, matIdx, int( 1 ), int( MATERIAL_SLOTS ) ).toVar();
			const data2 = getDatafromStorageBuffer( materialBuffer, matIdx, int( 2 ), int( MATERIAL_SLOTS ) ).toVar();

			const secAlbedo = data0.rgb;
			const secEmissive = data1.rgb.mul( data2.a ); // emissive × emissiveIntensity
			const radiance = secEmissive.toVar();

			// ─── ONE NEE SAMPLE AT SECONDARY SURFACE ───
			// Pick one light source and evaluate direct contribution
			const totalDiscreteLights = numDirLights.add( numAreaLights ).add( numPointLights ).add( numSpotLights ).toVar();
			const hasEmissive = emissiveTriCount.greaterThan( int( 0 ) );
			const hasDiscrete = totalDiscreteLights.greaterThan( int( 0 ) );
			const discretePowerEst = float( totalDiscreteLights ).mul( 10.0 ).toVar();
			const totalPowerEst = max( emissivePower.add( discretePowerEst ), float( 1e-8 ) ).toVar();
			const emissiveProb = select( hasEmissive, emissivePower.div( totalPowerEst ), float( 0.0 ) ).toVar();

			const lightSamplePos = vec3( 0.0 ).toVar();
			const lightEmission = vec3( 0.0 ).toVar();
			const lightValid = int( 0 ).toVar();
			const randCat = RandomValue( rngState ).toVar();

			// Sample from emissive triangles or discrete lights
			If( randCat.lessThan( emissiveProb ).and( hasEmissive ), () => {

				const randCDF = RandomValue( rngState ).toVar();
				const emIdx = int( binarySearchCDF( emissiveTriBuffer, emissiveTriCount, randCDF ) ).toVar();
				const baseIdx = emIdx.mul( EMISSIVE_STRIDE );
				const emData0 = emissiveTriBuffer.element( baseIdx ).toVar();
				const emData1 = emissiveTriBuffer.element( baseIdx.add( 1 ) ).toVar();

				const triIndex = int( emData0.r );
				const emission = emData1.xyz;

				// Sample point on emissive triangle
				const p0 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 0 ), int( 8 ) ).xyz;
				const p1 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 1 ), int( 8 ) ).xyz;
				const p2 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 2 ), int( 8 ) ).xyz;
				const xiLight = vec2( RandomValue( rngState ), RandomValue( rngState ) );
				lightSamplePos.assign( sampleTriangle( p0, p1, p2, xiLight ) );
				lightEmission.assign( emission );
				lightValid.assign( int( 1 ) );

			} ).ElseIf( hasDiscrete, () => {

				// Uniform random selection among discrete lights
				// Pre-compute range boundaries for ElseIf chain (avoids separate If blocks — TSL pitfall)
				const randLight = RandomValue( rngState ).mul( float( totalDiscreteLights ) );
				const selectedIdx = int( randLight ).toVar();
				const dirEnd = numDirLights.toVar();
				const areaEnd = dirEnd.add( numAreaLights ).toVar();
				const pointEnd = areaEnd.add( numPointLights ).toVar();

				If( selectedIdx.lessThan( dirEnd ), () => {

					const li = selectedIdx;
					const light = DirectionalLight.wrap( getDirectionalLight( dirLightsBuffer, li ) );
					lightSamplePos.assign( secondaryPos.add( normalize( light.direction ).mul( 1e6 ) ) );
					lightEmission.assign( light.color.mul( light.intensity ) );
					lightValid.assign( int( 1 ) );

				} ).ElseIf( selectedIdx.lessThan( areaEnd ), () => {

					const li = selectedIdx.sub( dirEnd );
					const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, li ) );
					const ruv = vec2( RandomValue( rngState ), RandomValue( rngState ) );
					lightSamplePos.assign( light.position.add( light.u.mul( ruv.x.sub( 0.5 ) ) ).add( light.v.mul( ruv.y.sub( 0.5 ) ) ) );
					lightEmission.assign( light.color.mul( light.intensity ) );
					lightValid.assign( int( 1 ) );

				} ).ElseIf( selectedIdx.lessThan( pointEnd ), () => {

					const li = selectedIdx.sub( areaEnd );
					const light = PointLight.wrap( getPointLight( pointLightsBuffer, li ) );
					lightSamplePos.assign( light.position );
					lightEmission.assign( light.color.mul( light.intensity ) );
					lightValid.assign( int( 1 ) );

				} ).Else( () => {

					const li = selectedIdx.sub( pointEnd );
					const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, li ) );
					lightSamplePos.assign( light.position );
					lightEmission.assign( light.color.mul( light.intensity ) );
					lightValid.assign( int( 1 ) );

				} );

			} );

			// Evaluate NEE at secondary surface
			If( lightValid.greaterThan( int( 0 ) ), () => {

				const toLightSec = lightSamplePos.sub( secondaryPos ).toVar();
				const distSqSec = max( dot( toLightSec, toLightSec ), float( 1e-8 ) );
				const distSec = sqrt( distSqSec );
				const lightDirSec = toLightSec.div( distSec );
				const NdotL_sec = max( dot( secNormal, lightDirSec ), float( 0.0 ) ).toVar();

				If( NdotL_sec.greaterThan( float( 0.0 ) ), () => {

					const secOffset = secNormal.mul( max( float( 1e-4 ), length( secondaryPos ).mul( 1e-6 ) ) );
					const shadowRngState = initRNG( gx, gy, resW, frameCount, 6000 );

					const vis = float( traceShadowRay(
						secondaryPos.add( secOffset ), lightDirSec, distSec.sub( 0.002 ), shadowRngState,
						traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
					) ).toVar();

					// Lambertian at secondary: (albedo / π) × Le × NdotL × vis × numLights (uniform PDF correction)
					const totalLights = float( totalDiscreteLights ).add( float( emissiveTriCount ) ).toVar();
					const neeContrib = secAlbedo.mul( float( PI_INV ) )
						.mul( lightEmission )
						.mul( NdotL_sec )
						.mul( vis )
						.mul( max( totalLights, float( 1.0 ) ) );

					radiance.addAssign( neeContrib );

				} );

			} );

			// Store final secondary radiance
			secondaryRadiance.assign( radiance );

			// Target PDF = luminance(incoming radiance)
			targetPdf.assign( max( dot( secondaryRadiance, REC709_LUM ), float( 0.0 ) ) );

			// Initial reservoir: M=1, wSum = targetPdf / cosinePdf (importance weight)
			If( targetPdf.greaterThan( float( 0.0 ) ), () => {

				wSum.assign( targetPdf.div( max( cosinePdf, float( 1e-6 ) ) ) );
				M.assign( 1.0 );

			} );

		} );

		// ─── TEMPORAL REUSE ───
		If( frameCount.greaterThan( int( 0 ) ), () => {

			const motion = textureLoad( motionTexNode, ivec2( gx, gy ) ).toVar();
			const hasMotion = motion.w.greaterThan( 0.5 );

			// Use motion vectors if available, otherwise identity reprojection (static scene)
			const prevX = int( select( hasMotion,
				float( gx ).sub( motion.x.mul( float( resW ) ) ),
				float( gx )
			) ).toVar();
			const prevY = int( select( hasMotion,
				float( gy ).sub( motion.y.mul( float( resH ) ) ),
				float( gy )
			) ).toVar();

			If( prevX.greaterThanEqual( int( 0 ) ).and( prevX.lessThan( int( resW ) ) )
				.and( prevY.greaterThanEqual( int( 0 ) ) ).and( prevY.lessThan( int( resH ) ) ), () => {

				const prevSample = textureLoad( prevSampleTexNode, ivec2( prevX, prevY ) ).toVar();
				const prevRad = textureLoad( prevRadianceTexNode, ivec2( prevX, prevY ) ).toVar();
				const prevWeight = textureLoad( prevWeightTexNode, ivec2( prevX, prevY ) ).toVar();
				const prevM = prevWeight.y.toVar();

				If( prevM.greaterThan( float( 0.0 ) ), () => {

					// Use max(M, 1.0) for clamp reference so temporal survives when current sample is invalid (M=0)
					const clampedM = min( prevM, max( M, float( 1.0 ) ).mul( float( TEMPORAL_M_CLAMP ) ) ).toVar();
					const prevTargetPdf = max( dot( prevRad.xyz, REC709_LUM ), float( 0.0 ) ).toVar();

					If( prevTargetPdf.greaterThan( float( 0.0 ) ), () => {

						const temporalWeight = clampedM.mul( prevTargetPdf );
						wSum.addAssign( temporalWeight );
						M.addAssign( clampedM );

						If( RandomValue( rngState ).mul( wSum ).lessThan( temporalWeight ), () => {

							secondaryPos.assign( prevSample.xyz );
							secondaryRadiance.assign( prevRad.xyz );
							targetPdf.assign( prevTargetPdf );

						} );

					} );

				} );

			} );

		} );

		// Compute output weight W
		const W = select(
			targetPdf.greaterThan( float( 0.0 ) ).and( M.greaterThan( float( 0.0 ) ) ),
			wSum.div( M.mul( targetPdf ) ),
			float( 0.0 )
		).toVar();

		// Write reservoir to A
		textureStore( reservoirASampleTex, coord, vec4( secondaryPos, 0.0 ) ).toWriteOnly();
		textureStore( reservoirARadianceTex, coord, vec4( secondaryRadiance, 0.0 ) ).toWriteOnly();
		textureStore( reservoirAWeightTex, coord, vec4( wSum, M, W, targetPdf ) ).toWriteOnly();

	} );

	return computeFn;

}

// ================================================================================
// PASS 2: SPATIAL REUSE
// ================================================================================

export function buildGISpatialReuseCompute( {
	normalDepthTexNode,
	readSampleTexNode, readRadianceTexNode, readWeightTexNode,
	reservoirBSampleTex, reservoirBRadianceTex, reservoirBWeightTex,
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

		const coord = uvec2( uint( gx ), uint( gy ) );

		const nd = textureLoad( normalDepthTexNode, ivec2( gx, gy ) ).toVar();
		const linearDepth = nd.w.toVar();

		// Background — pass through zero
		If( linearDepth.greaterThanEqual( float( 1e9 ) ), () => {

			textureStore( reservoirBSampleTex, coord, vec4( 0.0 ) ).toWriteOnly();
			textureStore( reservoirBRadianceTex, coord, vec4( 0.0 ) ).toWriteOnly();
			textureStore( reservoirBWeightTex, coord, vec4( 0.0 ) ).toWriteOnly();
			return;

		} );

		const surfaceNormal = normalize( nd.xyz.mul( 2.0 ).sub( 1.0 ) ).toVar();

		// Read current pixel's reservoir from A
		const currentSample = textureLoad( readSampleTexNode, ivec2( gx, gy ) ).toVar();
		const currentRadiance = textureLoad( readRadianceTexNode, ivec2( gx, gy ) ).toVar();
		const currentWeight = textureLoad( readWeightTexNode, ivec2( gx, gy ) ).toVar();

		const wSum = currentWeight.x.toVar();
		const M = currentWeight.y.toVar();
		const bestSample = currentSample.toVar();
		const bestRadiance = currentRadiance.toVar();
		const bestTargetPdf = currentWeight.w.toVar();

		const rngState = initRNG( gx, gy, resW, frameCount, 7000 );

		// Sample spatial neighbors
		Loop( { start: int( 0 ), end: spatialNeighbors, type: 'int', condition: '<' }, () => {

			const angle = RandomValue( rngState ).mul( float( TWO_PI ) );
			const r = sqrt( RandomValue( rngState ) ).mul( spatialRadius );
			const nx = gx.add( int( cos( angle ).mul( r ) ) );
			const ny = gy.add( int( sin( angle ).mul( r ) ) );

			If( nx.greaterThanEqual( int( 0 ) ).and( nx.lessThan( int( resW ) ) )
				.and( ny.greaterThanEqual( int( 0 ) ) ).and( ny.lessThan( int( resH ) ) ), () => {

				const neighborND = textureLoad( normalDepthTexNode, ivec2( nx, ny ) ).toVar();
				const neighborNormal = normalize( neighborND.xyz.mul( 2.0 ).sub( 1.0 ) );
				const neighborDepth = neighborND.w;

				const normalSimilarity = dot( surfaceNormal, neighborNormal );
				const depthDiff = abs( linearDepth.sub( neighborDepth ) ).div( max( linearDepth, float( 0.001 ) ) );

				If( normalSimilarity.greaterThan( normalThreshold )
					.and( depthDiff.lessThan( depthThreshold ) )
					.and( neighborDepth.lessThan( float( 1e9 ) ) ), () => {

					const neighborSample = textureLoad( readSampleTexNode, ivec2( nx, ny ) ).toVar();
					const neighborRadiance = textureLoad( readRadianceTexNode, ivec2( nx, ny ) ).toVar();
					const neighborWeight = textureLoad( readWeightTexNode, ivec2( nx, ny ) ).toVar();
					const neighborM = neighborWeight.y;

					If( neighborM.greaterThan( float( 0.0 ) ), () => {

						// Biased: use neighbor's stored targetPdf
						const neighborTargetPdf = neighborWeight.w;

						If( neighborTargetPdf.greaterThan( float( 0.0 ) ), () => {

							const spatialWeight = neighborM.mul( neighborTargetPdf );
							wSum.addAssign( spatialWeight );
							M.addAssign( neighborM );

							If( RandomValue( rngState ).mul( wSum ).lessThan( spatialWeight ), () => {

								bestSample.assign( neighborSample );
								bestRadiance.assign( neighborRadiance );
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

		textureStore( reservoirBSampleTex, coord, bestSample ).toWriteOnly();
		textureStore( reservoirBRadianceTex, coord, bestRadiance ).toWriteOnly();
		textureStore( reservoirBWeightTex, coord, vec4( wSum, M, W, bestTargetPdf ) ).toWriteOnly();

	} );

	return computeFn;

}

// ================================================================================
// PASS 3: FINAL SHADING
// ================================================================================

export function buildGIFinalShadingCompute( {
	normalDepthTexNode, albedoTexNode, pathTracerTexNode,
	finalSampleTexNode, finalRadianceTexNode, finalWeightTexNode,
	outputTex,
	bvhBuffer, triangleBuffer, materialBuffer,
	cameraWorldMatrix, cameraProjInverse,
	resW, resH, frameCount, debugMode,
} ) {

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.greaterThanEqual( int( resW ) ).or( gy.greaterThanEqual( int( resH ) ) ), () => {

			return;

		} );

		const coord = uvec2( uint( gx ), uint( gy ) );

		const nd = textureLoad( normalDepthTexNode, ivec2( gx, gy ) ).toVar();
		const linearDepth = nd.w;

		// Background
		If( linearDepth.greaterThanEqual( float( 1e9 ) ), () => {

			textureStore( outputTex, coord, vec4( 0.0, 0.0, 0.0, 1.0 ) ).toWriteOnly();
			return;

		} );

		const surfaceNormal = normalize( nd.xyz.mul( 2.0 ).sub( 1.0 ) ).toVar();
		const worldPos = vec3( reconstructWorldPos(
			gx, gy, linearDepth, resW, resH, cameraWorldMatrix, cameraProjInverse
		) ).toVar();

		const albedo = textureLoad( albedoTexNode, ivec2( gx, gy ) ).xyz.toVar();

		// Read reservoir
		const resSample = textureLoad( finalSampleTexNode, ivec2( gx, gy ) ).toVar();
		const resRadiance = textureLoad( finalRadianceTexNode, ivec2( gx, gy ) ).toVar();
		const resWeight = textureLoad( finalWeightTexNode, ivec2( gx, gy ) ).toVar();

		const W = resWeight.z;

		If( W.lessThanEqual( float( 0.0 ) ), () => {

			textureStore( outputTex, coord, vec4( 0.0, 0.0, 0.0, 1.0 ) ).toWriteOnly();
			return;

		} );

		const secondaryPos = resSample.xyz;
		const incomingRadiance = resRadiance.xyz;

		// Direction and distance to secondary surface
		const toSecondary = secondaryPos.sub( worldPos ).toVar();
		const distSq = max( dot( toSecondary, toSecondary ), float( 1e-8 ) );
		const dist = sqrt( distSq );
		const lightDir = toSecondary.div( dist ).toVar();

		const NdotL = max( dot( surfaceNormal, lightDir ), float( 0.0 ) ).toVar();

		// ─── Visibility ray from primary to secondary ───
		const rngState = initRNG( gx, gy, resW, frameCount, 8000 );
		const shadowOrigin = worldPos.add( surfaceNormal.mul( max( float( 1e-4 ), length( worldPos ).mul( 1e-6 ) ) ) ).toVar();
		const shadowDist = dist.sub( float( 0.002 ) );

		const visibility = float( traceShadowRay(
			shadowOrigin, lightDir, shadowDist, rngState,
			traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
		) ).toVar();

		// ─── Lambertian BRDF at primary surface: albedo / π ───
		const brdf = albedo.mul( float( PI_INV ) );

		// Final: Lo = incoming_radiance × BRDF × NdotL × W × visibility
		const Lo = incomingRadiance.mul( brdf ).mul( NdotL ).mul( W ).mul( visibility ).toVar();

		// Firefly clamp
		const maxComp = max( Lo.x, max( Lo.y, Lo.z ) );
		If( maxComp.greaterThan( float( 100.0 ) ), () => {

			Lo.mulAssign( float( 100.0 ).div( maxComp ) );

		} );

		// Debug modes: 0=combined, 1=GI only, 2=incoming radiance, 3=weight heatmap
		const finalOutput = vec3( 0.0 ).toVar();

		If( debugMode.equal( int( 1 ) ), () => {

			// GI only — just the indirect contribution
			finalOutput.assign( Lo );

		} ).ElseIf( debugMode.equal( int( 2 ) ), () => {

			// Raw incoming radiance at secondary (before BRDF/visibility)
			finalOutput.assign( incomingRadiance );

		} ).ElseIf( debugMode.equal( int( 3 ) ), () => {

			// Weight heatmap: sqrt-scale W mapped to color (blue→green→red)
			// sqrt compresses dynamic range; /7.0 maps W≈49 → 1.0
			const wNorm = min( sqrt( W ).div( float( 7.0 ) ), float( 1.0 ) );
			finalOutput.assign( vec3(
				min( wNorm.mul( 2.0 ), float( 1.0 ) ),
				select( wNorm.lessThan( 0.5 ), wNorm.mul( 2.0 ), float( 2.0 ).sub( wNorm.mul( 2.0 ) ) ),
				max( float( 1.0 ).sub( wNorm.mul( 2.0 ) ), float( 0.0 ) ),
			) );

		} ).ElseIf( debugMode.equal( int( 4 ) ), () => {

			// Diagnostic: raw G-buffer normal encoding (nd.xyz)
			// If this matches mode 2 (Radiance), it confirms a TextureNode binding issue
			finalOutput.assign( nd.xyz );

		} ).Else( () => {

			// Combined: path tracer + GI
			const ptColor = textureLoad( pathTracerTexNode, ivec2( gx, gy ) ).xyz;
			finalOutput.assign( ptColor.add( Lo ) );

		} );

		textureStore( outputTex, coord, vec4( finalOutput, 1.0 ) ).toWriteOnly();

	} );

	return computeFn;

}
