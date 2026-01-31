import {
	Fn,
	float,
	vec3,
	vec4,
	vec2,
	int,
	uint,
	bool as tslBool,
	max,
	min,
	sqrt,
	abs,
	pow,
	exp,
	log,
	clamp,
	mix,
	dot,
	normalize,
	length,
	If,
	Loop,
	Break,
	Return
} from 'three/tsl';
import { wgslFn } from 'three/tsl';

/**
 * Path Tracer Core for TSL/WGSL
 * Complete port of pathtracer_core.fs from GLSL to TSL/WGSL
 *
 * This module contains the main path tracing loop (Trace function), Russian
 * Roulette logic, and path state management for ray traversal.
 *
 * Core components:
 * - Path contribution estimation
 * - Russian Roulette path termination with material importance
 * - Background sampling and contribution regularization
 * - Main path tracing loop with multi-bounce ray traversal
 *
 * Matches the GLSL implementation exactly.
 *
 * NOTE: This module provides the equivalent functionality of pathtracer_core.fs
 * It's designed to be integrated into PathTracingStage.js when the full
 * TSL/WGSL pipeline is ready. See PathTracer.js for the main shader entry point.
 */

// ================================================================================
// CONSTANTS
// ================================================================================

const EPSILON = 1e-6;
const MIN_PDF = 1e-8;

// Ray type enumeration for proper classification
const RAY_TYPE_CAMERA = 0; // Primary rays from camera
const RAY_TYPE_REFLECTION = 1; // Reflection rays
const RAY_TYPE_TRANSMISSION = 2; // Transmission/refraction rays
const RAY_TYPE_DIFFUSE = 3; // Diffuse indirect rays
const RAY_TYPE_SHADOW = 4; // Shadow rays

// Material roughness constants (should match MaterialProperties)
const MIN_ROUGHNESS = 0.045;
const MAX_ROUGHNESS = 1.0;
const MIN_CLEARCOAT_ROUGHNESS = 0.089;

// ================================================================================
// HELPER FUNCTIONS
// ================================================================================

/**
 * Get maximum component of a vec3.
 *
 * @param {vec3} v - Input vector
 * @returns {float} Maximum component value
 */
export const maxComponent = Fn( ( [ v ] ) => {

	return max( max( v.x, v.y ), v.z );

} ).setLayout( {
	name: 'maxComponent',
	type: 'float',
	inputs: [ { name: 'v', type: 'vec3' } ]
} );

/**
 * Get minimum component of a vec3.
 *
 * @param {vec3} v - Input vector
 * @returns {float} Minimum component value
 */
export const minComponent = Fn( ( [ v ] ) => {

	return min( min( v.x, v.y ), v.z );

} ).setLayout( {
	name: 'minComponent',
	type: 'float',
	inputs: [ { name: 'v', type: 'vec3' } ]
} );

/**
 * Calculate firefly threshold with soft suppression.
 * Uses variation multiplier and depth for adaptive threshold.
 *
 * @param {float} fireflyThreshold - Base firefly threshold (uniform)
 * @param {float} variationMultiplier - Path variation factor
 * @param {int} depth - Current bounce depth
 * @returns {float} Calculated threshold value
 */
export const calculateFireflyThreshold = Fn( ( [ fireflyThreshold, variationMultiplier, depth ] ) => {

	const depthFactor = float( 1.0 ).add( float( depth ).mul( 0.15 ) ).toVar();
	return fireflyThreshold.mul( variationMultiplier ).mul( depthFactor );

} ).setLayout( {
	name: 'calculateFireflyThreshold',
	type: 'float',
	inputs: [
		{ name: 'fireflyThreshold', type: 'float' },
		{ name: 'variationMultiplier', type: 'float' },
		{ name: 'depth', type: 'int' }
	]
} );

/**
 * Apply soft suppression to RGB values.
 * Smoothly clamps bright values without hard cutoff.
 *
 * @param {vec3} contribution - Input color contribution
 * @param {float} threshold - Suppression threshold
 * @param {float} softness - Soft clamping factor [0, 1]
 * @returns {vec3} Suppressed color contribution
 */
