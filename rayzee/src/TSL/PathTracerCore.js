/**
 * PathTracerCore.js — shared path-tracing sampling helpers (TSL).
 *
 * Imported by the wavefront kernels (GenerateKernel / ShadeKernel):
 *  - generateSampledDirection   — BRDF direction sampling with multi-lobe CDF
 *  - regularizePathContribution — firefly suppression
 *  - computeNDCDepth            — world position → NDC depth [0,1]
 *  - handleRussianRoulette      — adaptive path termination
 */

import {
	Fn,
	wgslFn,
	float,
	vec2,
	vec3,
	int,
	max,
	min,
	clamp,
	dot,
	reflect,
	If,
	mix,
	smoothstep,
	exp,
	select,
} from 'three/tsl';

import {
	PI_INV,
	MAX_ROUGHNESS,
	MIN_CLEARCOAT_ROUGHNESS,
	MIN_PDF,
	constructTBN,
	anisoTangentFrame,
	calculateFireflyThreshold,
	applySoftSuppressionRGB,
} from './Common.js';
import { AnisoFrame, DirectionSample, MaterialCache } from './Struct.js';
import { RandomValue } from './Random.js';
import { sampleMicrofacetTransmission, MicrofacetTransmissionResult } from './MaterialTransmission.js';
import {
	SheenDistribution,
	calculateVNDFPDF,
	calculateVNDFPDFAniso,
	computeAnisoAlphas,
	calculateBRDFWeights,
} from './MaterialProperties.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { dielectricF0 } from './Fresnel.js';
import {
	ImportanceSampleCosine,
	ImportanceSampleGGX,
	sampleGGXVNDF,
	sampleGGXVNDFAniso,
} from './MaterialSampling.js';

// =============================================================================
// BRDF Direction Sampling
// =============================================================================

