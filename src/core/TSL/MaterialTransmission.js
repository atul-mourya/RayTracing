// Material Transmission & Refraction - Ported from material_transmission.fs
// Handles both volumetric transmission AND opacity-based transparency

import {
	Fn,
	wgslFn,
	vec2,
	vec3,
	vec4,
	float,
	int,
	bool as tslBool,
	uint,
	If,
	Loop,
	select,
	abs,
	acos,
	sin,
	cos,
	dot,
	normalize,
	reflect,
	refract,
	max,
	min,
	mix,
	clamp,
	pow,
	fract,
} from 'three/tsl';

import { struct } from './structProxy.js';
import { Ray, RayTracingMaterial, RenderState, HitInfo, DotProducts, DirectionSample } from './Struct.js';
import { PI, MIN_ROUGHNESS, MIN_CLEARCOAT_ROUGHNESS, computeDotProducts } from './Common.js';
import { iorToFresnel0, fresnelSchlickFloat } from './Fresnel.js';
import { DistributionGGX, calculateGGXPDF } from './MaterialProperties.js';
import { ImportanceSampleGGX } from './MaterialSampling.js';
import { RandomValue, pcgHash } from './Random.js';

// ================================================================================
// STRUCTS (local to transmission)
// ================================================================================

export const TransmissionResult = struct( {
	direction: 'vec3', // New ray direction after transmission/reflection
	throughput: 'vec3', // Color throughput including absorption
	didReflect: 'bool', // Whether the ray was reflected instead of transmitted
} );

export const MaterialInteractionResult = struct( {
	continueRay: 'bool', // Whether the ray should continue without further BRDF evaluation
	isTransmissive: 'bool', // Flag to indicate this was a transmissive interaction
	isAlphaSkip: 'bool', // Flag to indicate this was an alpha skip
	didReflect: 'bool', // Whether TIR/reflection occurred (for medium stack update)
	entering: 'bool', // Whether ray is entering or exiting medium
	direction: 'vec3', // New ray direction if continuing
	throughput: 'vec3', // Color modification for the ray
	alpha: 'float', // Alpha modification
} );

export const Medium = struct( {
	ior: 'float',
	attenuationColor: 'vec3',
	attenuationDistance: 'float',
	dispersion: 'float',
} );

export const SpectralSample = struct( {
	wavelength: 'float', // Wavelength in nanometers
	ior: 'float', // IOR at this wavelength
	colorWeight: 'vec3', // Color contribution weight
} );

export const MicrofacetTransmissionResult = struct( {
	direction: 'vec3', // Refracted/reflected direction
	halfVector: 'vec3', // Sampled half-vector
	didReflect: 'bool', // Whether TIR occurred
	pdf: 'float', // PDF of the sampled direction
} );

// Maximum number of nested media
const MAX_MEDIA_STACK = 4;

// MediumStack as a struct with fixed-size slots
export const MediumStack = struct( {
	m0_ior: 'float',
	m0_attenuationColor: 'vec3',
	m0_attenuationDistance: 'float',
	m0_dispersion: 'float',
	m1_ior: 'float',
	m1_attenuationColor: 'vec3',
	m1_attenuationDistance: 'float',
	m1_dispersion: 'float',
	m2_ior: 'float',
	m2_attenuationColor: 'vec3',
	m2_attenuationDistance: 'float',
	m2_dispersion: 'float',
	m3_ior: 'float',
	m3_attenuationColor: 'vec3',
	m3_attenuationDistance: 'float',
	m3_dispersion: 'float',
	depth: 'int',
} );

// ================================================================================
// MEDIUM STACK HELPERS
// ================================================================================

export const getCurrentMediumIOR = Fn( ( [ mediumStack ] ) => {

	const result = float( 1.0 ).toVar();

	If( mediumStack.depth.greaterThan( int( 0 ) ), () => {

		// Read IOR from current depth
		If( mediumStack.depth.equal( int( 1 ) ), () => {

			result.assign( mediumStack.m1_ior );

		} );
		If( mediumStack.depth.equal( int( 2 ) ), () => {

			result.assign( mediumStack.m2_ior );

		} );
		If( mediumStack.depth.equal( int( 3 ) ), () => {

			result.assign( mediumStack.m3_ior );

		} );

	} );

	return result;

} );

// ================================================================================
// DISPERSION
// ================================================================================