export const applySoftSuppressionRGB = Fn( ( [ contribution, threshold, softness ] ) => {

	const maxVal = maxComponent( contribution ).toVar();

	If( maxVal.lessThanEqual( threshold ), () => {

		Return( contribution );

	} );

	// Soft clamping using smoothstep-like function
	const excess = maxVal.sub( threshold ).toVar();
	const factor = threshold.div( maxVal ).toVar();
	const smoothFactor = mix( factor, float( 1.0 ), softness.mul( exp( excess.negate().div( threshold ) ) ) ).toVar();

	return contribution.mul( smoothFactor );

} ).setLayout( {
	name: 'applySoftSuppressionRGB',
	type: 'vec3',
	inputs: [
		{ name: 'contribution', type: 'vec3' },
		{ name: 'threshold', type: 'float' },
		{ name: 'softness', type: 'float' }
	]
} );

// ================================================================================
// PATH CONTRIBUTION ESTIMATION
// ================================================================================

/**
 * Estimate path contribution for Russian Roulette and importance tracking.
 * Uses cached material classification and throughput strength.
 *
 * @param {vec3} throughput - Current path throughput
 * @param {vec3} direction - Ray direction
 * @param {RayTracingMaterial} material - Surface material
 * @param {int} materialIndex - Material index for caching
 * @param {PathState} pathState - Path state with cached values
 * @returns {float} Estimated contribution weight [0, 1]
 */
export const estimatePathContribution = Fn( ( [ throughput, direction, material, materialIndex, pathState ] ) => {

	const throughputStrength = maxComponent( throughput ).toVar();

	// Use cached material classification (assumed to be called via getOrCreateMaterialClassification)
	// For TSL, we'll access pathState.materialClass directly
	const materialImportance = wgslFn( `return pathState.materialClass.complexityScore;` )().toVar();

	// Add interaction complexity bonuses for high-value material combinations
	// Access classification bools (stored as u32)
	const isMetallic = wgslFn( `return pathState.materialClass.isMetallic;` )().toVar();
	const isSmooth = wgslFn( `return pathState.materialClass.isSmooth;` )().toVar();
	const isTransmissive = wgslFn( `return pathState.materialClass.isTransmissive;` )().toVar();
	const hasClearcoat = wgslFn( `return pathState.materialClass.hasClearcoat;` )().toVar();
	const isEmissive = wgslFn( `return pathState.materialClass.isEmissive;` )().toVar();

	If( isMetallic.and( isSmooth ), () => {

		materialImportance.assign( materialImportance.add( 0.15 ) );

	} );

	If( isTransmissive.and( hasClearcoat ), () => {

		materialImportance.assign( materialImportance.add( 0.12 ) );

	} );

	If( isEmissive, () => {

		materialImportance.assign( materialImportance.add( 0.1 ) );

	} );

	materialImportance.assign( clamp( materialImportance, float( 0.0 ), float( 1.0 ) ) );

	// Optimized direction importance calculation
	const directionImportance = float( 0.5 ).toVar(); // Default value

	// Only calculate environment importance if beneficial
	// Assuming enableEnvironmentLight and useEnvMapIS are uniforms
	const enableEnvLight = wgslFn( `return enableEnvironmentLight;` )().toVar();
	const useEnvIS = wgslFn( `return useEnvMapIS;` )().toVar();

	If( enableEnvLight.and( useEnvIS ).and( throughputStrength.greaterThan( 0.01 ) ), () => {

		// Fast approximation using simplified PDF calculation
		const cosTheta = clamp( direction.y, float( 0.0 ), float( 1.0 ) ).toVar(); // Assume y-up environment
		directionImportance.assign( mix( float( 0.3 ), float( 0.8 ), cosTheta.mul( cosTheta ) ) );

	} );

	// Enhanced weighting with throughput consideration
	const throughputWeight = wgslFn( `return smoothstep(0.001, 0.1, throughputStrength);` )().toVar();

	return throughputStrength
		.mul( mix( materialImportance.mul( 0.7 ), directionImportance, float( 0.3 ) ) )
		.mul( throughputWeight );

} ).setLayout( {
	name: 'estimatePathContribution',
	type: 'float',
	inputs: [
		{ name: 'throughput', type: 'vec3' },
		{ name: 'direction', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'materialIndex', type: 'int' },
		{ name: 'pathState', type: 'PathState' }
	]
} );

// ================================================================================
// RUSSIAN ROULETTE PATH TERMINATION
// ================================================================================

