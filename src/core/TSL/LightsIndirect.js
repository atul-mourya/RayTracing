/**
 * LightsIndirect.js - Indirect Lighting (Global Illumination)
 *
 * Exact port of lights_indirect.fs
 * Pure TSL: Fn(), If(), Loop(), .toVar(), .assign() — NO wgslFn()
 *
 * Contains:
 *  - calculateTransmissionPDF  — transmission PDF for MIS
 *  - calculateClearcoatPDF     — clearcoat PDF for MIS
 *  - computeSamplingInfo       — compute importance weights for each strategy
 *  - selectSamplingStrategy    — CDF-based strategy selection
 *  - calculateIndirectLighting — main indirect lighting with multi-strategy MIS
 */

import {
	Fn,
	float,
	vec2,
	vec3,
	vec4,
	int,
	uint,
	bool as tslBool,
	max,
	min,
	abs,
	sqrt,
	dot,
	normalize,
	length,
	clamp,
	If,
	select,
} from 'three/tsl';

import {
	IndirectLightingResult,
} from './LightsCore.js';
import {
	SamplingStrategyWeights,
	ImportanceSamplingInfo,
} from './Struct.js';
import {
	PI,
	PI_INV,
	EPSILON,
	MIN_PDF,
} from './Common.js';
import { DistributionGGX, calculateVNDFPDF } from './MaterialProperties.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { RandomValue } from './Random.js';
import { sampleEquirectProbability, sampleEquirect } from './Environment.js';
import { sampleMicrofacetTransmission, MicrofacetTransmissionResult } from './MaterialTransmission.js';
import { cosineWeightedSample } from './MaterialSampling.js';

// =============================================================================
// PDF Calculation Helpers
// =============================================================================

// Transmission PDF (Walter et al. 2007)
export const calculateTransmissionPDF = Fn( ( [ V, L, N, ior, roughness, entering ] ) => {

	// eta is the relative IOR: eta_transmitted / eta_incident
	// When entering: air(1.0) -> material(ior), so eta = ior
	// When exiting: material(ior) -> air(1.0), so eta = 1.0/ior
	const eta = select( entering, ior, float( 1.0 ).div( ior ) ).toVar();

	// Transmission half-vector formula
	const H_raw = V.add( L.mul( eta ) ).toVar();
	const lenSq = dot( H_raw, H_raw ).toVar();
	const H = select( lenSq.greaterThan( EPSILON ), H_raw.div( sqrt( lenSq ) ), N ).toVar();

	// Ensure H points into the correct hemisphere
	If( dot( H, N ).lessThan( 0.0 ), () => {

		H.assign( H.negate() );

	} );

	const VoH = abs( dot( V, H ) ).toVar();
	const LoH = abs( dot( L, H ) ).toVar();
	const NoH = abs( dot( N, H ) ).toVar();

	// GGX distribution
	const D = DistributionGGX( NoH, roughness ).toVar();

	// Jacobian for transmission
	const denom_inner = VoH.add( LoH.mul( eta ) ).toVar();
	const denom = denom_inner.mul( denom_inner ).toVar();
	const jacobian = LoH.mul( eta ).mul( eta ).div( max( denom, EPSILON ) ).toVar();

	return D.mul( NoH ).mul( jacobian );

} );

// Clearcoat PDF
export const calculateClearcoatPDF = Fn( ( [ V, L, N, clearcoatRoughness ] ) => {

	const H_raw = V.add( L ).toVar();
	const lenSq = dot( H_raw, H_raw ).toVar();
	const H = select( lenSq.greaterThan( EPSILON ), H_raw.div( sqrt( lenSq ) ), N ).toVar();

	const NoH = max( dot( N, H ), 0.0 ).toVar();
	const NoV = max( dot( N, V ), 0.0 ).toVar();

	return calculateVNDFPDF( NoH, NoV, clearcoatRoughness );

} );

// =============================================================================
// Sampling Strategy Computation
// =============================================================================