// Calculate wavelength-dependent IOR for dispersion using Cauchy dispersion equation
export const calculateDispersiveIOR = /*@__PURE__*/ wgslFn( `
	fn calculateDispersiveIOR( baseIOR: f32, dispersionStrength: f32 ) -> vec3f {
		let B = dispersionStrength * 0.03f;
		// Standard CIE wavelengths for RGB (in micrometers)
		let wavelengths = vec3f( 0.7000f, 0.5461f, 0.4358f );
		// Apply Cauchy's equation: n(λ) = A + B/λ²
		let dispersiveIOR = baseIOR + B / ( wavelengths * wavelengths );
		return max( dispersiveIOR, vec3f( 1.001f ) );
	}
` );

// Convert wavelength to RGB using spectral sensitivity curves
export const wavelengthToRGB = /*@__PURE__*/ wgslFn( `
	fn wavelengthToRGB( wavelength: f32 ) -> vec3f {
		var color = vec3f( 0.0f );
		// Violet: 380-440
		if ( wavelength >= 380.0f && wavelength < 440.0f ) {
			let t = ( wavelength - 380.0f ) / 60.0f;
			color = vec3f( 0.6f + 0.4f * ( 1.0f - t ), 0.0f, 1.0f );
		}
		// Blue: 440-490
		if ( wavelength >= 440.0f && wavelength < 490.0f ) {
			let t = ( wavelength - 440.0f ) / 50.0f;
			color = vec3f( 0.6f * ( 1.0f - t ), 0.0f, 1.0f );
		}
		// Blue-Cyan: 490-510
		if ( wavelength >= 490.0f && wavelength < 510.0f ) {
			let t = ( wavelength - 490.0f ) / 20.0f;
			color = vec3f( 0.0f, t, 1.0f );
		}
		// Cyan-Green-Yellow: 510-580
		if ( wavelength >= 510.0f && wavelength < 580.0f ) {
			let t = ( wavelength - 510.0f ) / 70.0f;
			if ( t < 0.5f ) {
				color = vec3f( 0.0f, 1.0f, 1.0f - t * 2.0f );
			} else {
				color = vec3f( ( t - 0.5f ) * 2.0f, 1.0f, 0.0f );
			}
		}
		// Yellow-Orange-Red: 580-645
		if ( wavelength >= 580.0f && wavelength < 645.0f ) {
			let t = ( wavelength - 580.0f ) / 65.0f;
			color = vec3f( 1.0f, 1.0f - t, 0.0f );
		}
		// Red: 645-700
		if ( wavelength >= 645.0f && wavelength <= 700.0f ) {
			color = vec3f( 1.0f, 0.0f, 0.0f );
		}
		// Apply intensity falloff at spectrum edges
		if ( wavelength < 420.0f ) {
			color = color * ( ( wavelength - 380.0f ) / 40.0f );
		}
		if ( wavelength > 680.0f ) {
			color = color * ( ( 700.0f - wavelength ) / 20.0f );
		}
		return color;
	}
` );

// Enhanced spectral sampling for realistic dispersion
export const sampleWavelengthForDispersion = Fn( ( [ baseIOR, dispersionStrength, random ] ) => {

	// Map random value to visible spectrum (380-700nm)
	const wl = mix( float( 380.0 ), float( 700.0 ), random ).toVar();

	// Convert to micrometers for Cauchy equation
	const wlMicron = wl.div( 1000.0 );

	// Strong IOR calculation for dramatic dispersion
	const A = baseIOR;
	const B = dispersionStrength.mul( 0.03 );
	const sampledIOR = A.add( B.div( wlMicron.mul( wlMicron ) ) ).toVar();

	// PURE SATURATED spectral colors
	const colorWeight = vec3( 0.0 ).toVar();

	// Deep Violet: 380-420
	If( wl.greaterThanEqual( 380.0 ).and( wl.lessThan( 420.0 ) ), () => {

		colorWeight.assign( vec3( 0.9, 0.0, 1.0 ) );

	} );

	// Blue: 420-480
	If( wl.greaterThanEqual( 420.0 ).and( wl.lessThan( 480.0 ) ), () => {

		colorWeight.assign( vec3( 0.0, 0.0, 1.0 ) );

	} );

	// Cyan: 480-500
	If( wl.greaterThanEqual( 480.0 ).and( wl.lessThan( 500.0 ) ), () => {

		colorWeight.assign( vec3( 0.0, 1.0, 1.0 ) );

	} );

	// Green: 500-530
	If( wl.greaterThanEqual( 500.0 ).and( wl.lessThan( 530.0 ) ), () => {

		colorWeight.assign( vec3( 0.0, 1.0, 0.0 ) );

	} );

	// Yellow: 530-570
	If( wl.greaterThanEqual( 530.0 ).and( wl.lessThan( 570.0 ) ), () => {

		colorWeight.assign( vec3( 1.0, 1.0, 0.0 ) );

	} );

	// Orange: 570-620
	If( wl.greaterThanEqual( 570.0 ).and( wl.lessThan( 620.0 ) ), () => {

		colorWeight.assign( vec3( 1.0, 0.5, 0.0 ) );

	} );

	// Red: 620-700
	If( wl.greaterThanEqual( 620.0 ).and( wl.lessThanEqual( 700.0 ) ), () => {

		colorWeight.assign( vec3( 1.0, 0.0, 0.0 ) );

	} );

	// Maximum saturation
	colorWeight.assign( pow( colorWeight, vec3( 0.4 ) ) );
	colorWeight.assign( clamp( colorWeight, vec3( 0.0 ), vec3( 2.0 ) ) );

	return SpectralSample( {
		wavelength: wl,
		ior: sampledIOR,
		colorWeight: colorWeight,
	} );

} );

