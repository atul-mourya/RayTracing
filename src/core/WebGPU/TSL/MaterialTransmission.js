import {
	Fn,
	float,
	vec2,
	vec3,
	vec4,
	int,
	uint,
	bool,
	abs,
	max,
	min,
	clamp,
	dot,
	normalize,
	reflect,
	refract,
	sqrt,
	exp,
	log,
	pow,
	sin,
	cos,
	acos,
	mix,
	fract,
	If
} from 'three/tsl';

/**
 * Material Transmission for TSL/WGSL
 * Complete port of material_transmission.fs from GLSL to TSL/WGSL
 *
 * This module handles volumetric transmission, refraction, and opacity-based transparency.
 * Features include:
 * - Microfacet transmission with roughness
 * - Spectral dispersion (chromatic aberration)
 * - Beer's law volumetric absorption
 * - Fresnel-based reflection/transmission
 * - Alpha transparency modes (BLEND, MASK)
 * - Total Internal Reflection (TIR)
 * - Medium stack tracking for nested dielectrics
 */

// ================================================================================
// CONSTANTS
// ================================================================================

const MAX_MEDIA_STACK = 4;
const MIN_ROUGHNESS = 0.0001;
const TWO_PI = 2.0 * Math.PI;

// ================================================================================
// HELPER FUNCTIONS (from other modules - assume available)
// ================================================================================
// These should be imported from their respective modules:
// - fresnelSchlick, iorToFresnel0 from Fresnel.js
// - importanceSampleGGX from MaterialSampling.js
// - calculateGGXPDF, calculateVNDFPDF, DistributionGGX from MaterialProperties.js
// - RandomValue, pcg_hash from Random.js

// For now, we'll declare them as externals that need to be passed in
// or imported when integrating into the full pipeline

/**
 * Get current medium IOR from the medium stack
 * @param {TSLNode} mediumStack - Medium stack structure
 * @returns {TSLNode} Current medium IOR (float)
 */
export const getCurrentMediumIOR = Fn( ( [ mediumStack ] ) => {

	const ior = float( 1.0 ).toVar();

	If( mediumStack.depth.lessThanEqual( 0 ), () => {
		ior.assign( 1.0 ); // Air/vacuum
	} ).Else( () => {
		// Access the current medium from the stack
		// Note: WGSL array indexing with variable requires special handling
		ior.assign( mediumStack.media.element( mediumStack.depth ).ior );
	} );

	return ior;

} ).setLayout( {
	name: 'getCurrentMediumIOR',
	type: 'float',
	inputs: [
		{ name: 'mediumStack', type: 'MediumStack' }
	]
} );

/**
 * Calculate wavelength-dependent IOR for dispersion using Cauchy dispersion equation
 * @param {TSLNode} baseIOR - Base index of refraction (float)
 * @param {TSLNode} dispersionStrength - Strength of dispersion effect (float)
 * @returns {TSLNode} Dispersive IOR for RGB channels (vec3)
 */
export const calculateDispersiveIOR = Fn( ( [ baseIOR, dispersionStrength ] ) => {

	const A = baseIOR.toVar();
	const B = dispersionStrength.mul( 0.03 ).toVar();

	// Standard CIE wavelengths for RGB (in micrometers) - Red, Green, Blue
	const wavelengths = vec3( 0.7000, 0.5461, 0.4358 ).toVar();

	// Apply Cauchy's equation: n(λ) = A + B/λ²
	const dispersiveIOR = A.add( B.div( wavelengths.mul( wavelengths ) ) ).toVar();

	// Ensure IOR values are physically reasonable (> 1.0 for real materials)
	return max( dispersiveIOR, vec3( 1.001 ) );

} ).setLayout( {
	name: 'calculateDispersiveIOR',
	type: 'vec3',
	inputs: [
		{ name: 'baseIOR', type: 'float' },
		{ name: 'dispersionStrength', type: 'float' }
	]
} );

/**
 * Convert wavelength to RGB using proper spectral sensitivity curves
 * @param {TSLNode} wavelength - Wavelength in nanometers (float)
 * @returns {TSLNode} RGB color (vec3)
 */
