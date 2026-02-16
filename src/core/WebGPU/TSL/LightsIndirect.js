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
import { sampleEquirectProbability, sampleEquirectProbabilityColor, sampleEquirect } from './Environment.js';
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
	const eta = select( entering, ior, float( 1.0 ).div( ior ) ).toVar( 'tpdf_eta' );

	// Transmission half-vector formula
	const H_raw = V.add( L.mul( eta ) ).toVar( 'tpdf_Hraw' );
	const lenSq = dot( H_raw, H_raw ).toVar( 'tpdf_lenSq' );
	const H = select( lenSq.greaterThan( EPSILON ), H_raw.div( sqrt( lenSq ) ), N ).toVar( 'tpdf_H' );

	// Ensure H points into the correct hemisphere
	If( dot( H, N ).lessThan( 0.0 ), () => {

		H.assign( H.negate() );

	} );

	const VoH = abs( dot( V, H ) ).toVar( 'tpdf_VoH' );
	const LoH = abs( dot( L, H ) ).toVar( 'tpdf_LoH' );
	const NoH = abs( dot( N, H ) ).toVar( 'tpdf_NoH' );

	// GGX distribution
	const D = DistributionGGX( NoH, roughness ).toVar( 'tpdf_D' );

	// Jacobian for transmission
	const denom_inner = VoH.add( LoH.mul( eta ) ).toVar( 'tpdf_denomInner' );
	const denom = denom_inner.mul( denom_inner ).toVar( 'tpdf_denom' );
	const jacobian = LoH.mul( eta ).mul( eta ).div( max( denom, EPSILON ) ).toVar( 'tpdf_J' );

	return D.mul( NoH ).mul( jacobian );

} );