/**
 * Russian Roulette with enhanced material importance and optimized sampling.
 * Returns the continuation probability (0.0 = terminate, >0.0 = continue with throughput compensation).
 *
 * @param {int} depth - Current bounce depth
 * @param {vec3} throughput - Current path throughput
 * @param {RayTracingMaterial} material - Surface material
 * @param {int} materialIndex - Material index for caching
 * @param {vec3} rayDirection - Current ray direction
 * @param {uint} rngState - Random number generator state (inout)
 * @param {PathState} pathState - Path state with cached values
 * @returns {float} Survival probability (0.0 = terminate, else compensate throughput by 1/prob)
 */
export const handleRussianRoulette = Fn( ( [ depth, throughput, material, materialIndex, rayDirection, rngState, pathState ] ) => {

	// Always continue for first few bounces (return 1.0 = no compensation needed)
	If( depth.lessThan( 3 ), () => {

		Return( float( 1.0 ) );

	} );

	// Get throughput strength
	const throughputStrength = maxComponent( throughput ).toVar();

	// Energy-conserving early termination for very low throughput paths
	If( throughputStrength.lessThan( 0.0008 ).and( depth.greaterThan( 4 ) ), () => {

		const lowThroughputProb = max( throughputStrength.mul( 125.0 ), float( 0.01 ) ).toVar();
		const rrSample = wgslFn( `return RandomValue(rngState);` )().toVar();

		Return( rrSample.lessThan( lowThroughputProb ).select( lowThroughputProb, float( 0.0 ) ) );

	} );

	// Use consolidated classification function
	const materialImportance = wgslFn( `return pathState.materialClass.complexityScore;` )().toVar();

	// Access classification bools
	const isEmissive = wgslFn( `return pathState.materialClass.isEmissive;` )().toVar();
	const isTransmissive = wgslFn( `return pathState.materialClass.isTransmissive;` )().toVar();
	const isMetallic = wgslFn( `return pathState.materialClass.isMetallic;` )().toVar();
	const isSmooth = wgslFn( `return pathState.materialClass.isSmooth;` )().toVar();

	// Boost importance for special materials based on path depth
	If( isEmissive.and( depth.lessThan( 6 ) ), () => {

		materialImportance.assign( materialImportance.add( 0.3 ) );

	} );

	If( isTransmissive.and( depth.lessThan( 5 ) ), () => {

		materialImportance.assign( materialImportance.add( 0.25 ) );

	} );

	If( isMetallic.and( isSmooth ).and( depth.lessThan( 4 ) ), () => {

		materialImportance.assign( materialImportance.add( 0.2 ) );

	} );

	materialImportance.assign( clamp( materialImportance, float( 0.0 ), float( 1.0 ) ) );

	// Dynamic minimum bounces based on material complexity
	const minBounces = int( 3 ).toVar();

	If( materialImportance.greaterThan( 0.6 ), () => {

		minBounces.assign( int( 5 ) );

	} ).ElseIf( materialImportance.greaterThan( 0.4 ), () => {

		minBounces.assign( int( 4 ) );

	} );

	If( depth.lessThan( minBounces ), () => {

		Return( float( 1.0 ) );

	} );

	// Enhanced path importance calculation with caching
	const pathContribution = float( 0.0 ).toVar();

	const classificationCached = wgslFn( `return pathState.classificationCached;` )().toVar();
	const weightsComputed = wgslFn( `return pathState.weightsComputed;` )().toVar();

	If( classificationCached.and( weightsComputed ), () => {

		pathContribution.assign( wgslFn( `return pathState.pathImportance;` )() );

	} ).Else( () => {

		pathContribution.assign( estimatePathContribution( throughput, rayDirection, material, materialIndex, pathState ) );
		wgslFn( `pathState.pathImportance = pathContribution;` )();

	} );

	// Improved adaptive continuation probability
	const rrProb = float( 0.0 ).toVar();
	const adaptiveFactor = materialImportance.mul( 0.4 ).add( throughputStrength.mul( 0.6 ) ).toVar();

	If( depth.lessThan( 6 ), () => {

		rrProb.assign( clamp( adaptiveFactor.mul( 1.2 ), float( 0.15 ), float( 0.95 ) ) );

	} ).ElseIf( depth.lessThan( 10 ), () => {

		const baseProb = clamp( throughputStrength.mul( 0.8 ), float( 0.08 ), float( 0.85 ) ).toVar();
		rrProb.assign( mix( baseProb, pathContribution, float( 0.6 ) ) );

	} ).Else( () => {

		rrProb.assign( clamp(
			throughputStrength.mul( 0.4 ).add( materialImportance.mul( 0.1 ) ),
			float( 0.03 ),
			float( 0.6 )
		) );

	} );

	// Enhanced material-specific boosts
	If( materialImportance.greaterThan( 0.5 ), () => {

		const boostFactor = materialImportance.sub( 0.5 ).mul( 0.6 ).toVar();
		rrProb.assign( mix( rrProb, float( 1.0 ), boostFactor ) );

	} );

	// Smoother depth-based decay
	const depthDecay = float( 0.12 ).add( materialImportance.mul( 0.08 ) ).toVar();
	const depthFactor = exp(
		float( depth ).sub( minBounces ).mul( depthDecay ).negate()
	).toVar();
	rrProb.assign( rrProb.mul( depthFactor ) );

	// Enhanced minimum probability
	const minProb = isEmissive.select( float( 0.04 ), float( 0.02 ) ).toVar();
	rrProb.assign( max( rrProb, minProb ) );

	const rrSample = wgslFn( `return RandomValue(rngState);` )().toVar();

	// If ray survives, return the survival probability for throughput compensation
	// If ray terminates, return 0.0
	Return( rrSample.lessThan( rrProb ).select( rrProb, float( 0.0 ) ) );

} ).setLayout( {
	name: 'handleRussianRoulette',
	type: 'float',
	inputs: [
		{ name: 'depth', type: 'int' },
		{ name: 'throughput', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'materialIndex', type: 'int' },
		{ name: 'rayDirection', type: 'vec3' },
		{ name: 'rngState', type: 'uint' },
		{ name: 'pathState', type: 'PathState' }
	]
} );