// ================================================================================
// ABSORPTION
// ================================================================================

// Apply Beer's law absorption
export const calculateBeerLawAbsorption = /*@__PURE__*/ wgslFn( `
	fn calculateBeerLawAbsorption( attenuationColor: vec3f, attenuationDistance: f32, thickness: f32 ) -> vec3f {
		if ( attenuationDistance <= 0.0f ) { return vec3f( 1.0f ); }
		// Convert RGB attenuation color to absorption coefficients
		let absorption = -log( max( attenuationColor, vec3f( 0.001f ) ) ) / attenuationDistance;
		// Apply Beer's law
		return exp( -absorption * thickness );
	}
` );

// ================================================================================
// SHADOW TRANSMITTANCE
// ================================================================================

export const calculateShadowTransmittance = Fn( ( [ rayDir, normal, material, entering ] ) => {

	const n1 = select( entering, float( 1.0 ), material.ior ).toVar();
	const n2 = select( entering, material.ior, float( 1.0 ) ).toVar();

	const cosThetaI = abs( dot( normal, rayDir ) );
	const sinThetaT2 = n1.mul( n1 ).div( n2.mul( n2 ) ).mul( float( 1.0 ).sub( cosThetaI.mul( cosThetaI ) ) );

	// Handle total internal reflection
	const result = float( 0.0 ).toVar();

	If( sinThetaT2.lessThanEqual( 1.0 ), () => {

		// Calculate Fresnel reflectance
		const F0 = iorToFresnel0( n2, n1 );
		const Fr = fresnelSchlickFloat( cosThetaI, F0 );

		// Base transmission: what gets through after Fresnel reflection
		const baseTransmission = float( 1.0 ).sub( Fr ).mul( material.transmission ).toVar();

		// Apply Beer's law absorption for exiting rays
		If( entering.not().and( material.attenuationDistance.greaterThan( 0.0 ) ), () => {

			const absorption = calculateBeerLawAbsorption( { attenuationColor: material.attenuationColor, attenuationDistance: material.attenuationDistance, thickness: material.thickness } );
			baseTransmission.assign( baseTransmission.mul( absorption.x.add( absorption.y ).add( absorption.z ).div( 3.0 ) ) );

		} );

		result.assign( clamp( baseTransmission, 0.0, 1.0 ) );

	} );

	return result;

} );

// ================================================================================
// MICROFACET TRANSMISSION
// ================================================================================

