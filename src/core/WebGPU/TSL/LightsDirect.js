import {
	Fn,
	float,
	vec3,
	vec2,
	int,
	bool as tslBool,
	max,
	min,
	sqrt,
	cos,
	dot,
	normalize,
	abs,
	smoothstep,
	If,
	Loop,
	length
} from 'three/tsl';

/**
 * Lights Direct for TSL/WGSL
 * Complete port of lights_direct.fs from GLSL to TSL/WGSL
 *
 * This module contains:
 * - Shadow ray tracing with transmission support
 * - Ray offset calculation for self-intersection avoidance
 * - Light importance estimation for adaptive sampling
 * - Direct lighting contribution functions for all light types
 *   - Directional lights (with soft shadows)
 *   - Area lights (with MIS)
 *   - Point lights
 *   - Spot lights
 *
 * Matches the GLSL implementation exactly.
 */

// ================================================================================
// CONSTANTS
// ================================================================================

const EPSILON = 1e-6;
const PI = Math.PI;
const TWO_PI = 2.0 * Math.PI;
const REC709_LUMINANCE_COEFFICIENTS = [ 0.2126, 0.7152, 0.0722 ];
const MIN_PDF = 1e-10;

// ================================================================================
// SHADOW RAY TRACING
// ================================================================================

/**
 * Get material transparency for shadow rays.
 * Handles both transmissive and transparent materials.
 * 
 * @param {TSLNode} shadowHit - HitInfo struct from BVH traversal
 * @param {TSLNode} shadowRay - Ray struct
 * @param {TSLNode} rngState - RNG state (uint, modified in place)
 * @returns {TSLNode} Opacity value [0=transparent, 1=opaque] (float)
 */
export const getMaterialTransparency = Fn( ( [ shadowHit, shadowRay, rngState ] ) => {

	// Check if the material has transmission (like glass)
	// #ifdef ENABLE_TRANSMISSION
	If( shadowHit.material.transmission.greaterThan( 0.0 ), () => {

		// Check if ray is entering or exiting the material
		const isEntering = dot( shadowRay.direction, shadowHit.normal ).lessThan( 0.0 ).toVar();

		// Use simplified shadow transmission instead of full handleTransmission
		const transmittance = calculateShadowTransmittance(
			shadowRay.direction,
			shadowHit.normal,
			shadowHit.material,
			isEntering
		).toVar();

		// Return opacity based on transmittance
		return float( 1.0 ).sub( transmittance );

	} );
	// #endif // ENABLE_TRANSMISSION

	// If no transmission, check if it's transparent
	If( shadowHit.material.transparent.greaterThan( 0 ), () => {

		return shadowHit.material.opacity;

	} );

	// If neither transmissive nor transparent, it's fully opaque
	return float( 1.0 );

} ).setLayout( {
	name: 'getMaterialTransparency',
	type: 'float',
	inputs: [
		{ name: 'shadowHit', type: 'HitInfo' },
		{ name: 'shadowRay', type: 'Ray' },
		{ name: 'rngState', type: 'uint' }
	]
} );

/**
 * Trace shadow ray through the scene with transmission support.
 * Returns accumulated transmittance along the ray path.
 * 
 * @param {TSLNode} origin - Shadow ray origin (vec3)
 * @param {TSLNode} dir - Shadow ray direction (vec3)
 * @param {TSLNode} maxDist - Maximum ray distance (float)
 * @param {TSLNode} rngState - RNG state (uint, modified in place)
 * @param {TSLNode} stats - Statistics tracker (ivec2, modified in place)
 * @returns {TSLNode} Transmittance value [0=blocked, 1=clear] (float)
 */