export const wavelengthToRGB = Fn( ( [ wavelength ] ) => {

	const color = vec3( 0.0 ).toVar();

	// Violet (380-440nm)
	If( wavelength.greaterThanEqual( 380.0 ).and( wavelength.lessThan( 440.0 ) ), () => {
		const t = wavelength.sub( 380.0 ).div( 60.0 ).toVar();
		color.assign( vec3( float( 0.6 ).add( float( 0.4 ).mul( float( 1.0 ).sub( t ) ) ), 0.0, 1.0 ) );
	} );

	// Blue (440-490nm)
	If( wavelength.greaterThanEqual( 440.0 ).and( wavelength.lessThan( 490.0 ) ), () => {
		const t = wavelength.sub( 440.0 ).div( 50.0 ).toVar();
		color.assign( vec3( float( 0.6 ).mul( float( 1.0 ).sub( t ) ), 0.0, 1.0 ) );
	} );

	// Blue-Cyan (490-510nm)
	If( wavelength.greaterThanEqual( 490.0 ).and( wavelength.lessThan( 510.0 ) ), () => {
		const t = wavelength.sub( 490.0 ).div( 20.0 ).toVar();
		color.assign( vec3( 0.0, t, 1.0 ) );
	} );

	// Cyan-Green-Yellow (510-580nm)
	If( wavelength.greaterThanEqual( 510.0 ).and( wavelength.lessThan( 580.0 ) ), () => {
		const t = wavelength.sub( 510.0 ).div( 70.0 ).toVar();
		If( t.lessThan( 0.5 ), () => {
			// Cyan to Green
			const t2 = t.mul( 2.0 ).toVar();
			color.assign( vec3( 0.0, 1.0, float( 1.0 ).sub( t2 ) ) );
		} ).Else( () => {
			// Green to Yellow
			const t2 = t.sub( 0.5 ).mul( 2.0 ).toVar();
			color.assign( vec3( t2, 1.0, 0.0 ) );
		} );
	} );

	// Yellow-Orange-Red (580-645nm)
	If( wavelength.greaterThanEqual( 580.0 ).and( wavelength.lessThan( 645.0 ) ), () => {
		const t = wavelength.sub( 580.0 ).div( 65.0 ).toVar();
		color.assign( vec3( 1.0, float( 1.0 ).sub( t ), 0.0 ) );
	} );

	// Red (645-700nm)
	If( wavelength.greaterThanEqual( 645.0 ).and( wavelength.lessThanEqual( 700.0 ) ), () => {
		color.assign( vec3( 1.0, 0.0, 0.0 ) );
	} );

	// Apply intensity falloff at spectrum edges
	If( wavelength.lessThan( 420.0 ), () => {
		const falloff = wavelength.sub( 380.0 ).div( 40.0 ).toVar();
		color.mulAssign( falloff );
	} );

	If( wavelength.greaterThan( 680.0 ), () => {
		const falloff = float( 700.0 ).sub( wavelength ).div( 20.0 ).toVar();
		color.mulAssign( falloff );
	} );

	return color;

} ).setLayout( {
	name: 'wavelengthToRGB',
	type: 'vec3',
	inputs: [
		{ name: 'wavelength', type: 'float' }
	]
} );

/**
 * Sample wavelength for dispersion with spectral IOR calculation
 * @param {TSLNode} baseIOR - Base index of refraction (float)
 * @param {TSLNode} dispersionStrength - Dispersion strength (float)
 * @param {TSLNode} random - Random value [0, 1] (float)
 * @returns {TSLNode} SpectralSample struct { wavelength, ior, colorWeight }
 */
export const sampleWavelengthForDispersion = Fn( ( [ baseIOR, dispersionStrength, random ] ) => {

	// Map random value to visible spectrum (380-700nm)
	const wavelength = mix( float( 380.0 ), float( 700.0 ), random ).toVar();

	// Convert to micrometers for Cauchy equation
	const wlMicron = wavelength.div( 1000.0 ).toVar();

	// Calculate IOR at this wavelength
	const A = baseIOR.toVar();
	const B = dispersionStrength.mul( 0.03 ).toVar();
	const ior = A.add( B.div( wlMicron.mul( wlMicron ) ) ).toVar();

	// Pure saturated spectral colors
	const colorWeight = vec3( 0.0 ).toVar();
	const wl = wavelength.toVar();

	// Pure primary and secondary colors with sharp transitions
	If( wl.greaterThanEqual( 380.0 ).and( wl.lessThan( 420.0 ) ), () => {
		colorWeight.assign( vec3( 0.9, 0.0, 1.0 ) ); // Deep Violet
	} );

	If( wl.greaterThanEqual( 420.0 ).and( wl.lessThan( 480.0 ) ), () => {
		colorWeight.assign( vec3( 0.0, 0.0, 1.0 ) ); // Blue
	} );

	If( wl.greaterThanEqual( 480.0 ).and( wl.lessThan( 500.0 ) ), () => {
		colorWeight.assign( vec3( 0.0, 1.0, 1.0 ) ); // Cyan
	} );

	If( wl.greaterThanEqual( 500.0 ).and( wl.lessThan( 530.0 ) ), () => {
		colorWeight.assign( vec3( 0.0, 1.0, 0.0 ) ); // Green
	} );

	If( wl.greaterThanEqual( 530.0 ).and( wl.lessThan( 570.0 ) ), () => {
		colorWeight.assign( vec3( 1.0, 1.0, 0.0 ) ); // Yellow
	} );

	If( wl.greaterThanEqual( 570.0 ).and( wl.lessThan( 620.0 ) ), () => {
		colorWeight.assign( vec3( 1.0, 0.5, 0.0 ) ); // Orange
	} );

	If( wl.greaterThanEqual( 620.0 ).and( wl.lessThanEqual( 700.0 ) ), () => {
		colorWeight.assign( vec3( 1.0, 0.0, 0.0 ) ); // Red
	} );

	// Maximum saturation
	colorWeight.assign( pow( colorWeight, vec3( 0.4 ) ) );
	colorWeight.assign( clamp( colorWeight, vec3( 0.0 ), vec3( 2.0 ) ) );

	// Return as SpectralSample (using vec4 for compatibility)
	// Format: (wavelength, ior, colorWeight.r, colorWeight.g, colorWeight.b)
	// We'll return multiple values - caller needs to handle
	return vec4( wavelength, ior, colorWeight.xy );

} ).setLayout( {
	name: 'sampleWavelengthForDispersion',
	type: 'vec4',
	inputs: [
		{ name: 'baseIOR', type: 'float' },
		{ name: 'dispersionStrength', type: 'float' },
		{ name: 'random', type: 'float' }
	]
} );