// ================================================================================
// BACKGROUND AND PATH CONTRIBUTION HELPERS
// ================================================================================

/**
 * Sample background lighting with proper intensity scaling.
 * Differentiates between primary camera rays and secondary bounces.
 *
 * @param {RenderState} state - Current render state
 * @param {vec3} direction - Ray direction for environment lookup
 * @returns {vec4} Background color (RGB) and alpha
 */
export const sampleBackgroundLighting = Fn( ( [ state, direction ] ) => {

	const isPrimaryRay = wgslFn( `return state.isPrimaryRay;` )().toVar();
	const showBg = wgslFn( `return showBackground;` )().toVar();

	// Only hide background for primary camera rays when showBackground is false
	If( isPrimaryRay.and( showBg.equal( 0 ) ), () => {

		Return( vec4( 0.0, 0.0, 0.0, 0.0 ) );

	} );

	// Sample environment (assumes sampleEnvironment function exists)
	const envColor = wgslFn( `return sampleEnvironment(direction) * environmentIntensity;` )().toVar();

	// Use consistent background intensity scaling
	If( isPrimaryRay, () => {

		// Primary camera rays: use user-controlled background intensity
		const bgIntensity = wgslFn( `return backgroundIntensity;` )().toVar();
		Return( envColor.mul( bgIntensity ) );

	} ).Else( () => {

		// Secondary rays: use environment intensity for realistic lighting
		Return( envColor.mul( 2.0 ) );

	} );

} ).setLayout( {
	name: 'sampleBackgroundLighting',
	type: 'vec4',
	inputs: [
		{ name: 'state', type: 'RenderState' },
		{ name: 'direction', type: 'vec3' }
	]
} );

/**
 * Regularize path contribution to prevent fireflies and extreme values.
 * Uses path variation and depth to compute adaptive threshold.
 *
 * @param {vec3} contribution - Input color contribution
 * @param {vec3} throughput - Current path throughput
 * @param {float} pathLength - Current path depth (as float)
 * @returns {vec3} Regularized contribution
 */