// Clearcoat PDF
export const calculateClearcoatPDF = Fn( ( [ V, L, N, clearcoatRoughness ] ) => {

	const H_raw = V.add( L ).toVar( 'ccpdf_Hraw' );
	const lenSq = dot( H_raw, H_raw ).toVar( 'ccpdf_lenSq' );
	const H = select( lenSq.greaterThan( EPSILON ), H_raw.div( sqrt( lenSq ) ), N ).toVar( 'ccpdf_H' );

	const NoH = max( dot( N, H ), 0.0 ).toVar( 'ccpdf_NoH' );
	const NoV = max( dot( N, V ), 0.0 ).toVar( 'ccpdf_NoV' );

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
	const envW = float( 0.0 ).toVar( 'csi_envW' );
	const useEnv = tslBool( false ).toVar( 'csi_useEnv' );

	If( enableEnvironmentLight.and( useEnvMapIS ), () => {

		envW.assign( samplingInfo.envmapImportance );
		useEnv.assign( envW.greaterThan( 0.001 ) );

	} );

	// Separate each sampling strategy
	const specularW = samplingInfo.specularImportance.toVar( 'csi_specW' );
	const useSpecular = specularW.greaterThan( 0.001 ).toVar( 'csi_useSpec' );

	const diffuseW = samplingInfo.diffuseImportance.toVar( 'csi_diffW' );
	const useDiffuse = diffuseW.greaterThan( 0.001 ).toVar( 'csi_useDiff' );

	const transmissionW = samplingInfo.transmissionImportance.toVar( 'csi_transW' );
	const useTransmission = transmissionW.greaterThan( 0.001 ).toVar( 'csi_useTrans' );

	const clearcoatW = samplingInfo.clearcoatImportance.toVar( 'csi_ccW' );
	const useClearcoat = clearcoatW.greaterThan( 0.001 ).toVar( 'csi_useCC' );

	// Calculate total weight
	const totalW = envW.add( specularW ).add( diffuseW ).add( transmissionW ).add( clearcoatW ).toVar( 'csi_totalW' );

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
		const invTotal = float( 1.0 ).div( totalW ).toVar( 'csi_inv' );
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

	const selectedStrategy = int( 2 ).toVar( 'ss_sel' ); // Default: diffuse
	const strategyPdf = float( 1.0 ).toVar( 'ss_pdf' );

	const cumulative = float( 0.0 ).toVar( 'ss_cum' );
	const found = tslBool( false ).toVar( 'ss_found' );

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
	// Global illumination scale
	globalIlluminationIntensity,
] ) => {

	// Initialize result
	const r_direction = vec3( 0.0 ).toVar( 'cil_dir' );
	const r_throughput = vec3( 0.0 ).toVar( 'cil_tp' );
	const r_misWeight = float( 0.0 ).toVar( 'cil_mis' );
	const r_pdf = float( 0.0 ).toVar( 'cil_pdf' );

	// Validate input sampling info
	const validInput = samplingInfo.diffuseImportance.greaterThanEqual( 0.0 )
		.and( samplingInfo.specularImportance.greaterThanEqual( 0.0 ) )
		.and( samplingInfo.transmissionImportance.greaterThanEqual( 0.0 ) )
		.and( samplingInfo.clearcoatImportance.greaterThanEqual( 0.0 ) )
		.and( samplingInfo.envmapImportance.greaterThanEqual( 0.0 ) )
		.toVar( 'cil_validIn' );

	If( validInput.not(), () => {

		// Fallback to diffuse sampling
		const sampleRand = vec2( RandomValue( rngState ), RandomValue( rngState ) ).toVar( 'cil_fbRand' );
		r_direction.assign( cosineWeightedSample( N, sampleRand ) );
		r_throughput.assign( material.color.xyz );
		r_misWeight.assign( 1.0 );
		r_pdf.assign( 1.0 );

	} ).Else( () => {

		// Use corrected sampling info
		const weights = SamplingStrategyWeights.wrap( computeSamplingInfo(
			samplingInfo, bounceIndex, material,
			enableEnvironmentLight, useEnvMapIS,
		).toVar( 'cil_weights' ) );

		const selectionRand = RandomValue( rngState ).toVar( 'cil_selRand' );
		const sampleRand = vec2( RandomValue( rngState ), RandomValue( rngState ) ).toVar( 'cil_smpRand' );

		// Strategy selection
		const strategyResult = selectSamplingStrategy( weights, selectionRand ).toVar( 'cil_strat' );
		const selectedStrategy = int( strategyResult.x ).toVar( 'cil_sSel' );
		const strategySelectionPdf = strategyResult.y.toVar( 'cil_sSelPdf' );

		const sampleDir = vec3( 0.0 ).toVar( 'cil_sDir' );
		const samplePdf = float( 0.0 ).toVar( 'cil_sPdf' );
		const sampleBrdfValue = vec3( 0.0 ).toVar( 'cil_sBrdf' );

		// Execute selected strategy

		// Strategy 0: Environment
		If( selectedStrategy.equal( int( 0 ) ), () => {

			const envSampleResult = sampleEquirectProbability(
				envTexture, envMarginalWeights, envConditionalWeights,
				envMatrix, environmentIntensity, envTotalSum, envResolution, sampleRand
			).toVar( 'cil_envSmp' );

			sampleDir.assign( envSampleResult.xyz );
			samplePdf.assign( envSampleResult.w );
			sampleBrdfValue.assign( evaluateMaterialResponse( V, sampleDir, N, material ) );

		} );

		// Strategy 1: Specular
		If( selectedStrategy.equal( int( 1 ) ), () => {

			sampleDir.assign( brdfSampleDirection );
			samplePdf.assign( brdfSamplePdf );
			sampleBrdfValue.assign( brdfSampleValue );

		} );

		// Strategy 2: Diffuse
		If( selectedStrategy.equal( int( 2 ) ), () => {

			sampleDir.assign( cosineWeightedSample( N, sampleRand ) );
			samplePdf.assign( cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) ) );
			sampleBrdfValue.assign( evaluateMaterialResponse( V, sampleDir, N, material ) );

		} );

		// Strategy 3: Transmission
		If( selectedStrategy.equal( int( 3 ) ), () => {

			const entering = dot( V, N ).lessThan( 0.0 ).toVar( 'cil_entering' );
			const mtResult = MicrofacetTransmissionResult.wrap( sampleMicrofacetTransmission(
				V, N, material.ior, material.roughness, entering, material.dispersion, sampleRand, rngState
			).toVar( 'cil_mtResult' ) );
			sampleDir.assign( mtResult.direction );
			samplePdf.assign( mtResult.pdf );
			sampleBrdfValue.assign( evaluateMaterialResponse( V, sampleDir, N, material ) );

		} );

		// Strategy 4: Clearcoat
		If( selectedStrategy.equal( int( 4 ) ), () => {

			sampleDir.assign( brdfSampleDirection );
			samplePdf.assign( brdfSamplePdf );
			sampleBrdfValue.assign( brdfSampleValue );

		} );

		const NoL = max( dot( N, sampleDir ), 0.0 ).toVar( 'cil_NoL' );

		// Calculate combined PDF for MIS (all active strategies)
		const combinedPdf = float( 0.0 ).toVar( 'cil_cPdf' );

		If( weights.useEnv, () => {

			const envEvalResult = sampleEquirect(
				envTexture, sampleDir, envMatrix, envTotalSum, envResolution
			).toVar( 'cil_envEval' );
			const envPdf = envEvalResult.w.toVar( 'cil_envEvalPdf' );

			// Only include environment in MIS if it has valid contribution
			If( envPdf.greaterThan( 0.0 ), () => {

				combinedPdf.addAssign( weights.envWeight.mul( envPdf ) );

			} );

		} );

		If( weights.useSpecular, () => {

			combinedPdf.addAssign( weights.specularWeight.mul( brdfSamplePdf ) );

		} );

		If( weights.useDiffuse, () => {

			const diffusePdf = cosineWeightedPDF( NoL ).toVar( 'cil_diffPdf' );
			combinedPdf.addAssign( weights.diffuseWeight.mul( diffusePdf ) );

		} );

		If( weights.useTransmission.and( material.transmission.greaterThan( 0.0 ) ), () => {

			// Calculate transmission PDF for this direction
			const entering = dot( V, N ).lessThan( 0.0 ).toVar( 'cil_tEntering' );
			const transmissionPdf = calculateTransmissionPDF( V, sampleDir, N, material.ior, material.roughness, entering ).toVar( 'cil_tPdf' );
			combinedPdf.addAssign( weights.transmissionWeight.mul( transmissionPdf ) );

		} );

		If( weights.useClearcoat.and( material.clearcoat.greaterThan( 0.0 ) ), () => {

			// Calculate clearcoat PDF for this direction
			const clearcoatPdf = calculateClearcoatPDF( V, sampleDir, N, material.clearcoatRoughness ).toVar( 'cil_ccPdf' );
			combinedPdf.addAssign( weights.clearcoatWeight.mul( clearcoatPdf ) );

		} );

		// Ensure valid PDFs
		samplePdf.assign( max( samplePdf, MIN_PDF ) );
		combinedPdf.assign( max( combinedPdf, MIN_PDF ) );

		// MIS weight calculation
		const misWeight = samplePdf.div( combinedPdf ).toVar( 'cil_misW' );

		// Throughput calculation
		const throughput = sampleBrdfValue.mul( NoL ).mul( misWeight ).div( samplePdf ).toVar( 'cil_throughput' );

		// Apply global illumination scaling
		throughput.mulAssign( globalIlluminationIntensity );

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