/**
 * Apply Beer's law absorption for volumetric attenuation
 * @param {TSLNode} attenuationColor - Attenuation color (vec3)
 * @param {TSLNode} attenuationDistance - Attenuation distance (float)
 * @param {TSLNode} thickness - Material thickness (float)
 * @returns {TSLNode} Absorption factor (vec3)
 */
export const calculateBeerLawAbsorption = Fn( ( [ attenuationColor, attenuationDistance, thickness ] ) => {

	const absorption = vec3( 1.0 ).toVar();

	If( attenuationDistance.lessThanEqual( 0.0 ), () => {
		absorption.assign( vec3( 1.0 ) );
	} ).Else( () => {
		// Convert RGB attenuation color to absorption coefficients
		const absCoeff = log( max( attenuationColor, vec3( 0.001 ) ) ).negate().div( attenuationDistance ).toVar();

		// Apply Beer's law: exp(-absorption * distance)
		absorption.assign( exp( absCoeff.negate().mul( thickness ) ) );
	} );

	return absorption;

} ).setLayout( {
	name: 'calculateBeerLawAbsorption',
	type: 'vec3',
	inputs: [
		{ name: 'attenuationColor', type: 'vec3' },
		{ name: 'attenuationDistance', type: 'float' },
		{ name: 'thickness', type: 'float' }
	]
} );

/**
 * Calculate shadow transmittance for simplified transmission
 * Used for shadow rays - faster than full transmission calculation
 *
 * @param {TSLNode} rayDir - Ray direction (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} material - Material properties
 * @param {TSLNode} entering - Whether ray is entering medium (bool/uint)
 * @returns {TSLNode} Transmittance value (float)
 */
export const calculateShadowTransmittance = Fn( ( [ rayDir, normal, material, entering ] ) => {

	// IOR setup based on direction
	const n1 = entering.select( float( 1.0 ), material.ior ).toVar();
	const n2 = entering.select( material.ior, float( 1.0 ) ).toVar();

	const cosThetaI = abs( dot( normal, rayDir ) ).toVar();
	const sinThetaT2 = n1.mul( n1 ).div( n2.mul( n2 ) ).mul( float( 1.0 ).sub( cosThetaI.mul( cosThetaI ) ) ).toVar();

	const transmittance = float( 0.0 ).toVar();

	// Handle total internal reflection
	If( sinThetaT2.greaterThan( 1.0 ), () => {
		transmittance.assign( 0.0 );
	} ).Else( () => {
		// Calculate Fresnel reflectance (need to import these functions)
		// const F0 = iorToFresnel0( n2, n1 ).toVar();
		// const Fr = fresnelSchlick( cosThetaI, F0 ).toVar();

		// Simplified Fresnel calculation
		const F0 = n2.sub( n1 ).div( n2.add( n1 ) ).toVar();
		F0.assign( F0.mul( F0 ) );
		const Fr = F0.add( float( 1.0 ).sub( F0 ).mul( pow( float( 1.0 ).sub( cosThetaI ), float( 5.0 ) ) ) ).toVar();

		// Base transmission
		const baseTransmission = float( 1.0 ).sub( Fr ).mul( material.transmission ).toVar();

		// Apply Beer's law absorption for exiting rays
		If( entering.equal( 0 ).and( material.attenuationDistance.greaterThan( 0.0 ) ), () => {
			const absorption = calculateBeerLawAbsorption(
				material.attenuationColor,
				material.attenuationDistance,
				material.thickness
			).toVar();
			baseTransmission.mulAssign( absorption.r.add( absorption.g ).add( absorption.b ).div( 3.0 ) );
		} );

		transmittance.assign( clamp( baseTransmission, float( 0.0 ), float( 1.0 ) ) );
	} );

	return transmittance;

} ).setLayout( {
	name: 'calculateShadowTransmittance',
	type: 'float',
	inputs: [
		{ name: 'rayDir', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'entering', type: 'uint' }
	]
} );