// Compute normalized strategy weights based on importance info
export const computeSamplingInfo = Fn( ( [
	samplingInfo, bounceIndex, material,
	enableEnvironmentLight, useEnvMapIS,
] ) => {

	// Environment sampling weight
	const envW = float( 0.0 ).toVar();
	const useEnv = tslBool( false ).toVar();

	If( enableEnvironmentLight.and( useEnvMapIS ), () => {

		envW.assign( samplingInfo.envmapImportance );
		useEnv.assign( envW.greaterThan( 0.001 ) );

	} );

	// Separate each sampling strategy
	const specularW = samplingInfo.specularImportance.toVar();
	const useSpecular = specularW.greaterThan( 0.001 ).toVar();

	const diffuseW = samplingInfo.diffuseImportance.toVar();
	const useDiffuse = diffuseW.greaterThan( 0.001 ).toVar();

	const transmissionW = samplingInfo.transmissionImportance.toVar();
	const useTransmission = transmissionW.greaterThan( 0.001 ).toVar();

	const clearcoatW = samplingInfo.clearcoatImportance.toVar();
	const useClearcoat = clearcoatW.greaterThan( 0.001 ).toVar();

	// Calculate total weight
	const totalW = envW.add( specularW ).add( diffuseW ).add( transmissionW ).add( clearcoatW ).toVar();

	// Proper normalization and fallback
	If( totalW.lessThan( 0.001 ), () => {

		// Safe fallback to diffuse sampling
		envW.assign( 0.0 );
		specularW.assign( 0.0 );
		diffuseW.assign( 1.0 );
		transmissionW.assign( 0.0 );
		clearcoatW.assign( 0.0 );
		totalW.assign( 1.0 );
		useEnv.assign( tslBool( false ) );
		useSpecular.assign( tslBool( false ) );
		useDiffuse.assign( tslBool( true ) );
		useTransmission.assign( tslBool( false ) );
		useClearcoat.assign( tslBool( false ) );

	} ).Else( () => {

		// Normalize weights to sum to 1.0
		const invTotal = float( 1.0 ).div( totalW ).toVar();
		envW.mulAssign( invTotal );
		specularW.mulAssign( invTotal );
		diffuseW.mulAssign( invTotal );
		transmissionW.mulAssign( invTotal );
		clearcoatW.mulAssign( invTotal );
		totalW.assign( 1.0 );

	} );

	return SamplingStrategyWeights( {
		envWeight: envW,
		specularWeight: specularW,
		diffuseWeight: diffuseW,
		transmissionWeight: transmissionW,
		clearcoatWeight: clearcoatW,
		totalWeight: totalW,
		useEnv,
		useSpecular,
		useDiffuse,
		useTransmission,
		useClearcoat,
	} );

} );

// =============================================================================
// Strategy Selection via Cumulative Distribution
// =============================================================================

// Returns vec2(selectedStrategy, strategyPdf)
// Strategy IDs: 0=env, 1=specular, 2=diffuse, 3=transmission, 4=clearcoat
export const selectSamplingStrategy = Fn( ( [ weights, randomValue ] ) => {

	const selectedStrategy = int( 2 ).toVar(); // Default: diffuse
	const strategyPdf = float( 1.0 ).toVar();

	const cumulative = float( 0.0 ).toVar();
	const found = tslBool( false ).toVar();

	If( weights.useEnv.and( found.not() ), () => {

		cumulative.addAssign( weights.envWeight );

		If( randomValue.lessThan( cumulative ), () => {

			selectedStrategy.assign( 0 );
			strategyPdf.assign( weights.envWeight );
			found.assign( tslBool( true ) );

		} );

	} );

	If( weights.useSpecular.and( found.not() ), () => {

		cumulative.addAssign( weights.specularWeight );

		If( randomValue.lessThan( cumulative ), () => {

			selectedStrategy.assign( 1 );
			strategyPdf.assign( weights.specularWeight );
			found.assign( tslBool( true ) );

		} );

	} );

	If( weights.useDiffuse.and( found.not() ), () => {

		cumulative.addAssign( weights.diffuseWeight );

		If( randomValue.lessThan( cumulative ), () => {

			selectedStrategy.assign( 2 );
			strategyPdf.assign( weights.diffuseWeight );
			found.assign( tslBool( true ) );

		} );

	} );

	If( weights.useTransmission.and( found.not() ), () => {

		cumulative.addAssign( weights.transmissionWeight );

		If( randomValue.lessThan( cumulative ), () => {

			selectedStrategy.assign( 3 );
			strategyPdf.assign( weights.transmissionWeight );
			found.assign( tslBool( true ) );

		} );

	} );

	If( weights.useClearcoat.and( found.not() ), () => {

		selectedStrategy.assign( 4 );
		strategyPdf.assign( weights.clearcoatWeight );
		found.assign( tslBool( true ) );

	} );

	// Fallback
	If( found.not(), () => {

		selectedStrategy.assign( 2 ); // Diffuse
		strategyPdf.assign( select( weights.useDiffuse, weights.diffuseWeight, float( 1.0 ) ) );

	} );

	return vec2( float( selectedStrategy ), strategyPdf );

} );

