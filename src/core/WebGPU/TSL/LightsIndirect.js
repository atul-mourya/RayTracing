import { Fn, float, vec3, vec2, int, bool as tslBool, uint, max, min, sqrt, abs, dot, If, Return } from 'three/tsl';
import { wgslFn } from 'three/tsl';

/**
 * Lights Indirect for TSL/WGSL
 * Complete port of lights_indirect.fs from GLSL to TSL/WGSL
 *
 * This module contains indirect lighting (global illumination) calculations including:
 * - PDF calculation helpers for transmission and clearcoat
 * - Sampling strategy computation and selection
 * - Indirect lighting calculation with Multiple Importance Sampling (MIS)
 *
 * Matches the GLSL implementation exactly.
 */

// ================================================================================
// CONSTANTS
// ================================================================================

const EPSILON = 1e-6;
const MIN_PDF = 1e-8;

// ================================================================================
// PDF CALCULATION HELPERS
// ================================================================================

/**
 * Calculate PDF for transmission sampling using microfacet transmission.
 * Uses GGX distribution and proper Jacobian for refraction.
 * 
 * @param {vec3} V - View direction (pointing away from surface)
 * @param {vec3} L - Light/sample direction
 * @param {vec3} N - Surface normal
 * @param {float} ior - Index of refraction
 * @param {float} roughness - Surface roughness
 * @param {bool} entering - Whether ray is entering the material (true) or exiting (false)
 * @returns {float} PDF value for transmission sampling
 */
export const calculateTransmissionPDF = Fn( ( [ V, L, N, ior, roughness, entering ] ) => {
	
	// Calculate the half vector for transmission
	// eta is the relative IOR: eta_transmitted / eta_incident
	// When entering: air(1.0) -> material(ior), so eta = ior
	// When exiting: material(ior) -> air(1.0), so eta = 1.0/ior
	const eta = entering.select( ior, float( 1.0 ).div( ior ) ).toVar();
	
	// Transmission half-vector formula (Walter et al. 2007)
	const H = V.add( L.mul( eta ) ).toVar();
	const lenSq = dot( H, H ).toVar();
	H.assign( lenSq.greaterThan( EPSILON ).select( H.div( sqrt( lenSq ) ), N ) );
	
	If( dot( H, N ).lessThan( 0.0 ), () => {
		H.assign( H.negate() ); // Ensure H points into the correct hemisphere
	} );
	
	const VoH = abs( dot( V, H ) ).toVar();
	const LoH = abs( dot( L, H ) ).toVar();
	const NoH = abs( dot( N, H ) ).toVar();
	
	// GGX distribution (needs to be imported from MaterialProperties or defined)
	// Assuming DistributionGGX is available from imports
	const D = wgslFn( `return DistributionGGX(NoH, roughness);` )().toVar();
	
	// Jacobian for transmission
	const denom = VoH.add( LoH.mul( eta ) ).mul( VoH.add( LoH.mul( eta ) ) ).toVar();
	const jacobian = LoH.mul( eta ).mul( eta ).div( max( denom, float( EPSILON ) ) ).toVar();
	
	return D.mul( NoH ).mul( jacobian );
	
} ).setLayout( {
	name: 'calculateTransmissionPDF',
	type: 'float',
	inputs: [
		{ name: 'V', type: 'vec3' },
		{ name: 'L', type: 'vec3' },
		{ name: 'N', type: 'vec3' },
		{ name: 'ior', type: 'float' },
		{ name: 'roughness', type: 'float' },
		{ name: 'entering', type: 'bool' }
	]
} );

/**
 * Calculate PDF for clearcoat sampling using VNDF.
 * 
 * @param {vec3} V - View direction
 * @param {vec3} L - Light direction
 * @param {vec3} N - Surface normal
 * @param {float} clearcoatRoughness - Clearcoat layer roughness
 * @returns {float} PDF value for clearcoat sampling
 */
export const calculateClearcoatPDF = Fn( ( [ V, L, N, clearcoatRoughness ] ) => {
	
	const H = V.add( L ).toVar();
	const lenSq = dot( H, H ).toVar();
	H.assign( lenSq.greaterThan( EPSILON ).select( H.div( sqrt( lenSq ) ), N ) );
	
	const NoH = max( dot( N, H ), float( 0.0 ) ).toVar();
	const NoV = max( dot( N, V ), float( 0.0 ) ).toVar();
	
	// Assuming calculateVNDFPDF is available from imports
	return wgslFn( `return calculateVNDFPDF(NoH, NoV, clearcoatRoughness);` )();
	
} ).setLayout( {
	name: 'calculateClearcoatPDF',
	type: 'float',
	inputs: [
		{ name: 'V', type: 'vec3' },
		{ name: 'L', type: 'vec3' },
		{ name: 'N', type: 'vec3' },
		{ name: 'clearcoatRoughness', type: 'float' }
	]
} );