export const sampleMicrofacetTransmission = Fn( ( [
	V, N, ior, roughness, entering, dispersion, xi, rngState
] ) => {

	const result = MicrofacetTransmissionResult( {
		direction: vec3( 0.0 ),
		halfVector: vec3( 0.0 ),
		didReflect: false,
		pdf: float( 0.0 ),
	} ).toVar();

	// For smooth surfaces with dispersion, use perfect refraction with spectral IOR
	If( roughness.lessThanEqual( 0.05 ).and( dispersion.greaterThan( 0.0 ) ), () => {

		result.halfVector.assign( N );
		result.didReflect.assign( false );

		const eta = ior;
		const etaRatio = select( entering, float( 1.0 ).div( eta ), eta ).toVar();

		// Handle dispersion with spectral sampling
		const spectralSample = SpectralSample.wrap( sampleWavelengthForDispersion( ior, dispersion, RandomValue( rngState ) ) );
		etaRatio.assign( select( entering, float( 1.0 ).div( spectralSample.ior ), spectralSample.ior ) );

		// Perfect refraction using surface normal
		const refractDir = refract( V.negate(), N, etaRatio ).toVar();

		// Check for total internal reflection
		If( dot( refractDir, refractDir ).lessThan( 0.001 ), () => {

			result.direction.assign( reflect( V.negate(), N ) );
			result.didReflect.assign( true );
			result.pdf.assign( 1.0 );

		} ).Else( () => {

			result.direction.assign( refractDir );
			result.pdf.assign( 1.0 );

		} );

	} ).Else( () => {

		// Use minimum roughness to avoid numerical issues for rough surfaces
		const transmissionRoughness = max( MIN_ROUGHNESS, roughness );

		// Sample the microfacet normal with GGX distribution
		const H = ImportanceSampleGGX( { N, roughness: transmissionRoughness, Xi: xi } ).toVar();
		result.halfVector.assign( H );

		// Compute IOR ratio
		const etaRatio = select( entering, float( 1.0 ).div( ior ), ior ).toVar();

		// Handle dispersion with improved spectral sampling
		If( dispersion.greaterThan( 0.0 ), () => {

			const spectralSample = SpectralSample.wrap( sampleWavelengthForDispersion( ior, dispersion, RandomValue( rngState ) ) );
			etaRatio.assign( select( entering, float( 1.0 ).div( spectralSample.ior ), spectralSample.ior ) );

		} );

		// Compute refracted direction using the sampled half-vector
		const HoV = clamp( dot( H, V ), 0.001, 1.0 );
		const refractDir = refract( V.negate(), H, etaRatio ).toVar();

		// Check for total internal reflection
		If( dot( refractDir, refractDir ).lessThan( 0.001 ), () => {

			// TIR occurred, use reflection instead
			result.direction.assign( reflect( V.negate(), H ) );
			result.didReflect.assign( true );

			// Calculate PDF for reflection (standard GGX sampling)
			const NoH = clamp( dot( N, H ), 0.001, 1.0 );
			const VoH = clamp( dot( V, H ), 0.001, 1.0 );
			result.pdf.assign( calculateGGXPDF( NoH, VoH, transmissionRoughness ) );

		} ).Else( () => {

			// Successful refraction
			result.direction.assign( refractDir );
			result.didReflect.assign( false );

			// Calculate proper PDF for microfacet transmission
			const NoH = clamp( dot( N, H ), 0.001, 1.0 );
			const HoL = clamp( dot( H, refractDir ), 0.001, 1.0 );
			const D = DistributionGGX( NoH, transmissionRoughness );

			// Account for change of measure due to refraction (Jacobian)
			const sqrtDenom = HoV.add( etaRatio.mul( HoL ) );
			const jacobian = abs( HoL ).div( sqrtDenom.mul( sqrtDenom ) );

			// Final PDF for microfacet transmission
			result.pdf.assign( D.mul( NoH ).mul( jacobian ) );

		} );

	} );

	return result;

} );

// ================================================================================
// TRANSMISSION HANDLER
// ================================================================================