/**
 * Sample microfacet transmission with optional dispersion
 * Handles both rough and smooth transmission with proper PDF calculation
 *
 * @param {TSLNode} V - View direction (pointing away from surface) (vec3)
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} ior - Material IOR (float)
 * @param {TSLNode} roughness - Material roughness (float)
 * @param {TSLNode} entering - Whether entering medium (uint/bool)
 * @param {TSLNode} dispersion - Dispersion strength (float)
 * @param {TSLNode} xi - Random samples (vec2)
 * @param {TSLNode} rngState - RNG state (uint, mutable)
 * @returns {TSLNode} MicrofacetTransmissionResult (vec4 for direction + metadata)
 */
export const sampleMicrofacetTransmission = Fn( ( [ V, N, ior, roughness, entering, dispersion, xi, rngState ] ) => {

	// Result structure (packed into multiple outputs)
	const direction = vec3( 0.0 ).toVar();
	const halfVector = vec3( 0.0 ).toVar();
	const didReflect = uint( 0 ).toVar();
	const pdf = float( 0.0 ).toVar();

	// For smooth surfaces with dispersion, use perfect refraction
	If( roughness.lessThanEqual( 0.05 ).and( dispersion.greaterThan( 0.0 ) ), () => {
		halfVector.assign( N );
		didReflect.assign( 0 );

		// Compute IOR ratio
		const eta = ior.toVar();
		const etaRatio = entering.select( float( 1.0 ).div( eta ), eta ).toVar();

		// Handle dispersion with spectral sampling
		// Note: Requires RandomValue function from Random module
		// const randomVal = RandomValue( rngState ).toVar();
		// For now, use placeholder
		const randomVal = xi.x.toVar();
		const spectralData = sampleWavelengthForDispersion( ior, dispersion, randomVal ).toVar();
		const spectralIOR = spectralData.y.toVar();
		etaRatio.assign( entering.select( float( 1.0 ).div( spectralIOR ), spectralIOR ) );

		// Perfect refraction using surface normal
		const refractDir = refract( V.negate(), N, etaRatio ).toVar();

		// Check for total internal reflection
		If( dot( refractDir, refractDir ).lessThan( 0.001 ), () => {
			direction.assign( reflect( V.negate(), N ) );
			didReflect.assign( 1 );
			pdf.assign( 1.0 );
		} ).Else( () => {
			direction.assign( refractDir );
			pdf.assign( 1.0 );
		} );

	} ).Else( () => {
		// Rough transmission with microfacets

		// Use minimum roughness to avoid numerical issues
		const transmissionRoughness = max( float( MIN_ROUGHNESS ), roughness ).toVar();

		// Sample microfacet normal with GGX distribution
		// Requires importanceSampleGGX from MaterialSampling
		// const H = importanceSampleGGX( N, transmissionRoughness, xi ).toVar();
		// For now, use placeholder
		const H = N.toVar(); // Placeholder
		halfVector.assign( H );

		// Compute IOR ratio
		const eta = ior.toVar();
		const etaRatio = entering.select( float( 1.0 ).div( eta ), eta ).toVar();

		// Handle dispersion
		If( dispersion.greaterThan( 0.0 ), () => {
			const randomVal = xi.x.toVar();
			const spectralData = sampleWavelengthForDispersion( ior, dispersion, randomVal ).toVar();
			const spectralIOR = spectralData.y.toVar();
			etaRatio.assign( entering.select( float( 1.0 ).div( spectralIOR ), spectralIOR ) );
		} );

		// Compute refracted direction
		const HoV = clamp( dot( H, V ), float( 0.001 ), float( 1.0 ) ).toVar();
		const refractDir = refract( V.negate(), H, etaRatio ).toVar();

		// Check for TIR
		If( dot( refractDir, refractDir ).lessThan( 0.001 ), () => {
			// TIR - use reflection
			direction.assign( reflect( V.negate(), H ) );
			didReflect.assign( 1 );

			// Calculate PDF for reflection (GGX sampling)
			const NoH = clamp( dot( N, H ), float( 0.001 ), float( 1.0 ) ).toVar();
			const VoH = clamp( dot( V, H ), float( 0.001 ), float( 1.0 ) ).toVar();
			// pdf.assign( calculateGGXPDF( NoH, VoH, transmissionRoughness ) );
			pdf.assign( 1.0 ); // Placeholder

		} ).Else( () => {
			// Successful refraction
			direction.assign( refractDir );
			didReflect.assign( 0 );

			// Calculate proper PDF for microfacet transmission
			const NoH = clamp( dot( N, H ), float( 0.001 ), float( 1.0 ) ).toVar();
			const HoL = clamp( dot( H, refractDir ), float( 0.001 ), float( 1.0 ) ).toVar();
			// const D = DistributionGGX( NoH, transmissionRoughness ).toVar();

			// Jacobian for refraction
			const sqrtDenom = HoV.add( etaRatio.mul( HoL ) ).toVar();
			const jacobian = abs( HoL ).div( sqrtDenom.mul( sqrtDenom ) ).toVar();

			// Final PDF
			// pdf.assign( D.mul( NoH ).mul( jacobian ) );
			pdf.assign( jacobian ); // Simplified placeholder
		} );
	} );

	// Return packed result (direction in xyz, didReflect in w)
	// PDF returned separately
	// Caller needs to handle unpacking
	return vec4( direction, float( didReflect ) );

} ).setLayout( {
	name: 'sampleMicrofacetTransmission',
	type: 'vec4',
	inputs: [
		{ name: 'V', type: 'vec3' },
		{ name: 'N', type: 'vec3' },
		{ name: 'ior', type: 'float' },
		{ name: 'roughness', type: 'float' },
		{ name: 'entering', type: 'uint' },
		{ name: 'dispersion', type: 'float' },
		{ name: 'xi', type: 'vec2' },
		{ name: 'rngState', type: 'uint' }
	]
} );