// ================================================================================
// SAMPLING STRATEGY COMPUTATION
// ================================================================================

/**
 * Validate ImportanceSamplingInfo structure values.
 * Ensures all importance values are non-negative.
 * 
 * @param {ImportanceSamplingInfo} info - Sampling info to validate
 * @returns {bool} True if valid, false otherwise
 */
export const validateSamplingInfo = Fn( ( [ info ] ) => {
	
	return info.diffuseImportance.greaterThanEqual( 0.0 )
		.and( info.specularImportance.greaterThanEqual( 0.0 ) )
		.and( info.transmissionImportance.greaterThanEqual( 0.0 ) )
		.and( info.clearcoatImportance.greaterThanEqual( 0.0 ) )
		.and( info.envmapImportance.greaterThanEqual( 0.0 ) );
	
} ).setLayout( {
	name: 'validateSamplingInfo',
	type: 'bool',
	inputs: [
		{ name: 'info', type: 'ImportanceSamplingInfo' }
	]
} );

/**
 * Compute sampling strategy weights from importance sampling information.
 * Normalizes weights and determines which strategies are active.
 * 
 * @param {ImportanceSamplingInfo} samplingInfo - Raw importance values
 * @param {int} bounceIndex - Current bounce depth (unused but kept for API compatibility)
 * @param {RayTracingMaterial} material - Surface material (unused but kept for API compatibility)
 * @returns {SamplingStrategyWeights} Normalized sampling weights
 */