export const handleTransmission = Fn( ( [
	rayDir, normal, material, entering, rngState,
	currentMediumIOR, previousMediumIOR,
] ) => {

	const result = TransmissionResult( {
		direction: vec3( 0.0 ),
		throughput: vec3( 1.0 ),
		didReflect: false,
	} ).toVar();

	// Setup surface normal based on ray direction
	const N = select( entering, normal, normal.negate() ).toVar();
	const V = rayDir.negate().toVar();

	// Calculate IOR transition using precomputed medium stack values
	// Entering: n1 = current medium IOR (where ray is), n2 = material IOR (where ray goes)
	// Exiting: n1 = material IOR (where ray is), n2 = previous medium IOR (where ray returns to)
	const n1 = select( entering, currentMediumIOR, material.ior ).toVar();
	const n2 = select( entering, material.ior, previousMediumIOR ).toVar();

	// Calculate basic reflection/refraction parameters
	const cosThetaI = abs( dot( N, rayDir ) );
	const sinThetaT2 = n1.mul( n1 ).div( n2.mul( n2 ) ).mul( float( 1.0 ).sub( cosThetaI.mul( cosThetaI ) ) );
	const totalInternalReflection = sinThetaT2.greaterThan( 1.0 ).toVar();

	const F0 = iorToFresnel0( n2, n1 );
	const Fr = select( totalInternalReflection, float( 1.0 ), fresnelSchlickFloat( cosThetaI, F0 ) ).toVar();

	const reflectProb = float( 0.0 ).toVar();

	If( totalInternalReflection, () => {

		reflectProb.assign( 1.0 );

	} ).Else( () => {

		// For dielectrics: balance Fresnel reflection with material transmission
		const dielectricReflect = Fr.add( float( 1.0 ).sub( Fr ).mul( float( 1.0 ).sub( material.transmission ) ) );
		// For metals: mostly reflect regardless of transmission setting
		const metallicReflect = float( 0.95 );

		// Blend based on metalness
		const baseReflectProb = mix( dielectricReflect, metallicReflect, material.metalness ).toVar();

		// FORCE more transmission for dispersive materials
		If( material.dispersion.greaterThan( 0.0 ), () => {

			const dispersionBoost = clamp( material.dispersion.mul( 0.1 ), 0.0, 0.8 );
			reflectProb.assign( baseReflectProb.mul( float( 1.0 ).sub( dispersionBoost ) ) );

		} ).Else( () => {

			reflectProb.assign( baseReflectProb );

		} );

	} );

	// Conservative clamp
	reflectProb.assign( clamp( reflectProb, 0.05, 0.95 ) );

	// Force reflection if TIR, otherwise probabilistically choose
	const doReflect = totalInternalReflection.or( RandomValue( rngState ).lessThan( reflectProb ) ).toVar();
	result.didReflect.assign( doReflect );

	// Choose random sample for microfacet sampling
	const xi_r1 = RandomValue( rngState ).toVar();
	const xi_r2 = RandomValue( rngState ).toVar();
	const xi = vec2( xi_r1, xi_r2 );

	If( doReflect, () => {

		// Reflection path
		If( material.roughness.greaterThan( 0.05 ), () => {

			const mtResult = MicrofacetTransmissionResult.wrap( sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, float( 0.0 ), xi, rngState ) );
			result.direction.assign( mtResult.direction );

		} ).Else( () => {

			result.direction.assign( reflect( rayDir, N ) );

		} );

		// Energy-conserving reflection: Fresnel-weighted with PDF compensation
		result.throughput.assign( material.color.xyz.mul( Fr ).div( max( reflectProb, 0.05 ) ) );

	} ).Else( () => {

		// Transmission/refraction path
		If( material.roughness.greaterThan( 0.05 ).or( material.dispersion.greaterThan( 0.0 ) ), () => {

			const mtResult = MicrofacetTransmissionResult.wrap( sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, material.dispersion, xi, rngState ) );

			// If TIR occurred during sampling, respect it
			If( mtResult.didReflect, () => {

				result.direction.assign( mtResult.direction );
				result.didReflect.assign( true );
				// TIR during intended transmission: compensate for selection probability
				result.throughput.assign( material.color.xyz.div( max( float( 1.0 ).sub( reflectProb ), 0.05 ) ) );

			} ).Else( () => {

				result.direction.assign( mtResult.direction );

				// Handle dispersion coloring
				If( material.dispersion.greaterThan( 0.0 ), () => {

					// Calculate refracted ray deviation from original direction
					const originalDir = normalize( rayDir );
					const refractedDir = normalize( result.direction );

					// Calculate angle-dependent dispersion factor
					const edgeFactor = float( 1.0 ).sub( abs( dot( N, originalDir ) ) );
					const deviationAngle = acos( clamp( dot( originalDir, refractedDir ), - 1.0, 1.0 ) );

					// Create spatial variation using ray direction and normal
					const combinedVec = normalize( originalDir.add( N ) );
					const spatialVariation = sin( combinedVec.x.mul( 15.0 ) ).mul( cos( combinedVec.y.mul( 12.0 ) ) ).mul( sin( combinedVec.z.mul( 18.0 ) ) );

					// Add additional variation using refracted direction
					const refractVariation = sin( refractedDir.x.mul( 8.0 ).add( refractedDir.y.mul( 6.0 ) ).add( refractedDir.z.mul( 10.0 ) ) );

					// Combine multiple factors for better color distribution
					const baseColorIndex = deviationAngle.mul( material.dispersion ).mul( 3.0 );
					const spatialBoost = spatialVariation.mul( 0.3 );
					const refractBoost = refractVariation.mul( 0.2 );
					const edgeBoost = edgeFactor.mul( 0.4 );

					// Create continuous color mapping across the prism
					const colorIndex = fract( baseColorIndex.add( spatialBoost ).add( refractBoost ).add( edgeBoost ) ).toVar();

					// ROYGBIV spectrum mapping with smooth transitions
					const rainbowColor = vec3( 0.0 ).toVar();

					// Red zone
					If( colorIndex.lessThan( 0.143 ), () => {

						const t = colorIndex.div( 0.143 );
						rainbowColor.assign( mix( vec3( 0.8, 0.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), t ) );

					} );

					// Red to Orange
					If( colorIndex.greaterThanEqual( 0.143 ).and( colorIndex.lessThan( 0.286 ) ), () => {

						const t = colorIndex.sub( 0.143 ).div( 0.143 );
						rainbowColor.assign( mix( vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 0.6, 0.0 ), t ) );

					} );

					// Orange to Yellow
					If( colorIndex.greaterThanEqual( 0.286 ).and( colorIndex.lessThan( 0.429 ) ), () => {

						const t = colorIndex.sub( 0.286 ).div( 0.143 );
						rainbowColor.assign( mix( vec3( 1.0, 0.6, 0.0 ), vec3( 1.0, 1.0, 0.0 ), t ) );

					} );

					// Yellow to Green
					If( colorIndex.greaterThanEqual( 0.429 ).and( colorIndex.lessThan( 0.571 ) ), () => {

						const t = colorIndex.sub( 0.429 ).div( 0.142 );
						rainbowColor.assign( mix( vec3( 1.0, 1.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ), t ) );

					} );

					// Green to Blue
					If( colorIndex.greaterThanEqual( 0.571 ).and( colorIndex.lessThan( 0.714 ) ), () => {

						const t = colorIndex.sub( 0.571 ).div( 0.143 );
						rainbowColor.assign( mix( vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 0.4, 1.0 ), t ) );

					} );

					// Blue to Indigo
					If( colorIndex.greaterThanEqual( 0.714 ).and( colorIndex.lessThan( 0.857 ) ), () => {

						const t = colorIndex.sub( 0.714 ).div( 0.143 );
						rainbowColor.assign( mix( vec3( 0.0, 0.4, 1.0 ), vec3( 0.3, 0.0, 0.8 ), t ) );

					} );

					// Indigo to Violet
					If( colorIndex.greaterThanEqual( 0.857 ), () => {

						const t = colorIndex.sub( 0.857 ).div( 0.143 );
						rainbowColor.assign( mix( vec3( 0.3, 0.0, 0.8 ), vec3( 0.6, 0.0, 1.0 ), t ) );

					} );

					// Calculate dispersion strength with proper variation
					const normalizedDispersion = clamp( material.dispersion.div( 5.0 ), 0.0, 1.0 );
					const angleBoost = float( 1.0 ).add( edgeFactor.mul( 1.5 ) );

					// Make dispersion visibility more gradual
					const baseVisibility = normalizedDispersion.mul( angleBoost );
					const combinedVariation = spatialVariation.add( refractVariation );
					const spatialMod = float( 0.5 ).add( float( 0.5 ).mul( sin( combinedVariation.mul( 3.14159 ) ) ) );
					const dispersionVisibility = clamp( baseVisibility.mul( spatialMod ), 0.1, 0.8 );

					// Mix rainbow color with clear base for realistic prism effect
					result.throughput.assign( mix( vec3( 1.0 ), rainbowColor, dispersionVisibility ) );

				} ).Else( () => {

					// No dispersion - pure white transmission
					result.throughput.assign( vec3( 1.0 ) );

				} );

			} );

		} ).Else( () => {

			// Simple refraction for completely smooth, non-dispersive surfaces
			result.direction.assign( refract( rayDir, N, n1.div( n2 ) ) );
			result.throughput.assign( vec3( 1.0 ) );

		} );

		// Common transmission calculations
		If( result.didReflect.not(), () => {

			// Apply material color for transmission
			result.throughput.mulAssign( material.color.xyz );

			// Apply Beer's law absorption when entering medium
			If( entering.and( material.attenuationDistance.greaterThan( 0.0 ) ), () => {

				result.throughput.mulAssign( calculateBeerLawAbsorption( { attenuationColor: material.attenuationColor, attenuationDistance: material.attenuationDistance, thickness: material.thickness } ) );

			} );

			// Fresnel transmission factor with PDF compensation
			result.throughput.mulAssign( float( 1.0 ).sub( Fr ).div( max( float( 1.0 ).sub( reflectProb ), 0.05 ) ) );

		} );

	} );

	return result;

} );