export const traceShadowRay = Fn( ( [ origin, dir, maxDist, rngState, stats ] ) => {

	const shadowRay = {
		origin: origin.toVar(),
		direction: dir
	};

	// Track accumulated transmittance
	const transmittance = float( 1.0 ).toVar();

	// Allow more steps through transparent media for shadow rays
	const MAX_SHADOW_TRANSMISSIONS = 8;

	Loop( { start: int( 0 ), end: int( MAX_SHADOW_TRANSMISSIONS ), type: 'int', condition: '<' }, ( { i: step } ) => {

		const shadowHit = traverseBVH( shadowRay, stats, tslBool( true ) ).toVar();

		// No hit or hit beyond light distance
		If( shadowHit.didHit.equal( 0 ).or( shadowHit.dst.greaterThan( maxDist ) ), () => {

			// Break loop
			return;

		} );

		// Special handling for transmissive materials
		// #ifdef ENABLE_TRANSMISSION
		If( shadowHit.material.transmission.greaterThan( 0.0 ), () => {

			// Determine if entering or exiting medium
			const entering = dot( shadowRay.direction, shadowHit.normal ).lessThan( 0.0 ).toVar();
			const N = entering.select( shadowHit.normal, shadowHit.normal.negate() ).toVar();

			// Apply absorption if exiting medium
			If( entering.equal( false ).and( shadowHit.material.attenuationDistance.greaterThan( 0.0 ) ), () => {

				const dist = length( shadowHit.hitPoint.sub( shadowRay.origin ) ).toVar();
				const absorption = calculateBeerLawAbsorption(
					shadowHit.material.attenuationColor,
					shadowHit.material.attenuationDistance,
					dist
				).toVar();
				transmittance.mulAssign(
					absorption.r.add( absorption.g ).add( absorption.b ).div( 3.0 )
				);

			} );

			// Compute transmittance based on material properties
			const fresnel = fresnelSchlick(
				abs( dot( shadowRay.direction, N ) ),
				iorToFresnel0( shadowHit.material.ior, float( 1.0 ) )
			).toVar();

			// Combine Fresnel with transmission property
			const matTransmittance = float( 1.0 ).sub( fresnel ).mul( shadowHit.material.transmission ).toVar();
			transmittance.mulAssign( matTransmittance );

			// Early exit if almost no light passes through
			If( transmittance.lessThan( 0.005 ), () => {

				return float( 0.0 );

			} );

			// Continue ray
			shadowRay.origin.assign( shadowHit.hitPoint.add( shadowRay.direction.mul( 0.001 ) ) );

		} ).Else( () => {

			// #endif // ENABLE_TRANSMISSION
			If( shadowHit.material.transparent.greaterThan( 0 ), () => {

				// Handle transparent materials
				transmittance.mulAssign( float( 1.0 ).sub( shadowHit.material.opacity ) );

				If( transmittance.lessThan( 0.005 ), () => {

					return float( 0.0 );

				} );

				// Continue ray
				shadowRay.origin.assign( shadowHit.hitPoint.add( shadowRay.direction.mul( 0.001 ) ) );

			} ).Else( () => {

				// Fully opaque object blocks shadow ray
				return float( 0.0 );

			} );

		} );

	} );

	return transmittance;

} ).setLayout( {
	name: 'traceShadowRay',
	type: 'float',
	inputs: [
		{ name: 'origin', type: 'vec3' },
		{ name: 'dir', type: 'vec3' },
		{ name: 'maxDist', type: 'float' },
		{ name: 'rngState', type: 'uint' },
		{ name: 'stats', type: 'ivec2' }
	]
} );

// ================================================================================
// RAY OFFSET CALCULATION
// ================================================================================

/**
 * Calculate adaptive ray offset based on scene scale and surface properties.
 * Prevents self-intersection artifacts.
 * 
 * @param {TSLNode} hitPoint - Surface hit point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @returns {TSLNode} Offset vector along normal (vec3)
 */