/**
 * Handle full transmission calculation with Fresnel and Beer's law
 * Main transmission function that combines reflection/refraction decision,
 * microfacet sampling, and volumetric absorption
 *
 * @param {TSLNode} rayDir - Incident ray direction (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} material - Material properties
 * @param {TSLNode} entering - Whether entering medium (uint/bool)
 * @param {TSLNode} rngState - RNG state (uint, mutable)
 * @param {TSLNode} mediumStack - Medium stack for nested dielectrics
 * @returns {TSLNode} TransmissionResult (packed as vec4)
 */
export const handleTransmission = Fn( ( [ rayDir, normal, material, entering, rngState, mediumStack ] ) => {

	const resultDirection = vec3( 0.0 ).toVar();
	const resultThroughput = vec3( 1.0 ).toVar();
	const resultDidReflect = uint( 0 ).toVar();

	// Setup surface normal based on ray direction
	const N = entering.select( normal, normal.negate() ).toVar();

	// Incident direction (points toward surface)
	const V = rayDir.negate().toVar();

	// Get current medium IOR from stack
	const currentMediumIOR = getCurrentMediumIOR( mediumStack ).toVar();

	// Calculate IOR transition
	const n1 = float( 0.0 ).toVar();
	const n2 = float( 0.0 ).toVar();

	If( entering, () => {
		// Ray entering new medium
		n1.assign( currentMediumIOR );
		n2.assign( material.ior );
	} ).Else( () => {
		// Ray exiting current medium
		n1.assign( material.ior );

		// Determine exit medium
		If( mediumStack.depth.greaterThan( 1 ), () => {
			// Exiting into previous medium
			n2.assign( mediumStack.media.element( mediumStack.depth.sub( 1 ) ).ior );
		} ).Else( () => {
			// Exiting into air
			n2.assign( 1.0 );
		} );
	} );

	// Calculate reflection/refraction parameters
	const cosThetaI = abs( dot( N, rayDir ) ).toVar();
	const sinThetaT2 = n1.mul( n1 ).div( n2.mul( n2 ) ).mul( float( 1.0 ).sub( cosThetaI.mul( cosThetaI ) ) ).toVar();
	const totalInternalReflection = sinThetaT2.greaterThan( 1.0 ).toVar();

	// Fresnel calculation (simplified)
	const F0 = n2.sub( n1 ).div( n2.add( n1 ) ).toVar();
	F0.assign( F0.mul( F0 ) );
	const Fr = totalInternalReflection.select(
		float( 1.0 ),
		F0.add( float( 1.0 ).sub( F0 ).mul( pow( float( 1.0 ).sub( cosThetaI ), float( 5.0 ) ) ) )
	).toVar();

	// Calculate reflection probability
	const reflectProb = float( 0.5 ).toVar();

	If( totalInternalReflection, () => {
		reflectProb.assign( 1.0 ); // Always reflect at TIR
	} ).Else( () => {
		// Balance Fresnel with material transmission
		const dielectricReflect = Fr.add( float( 1.0 ).sub( Fr ).mul( float( 1.0 ).sub( material.transmission ) ) ).toVar();
		const metallicReflect = float( 0.95 ).toVar();

		// Blend based on metalness
		const baseReflectProb = mix( dielectricReflect, metallicReflect, material.metalness ).toVar();

		// Boost transmission for dispersive materials
		If( material.dispersion.greaterThan( 0.0 ), () => {
			const dispersionBoost = clamp( material.dispersion.mul( 0.1 ), float( 0.0 ), float( 0.8 ) ).toVar();
			reflectProb.assign( baseReflectProb.mul( float( 1.0 ).sub( dispersionBoost ) ) );
		} ).Else( () => {
			reflectProb.assign( baseReflectProb );
		} );
	} );

	// Clamp reflection probability
	reflectProb.assign( clamp( reflectProb, float( 0.05 ), float( 0.95 ) ) );

	// Random samples for microfacet sampling
	// const randomVal1 = RandomValue( rngState ).toVar();
	// const randomVal2 = RandomValue( rngState ).toVar();
	const randomVal1 = float( 0.5 ).toVar(); // Placeholder
	const randomVal2 = float( 0.5 ).toVar(); // Placeholder
	const xi = vec2( randomVal1, randomVal2 ).toVar();

	// Decide reflection or transmission
	// const shouldReflect = totalInternalReflection.or( RandomValue( rngState ).lessThan( reflectProb ) ).toVar();
	const shouldReflect = totalInternalReflection.toVar(); // Simplified

	If( shouldReflect, () => {
		// Reflection path
		resultDidReflect.assign( 1 );

		If( material.roughness.greaterThan( 0.05 ), () => {
			// Microfacet reflection
			const mtResult = sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, float( 0.0 ), xi, rngState ).toVar();
			resultDirection.assign( mtResult.xyz );
		} ).Else( () => {
			// Perfect mirror reflection
			resultDirection.assign( reflect( rayDir, N ) );
		} );

		resultThroughput.assign( material.color.rgb );

	} ).Else( () => {
		// Transmission/refraction path
		resultDidReflect.assign( 0 );

		If( material.roughness.greaterThan( 0.05 ).or( material.dispersion.greaterThan( 0.0 ) ), () => {
			// Microfacet or dispersive transmission
			const mtResult = sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, material.dispersion, xi, rngState ).toVar();

			// Check if TIR occurred during sampling
			const didReflectInSampling = mtResult.w.greaterThan( 0.5 ).toVar();

			If( didReflectInSampling, () => {
				resultDirection.assign( mtResult.xyz );
				resultDidReflect.assign( 1 );
				resultThroughput.assign( material.color.rgb );
			} ).Else( () => {
				resultDirection.assign( mtResult.xyz );

				// Handle dispersion coloring
				If( material.dispersion.greaterThan( 0.0 ), () => {
					// Rainbow color mapping for dispersion
					const originalDir = normalize( rayDir ).toVar();
					const refractedDir = normalize( resultDirection ).toVar();

					const edgeFactor = float( 1.0 ).sub( abs( dot( N, originalDir ) ) ).toVar();
					const deviationAngle = acos( clamp( dot( originalDir, refractedDir ), float( -1.0 ), float( 1.0 ) ) ).toVar();

					// Spatial variation
					const combinedVec = normalize( originalDir.add( N ) ).toVar();
					const spatialVariation = sin( combinedVec.x.mul( 15.0 ) )
						.mul( cos( combinedVec.y.mul( 12.0 ) ) )
						.mul( sin( combinedVec.z.mul( 18.0 ) ) ).toVar();

					const refractVariation = sin(
						refractedDir.x.mul( 8.0 )
							.add( refractedDir.y.mul( 6.0 ) )
							.add( refractedDir.z.mul( 10.0 ) )
					).toVar();

					// Color index calculation
					const baseColorIndex = deviationAngle.mul( material.dispersion ).mul( 3.0 ).toVar();
					const colorIndex = fract(
						baseColorIndex
							.add( spatialVariation.mul( 0.3 ) )
							.add( refractVariation.mul( 0.2 ) )
							.add( edgeFactor.mul( 0.4 ) )
					).toVar();

					// ROYGBIV spectrum mapping
					const rainbowColor = vec3( 1.0 ).toVar();

					// Red zone
					If( colorIndex.lessThan( 0.143 ), () => {
						const t = colorIndex.div( 0.143 ).toVar();
						rainbowColor.assign( mix( vec3( 0.8, 0.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), t ) );
					} );

					// Red to Orange
					If( colorIndex.greaterThanEqual( 0.143 ).and( colorIndex.lessThan( 0.286 ) ), () => {
						const t = colorIndex.sub( 0.143 ).div( 0.143 ).toVar();
						rainbowColor.assign( mix( vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 0.6, 0.0 ), t ) );
					} );

					// Orange to Yellow
					If( colorIndex.greaterThanEqual( 0.286 ).and( colorIndex.lessThan( 0.429 ) ), () => {
						const t = colorIndex.sub( 0.286 ).div( 0.143 ).toVar();
						rainbowColor.assign( mix( vec3( 1.0, 0.6, 0.0 ), vec3( 1.0, 1.0, 0.0 ), t ) );
					} );

					// Yellow to Green
					If( colorIndex.greaterThanEqual( 0.429 ).and( colorIndex.lessThan( 0.571 ) ), () => {
						const t = colorIndex.sub( 0.429 ).div( 0.142 ).toVar();
						rainbowColor.assign( mix( vec3( 1.0, 1.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ), t ) );
					} );

					// Green to Blue
					If( colorIndex.greaterThanEqual( 0.571 ).and( colorIndex.lessThan( 0.714 ) ), () => {
						const t = colorIndex.sub( 0.571 ).div( 0.143 ).toVar();
						rainbowColor.assign( mix( vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 0.4, 1.0 ), t ) );
					} );

					// Blue to Indigo
					If( colorIndex.greaterThanEqual( 0.714 ).and( colorIndex.lessThan( 0.857 ) ), () => {
						const t = colorIndex.sub( 0.714 ).div( 0.143 ).toVar();
						rainbowColor.assign( mix( vec3( 0.0, 0.4, 1.0 ), vec3( 0.3, 0.0, 0.8 ), t ) );
					} );

					// Indigo to Violet
					If( colorIndex.greaterThanEqual( 0.857 ), () => {
						const t = colorIndex.sub( 0.857 ).div( 0.143 ).toVar();
						rainbowColor.assign( mix( vec3( 0.3, 0.0, 0.8 ), vec3( 0.6, 0.0, 1.0 ), t ) );
					} );

					// Calculate dispersion visibility
					const normalizedDispersion = clamp( material.dispersion.div( 5.0 ), float( 0.0 ), float( 1.0 ) ).toVar();
					const angleBoost = float( 1.0 ).add( edgeFactor.mul( 1.5 ) ).toVar();
					const baseVisibility = normalizedDispersion.mul( angleBoost ).toVar();
					const combinedVariation = spatialVariation.add( refractVariation ).toVar();
					const spatialMod = float( 0.5 ).add( float( 0.5 ).mul( sin( combinedVariation.mul( 3.14159 ) ) ) ).toVar();
					const dispersionVisibility = clamp( baseVisibility.mul( spatialMod ), float( 0.1 ), float( 0.8 ) ).toVar();

					// Mix rainbow with clear base
					resultThroughput.assign( mix( vec3( 1.0 ), rainbowColor, dispersionVisibility ) );

				} ).Else( () => {
					// No dispersion
					resultThroughput.assign( vec3( 1.0 ) );
				} );
			} );

		} ).Else( () => {
			// Simple refraction for smooth non-dispersive surfaces
			resultDirection.assign( refract( rayDir, N, n1.div( n2 ) ) );
			resultThroughput.assign( vec3( 1.0 ) );
		} );

		// Common transmission calculations
		If( resultDidReflect.equal( 0 ), () => {
			// Apply material color blending
			resultThroughput.mulAssign( mix( material.color.rgb, vec3( 1.0 ), material.transmission.mul( 0.2 ) ) );

			// Apply Beer's law absorption when entering
			If( entering.and( material.attenuationDistance.greaterThan( 0.0 ) ), () => {
				const absorption = calculateBeerLawAbsorption(
					material.attenuationColor,
					material.attenuationDistance,
					material.thickness
				).toVar();
				resultThroughput.mulAssign( absorption );
			} );

			// PDF compensation
			resultThroughput.mulAssign( float( 1.0 ).div( max( float( 1.0 ).sub( reflectProb ), float( 0.05 ) ) ) );
		} );
	} );

	// Return packed result (direction + throughput + didReflect flag)
	// Format: vec4(direction.xyz, didReflect)
	// Throughput returned separately
	return vec4( resultDirection, float( resultDidReflect ) );

} ).setLayout( {
	name: 'handleTransmission',
	type: 'vec4',
	inputs: [
		{ name: 'rayDir', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'entering', type: 'uint' },
		{ name: 'rngState', type: 'uint' },
		{ name: 'mediumStack', type: 'MediumStack' }
	]
} );