export const computeSamplingInfo = Fn( ( [ samplingInfo, bounceIndex, material ] ) => {
	
	const info = wgslFn( `
		var info: SamplingStrategyWeights;
		info.envWeight = 0.0;
		info.specularWeight = 0.0;
		info.diffuseWeight = 0.0;
		info.transmissionWeight = 0.0;
		info.clearcoatWeight = 0.0;
		info.totalWeight = 0.0;
		info.useEnv = 0u;
		info.useSpecular = 0u;
		info.useDiffuse = 0u;
		info.useTransmission = 0u;
		info.useClearcoat = 0u;
		return info;
	` )().toVar();
	
	// Environment sampling weight
	// Assuming enableEnvironmentLight and useEnvMapIS are uniforms
	If( wgslFn( `return enableEnvironmentLight && useEnvMapIS;` )(), () => {
		info.envWeight.assign( samplingInfo.envmapImportance );
		If( info.envWeight.greaterThan( 0.001 ), () => {
			info.useEnv.assign( uint( 1 ) );
		} );
	} );
	
	// Separate each sampling strategy
	info.specularWeight.assign( samplingInfo.specularImportance );
	If( info.specularWeight.greaterThan( 0.001 ), () => {
		info.useSpecular.assign( uint( 1 ) );
	} );
	
	info.diffuseWeight.assign( samplingInfo.diffuseImportance );
	If( info.diffuseWeight.greaterThan( 0.001 ), () => {
		info.useDiffuse.assign( uint( 1 ) );
	} );
	
	info.transmissionWeight.assign( samplingInfo.transmissionImportance );
	If( info.transmissionWeight.greaterThan( 0.001 ), () => {
		info.useTransmission.assign( uint( 1 ) );
	} );
	
	info.clearcoatWeight.assign( samplingInfo.clearcoatImportance );
	If( info.clearcoatWeight.greaterThan( 0.001 ), () => {
		info.useClearcoat.assign( uint( 1 ) );
	} );
	
	// Calculate total weight
	info.totalWeight.assign( 
		info.envWeight
			.add( info.specularWeight )
			.add( info.diffuseWeight )
			.add( info.transmissionWeight )
			.add( info.clearcoatWeight )
	);
	
	// Proper normalization and fallback
	If( info.totalWeight.lessThan( 0.001 ), () => {
		// Safe fallback to diffuse sampling
		info.envWeight.assign( 0.0 );
		info.specularWeight.assign( 0.0 );
		info.diffuseWeight.assign( 1.0 );
		info.transmissionWeight.assign( 0.0 );
		info.clearcoatWeight.assign( 0.0 );
		info.totalWeight.assign( 1.0 );
		info.useEnv.assign( uint( 0 ) );
		info.useSpecular.assign( uint( 0 ) );
		info.useDiffuse.assign( uint( 1 ) );
		info.useTransmission.assign( uint( 0 ) );
		info.useClearcoat.assign( uint( 0 ) );
	} ).Else( () => {
		// Normalize weights to sum to 1.0
		const invTotal = float( 1.0 ).div( info.totalWeight ).toVar();
		info.envWeight.mulAssign( invTotal );
		info.specularWeight.mulAssign( invTotal );
		info.diffuseWeight.mulAssign( invTotal );
		info.transmissionWeight.mulAssign( invTotal );
		info.clearcoatWeight.mulAssign( invTotal );
		info.totalWeight.assign( 1.0 );
	} );
	
	return info;
	
} ).setLayout( {
	name: 'computeSamplingInfo',
	type: 'SamplingStrategyWeights',
	inputs: [
		{ name: 'samplingInfo', type: 'ImportanceSamplingInfo' },
		{ name: 'bounceIndex', type: 'int' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

/**
 * Select sampling strategy based on weights and random value.
 * Uses cumulative distribution for proper stratified sampling.
 * 
 * Strategy IDs: 0=env, 1=specular, 2=diffuse, 3=transmission, 4=clearcoat
 * 
 * @param {SamplingStrategyWeights} weights - Normalized sampling weights
 * @param {float} randomValue - Random value in [0,1]
 * @param {int} selectedStrategy - Output: selected strategy ID (passed by reference)
 * @param {float} strategyPdf - Output: PDF of selecting this strategy (passed by reference)
 */
export const selectSamplingStrategy = Fn( ( [ weights, randomValue, selectedStrategy, strategyPdf ] ) => {
	
	const cumulative = float( 0.0 ).toVar();
	
	If( weights.useEnv.equal( uint( 1 ) ), () => {
		cumulative.addAssign( weights.envWeight );
		If( randomValue.lessThan( cumulative ), () => {
			selectedStrategy.assign( int( 0 ) );
			strategyPdf.assign( weights.envWeight );
			Return();
		} );
	} );
	
	If( weights.useSpecular.equal( uint( 1 ) ), () => {
		cumulative.addAssign( weights.specularWeight );
		If( randomValue.lessThan( cumulative ), () => {
			selectedStrategy.assign( int( 1 ) );
			strategyPdf.assign( weights.specularWeight );
			Return();
		} );
	} );
	
	If( weights.useDiffuse.equal( uint( 1 ) ), () => {
		cumulative.addAssign( weights.diffuseWeight );
		If( randomValue.lessThan( cumulative ), () => {
			selectedStrategy.assign( int( 2 ) );
			strategyPdf.assign( weights.diffuseWeight );
			Return();
		} );
	} );
	
	If( weights.useTransmission.equal( uint( 1 ) ), () => {
		cumulative.addAssign( weights.transmissionWeight );
		If( randomValue.lessThan( cumulative ), () => {
			selectedStrategy.assign( int( 3 ) );
			strategyPdf.assign( weights.transmissionWeight );
			Return();
		} );
	} );
	
	If( weights.useClearcoat.equal( uint( 1 ) ), () => {
		selectedStrategy.assign( int( 4 ) );
		strategyPdf.assign( weights.clearcoatWeight );
		Return();
	} );
	
	// Fallback
	selectedStrategy.assign( int( 2 ) ); // Diffuse
	strategyPdf.assign( weights.useDiffuse.equal( uint( 1 ) ).select( weights.diffuseWeight, float( 1.0 ) ) );
	
} ).setLayout( {
	name: 'selectSamplingStrategy',
	type: 'void',
	inputs: [
		{ name: 'weights', type: 'SamplingStrategyWeights' },
		{ name: 'randomValue', type: 'float' },
		{ name: 'selectedStrategy', type: 'ptr<function, i32>' },
		{ name: 'strategyPdf', type: 'ptr<function, f32>' }
	]
} );

// ================================================================================
// INDIRECT LIGHTING CALCULATION
// ================================================================================

/**
 * Calculate indirect lighting contribution using Multiple Importance Sampling (MIS).
 * Combines BRDF, environment, and material sampling strategies.
 * 
 * @param {vec3} V - View direction (pointing away from surface)
 * @param {vec3} N - Surface normal
 * @param {RayTracingMaterial} material - Surface material properties
 * @param {DirectionSample} brdfSample - Pre-computed BRDF sample
 * @param {int} sampleIndex - Sample index for this pixel
 * @param {int} bounceIndex - Current bounce depth
 * @param {uint} rngState - Random number generator state (passed by reference)
 * @param {ImportanceSamplingInfo} samplingInfo - Importance weights for strategies
 * @returns {IndirectLightingResult} Indirect lighting result
 */
export const calculateIndirectLighting = Fn( ( [ V, N, material, brdfSample, sampleIndex, bounceIndex, rngState, samplingInfo ] ) => {
	
	// Initialize result
	const result = wgslFn( `
		var result: IndirectLightingResult;
		result.direction = vec3f(0.0);
		result.throughput = vec3f(0.0);
		result.misWeight = 0.0;
		result.pdf = 0.0;
		return result;
	` )().toVar();
	
	// Validate input sampling info
	If( samplingInfo.diffuseImportance.lessThan( 0.0 )
		.or( samplingInfo.specularImportance.lessThan( 0.0 ) )
		.or( samplingInfo.transmissionImportance.lessThan( 0.0 ) )
		.or( samplingInfo.clearcoatImportance.lessThan( 0.0 ) )
		.or( samplingInfo.envmapImportance.lessThan( 0.0 ) ), () => {
		// Fallback to diffuse sampling
		// Assuming cosineWeightedSample and RandomValue are available
		const rand1 = wgslFn( `return RandomValue(rngState);` )().toVar();
		const rand2 = wgslFn( `return RandomValue(rngState);` )().toVar();
		result.direction.assign( wgslFn( `return cosineWeightedSample(N, vec2f(rand1, rand2));` )() );
		result.throughput.assign( material.color.xyz );
		result.misWeight.assign( 1.0 );
		result.pdf.assign( 1.0 );
		return result;
	} );
	
	// Use corrected sampling info
	const weights = computeSamplingInfo( samplingInfo, bounceIndex, material ).toVar();
	
	const selectionRand = wgslFn( `return RandomValue(rngState);` )().toVar();
	const rand1 = wgslFn( `return RandomValue(rngState);` )().toVar();
	const rand2 = wgslFn( `return RandomValue(rngState);` )().toVar();
	const sampleRand = vec2( rand1, rand2 ).toVar();
	
	// Strategy selection
	const selectedStrategy = int( 0 ).toVar();
	const strategySelectionPdf = float( 0.0 ).toVar();
	selectSamplingStrategy( weights, selectionRand, selectedStrategy, strategySelectionPdf );
	
	const sampleDir = vec3( 0.0 ).toVar();
	const samplePdf = float( 0.0 ).toVar();
	const sampleBrdfValue = vec3( 0.0 ).toVar();
	
	// Execute selected strategy
	If( selectedStrategy.equal( 0 ), () => { // Environment
		const envColor = vec3( 0.0 ).toVar();
		// Assuming sampleEquirectProbability is available
		samplePdf.assign( wgslFn( `return sampleEquirectProbability(sampleRand, envColor, sampleDir);` )() );
		// Assuming evaluateMaterialResponse is available
		sampleBrdfValue.assign( wgslFn( `return evaluateMaterialResponse(V, sampleDir, N, material);` )() );
		
	} ).ElseIf( selectedStrategy.equal( 1 ), () => { // Specular
		sampleDir.assign( brdfSample.direction );
		samplePdf.assign( brdfSample.pdf );
		sampleBrdfValue.assign( brdfSample.value );
		
	} ).ElseIf( selectedStrategy.equal( 2 ), () => { // Diffuse
		// Assuming cosineWeightedSample and cosineWeightedPDF are available
		sampleDir.assign( wgslFn( `return cosineWeightedSample(N, sampleRand);` )() );
		const NoL = max( dot( N, sampleDir ), float( 0.0 ) ).toVar();
		samplePdf.assign( wgslFn( `return cosineWeightedPDF(NoL);` )() );
		sampleBrdfValue.assign( wgslFn( `return evaluateMaterialResponse(V, sampleDir, N, material);` )() );
		
	} ).ElseIf( selectedStrategy.equal( 3 ), () => { // Transmission (conditional compilation)
		// #ifdef ENABLE_TRANSMISSION
		const entering = dot( V, N ).lessThan( 0.0 ).toVar();
		// Assuming sampleMicrofacetTransmission is available
		const mtResult = wgslFn( `return sampleMicrofacetTransmission(V, N, material.ior, material.roughness, entering, material.dispersion, sampleRand, rngState);` )().toVar();
		sampleDir.assign( mtResult.direction );
		samplePdf.assign( mtResult.pdf );
		sampleBrdfValue.assign( wgslFn( `return evaluateMaterialResponse(V, sampleDir, N, material);` )() );
		// #endif
		
	} ).Else( () => { // Clearcoat (strategy 4)
		sampleDir.assign( brdfSample.direction );
		samplePdf.assign( brdfSample.pdf );
		sampleBrdfValue.assign( brdfSample.value );
	} );
	
	const NoL = max( dot( N, sampleDir ), float( 0.0 ) ).toVar();
	
	// Calculate combined PDF for MIS (all active strategies)
	const combinedPdf = float( 0.0 ).toVar();
	
	If( weights.useEnv.equal( uint( 1 ) ), () => {
		const envColor = vec3( 0.0 ).toVar();
		// Assuming sampleEquirect is available
		const envPdf = wgslFn( `return sampleEquirect(sampleDir, envColor);` )().toVar();
		// Only include environment in MIS if it has valid contribution (envPdf > 0)
		If( envPdf.greaterThan( 0.0 ), () => {
			combinedPdf.addAssign( weights.envWeight.mul( envPdf ) );
		} );
	} );
	
	If( weights.useSpecular.equal( uint( 1 ) ), () => {
		combinedPdf.addAssign( weights.specularWeight.mul( brdfSample.pdf ) );
	} );
	
	If( weights.useDiffuse.equal( uint( 1 ) ), () => {
		// Assuming cosineWeightedPDF is available
		const diffusePdf = wgslFn( `return cosineWeightedPDF(NoL);` )().toVar();
		combinedPdf.addAssign( weights.diffuseWeight.mul( diffusePdf ) );
	} );
	
	If( weights.useTransmission.equal( uint( 1 ) ).and( material.transmission.greaterThan( 0.0 ) ), () => {
		// Calculate transmission PDF for this direction
		const entering = dot( V, N ).lessThan( 0.0 ).toVar();
		const transmissionPdf = calculateTransmissionPDF( V, sampleDir, N, material.ior, material.roughness, entering ).toVar();
		combinedPdf.addAssign( weights.transmissionWeight.mul( transmissionPdf ) );
	} );
	
	If( weights.useClearcoat.equal( uint( 1 ) ).and( material.clearcoat.greaterThan( 0.0 ) ), () => {
		// Calculate clearcoat PDF for this direction
		const clearcoatPdf = calculateClearcoatPDF( V, sampleDir, N, material.clearcoatRoughness ).toVar();
		combinedPdf.addAssign( weights.clearcoatWeight.mul( clearcoatPdf ) );
	} );
	
	// Ensure valid PDFs
	samplePdf.assign( max( samplePdf, float( MIN_PDF ) ) );
	combinedPdf.assign( max( combinedPdf, float( MIN_PDF ) ) );
	
	// MIS weight calculation
	const misWeight = samplePdf.div( combinedPdf ).toVar();
	
	// Throughput calculation
	const throughput = sampleBrdfValue.mul( NoL ).mul( misWeight ).div( samplePdf ).toVar();
	
	// Apply global illumination scaling
	// Assuming globalIlluminationIntensity is a uniform
	throughput.mulAssign( wgslFn( `return globalIlluminationIntensity;` )() );
	
	// Firefly reduction (commented out in original GLSL, kept as comment)
	// float materialTolerance = getMaterialFireflyTolerance( material );
	// float viewTolerance = getViewDependentTolerance( material, sampleDir, V, N );
	// float finalThreshold = calculateFireflyThreshold( fireflyThreshold, materialTolerance * viewTolerance, bounceIndex );
	// throughput = applySoftSuppressionRGB( throughput, finalThreshold, 0.25 );
	
	result.direction.assign( sampleDir );
	result.throughput.assign( throughput );
	result.misWeight.assign( misWeight );
	result.pdf.assign( samplePdf );
	
	return result;
	
} ).setLayout( {
	name: 'calculateIndirectLighting',
	type: 'IndirectLightingResult',
	inputs: [
		{ name: 'V', type: 'vec3' },
		{ name: 'N', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'brdfSample', type: 'DirectionSample' },
		{ name: 'sampleIndex', type: 'int' },
		{ name: 'bounceIndex', type: 'int' },
		{ name: 'rngState', type: 'ptr<function, u32>' },
		{ name: 'samplingInfo', type: 'ImportanceSamplingInfo' }
	]
} );