// =============================================================================
// Cosine Weighted PDF helper
// =============================================================================

const cosineWeightedPDF = Fn( ( [ NoL ] ) => {

	return max( NoL, 0.0 ).mul( PI_INV );

} );

// =============================================================================
// Indirect Lighting Calculation
// =============================================================================

export const calculateIndirectLighting = Fn( ( [
	V, N, material,
	// brdfSample fields (DirectionSample)
	brdfSampleDirection, brdfSamplePdf, brdfSampleValue,
	sampleIndex, bounceIndex,
	rngState,
	samplingInfo,
	// Environment resources
	envTexture, environmentIntensity, envMatrix,
	envMarginalWeights, envConditionalWeights,
	envTotalSum, envResolution,
	enableEnvironmentLight, useEnvMapIS,
] ) => {

	// Initialize result
	const r_direction = vec3( 0.0 ).toVar();
	const r_throughput = vec3( 0.0 ).toVar();
	const r_misWeight = float( 0.0 ).toVar();
	const r_pdf = float( 0.0 ).toVar();

	// Validate input sampling info
	const validInput = samplingInfo.diffuseImportance.greaterThanEqual( 0.0 )
		.and( samplingInfo.specularImportance.greaterThanEqual( 0.0 ) )
		.and( samplingInfo.transmissionImportance.greaterThanEqual( 0.0 ) )
		.and( samplingInfo.clearcoatImportance.greaterThanEqual( 0.0 ) )
		.and( samplingInfo.envmapImportance.greaterThanEqual( 0.0 ) )
		.toVar();

	If( validInput.not(), () => {

		// Fallback to diffuse sampling
		const r1_fb = RandomValue( rngState ).toVar();
		const r2_fb = RandomValue( rngState ).toVar();
		const sampleRand = vec2( r1_fb, r2_fb ).toVar();
		r_direction.assign( cosineWeightedSample( N, sampleRand ) );
		r_throughput.assign( material.color.xyz );
		r_misWeight.assign( 1.0 );
		r_pdf.assign( 1.0 );

	} ).Else( () => {

		// Use corrected sampling info
		const weights = SamplingStrategyWeights.wrap( computeSamplingInfo(
			samplingInfo, bounceIndex, material,
			enableEnvironmentLight, useEnvMapIS,
		).toVar() );

		const selectionRand = RandomValue( rngState ).toVar();
		const r1 = RandomValue( rngState ).toVar();
		const r2 = RandomValue( rngState ).toVar();
		const sampleRand = vec2( r1, r2 ).toVar();

		// Strategy selection
		const strategyResult = selectSamplingStrategy( weights, selectionRand ).toVar();
		const selectedStrategy = int( strategyResult.x ).toVar();
		const strategySelectionPdf = strategyResult.y.toVar();

		const sampleDir = vec3( 0.0 ).toVar();
		const samplePdf = float( 0.0 ).toVar();
		const sampleBrdfValue = vec3( 0.0 ).toVar();

		// Execute selected strategy (chained If/ElseIf/Else for exclusive branches)

		// Strategy 0: Environment
		If( selectedStrategy.equal( int( 0 ) ), () => {

			const envColorUnused = vec3( 0.0 ).toVar();
			const envSampleResult = sampleEquirectProbability(
				envTexture, envMarginalWeights, envConditionalWeights,
				envMatrix, environmentIntensity, envTotalSum, envResolution, sampleRand, envColorUnused
			).toVar();

			sampleDir.assign( envSampleResult.xyz );
			samplePdf.assign( envSampleResult.w );
			sampleBrdfValue.assign( evaluateMaterialResponse( V, sampleDir, N, material ) );

		} ).ElseIf( selectedStrategy.equal( int( 1 ) ), () => {

			// Strategy 1: Specular
			sampleDir.assign( brdfSampleDirection );
			samplePdf.assign( brdfSamplePdf );
			sampleBrdfValue.assign( brdfSampleValue );

		} ).ElseIf( selectedStrategy.equal( int( 2 ) ), () => {

			// Strategy 2: Diffuse
			sampleDir.assign( cosineWeightedSample( N, sampleRand ) );
			samplePdf.assign( cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) ) );
			sampleBrdfValue.assign( evaluateMaterialResponse( V, sampleDir, N, material ) );

		} ).ElseIf( selectedStrategy.equal( int( 3 ) ), () => {

			// Strategy 3: Transmission
			const entering = dot( V, N ).greaterThan( 0.0 ).toVar();
			const mtResult = MicrofacetTransmissionResult.wrap( sampleMicrofacetTransmission(
				V, N, material.ior, material.roughness, entering, material.dispersion, sampleRand, rngState
			).toVar() );
			sampleDir.assign( mtResult.direction );
			samplePdf.assign( mtResult.pdf );
			sampleBrdfValue.assign( evaluateMaterialResponse( V, sampleDir, N, material ) );

		} ).Else( () => {

			// Strategy 4: Clearcoat (fallback)
			sampleDir.assign( brdfSampleDirection );
			samplePdf.assign( brdfSamplePdf );
			sampleBrdfValue.assign( brdfSampleValue );

		} );

		// For transmission directions (below surface), use |cos| instead of max(cos, 0)
		const rawNoL = dot( N, sampleDir ).toVar();
		const NoL = max( rawNoL, 0.0 ).toVar();
		const absNoL = abs( rawNoL ).toVar();

		// Calculate combined PDF for MIS (all active strategies)
		const combinedPdf = float( 0.0 ).toVar();

		If( weights.useEnv, () => {

			const envEvalResult = sampleEquirect(
				envTexture, sampleDir, envMatrix, envTotalSum, envResolution
			).toVar();
			const envPdf = envEvalResult.w.toVar();

			// Only include environment in MIS if it has valid contribution
			If( envPdf.greaterThan( 0.0 ), () => {

				combinedPdf.addAssign( weights.envWeight.mul( envPdf ) );

			} );

		} );

		If( weights.useSpecular, () => {

			// Evaluate specular PDF at sampleDir (not brdfSampleDirection which may differ)
			const H_spec = normalize( V.add( sampleDir ) );
			const NoH_spec = max( dot( N, H_spec ), 0.001 );
			const NoV_spec = max( dot( N, V ), 0.001 );
			const specPdfAtSampleDir = calculateVNDFPDF( NoH_spec, NoV_spec, material.roughness );
			combinedPdf.addAssign( weights.specularWeight.mul( specPdfAtSampleDir ) );

		} );

		If( weights.useDiffuse, () => {

			const diffusePdf = cosineWeightedPDF( NoL ).toVar();
			combinedPdf.addAssign( weights.diffuseWeight.mul( diffusePdf ) );

		} );

		If( weights.useTransmission.and( material.transmission.greaterThan( 0.0 ) ), () => {

			// Calculate transmission PDF for this direction
			const entering = dot( V, N ).greaterThan( 0.0 ).toVar();
			const transmissionPdf = calculateTransmissionPDF( V, sampleDir, N, material.ior, material.roughness, entering ).toVar();
			combinedPdf.addAssign( weights.transmissionWeight.mul( transmissionPdf ) );

		} );

		If( weights.useClearcoat.and( material.clearcoat.greaterThan( 0.0 ) ), () => {

			// Calculate clearcoat PDF for this direction
			const clearcoatPdf = calculateClearcoatPDF( V, sampleDir, N, material.clearcoatRoughness ).toVar();
			combinedPdf.addAssign( weights.clearcoatWeight.mul( clearcoatPdf ) );

		} );

		// Ensure valid PDFs
		samplePdf.assign( max( samplePdf, MIN_PDF ) );
		combinedPdf.assign( max( combinedPdf, MIN_PDF ) );

		// MIS weight calculation
		const misWeight = samplePdf.div( combinedPdf ).toVar();

		// Throughput calculation: use |cos| for transmission, max(cos,0) for reflection strategies
		const cosineWeight = select( selectedStrategy.equal( int( 3 ) ), absNoL, NoL );
		const throughput = sampleBrdfValue.mul( cosineWeight ).mul( misWeight ).div( samplePdf ).toVar();

		r_direction.assign( sampleDir );
		r_throughput.assign( throughput );
		r_misWeight.assign( misWeight );
		r_pdf.assign( samplePdf );

	} ); // End validInput check

	return IndirectLightingResult( {
		direction: r_direction,
		throughput: r_throughput,
		misWeight: r_misWeight,
		pdf: r_pdf,
	} );

} );