// ================================================================================
// MATERIAL TRANSPARENCY HANDLER
// ================================================================================

export const handleMaterialTransparency = Fn( ( [
	ray, hitPoint, normal, material, rngState,
	// RenderState fields passed individually (since inout not supported)
	transmissiveTraversals,
	// Precomputed medium IOR values from stack
	currentMediumIOR, previousMediumIOR,
] ) => {

	const result = MaterialInteractionResult( {
		continueRay: false,
		isTransmissive: false,
		isAlphaSkip: false,
		didReflect: false,
		entering: false,
		direction: ray.direction,
		throughput: vec3( 1.0 ),
		alpha: float( 1.0 ),
	} ).toVar();

	// -----------------------------------------------------------------
	// Step 1: Fast path for completely opaque materials
	// -----------------------------------------------------------------
	// Quick early exit for fully opaque materials (most common case)
	If( material.alphaMode.equal( int( 0 ) ).and( material.transmission.lessThanEqual( 0.0 ) ), () => {

		// Return default (no interaction needed)

	} ).Else( () => {

		// -----------------------------------------------------------------
		// Step 2: Handle alpha modes according to glTF spec
		// -----------------------------------------------------------------
		const alphaRand = RandomValue( rngState );
		const transmissionRand = RandomValue( rngState );
		const transmissionSeed = pcgHash( { state: rngState } );

		const handled = tslBool( false ).toVar();

		// BLEND mode
		If( material.alphaMode.equal( int( 2 ) ), () => {

			const finalAlpha = material.color.a.mul( material.opacity );

			// Use stochastic transparency for blend mode
			If( alphaRand.greaterThan( finalAlpha ), () => {

				result.continueRay.assign( true );
				result.direction.assign( ray.direction );
				result.throughput.assign( vec3( 1.0 ) );
				result.alpha.assign( 0.0 );
				result.isAlphaSkip.assign( true );
				handled.assign( true );

			} ).Else( () => {

				result.alpha.assign( finalAlpha );

			} );

		} );

		// MASK mode
		If( handled.not().and( material.alphaMode.equal( int( 1 ) ) ), () => {

			const cutoff = select( material.alphaTest.greaterThan( 0.0 ), material.alphaTest, float( 0.5 ) );

			If( material.color.a.lessThan( cutoff ), () => {

				result.continueRay.assign( true );
				result.direction.assign( ray.direction );
				result.throughput.assign( vec3( 1.0 ) );
				result.alpha.assign( 0.0 );
				result.isAlphaSkip.assign( true );
				handled.assign( true );

			} ).Else( () => {

				result.alpha.assign( 1.0 );

			} );

		} );

		// -----------------------------------------------------------------
		// Step 3: Handle transmission if present
		// -----------------------------------------------------------------
		If( handled.not().and( material.transmission.greaterThan( 0.0 ) ).and( transmissiveTraversals.greaterThan( int( 0 ) ) ), () => {

			// Only apply transmission with probability equal to the transmission value
			If( transmissionRand.lessThan( material.transmission ), () => {

				const entering = dot( ray.direction, normal ).lessThan( 0.0 );

				const transResult = TransmissionResult.wrap( handleTransmission(
					ray.direction, normal, material, entering, transmissionSeed,
					currentMediumIOR, previousMediumIOR,
				) );

				result.direction.assign( transResult.direction );
				result.throughput.assign( transResult.throughput );
				result.continueRay.assign( true );
				result.isTransmissive.assign( true );
				result.didReflect.assign( transResult.didReflect );
				result.entering.assign( entering );
				result.alpha.assign( float( 1.0 ).sub( material.transmission ) );

			} );

		} );

	} );

	return result;

} );