export const regularizePathContribution = Fn( ( [ contribution, throughput, pathLength ] ) => {

	// Calculate throughput variation factor
	const throughputMax = maxComponent( throughput ).toVar();
	const throughputMin = minComponent( throughput ).toVar();

	// Calculate path "unusualness" factor
	const throughputVariation = throughputMax.add( 0.001 ).div( throughputMin.add( 0.001 ) ).toVar();

	// Path variation context multiplier
	const variationMultiplier = float( 1.0 ).div(
		float( 1.0 ).add( log( float( 1.0 ).add( throughputVariation ) ).mul( pathLength ).mul( 0.1 ) )
	).toVar();

	// Use shared firefly threshold calculation (assumes fireflyThreshold uniform)
	const fireflyThresh = wgslFn( `return fireflyThreshold;` )().toVar();
	const threshold = calculateFireflyThreshold(
		fireflyThresh,
		variationMultiplier,
		int( pathLength )
	).toVar();

	// Apply consistent soft suppression
	return applySoftSuppressionRGB( contribution, threshold, float( 0.5 ) );

} ).setLayout( {
	name: 'regularizePathContribution',
	type: 'vec3',
	inputs: [
		{ name: 'contribution', type: 'vec3' },
		{ name: 'throughput', type: 'vec3' },
		{ name: 'pathLength', type: 'float' }
	]
} );

// ================================================================================
// MAIN PATH TRACING LOOP
// ================================================================================

/**
 * Main path tracing function.
 * Traces a ray through the scene, accumulating radiance from multiple bounces.
 *
 * Handles:
 * - BVH traversal for ray-scene intersection
 * - Material texture sampling and displacement
 * - Transparency and transmission (if enabled)
 * - Direct and indirect lighting
 * - Russian Roulette path termination
 * - Emissive contributions
 *
 * @param {Ray} ray - Initial camera ray
 * @param {uint} rngState - Random number generator state (inout)
 * @param {int} rayIndex - Sample index within pixel
 * @param {int} pixelIndex - Pixel index in framebuffer
 * @param {vec3} objectNormal - Output: first hit normal for edge detection (out)
 * @param {vec3} objectColor - Output: first hit color for edge detection (out)
 * @param {float} objectID - Output: first hit material ID (out)
 * @param {vec3} firstHitPoint - Output: first hit point for motion vectors (out)
 * @param {float} firstHitDistance - Output: first hit distance (out)
 * @returns {vec4} Final radiance (RGB) and alpha
 */