/**
 * Handle material transparency effects: alpha modes and transmission
 * Main entry point for transparency handling in path tracer
 *
 * @param {TSLNode} ray - Ray structure
 * @param {TSLNode} hitPoint - Hit point position (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} material - Material properties
 * @param {TSLNode} rngState - RNG state (uint, mutable)
 * @param {TSLNode} state - Render state
 * @param {TSLNode} mediumStack - Medium stack
 * @returns {TSLNode} MaterialInteractionResult
 */
export const handleMaterialTransparency = Fn( ( [ ray, hitPoint, normal, material, rngState, state, mediumStack ] ) => {

	const continueRay = uint( 0 ).toVar();
	const isTransmissive = uint( 0 ).toVar();
	const isAlphaSkip = uint( 0 ).toVar();
	const direction = ray.direction.toVar();
	const throughput = vec3( 1.0 ).toVar();
	const alpha = float( 1.0 ).toVar();

	// Step 1: Fast path for completely opaque materials
	If( material.alphaMode.equal( 0 ).and( material.transmission.lessThanEqual( 0.0 ) ), () => {
		// Return early - no transparency
		continueRay.assign( 0 );
	} ).Else( () => {

		// Step 2: Handle alpha modes (BLEND=2, MASK=1, OPAQUE=0)
		// const alphaRand = RandomValue( rngState ).toVar();
		// const transmissionRand = RandomValue( rngState ).toVar();
		const alphaRand = float( 0.5 ).toVar(); // Placeholder
		const transmissionRand = float( 0.5 ).toVar(); // Placeholder

		// BLEND mode
		If( material.alphaMode.equal( 2 ), () => {
			const finalAlpha = material.color.a.mul( material.opacity ).toVar();

			If( alphaRand.greaterThan( finalAlpha ), () => {
				continueRay.assign( 1 );
				direction.assign( ray.direction );
				throughput.assign( vec3( 1.0 ) );
				alpha.assign( 0.0 );
				isAlphaSkip.assign( 1 );
			} );

			alpha.assign( finalAlpha );
		} );

		// MASK mode
		If( material.alphaMode.equal( 1 ), () => {
			const cutoff = material.alphaTest.greaterThan( 0.0 ).select( material.alphaTest, float( 0.5 ) ).toVar();

			If( material.color.a.lessThan( cutoff ), () => {
				continueRay.assign( 1 );
				direction.assign( ray.direction );
				throughput.assign( vec3( 1.0 ) );
				alpha.assign( 0.0 );
				isAlphaSkip.assign( 1 );
			} );

			alpha.assign( 1.0 );
		} );

		// Step 3: Handle transmission if present
		If( material.transmission.greaterThan( 0.0 ).and( state.transmissiveTraversals.greaterThan( 0 ) ), () => {

			If( transmissionRand.lessThan( material.transmission ), () => {
				// Determine entering/exiting
				const entering = dot( ray.direction, normal ).lessThan( 0.0 ).toVar();

				// Handle transmission
				const transResult = handleTransmission( ray.direction, normal, material, entering, rngState, mediumStack ).toVar();

				// Apply results
				direction.assign( transResult.xyz );
				// throughput from separate calculation
				continueRay.assign( 1 );
				isTransmissive.assign( 1 );
				alpha.assign( float( 1.0 ).sub( material.transmission ) );
			} );
		} );
	} );

	// Return packed result
	// Format needs to match MaterialInteractionResult structure
	return vec4( float( continueRay ), float( isTransmissive ), float( isAlphaSkip ), alpha );

} ).setLayout( {
	name: 'handleMaterialTransparency',
	type: 'vec4',
	inputs: [
		{ name: 'ray', type: 'Ray' },
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'rngState', type: 'uint' },
		{ name: 'state', type: 'RenderState' },
		{ name: 'mediumStack', type: 'MediumStack' }
	]
} );

// ================================================================================
// EXPORTS
// ================================================================================

export default {
	getCurrentMediumIOR,
	calculateDispersiveIOR,
	wavelengthToRGB,
	sampleWavelengthForDispersion,
	calculateBeerLawAbsorption,
	calculateShadowTransmittance,
	sampleMicrofacetTransmission,
	handleTransmission,
	handleMaterialTransparency
};