export const generateSampledDirection = Fn( ( [
	V, N, material, xi, rngState,
	// Caller-resolved material classification (avoids redundant classifyMaterial —
	// TSL Fn can't write back to caller variables, so the caller is responsible
	// for keeping psCachedClassification current and passes it in here).
	mc,
	weightsComputed, cachedBrdfWeights,
	materialCacheCached, cachedMaterialCache,
] ) => {

	const resultDirection = vec3( 0.0 ).toVar();
	const resultValue = vec3( 0.0 ).toVar();
	const resultPdf = float( 0.0 ).toVar();

	// Compute BRDF weights
	const weights = cachedBrdfWeights.toVar();

	If( weightsComputed.not(), () => {

		If( materialCacheCached, () => {

			weights.assign( calculateBRDFWeights( material, mc, cachedMaterialCache ) );

		} ).Else( () => {

			// Create minimal temporary cache
			const tempCache = MaterialCache( {
				F0: dielectricF0( material.ior ),
				NoV: float( 1.0 ),
				diffuseColor: vec3( 0.0 ),
				isPurelyDiffuse: false,
				alpha: float( 0.0 ),
				k: float( 0.0 ),
				alpha2: float( 0.0 ),
				invRoughness: float( 1.0 ).sub( material.roughness ),
				metalFactor: float( 0.5 ).add( float( 0.5 ).mul( material.metalness ) ),
				iorFactor: min( float( 2.0 ).div( material.ior ), 1.0 ),
				maxSheenColor: max( material.sheenColor.x, max( material.sheenColor.y, material.sheenColor.z ) ),
			} ).toVar();
			weights.assign( calculateBRDFWeights( material, mc, tempCache ) );

		} );

	} );

	const rand = xi.x.toVar();
	const directionSample = vec2( xi.y, RandomValue( rngState ) ).toVar();
	const H = vec3( 0.0 ).toVar();

	// Cumulative probability approach for sampling selection
	const cumulativeDiffuse = weights.diffuse.toVar();
	const cumulativeSpecular = cumulativeDiffuse.add( weights.specular ).toVar();
	const cumulativeSheen = cumulativeSpecular.add( weights.sheen ).toVar();
	const cumulativeClearcoat = cumulativeSheen.add( weights.clearcoat );

	// Hoisted out of the lobe chain: used by both Specular and Clearcoat branches
	const NoV = clamp( dot( N, V ), 0.001, 1.0 ).toVar();

	// Chained If/ElseIf so emitted WGSL becomes a single mutually-exclusive branch
	// (replaces five separate If blocks gated on a `sampled` flag — divergence hotspot)
	If( rand.lessThan( cumulativeDiffuse ), () => {

		resultDirection.assign( ImportanceSampleCosine( { N, xi: directionSample } ) );
		const NoL = clamp( dot( N, resultDirection ), 0.0, 1.0 );
		resultPdf.assign( NoL.mul( PI_INV ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

	} ).ElseIf( rand.lessThan( cumulativeSpecular ), () => {

		If( material.anisotropy.greaterThan( 0.0 ), () => {

			// Shared frame → sampler and eval/PDF stay bit-identical (MIS consistency)
			const f = AnisoFrame.wrap( anisoTangentFrame( N, material.anisotropyRotation ) );
			const Ta = f.Ta;
			const Ba = f.Ba;

			const localV = vec3( dot( V, Ta ), dot( V, Ba ), dot( V, N ) );
			const a = computeAnisoAlphas( material.roughness, material.anisotropy );
			const localH = sampleGGXVNDFAniso( { V: localV, alphaX: a.x, alphaY: a.y, Xi: xi } );
			H.assign( Ta.mul( localH.x ).add( Ba.mul( localH.y ) ).add( N.mul( localH.z ) ) );

			const NoH = clamp( dot( N, H ), 0.001, 1.0 );
			resultDirection.assign( reflect( V.negate(), H ) );
			resultPdf.assign( calculateVNDFPDFAniso( a.x, a.y, NoH, dot( Ta, H ), dot( Ba, H ), NoV, dot( Ta, V ), dot( Ba, V ) ) );
			resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

		} ).Else( () => {

			const TBN = constructTBN( { N } );
			const localV = TBN.transpose().mul( V );

			// VNDF sampling
			const localH = sampleGGXVNDF( { V: localV, roughness: material.roughness, Xi: xi } );
			H.assign( TBN.mul( localH ) );

			const NoH = clamp( dot( N, H ), 0.001, 1.0 );

			resultDirection.assign( reflect( V.negate(), H ) );
			resultPdf.assign( calculateVNDFPDF( NoH, NoV, material.roughness ) );
			resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

		} );

	} ).ElseIf( rand.lessThan( cumulativeSheen ), () => {

		H.assign( ImportanceSampleGGX( { N, roughness: material.sheenRoughness, Xi: xi } ) );
		const NoH = clamp( dot( N, H ), 0.001, 1.0 );
		const VoH = clamp( dot( V, H ), 0.001, 1.0 );
		resultDirection.assign( reflect( V.negate(), H ) );
		const NoL = dot( N, resultDirection ).toVar();

		// Reject directions below the surface - fall back to diffuse
		If( NoL.lessThanEqual( 0.0 ), () => {

			resultDirection.assign( ImportanceSampleCosine( { N, xi } ) );
			NoL.assign( clamp( dot( N, resultDirection ), 0.0, 1.0 ) );
			resultPdf.assign( NoL.mul( PI_INV ) );
			resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

		} ).Else( () => {

			resultPdf.assign( SheenDistribution( NoH, material.sheenRoughness ).mul( NoH ).div( float( 4.0 ).mul( VoH ) ) );
			resultPdf.assign( max( resultPdf, MIN_PDF ) );
			resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

		} );

	} ).ElseIf( rand.lessThan( cumulativeClearcoat ), () => {

		const clearcoatRoughness = clamp( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS, MAX_ROUGHNESS );
		H.assign( ImportanceSampleGGX( { N, roughness: clearcoatRoughness, Xi: xi } ) );
		const NoH = clamp( dot( N, H ), 0.0, 1.0 );
		resultDirection.assign( reflect( V.negate(), H ) );
		resultPdf.assign( calculateVNDFPDF( NoH, NoV, clearcoatRoughness ) );
		resultPdf.assign( max( resultPdf, MIN_PDF ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

	} ).Else( () => {

		// Transmission sampling (fallback)
		const entering = dot( V, N ).greaterThan( 0.0 );
		// pathWavelength=0 — only direction/PDF are consumed here, throughput goes via handleTransmission
		const mtResult = MicrofacetTransmissionResult.wrap( sampleMicrofacetTransmission(
			V, N, material.ior, material.roughness, entering, material.dispersion, xi, rngState, float( 0.0 ),
		) );
		resultDirection.assign( mtResult.direction );
		resultPdf.assign( max( mtResult.pdf, MIN_PDF ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

	} );

	// Ensure PDF is valid
	resultPdf.assign( max( resultPdf, MIN_PDF ) );

	return DirectionSample( {
		direction: resultDirection,
		value: resultValue,
		pdf: resultPdf,
	} );

} );

// =============================================================================
// Firefly Suppression
// =============================================================================

export const regularizePathContribution = /*@__PURE__*/ wgslFn( `
	fn regularizePathContribution( contribution: vec3f, pathLength: f32, fireflyThreshold: f32, frame: i32 ) -> vec3f {
		let threshold = calculateFireflyThreshold( fireflyThreshold, i32( pathLength ), frame );
		return applySoftSuppressionRGB( contribution, threshold, 0.5f );
	}
`, [ calculateFireflyThreshold, applySoftSuppressionRGB ] );

// ── Shared sampling helpers (used by the wavefront kernels) ──

// World position → NDC depth [0,1] for motion-vector reprojection.
export const computeNDCDepth = /*@__PURE__*/ wgslFn( `
	fn computeNDCDepth( worldPos: vec3f, cameraProjectionMatrix: mat4x4f, cameraViewMatrix: mat4x4f ) -> f32 {
		let clipPos = cameraProjectionMatrix * cameraViewMatrix * vec4f( worldPos, 1.0f );
		let ndcDepth = clipPos.z / clipPos.w * 0.5f + 0.5f;
		return clamp( ndcDepth, 0.0f, 1.0f );
	}
` );

// Adaptive Russian roulette (megakernel parity: PathTracerCore.js:302 on `main`, gap #7). Returns the
// survival probability (≥minProb) when the path continues, or 0.0 when terminated. Material-importance +
// throughput + env-direction aware, with a dynamic minBounces floor and exponential depth decay — replaces
// the flat `clamp(maxThroughput,0.05,0.95)` test. Unbiased either way; this just terminates the *right* rays
// (keeps smooth-metal / transmissive / emissive chains alive longer) → less noise per sample.
// Takes the already-computed MaterialClassification `mc` directly (the wavefront classifies once per shade).
export const handleRussianRoulette = Fn( ( [
	depth, throughput, mc, rayDirection, rngState,
	enableEnvironmentLight, useEnvMapIS,
] ) => {

	const result = float( 1.0 ).toVar();

	If( depth.greaterThanEqual( int( 3 ) ), () => {

		const throughputStrength = max( max( max( throughput.x, throughput.y ), throughput.z ), 0.0 ).toVar();

		// Energy-conserving early termination for very low throughput paths (compensated)
		If( throughputStrength.lessThan( 0.0008 ).and( depth.greaterThan( int( 4 ) ) ), () => {

			const lowThroughputProb = max( throughputStrength.mul( 125.0 ), 0.01 );
			const rrSample = RandomValue( rngState );
			result.assign( select( rrSample.lessThan( lowThroughputProb ), lowThroughputProb, float( 0.0 ) ) );

		} ).Else( () => {

			// Importance boosts: deeper budget for transport types that physically carry energy farther.
			const materialImportance = mc.complexityScore.toVar();
			If( mc.isMetallic.and( mc.isSmooth ).and( depth.lessThan( int( 7 ) ) ), () => {

				materialImportance.addAssign( 0.3 );

			} );
			If( mc.isTransmissive.and( depth.lessThan( int( 6 ) ) ), () => {

				materialImportance.addAssign( 0.25 );

			} );
			If( mc.isEmissive.and( depth.lessThan( int( 4 ) ) ), () => {

				materialImportance.addAssign( 0.15 );

			} );
			materialImportance.assign( clamp( materialImportance, 0.0, 1.0 ) );

			// Dynamic minimum bounces
			const minBounces = int( 3 ).toVar();
			If( materialImportance.greaterThan( 0.6 ), () => {

				minBounces.assign( 5 );

			} ).ElseIf( materialImportance.greaterThan( 0.4 ), () => {

				minBounces.assign( 4 );

			} );

			If( depth.lessThan( minBounces ), () => {

				result.assign( 1.0 );

			} ).Else( () => {

				const estMaterialImportance = mc.complexityScore.toVar();
				If( mc.isMetallic.and( mc.isSmooth ), () => {

					estMaterialImportance.addAssign( 0.15 );

				} );
				If( mc.isTransmissive.and( mc.hasClearcoat ), () => {

					estMaterialImportance.addAssign( 0.12 );

				} );
				If( mc.isEmissive, () => {

					estMaterialImportance.addAssign( 0.1 );

				} );
				estMaterialImportance.assign( clamp( estMaterialImportance, 0.0, 1.0 ) );

				const directionImportance = float( 0.5 ).toVar();
				If( enableEnvironmentLight.and( useEnvMapIS ).and( throughputStrength.greaterThan( 0.01 ) ), () => {

					const cosTheta = clamp( rayDirection.y, 0.0, 1.0 );
					directionImportance.assign( mix( float( 0.3 ), float( 0.8 ), cosTheta.mul( cosTheta ) ) );

				} );

				const throughputWeight = smoothstep( float( 0.001 ), float( 0.1 ), throughputStrength );
				const pathContribution = throughputStrength.mul(
					mix( estMaterialImportance.mul( 0.7 ), directionImportance, 0.3 ),
				).mul( throughputWeight ).toVar();

				// Smooth early→deep continuation probability (no discrete depth brackets)
				const earlyProb = clamp(
					materialImportance.mul( 0.4 ).add( throughputStrength.mul( 0.6 ) ).mul( 1.2 ),
					0.15, 0.95,
				);
				const deepProb = clamp(
					throughputStrength.mul( 0.4 ).add( materialImportance.mul( 0.1 ) ),
					0.03, 0.6,
				);

				const depthT = clamp( float( depth.sub( minBounces ) ).div( 10.0 ), 0.0, 1.0 );
				const rrProb = mix( earlyProb, deepProb, depthT ).toVar();

				rrProb.assign( mix( rrProb, max( rrProb, pathContribution ), 0.4 ) );

				If( materialImportance.greaterThan( 0.5 ), () => {

					const boostFactor = materialImportance.sub( 0.5 ).mul( 0.6 );
					rrProb.assign( mix( rrProb, float( 1.0 ), boostFactor ) );

				} );

				const depthDecay = float( 0.12 ).add( materialImportance.mul( 0.08 ) );
				const depthFactor = exp( float( depth.sub( minBounces ) ).negate().mul( depthDecay ) );
				rrProb.mulAssign( depthFactor );

				const minProb = select( mc.isEmissive, float( 0.04 ), float( 0.02 ) );
				rrProb.assign( max( rrProb, minProb ) );

				const rrSample = RandomValue( rngState );
				result.assign( select( rrSample.lessThan( rrProb ), rrProb, float( 0.0 ) ) );

			} );

		} );

	} );

	return result;

} );
