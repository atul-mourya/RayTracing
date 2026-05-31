/**
 * PathTracerCore.js — shared path-tracing sampling helpers (TSL).
 *
 * Imported by the wavefront kernels (GenerateKernel / ShadeKernel):
 *  - generateSampledDirection   — BRDF direction sampling with multi-lobe CDF
 *  - regularizePathContribution — firefly suppression
 *  - computeNDCDepth            — world position → NDC depth [0,1]
 *  - getRequiredSamples         — adaptive sampling sample count
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
	texture,
	floor,
} from 'three/tsl';

import {
	PI_INV,
	MAX_ROUGHNESS,
	MIN_CLEARCOAT_ROUGHNESS,
	MIN_PDF,
	constructTBN,
	calculateFireflyThreshold,
	applySoftSuppressionRGB,
} from './Common.js';
import { DirectionSample, MaterialCache } from './Struct.js';
import { RandomValue } from './Random.js';
import { sampleMicrofacetTransmission, MicrofacetTransmissionResult } from './MaterialTransmission.js';
import {
	SheenDistribution,
	calculateVNDFPDF,
	calculateBRDFWeights,
} from './MaterialProperties.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { dielectricF0 } from './Fresnel.js';
import {
	ImportanceSampleCosine,
	ImportanceSampleGGX,
	sampleGGXVNDF,
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

		const TBN = constructTBN( { N } );
		const localV = TBN.transpose().mul( V );

		// VNDF sampling
		const localH = sampleGGXVNDF( { V: localV, roughness: material.roughness, Xi: xi } );
		H.assign( TBN.mul( localH ) );

		const NoH = clamp( dot( N, H ), 0.001, 1.0 );

		resultDirection.assign( reflect( V.negate(), H ) );
		resultPdf.assign( calculateVNDFPDF( NoH, NoV, material.roughness ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

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

// Adaptive sampling: per-pixel required sample count from the guidance texture (0 = converged).
export const getRequiredSamples = Fn( ( [
	pixelCoord, resolution,
	adaptiveSamplingTexture, adaptiveSamplingMin, adaptiveSamplingMax,
] ) => {

	const texCoord = pixelCoord.div( resolution );
	const samplingData = texture( adaptiveSamplingTexture, texCoord, 0 );

	const result = int( 0 ).toVar();

	If( samplingData.b.greaterThan( 0.5 ), () => {

		result.assign( 0 );

	} ).Else( () => {

		const normalizedSamples = samplingData.r;
		const targetSamples = normalizedSamples.mul( float( adaptiveSamplingMax ) );
		const samples = int( floor( targetSamples.add( 0.5 ) ) );
		result.assign( clamp( samples, adaptiveSamplingMin, adaptiveSamplingMax ) );

	} );

	return result;

} );