export const calculateRayOffset = Fn( ( [ hitPoint, normal, material ] ) => {

	// Base epsilon scaled by scene size
	const scaleEpsilon = max( float( 1e-4 ), length( hitPoint ).mul( 1e-6 ) ).toVar();

	// Adjust for material properties
	const materialEpsilon = scaleEpsilon.toVar();

	If( material.transmission.greaterThan( 0.0 ), () => {

		// Transmissive materials need larger offsets to avoid light leaking
		materialEpsilon.mulAssign( 2.0 );

	} );

	If( material.roughness.lessThan( 0.1 ), () => {

		// Smooth materials are more sensitive to precision issues
		materialEpsilon.mulAssign( 1.5 );

	} );

	return normal.mul( materialEpsilon );

} ).setLayout( {
	name: 'calculateRayOffset',
	type: 'vec3',
	inputs: [
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

// ================================================================================
// LIGHT IMPORTANCE ESTIMATION
// ================================================================================

/**
 * Calculate directional light importance for adaptive sampling.
 * 
 * @param {TSLNode} light - DirectionalLight struct
 * @param {TSLNode} hitPoint - Surface hit point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} bounceIndex - Current bounce number (int)
 * @returns {TSLNode} Importance value (float)
 */
export const calculateDirectionalLightImportance = Fn( ( [ light, hitPoint, normal, material, bounceIndex ] ) => {

	const NoL = max( float( 0.0 ), dot( normal, light.direction ) ).toVar();

	If( NoL.lessThanEqual( 0.0 ), () => {

		return float( 0.0 );

	} );

	const intensity = light.intensity.mul(
		dot( light.color, vec3( REC709_LUMINANCE_COEFFICIENTS[ 0 ], REC709_LUMINANCE_COEFFICIENTS[ 1 ], REC709_LUMINANCE_COEFFICIENTS[ 2 ] ) )
	).toVar();

	// Material-specific weighting
	const materialWeight = float( 1.0 ).toVar();

	If( material.metalness.greaterThan( 0.7 ), () => {

		materialWeight.assign( 1.5 ); // Metals benefit more from directional lights

	} ).ElseIf( material.roughness.greaterThan( 0.8 ), () => {

		materialWeight.assign( 0.7 ); // Rough surfaces less sensitive to directional lights

	} );

	// Reduce importance on secondary bounces
	const bounceWeight = float( 1.0 ).div( float( 1.0 ).add( float( bounceIndex ).mul( 0.5 ) ) ).toVar();

	return intensity.mul( NoL ).mul( materialWeight ).mul( bounceWeight );

} ).setLayout( {
	name: 'calculateDirectionalLightImportance',
	type: 'float',
	inputs: [
		{ name: 'light', type: 'DirectionalLight' },
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'bounceIndex', type: 'int' }
	]
} );

/**
 * Estimate area light importance for adaptive sampling.
 * 
 * @param {TSLNode} light - AreaLight struct
 * @param {TSLNode} hitPoint - Surface hit point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @returns {TSLNode} Importance value (float)
 */
export const estimateLightImportance = Fn( ( [ light, hitPoint, normal, material ] ) => {

	// Distance-based importance
	const toLight = light.position.sub( hitPoint ).toVar();
	const dist = length( toLight ).toVar();
	const distSq = dist.mul( dist ).toVar();

	// Angular importance - light facing toward surface?
	const lightDir = toLight.div( dist ).toVar();
	const NoL = max( dot( normal, lightDir ), float( 0.0 ) ).toVar();

	If( NoL.lessThanEqual( 0.0 ), () => {

		return float( 0.0 ); // Early exit for back-facing lights

	} );

	const lightFacing = max( lightDir.negate().dot( light.normal ), float( 0.0 ) ).toVar();

	If( lightFacing.lessThanEqual( 0.0 ), () => {

		return float( 0.0 ); // Light pointing away

	} );

	// importance calculation using solid angle
	// Solid angle = Area / distance²
	const solidAngle = light.area.div( max( distSq, float( 0.1 ) ) ).toVar();

	// Radiant power = intensity × luminance × area
	const power = light.intensity.mul(
		dot( light.color, vec3( REC709_LUMINANCE_COEFFICIENTS[ 0 ], REC709_LUMINANCE_COEFFICIENTS[ 1 ], REC709_LUMINANCE_COEFFICIENTS[ 2 ] ) )
	).mul( light.area ).toVar();

	// BRDF-aware material weighting (view-independent approximation)
	const materialFactor = float( 1.0 ).toVar();

	// Metallic surfaces benefit more from bright, concentrated lights
	If( material.metalness.greaterThan( 0.7 ), () => {

		// Boost importance for metals (specular highlights)
		materialFactor.mulAssign( 1.5 );

		// Smooth metals prefer smaller, brighter lights
		If( material.roughness.lessThan( 0.3 ), () => {

			materialFactor.mulAssign( float( 1.0 ).add( float( 1.0 ).sub( material.roughness ).mul( 0.5 ) ) );

		} );

	} );

	// Rough diffuse surfaces prefer larger area lights
	If( material.roughness.greaterThan( 0.6 ).and( material.metalness.lessThan( 0.3 ) ), () => {

		// Weight by relative light size
		const sizeBoost = min( light.area.mul( 2.0 ), float( 2.0 ) ).toVar();
		materialFactor.mulAssign( sizeBoost );

	} );

	// Transmission/glass materials care about both intensity and geometry
	If( material.transmission.greaterThan( 0.5 ), () => {

		materialFactor.mulAssign( float( 1.0 ).add( material.transmission.mul( 0.3 ) ) );

	} );

	// Combined importance: power × solid angle × geometry × BRDF weight
	return power.mul( solidAngle ).mul( NoL ).mul( lightFacing ).mul( materialFactor );

} ).setLayout( {
	name: 'estimateLightImportance',
	type: 'float',
	inputs: [
		{ name: 'light', type: 'AreaLight' },
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

/**
 * Calculate point light importance for adaptive sampling.
 * 
 * @param {TSLNode} light - PointLight struct
 * @param {TSLNode} hitPoint - Surface hit point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @returns {TSLNode} Importance value (float)
 */
export const calculatePointLightImportance = Fn( ( [ light, hitPoint, normal, material ] ) => {

	const toLight = light.position.sub( hitPoint ).toVar();
	const distSq = dot( toLight, toLight ).toVar();

	If( distSq.lessThan( 0.001 ), () => {

		return float( 0.0 ); // Too close

	} );

	const dist = sqrt( distSq ).toVar();
	const lightDir = toLight.div( dist ).toVar();
	const NoL = max( float( 0.0 ), dot( normal, lightDir ) ).toVar();

	If( NoL.lessThanEqual( 0.0 ), () => {

		return float( 0.0 );

	} );

	// Physical inverse-square falloff
	const distanceFactor = float( 1.0 ).div( max( distSq, float( 0.1 ) ) ).toVar();

	// Power calculation (luminous intensity)
	const power = light.intensity.mul(
		dot( light.color, vec3( REC709_LUMINANCE_COEFFICIENTS[ 0 ], REC709_LUMINANCE_COEFFICIENTS[ 1 ], REC709_LUMINANCE_COEFFICIENTS[ 2 ] ) )
	).toVar();

	// Material-aware weighting
	const materialFactor = float( 1.0 ).toVar();

	// Metals benefit from bright point sources (sharp specular)
	If( material.metalness.greaterThan( 0.7 ), () => {

		materialFactor.mulAssign( 1.5 );

		// Smooth metals create sharper highlights
		If( material.roughness.lessThan( 0.3 ), () => {

			materialFactor.mulAssign( float( 1.0 ).add( float( 1.0 ).sub( material.roughness ).mul( 0.4 ) ) );

		} );

	} );

	// Rough surfaces have more uniform response
	If( material.roughness.greaterThan( 0.6 ), () => {

		materialFactor.mulAssign( 0.9 ); // Slightly reduce since point lights less effective

	} );

	// Transmission materials
	If( material.transmission.greaterThan( 0.5 ), () => {

		materialFactor.mulAssign( float( 1.0 ).add( material.transmission.mul( 0.2 ) ) );

	} );

	return power.mul( distanceFactor ).mul( NoL ).mul( materialFactor );

} ).setLayout( {
	name: 'calculatePointLightImportance',
	type: 'float',
	inputs: [
		{ name: 'light', type: 'PointLight' },
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

/**
 * Calculate spot light importance for adaptive sampling.
 * 
 * @param {TSLNode} light - SpotLight struct
 * @param {TSLNode} hitPoint - Surface hit point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @returns {TSLNode} Importance value (float)
 */
export const calculateSpotLightImportance = Fn( ( [ light, hitPoint, normal, material ] ) => {

	const toLight = light.position.sub( hitPoint ).toVar();
	const distSq = dot( toLight, toLight ).toVar();

	If( distSq.lessThan( 0.001 ), () => {

		return float( 0.0 );

	} );

	const lightDir = toLight.div( sqrt( distSq ) ).toVar();
	const NoL = max( float( 0.0 ), dot( normal, lightDir ) ).toVar();

	If( NoL.lessThanEqual( 0.0 ), () => {

		return float( 0.0 );

	} );

	// Check if point is within spot cone
	const spotCosAngle = dot( lightDir.negate(), light.direction ).toVar();
	const coneCosAngle = cos( light.angle ).toVar();

	If( spotCosAngle.lessThan( coneCosAngle ), () => {

		return float( 0.0 );

	} );

	// Distance attenuation
	const distanceFactor = float( 1.0 ).div( max( distSq, float( 0.01 ) ) ).toVar();

	// Cone attenuation
	const coneAttenuation = smoothstep( coneCosAngle, coneCosAngle.add( 0.1 ), spotCosAngle ).toVar();

	// Intensity and color
	const intensity = light.intensity.mul(
		dot( light.color, vec3( REC709_LUMINANCE_COEFFICIENTS[ 0 ], REC709_LUMINANCE_COEFFICIENTS[ 1 ], REC709_LUMINANCE_COEFFICIENTS[ 2 ] ) )
	).toVar();

	// Material weighting
	const materialWeight = material.metalness.greaterThan( 0.7 ).select(
		float( 1.5 ),
		material.roughness.greaterThan( 0.8 ).select( float( 0.8 ), float( 1.0 ) )
	).toVar();

	return intensity.mul( distanceFactor ).mul( coneAttenuation ).mul( NoL ).mul( materialWeight );

} ).setLayout( {
	name: 'calculateSpotLightImportance',
	type: 'float',
	inputs: [
		{ name: 'light', type: 'SpotLight' },
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

// ================================================================================
// DIRECTIONAL LIGHT CONTRIBUTION
// ================================================================================

/**
 * Fast early exit checks for directional lights.
 * 
 * @param {TSLNode} light - DirectionalLight struct
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} bounceIndex - Current bounce number (int)
 * @returns {TSLNode} True if light should be skipped (bool)
 */
export const shouldSkipDirectionalLight = Fn( ( [ light, normal, material, bounceIndex ] ) => {

	const NoL = max( float( 0.0 ), dot( normal, light.direction ) ).toVar();

	// Basic validity checks
	If( light.intensity.lessThanEqual( 0.001 ).or( NoL.lessThanEqual( 0.001 ) ), () => {

		return tslBool( true );

	} );

	// Material-specific early exits for performance
	If( bounceIndex.greaterThan( 0 ), () => {

		// Skip dim lights on secondary bounces
		If( light.intensity.lessThan( 0.01 ), () => {

			return tslBool( true );

		} );

		// Skip lights that barely hit metals at grazing angles
		If( material.metalness.greaterThan( 0.9 ).and( NoL.lessThan( 0.1 ) ), () => {

			return tslBool( true );

		} );

		// Skip lights that won't contribute much to rough dielectrics
		If( material.metalness.lessThan( 0.1 ).and( material.roughness.greaterThan( 0.9 ) ).and( light.intensity.lessThan( 0.1 ) ), () => {

			return tslBool( true );

		} );

	} );

	return tslBool( false );

} ).setLayout( {
	name: 'shouldSkipDirectionalLight',
	type: 'bool',
	inputs: [
		{ name: 'light', type: 'DirectionalLight' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'bounceIndex', type: 'int' }
	]
} );

/**
 * Calculate directional light contribution with soft shadows and MIS.
 * 
 * @param {TSLNode} light - DirectionalLight struct
 * @param {TSLNode} hitPoint - Surface hit point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} viewDir - View direction (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} matCache - MaterialCache struct
 * @param {TSLNode} brdfSample - DirectionSample from BRDF sampling
 * @param {TSLNode} bounceIndex - Current bounce number (int)
 * @param {TSLNode} rngState - RNG state (uint, modified in place)
 * @param {TSLNode} stats - Statistics tracker (ivec2, modified in place)
 * @returns {TSLNode} Light contribution (vec3)
 */
export const calculateDirectionalLightContribution = Fn( ( [
	light,
	hitPoint,
	normal,
	viewDir,
	material,
	matCache,
	brdfSample,
	bounceIndex,
	rngState,
	stats
] ) => {

	// Fast early exit
	If( shouldSkipDirectionalLight( light, normal, material, bounceIndex ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Calculate adaptive ray offset
	const rayOffset = calculateRayOffset( hitPoint, normal, material ).toVar();
	const rayOrigin = hitPoint.add( rayOffset ).toVar();

	// Determine shadow sampling strategy based on light angle
	const shadowDirection = vec3( 0.0, 0.0, 0.0 ).toVar();
	const lightPdf = float( 1e6 ).toVar(); // Default for sharp shadows

	If( light.angle.greaterThan( 0.001 ), () => {

		// Soft shadows: sample direction within cone
		const xi = vec2( RandomValue( rngState ), RandomValue( rngState ) ).toVar();
		const halfAngle = light.angle.mul( 0.5 ).toVar();
		shadowDirection.assign( sampleCone( light.direction, halfAngle, xi ) );

		// Calculate PDF for cone sampling
		const cosHalfAngle = cos( halfAngle ).toVar();
		lightPdf.assign( float( 1.0 ).div( float( TWO_PI ).mul( float( 1.0 ).sub( cosHalfAngle ) ) ) );

	} ).Else( () => {

		// Sharp shadows: use original direction
		shadowDirection.assign( light.direction );

	} );

	const NoL = max( float( 0.0 ), dot( normal, shadowDirection ) ).toVar();

	If( NoL.lessThanEqual( 0.0 ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Shadow test
	const maxShadowDistance = float( 1e6 ).toVar();
	const visibility = traceShadowRay( rayOrigin, shadowDirection, maxShadowDistance, rngState, stats ).toVar();

	If( visibility.lessThanEqual( 0.0 ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	// BRDF evaluation using sampled direction
	const brdfValue = evaluateMaterialResponseCached( viewDir, shadowDirection, normal, material, matCache ).toVar();

	// Physical light contribution
	const lightRadiance = light.color.mul( light.intensity ).toVar();
	const contribution = lightRadiance.mul( brdfValue ).mul( NoL ).mul( visibility ).toVar();

	// MIS for directional lights (only on primary rays where it matters)
	If( bounceIndex.equal( 0 ).and( brdfSample.pdf.greaterThan( 0.0 ) ), () => {

		// Check alignment between BRDF sample and shadow direction
		const alignment = max( float( 0.0 ), dot( normalize( brdfSample.direction ), shadowDirection ) ).toVar();

		// Only apply MIS if there's significant alignment
		If( alignment.greaterThan( 0.996 ), () => {

			const misWeight = powerHeuristic( lightPdf, brdfSample.pdf ).toVar();
			contribution.mulAssign( misWeight );

		} );

	} );

	return contribution;

} ).setLayout( {
	name: 'calculateDirectionalLightContribution',
	type: 'vec3',
	inputs: [
		{ name: 'light', type: 'DirectionalLight' },
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'viewDir', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'matCache', type: 'MaterialCache' },
		{ name: 'brdfSample', type: 'DirectionSample' },
		{ name: 'bounceIndex', type: 'int' },
		{ name: 'rngState', type: 'uint' },
		{ name: 'stats', type: 'ivec2' }
	]
} );

// ================================================================================
// AREA LIGHT CONTRIBUTION
// ================================================================================

/**
 * Calculate area light contribution with MIS between light and BRDF sampling.
 * 
 * @param {TSLNode} light - AreaLight struct
 * @param {TSLNode} hitPoint - Surface hit point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} viewDir - View direction (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} matCache - MaterialCache struct
 * @param {TSLNode} brdfSample - DirectionSample from BRDF sampling
 * @param {TSLNode} sampleIndex - Current sample index (int)
 * @param {TSLNode} bounceIndex - Current bounce number (int)
 * @param {TSLNode} rngState - RNG state (uint, modified in place)
 * @param {TSLNode} stats - Statistics tracker (ivec2, modified in place)
 * @returns {TSLNode} Light contribution (vec3)
 */
export const calculateAreaLightContribution = Fn( ( [
	light,
	hitPoint,
	normal,
	viewDir,
	material,
	matCache,
	brdfSample,
	sampleIndex,
	bounceIndex,
	rngState,
	stats
] ) => {

	// Importance estimation to decide sampling strategy
	const lightImportance = estimateLightImportance( light, hitPoint, normal, material ).toVar();

	// Skip lights with negligible contribution
	If( lightImportance.lessThan( 0.001 ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Pre-compute common values
	const contribution = vec3( 0.0, 0.0, 0.0 ).toVar();
	const rayOffset = calculateRayOffset( hitPoint, normal, material ).toVar();
	const rayOrigin = hitPoint.add( rayOffset ).toVar();

	// Adaptive sampling strategy based on material and importance
	const isDiffuse = material.roughness.greaterThan( 0.7 ).and( material.metalness.lessThan( 0.3 ) ).toVar();
	const isSpecular = material.roughness.lessThan( 0.3 ).or( material.metalness.greaterThan( 0.7 ) ).toVar();
	const isFirstBounce = bounceIndex.equal( 0 ).toVar();

	// LIGHT SAMPLING STRATEGY
	If( isFirstBounce.or( isDiffuse ).or( lightImportance.greaterThan( 0.1 ).and( isSpecular.equal( false ) ) ), () => {

		// Get stratified sample point for better coverage
		const ruv = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex, rngState, int( - 1 ) ).toVar();

		// Generate position on light surface
		const lightPos = light.position
			.add( light.u.mul( ruv.x.sub( 0.5 ) ) )
			.add( light.v.mul( ruv.y.sub( 0.5 ) ) )
			.toVar();

		// Calculate light direction and properties
		const toLight = lightPos.sub( hitPoint ).toVar();
		const lightDistSq = dot( toLight, toLight ).toVar();
		const lightDist = sqrt( lightDistSq ).toVar();
		const lightDir = toLight.div( lightDist ).toVar();

		// Geometric terms
		const NoL = max( float( 0.0 ), dot( normal, lightDir ) ).toVar();
		const lightFacing = max( float( 0.0 ), dot( lightDir.negate(), light.normal ) ).toVar();

		// Early exit for geometry facing away
		If( NoL.greaterThan( 0.0 ).and( lightFacing.greaterThan( 0.0 ) ), () => {

			// Shadow test
			const visibility = traceShadowRay( rayOrigin, lightDir, lightDist, rngState, stats ).toVar();

			If( visibility.greaterThan( 0.0 ), () => {

				// BRDF evaluation
				const brdfValue = evaluateMaterialResponseCached( viewDir, lightDir, normal, material, matCache ).toVar();

				// Calculate PDFs for MIS
				const lightPdf = lightDistSq.div( max( light.area.mul( lightFacing ), float( EPSILON ) ) ).toVar();
				const brdfPdf = brdfSample.pdf.toVar();

				// Light contribution with inverse-square falloff
				const falloff = light.area.div( float( 4.0 * PI ).mul( lightDistSq ) ).toVar();
				const lightContribution = light.color.mul( light.intensity ).mul( falloff ).mul( lightFacing ).toVar();

				// MIS weight
				const misWeight = brdfPdf.greaterThan( 0.0 ).and( isFirstBounce ).select(
					powerHeuristic( lightPdf, brdfPdf ),
					float( 1.0 )
				).toVar();

				contribution.addAssign( lightContribution.mul( brdfValue ).mul( NoL ).mul( visibility ).mul( misWeight ) );

			} );

		} );

	} );

	// BRDF SAMPLING STRATEGY
	If( isFirstBounce.or( isSpecular ).and( brdfSample.pdf.greaterThan( 0.0 ) ), () => {

		// Fast path - check if ray could possibly hit light
		const toLight = light.position.sub( rayOrigin ).toVar();
		const rayToLightDot = dot( toLight, brdfSample.direction ).toVar();

		// Only proceed if ray is pointing toward light
		If( rayToLightDot.greaterThan( 0.0 ), () => {

			const hitDistance = float( 0.0 ).toVar();
			const hitLight = intersectAreaLight( light, rayOrigin, brdfSample.direction, hitDistance ).toVar();

			If( hitLight, () => {

				const visibility = traceShadowRay( rayOrigin, brdfSample.direction, hitDistance, rngState, stats ).toVar();

				If( visibility.greaterThan( 0.0 ), () => {

					const lightFacing = max( float( 0.0 ), dot( brdfSample.direction.negate(), light.normal ) ).toVar();

					If( lightFacing.greaterThan( 0.0 ), () => {

						// PDFs for MIS
						const lightPdf = hitDistance.mul( hitDistance ).div(
							max( light.area.mul( lightFacing ), float( EPSILON ) )
						).toVar();
						const misWeight = powerHeuristic( brdfSample.pdf, lightPdf ).toVar();

						// Direct light emission
						const lightEmission = light.color.mul( light.intensity ).toVar();
						const NoL = max( float( 0.0 ), dot( normal, brdfSample.direction ) ).toVar();

						contribution.addAssign(
							lightEmission.mul( brdfSample.value ).mul( NoL ).mul( visibility ).mul( misWeight )
						);

					} );

				} );

			} );

		} );

	} );

	return contribution;

} ).setLayout( {
	name: 'calculateAreaLightContribution',
	type: 'vec3',
	inputs: [
		{ name: 'light', type: 'AreaLight' },
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'viewDir', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'matCache', type: 'MaterialCache' },
		{ name: 'brdfSample', type: 'DirectionSample' },
		{ name: 'sampleIndex', type: 'int' },
		{ name: 'bounceIndex', type: 'int' },
		{ name: 'rngState', type: 'uint' },
		{ name: 'stats', type: 'ivec2' }
	]
} );

// ================================================================================
// POINT LIGHT CONTRIBUTION
// ================================================================================

/**
 * Calculate point light contribution.
 * 
 * @param {TSLNode} light - PointLight struct
 * @param {TSLNode} hitPoint - Surface hit point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} viewDir - View direction (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} matCache - MaterialCache struct
 * @param {TSLNode} brdfSample - DirectionSample from BRDF sampling
 * @param {TSLNode} bounceIndex - Current bounce number (int)
 * @param {TSLNode} rngState - RNG state (uint, modified in place)
 * @param {TSLNode} stats - Statistics tracker (ivec2, modified in place)
 * @returns {TSLNode} Light contribution (vec3)
 */
export const calculatePointLightContribution = Fn( ( [
	light,
	hitPoint,
	normal,
	viewDir,
	material,
	matCache,
	brdfSample,
	bounceIndex,
	rngState,
	stats
] ) => {

	// Calculate vector from surface to light
	const toLight = light.position.sub( hitPoint ).toVar();
	const distance = length( toLight ).toVar();

	// Early exit for extremely far lights
	If( distance.greaterThan( 1000.0 ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	const lightDir = toLight.div( distance ).toVar();

	// Check if light is on same side of surface as normal
	const NdotL = dot( normal, lightDir ).toVar();

	If( NdotL.lessThanEqual( 0.0 ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Calculate attenuation using inverse square law
	const attenuation = float( 1.0 ).div( distance.mul( distance ) ).toVar();

	// Apply intensity and color
	const lightRadiance = light.color.mul( light.intensity ).mul( attenuation ).toVar();

	// Calculate shadow ray offset
	const rayOffset = calculateRayOffset( hitPoint, normal, material ).toVar();
	const rayOrigin = hitPoint.add( rayOffset ).toVar();

	// Trace shadow ray
	const visibility = traceShadowRay( rayOrigin, lightDir, distance.sub( 0.001 ), rngState, stats ).toVar();

	If( visibility.lessThanEqual( 0.0 ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Calculate BRDF contribution
	const brdfValue = evaluateMaterialResponse( viewDir, lightDir, normal, material ).toVar();

	// Final contribution
	return brdfValue.mul( lightRadiance ).mul( NdotL ).mul( visibility );

} ).setLayout( {
	name: 'calculatePointLightContribution',
	type: 'vec3',
	inputs: [
		{ name: 'light', type: 'PointLight' },
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'viewDir', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'matCache', type: 'MaterialCache' },
		{ name: 'brdfSample', type: 'DirectionSample' },
		{ name: 'bounceIndex', type: 'int' },
		{ name: 'rngState', type: 'uint' },
		{ name: 'stats', type: 'ivec2' }
	]
} );

// ================================================================================
// SPOT LIGHT CONTRIBUTION
// ================================================================================

/**
 * Calculate spot light contribution.
 * 
 * @param {TSLNode} light - SpotLight struct
 * @param {TSLNode} hitPoint - Surface hit point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} viewDir - View direction (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} matCache - MaterialCache struct
 * @param {TSLNode} brdfSample - DirectionSample from BRDF sampling
 * @param {TSLNode} bounceIndex - Current bounce number (int)
 * @param {TSLNode} rngState - RNG state (uint, modified in place)
 * @param {TSLNode} stats - Statistics tracker (ivec2, modified in place)
 * @returns {TSLNode} Light contribution (vec3)
 */
export const calculateSpotLightContribution = Fn( ( [
	light,
	hitPoint,
	normal,
	viewDir,
	material,
	matCache,
	brdfSample,
	bounceIndex,
	rngState,
	stats
] ) => {

	// Calculate vector from surface to light
	const toLight = light.position.sub( hitPoint ).toVar();
	const distance = length( toLight ).toVar();

	// Early exit for extremely far lights
	If( distance.greaterThan( 1000.0 ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	const lightDir = toLight.div( distance ).toVar();

	// Check if light is on same side of surface as normal
	const NdotL = dot( normal, lightDir ).toVar();

	If( NdotL.lessThanEqual( 0.0 ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Calculate spot light cone attenuation
	const spotCosAngle = dot( lightDir.negate(), light.direction ).toVar();
	const coneCosAngle = cos( light.angle ).toVar();

	// Early exit if outside the cone
	If( spotCosAngle.lessThan( coneCosAngle ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Smooth falloff at cone edge
	const coneAttenuation = smoothstep( coneCosAngle, coneCosAngle.add( 0.1 ), spotCosAngle ).toVar();

	// Calculate distance attenuation
	const distanceAttenuation = float( 1.0 ).div( distance.mul( distance ) ).toVar();

	// Apply intensity, color, and both attenuations
	const lightRadiance = light.color.mul( light.intensity ).mul( distanceAttenuation ).mul( coneAttenuation ).toVar();

	// Calculate shadow ray offset
	const rayOffset = calculateRayOffset( hitPoint, normal, material ).toVar();
	const rayOrigin = hitPoint.add( rayOffset ).toVar();

	// Trace shadow ray
	const visibility = traceShadowRay( rayOrigin, lightDir, distance.sub( 0.001 ), rngState, stats ).toVar();

	If( visibility.lessThanEqual( 0.0 ), () => {

		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Calculate BRDF contribution
	const brdfValue = evaluateMaterialResponse( viewDir, lightDir, normal, material ).toVar();

	// Final contribution
	return brdfValue.mul( lightRadiance ).mul( NdotL ).mul( visibility );

} ).setLayout( {
	name: 'calculateSpotLightContribution',
	type: 'vec3',
	inputs: [
		{ name: 'light', type: 'SpotLight' },
		{ name: 'hitPoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'viewDir', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'matCache', type: 'MaterialCache' },
		{ name: 'brdfSample', type: 'DirectionSample' },
		{ name: 'bounceIndex', type: 'int' },
		{ name: 'rngState', type: 'uint' },
		{ name: 'stats', type: 'ivec2' }
	]
} );