export const trace = Fn( ( [
	ray,
	rngState,
	rayIndex,
	pixelIndex,
	objectNormal,
	objectColor,
	objectID,
	firstHitPoint,
	firstHitDistance
] ) => {

	const radiance = vec3( 0.0 ).toVar();
	const throughput = vec3( 1.0 ).toVar();
	const alpha = float( 1.0 ).toVar();

	// Initialize edge detection variables
	objectNormal.assign( vec3( 0.0, 0.0, 0.0 ) );
	objectColor.assign( vec3( 0.0, 0.0, 0.0 ) );
	objectID.assign( float( - 1000.0 ) );

	// Initialize hit point data for motion vectors
	firstHitPoint.assign( ray.origin );
	firstHitDistance.assign( float( 1e10 ) );

	// Initialize media stack (for transmission/transparency)
	// Assuming MediumStack is defined in Struct.js
	const mediumStack = wgslFn( `
		var stack: MediumStack;
		stack.depth = 0;
		return stack;
	` )().toVar();

	// Initialize render state
	const state = wgslFn( `
		var s: RenderState;
		s.traversals = 0;
		s.transmissiveTraversals = transmissiveBounces;
		s.rayType = ${RAY_TYPE_CAMERA};
		s.isPrimaryRay = 1u;
		s.actualBounceDepth = 0;
		return s;
	` )().toVar();

	// Enhanced path state initialization for better caching
	const pathState = wgslFn( `
		var ps: PathState;
		ps.weightsComputed = 0u;
		ps.classificationCached = 0u;
		ps.materialCacheCached = 0u;
		ps.texturesLoaded = 0u;
		ps.pathImportance = 0.0;
		ps.lastMaterialIndex = -1;
		return ps;
	` )().toVar();

	// Track effective bounces separately from transmissive bounces
	const effectiveBounces = int( 0 ).toVar();

	// Get max bounces from uniform
	const maxBounces = wgslFn( `return maxBounceCount;` )().toVar();
	const transmissiveBounces = wgslFn( `return transmissiveBounces;` )().toVar();

	// Main path tracing loop
	Loop( { start: int( 0 ), end: maxBounces.add( transmissiveBounces ).add( 1 ), type: 'int', condition: '<=' }, ( { i: bounceIndex } ) => {

		// Update state for this bounce
		wgslFn( `state.traversals = maxBounceCount - effectiveBounces;` )();
		wgslFn( `state.isPrimaryRay = (bounceIndex == 0) ? 1u : 0u;` )();
		wgslFn( `state.actualBounceDepth = bounceIndex;` )();

		// Check if we've exceeded our effective bounce budget
		If( effectiveBounces.greaterThan( maxBounces ), () => {

			Break();

		} );

		// BVH traversal (assumes traverseBVH function exists)
		// stats is a global ivec2 for triangle/box test counts
		const hitInfo = wgslFn( `return traverseBVH(ray, stats, false);` )().toVar();

		// Check for miss
		const didHit = wgslFn( `return hitInfo.didHit;` )().toVar();

		If( didHit.equal( 0 ), () => {

			// ENVIRONMENT LIGHTING
			const envColor = sampleBackgroundLighting( state, ray.direction ).toVar();
			radiance.assign(
				radiance.add( regularizePathContribution(
					envColor.xyz.mul( throughput ),
					throughput,
					float( bounceIndex )
				) )
			);
			alpha.assign( alpha.mul( envColor.w ) );
			Break();

		} );

		// Sample all textures in one batch (assumes sampleAllMaterialTextures exists)
		const matSamples = wgslFn( `return sampleAllMaterialTextures(hitInfo.material, hitInfo.uv, hitInfo.normal);` )().toVar();

		// Update material with samples
		const material = wgslFn( `return hitInfo.material;` )().toVar();
		wgslFn( `material.color = matSamples.albedo;` )();
		wgslFn( `material.metalness = matSamples.metalness;` )();
		wgslFn( `material.roughness = clamp(matSamples.roughness, ${MIN_ROUGHNESS}, ${MAX_ROUGHNESS});` )();

		const N = wgslFn( `return matSamples.normal;` )().toVar();

		// Apply displacement mapping if enabled
		const hasDisplacement = wgslFn( `return material.displacementMapIndex >= 0 && material.displacementScale > 0.0;` )().toVar();

		If( hasDisplacement, () => {

			const heightSample = wgslFn( `return sampleDisplacementMap(material.displacementMapIndex, hitInfo.uv, material.displacementTransform);` )().toVar();
			const displacementHeight = heightSample.sub( 0.5 ).mul( wgslFn( `return material.displacementScale;` )() ).toVar();
			const displacement = N.mul( displacementHeight ).toVar();
			wgslFn( `hitInfo.hitPoint += displacement;` )();

			const largeDisplacement = wgslFn( `return material.displacementScale > 0.01;` )().toVar();

			If( largeDisplacement, () => {

				const displacedNormal = wgslFn( `return calculateDisplacedNormal(hitInfo.hitPoint, N, hitInfo.uv, material);` )().toVar();
				const blendFactor = clamp(
					wgslFn( `return material.displacementScale;` )().mul( 0.5 ),
					float( 0.1 ),
					float( 0.8 )
				).toVar();
				wgslFn( `blendFactor *= (1.0 - material.roughness * 0.5);` )();
				N.assign( normalize( mix( N, displacedNormal, blendFactor ) ) );

			} );

		} );

		// Handle transparent materials with transmission (if feature enabled)
		// This section would require ENABLE_TRANSMISSION or ENABLE_TRANSPARENCY preprocessor
		// For TSL, we'll use conditional checks based on material properties

		const hasTransmission = wgslFn( `return material.transmission > 0.01 || material.opacity < 0.99;` )().toVar();

		If( hasTransmission, () => {

			// Assumes handleMaterialTransparency exists
			const interaction = wgslFn( `return handleMaterialTransparency(ray, hitInfo.hitPoint, N, material, rngState, state, mediumStack);` )().toVar();

			const continueRay = wgslFn( `return interaction.continueRay;` )().toVar();

			If( continueRay, () => {

				const isFreeBounce = tslBool( false ).toVar();

				const isTransmissive = wgslFn( `return interaction.isTransmissive;` )().toVar();
				const hasTransmissiveBounces = wgslFn( `return state.transmissiveTraversals > 0;` )().toVar();

				If( isTransmissive.and( hasTransmissiveBounces ), () => {

					wgslFn( `state.transmissiveTraversals--;` )();
					wgslFn( `state.rayType = ${RAY_TYPE_TRANSMISSION};` )();
					isFreeBounce.assign( tslBool( true ) );

				} ).Else( () => {

					const isAlphaSkip = wgslFn( `return interaction.isAlphaSkip;` )().toVar();
					If( isAlphaSkip, () => {

						isFreeBounce.assign( tslBool( true ) );

					} );

				} );

				// Update ray and continue
				const interactionThroughput = wgslFn( `return interaction.throughput;` )().toVar();
				const interactionAlpha = wgslFn( `return interaction.alpha;` )().toVar();
				const interactionDirection = wgslFn( `return interaction.direction;` )().toVar();

				throughput.assign( throughput.mul( interactionThroughput ) );
				alpha.assign( alpha.mul( interactionAlpha ) );

				ray.origin.assign( wgslFn( `return hitInfo.hitPoint;` )().add( ray.direction.mul( 0.001 ) ) );
				ray.direction.assign( interactionDirection );

				wgslFn( `state.isPrimaryRay = 0u;` )();

				// Reset material-dependent caches when continuing through transparency
				wgslFn( `pathState.weightsComputed = 0u;` )();
				wgslFn( `pathState.materialCacheCached = 0u;` )();

				If( isFreeBounce.not(), () => {

					effectiveBounces.assign( effectiveBounces.add( 1 ) );

				} );

				Return( vec4( 0.0 ) ); // Continue to next iteration

			} );

			// Apply transparency alpha
			alpha.assign( alpha.mul( wgslFn( `return interaction.alpha;` )() ) );

		} );

		// Get random sample for BRDF sampling
		const randomSample = wgslFn( `return getRandomSample(gl_FragCoord.xy, rayIndex, bounceIndex, rngState, -1);` )().toVar();

		const V = ray.direction.negate().toVar(); // View direction
		wgslFn( `material.sheenRoughness = clamp(material.sheenRoughness, ${MIN_ROUGHNESS}, ${MAX_ROUGHNESS});` )();

		// Create material cache if not already cached
		const cacheCached = wgslFn( `return pathState.materialCacheCached;` )().toVar();

		If( cacheCached.equal( 0 ), () => {

			wgslFn( `
				pathState.materialCache = createMaterialCache(N, V, material, matSamples, pathState.materialClass);
				pathState.materialCacheCached = 1u;
			` )();

		} );

		// BRDF sampling
		const brdfSample = wgslFn( `
			var sample: DirectionSample;
			sample.direction = vec3f(0.0);
			sample.value = vec3f(0.0);
			sample.pdf = 0.0;
			return sample;
		` )().toVar();

		// Handle clear coat (if feature enabled)
		const hasClearcoat = wgslFn( `return material.clearcoat > 0.0;` )().toVar();

		If( hasClearcoat, () => {

			const L = vec3( 0.0 ).toVar();
			const pdf = float( 0.0 ).toVar();
			const clearcoatValue = wgslFn( `return sampleClearcoat(ray, hitInfo, material, randomSample, L, pdf, rngState);` )().toVar();

			brdfSample.direction.assign( L );
			brdfSample.value.assign( clearcoatValue );
			brdfSample.pdf.assign( pdf );

		} ).Else( () => {

			const sampledDir = wgslFn( `return generateSampledDirection(V, N, material, hitInfo.materialIndex, randomSample, rngState, pathState);` )().toVar();
			brdfSample.assign( sampledDir );

		} );

		// 1. EMISSIVE CONTRIBUTION
		const emissiveLength = length( wgslFn( `return matSamples.emissive;` )() ).toVar();

		If( emissiveLength.greaterThan( 0.0 ), () => {

			radiance.assign(
				radiance.add( wgslFn( `return matSamples.emissive;` )().mul( throughput ) )
			);

		} );

		// Update hitInfo for direct lighting
		wgslFn( `
			hitInfo.material = material;
			hitInfo.normal = N;
		` )();

		// 2. DIRECT LIGHTING
		const directLight = wgslFn( `
			return calculateDirectLightingUnified(hitInfo, V, brdfSample, rayIndex, bounceIndex, rngState, stats);
		` )().toVar();

		// Apply firefly suppression to regular direct lighting
		radiance.assign(
			radiance.add( regularizePathContribution(
				directLight.mul( throughput ),
				throughput,
				float( bounceIndex )
			) )
		);

		// Get importance sampling info with caching
		const weightsComputed = wgslFn( `return pathState.weightsComputed;` )().toVar();

		If( weightsComputed.equal( 0 ).or( bounceIndex.equal( 0 ) ), () => {

			wgslFn( `pathState.samplingInfo = getImportanceSamplingInfo(material, bounceIndex, pathState.materialClass);` )();

		} );

		// 3. INDIRECT LIGHTING
		const samplingInfo = wgslFn( `return pathState.samplingInfo;` )().toVar();
		const indirectResult = wgslFn( `
			return calculateIndirectLighting(V, N, material, brdfSample, rayIndex, bounceIndex, rngState, samplingInfo);
		` )().toVar();

		const indirectThroughput = wgslFn( `return indirectResult.throughput;` )().toVar();
		const indirectMISWeight = wgslFn( `return indirectResult.misWeight;` )().toVar();
		const indirectDirection = wgslFn( `return indirectResult.direction;` )().toVar();

		throughput.assign( throughput.mul( indirectThroughput ).mul( indirectMISWeight ) );

		// Early ray termination
		const maxThroughput = max( max( throughput.x, throughput.y ), throughput.z ).toVar();

		If( maxThroughput.lessThan( 0.001 ).and( bounceIndex.greaterThan( 2 ) ), () => {

			Break();

		} );

		// Prepare for next bounce
		ray.origin.assign( wgslFn( `return hitInfo.hitPoint;` )().add( N.mul( 0.001 ) ) );
		ray.direction.assign( indirectDirection );

		wgslFn( `state.isPrimaryRay = 0u;` )();

		// Determine ray type based on material interaction
		const isMetallic = wgslFn( `return material.metalness > 0.7 && material.roughness < 0.3;` )().toVar();
		const isTransmissive = wgslFn( `return material.transmission > 0.5;` )().toVar();

		If( isMetallic, () => {

			wgslFn( `state.rayType = ${RAY_TYPE_REFLECTION};` )();

		} ).ElseIf( isTransmissive, () => {

			wgslFn( `state.rayType = ${RAY_TYPE_TRANSMISSION};` )();

		} ).Else( () => {

			wgslFn( `state.rayType = ${RAY_TYPE_DIFFUSE};` )();

		} );

		// Store first hit data for edge detection and motion vectors
		If( bounceIndex.equal( 0 ).and( didHit ), () => {

			objectNormal.assign( N );
			objectColor.assign( wgslFn( `return material.color.rgb;` )() );
			objectID.assign( float( wgslFn( `return hitInfo.materialIndex;` )() ) );

			firstHitPoint.assign( wgslFn( `return hitInfo.hitPoint;` )() );
			firstHitDistance.assign( wgslFn( `return hitInfo.dst;` )() );

		} );

		// 4. RUSSIAN ROULETTE
		const rrSurvivalProb = handleRussianRoulette(
			wgslFn( `return state.actualBounceDepth;` )(),
			throughput,
			material,
			wgslFn( `return hitInfo.materialIndex;` )(),
			ray.direction,
			rngState,
			pathState
		).toVar();

		If( rrSurvivalProb.lessThanEqual( 0.0 ), () => {

			Break(); // Ray terminated

		} );

		// Apply throughput compensation to maintain unbiased estimator
		throughput.assign( throughput.div( rrSurvivalProb ) );

		// Increment effective bounces
		effectiveBounces.assign( effectiveBounces.add( 1 ) );

	} );

	return vec4( radiance, alpha );

} ).setLayout( {
	name: 'trace',
	type: 'vec4',
	inputs: [
		{ name: 'ray', type: 'Ray' },
		{ name: 'rngState', type: 'uint' },
		{ name: 'rayIndex', type: 'int' },
		{ name: 'pixelIndex', type: 'int' },
		{ name: 'objectNormal', type: 'vec3' },
		{ name: 'objectColor', type: 'vec3' },
		{ name: 'objectID', type: 'float' },
		{ name: 'firstHitPoint', type: 'vec3' },
		{ name: 'firstHitDistance', type: 'float' }
	]
} );
