import { Fn, float, vec3, vec2, int, bool as tslBool, max, min, sqrt, cos, sin, pow, dot, normalize, cross, abs, mix, clamp, smoothstep, If } from 'three/tsl';
import { wgslFn } from 'three/tsl';

/**
 * Lights Core for TSL/WGSL
 * Complete port of lights_core.fs from GLSL to TSL/WGSL
 *
 * This module contains:
 * - Light data structures
 * - Light data access functions
 * - Light utility functions (attenuation, MIS, cone sampling)
 * - Light intersection tests
 *
 * Matches the GLSL implementation exactly.
 */

// ================================================================================
// CONSTANTS
// ================================================================================

const EPSILON = 1e-6;
const PI = Math.PI;
const TWO_PI = 2.0 * Math.PI;

// Light type constants
const LIGHT_TYPE_DIRECTIONAL = 0;
const LIGHT_TYPE_AREA = 1;
const LIGHT_TYPE_POINT = 2;
const LIGHT_TYPE_SPOT = 3;

// ================================================================================
// LIGHT STRUCTURE DEFINITIONS
// ================================================================================

/**
 * DirectionalLight structure - sun/moon-like directional lighting.
 * Includes angular diameter for soft shadows.
 */
export const directionalLightStruct = wgslFn( `
struct DirectionalLight {
	direction: vec3f,
	color: vec3f,
	intensity: f32,
	angle: f32  // Angular diameter in radians
}
` );

/**
 * AreaLight structure - rectangular area light source.
 */
export const areaLightStruct = wgslFn( `
struct AreaLight {
	position: vec3f,
	u: vec3f,        // First axis of the rectangular light
	v: vec3f,        // Second axis of the rectangular light
	color: vec3f,
	intensity: f32,
	normal: vec3f,
	area: f32
}
` );

/**
 * PointLight structure - omnidirectional point light source.
 */
export const pointLightStruct = wgslFn( `
struct PointLight {
	position: vec3f,
	color: vec3f,
	intensity: f32
}
` );

/**
 * SpotLight structure - cone-shaped spot light source.
 */
export const spotLightStruct = wgslFn( `
struct SpotLight {
	position: vec3f,
	direction: vec3f,
	color: vec3f,
	intensity: f32,
	angle: f32  // cone half-angle in radians
}
` );

/**
 * LightSample structure - result of light sampling.
 */
export const lightSampleStruct = wgslFn( `
struct LightSample {
	direction: vec3f,
	emission: vec3f,
	pdf: f32,
	distance: f32,
	lightType: i32,
	valid: u32  // bool as u32
}
` );

/**
 * IndirectLightingResult structure - result of indirect lighting sampling.
 */
export const indirectLightingResultStruct = wgslFn( `
struct IndirectLightingResult {
	direction: vec3f,     // Sampled direction for next bounce
	throughput: vec3f,    // Light throughput along this path
	misWeight: f32,       // MIS weight for this sample
	pdf: f32              // PDF of the generated sample
}
` );

// ================================================================================
// LIGHT DATA ACCESS FUNCTIONS
// ================================================================================

/**
 * Get directional light data from uniform array.
 * 
 * @param {TSLNode} directionalLights - Uniform array of directional light data (array<f32>)
 * @param {TSLNode} index - Light index (int)
 * @returns {TSLNode} DirectionalLight struct
 */
export const getDirectionalLight = Fn( ( [ directionalLights, index ] ) => {

	const baseIndex = index.mul( 8 ).toVar(); // 8 floats per light

	const light = {
		direction: normalize( vec3(
			directionalLights.element( baseIndex ),
			directionalLights.element( baseIndex.add( 1 ) ),
			directionalLights.element( baseIndex.add( 2 ) )
		) ),
		color: vec3(
			directionalLights.element( baseIndex.add( 3 ) ),
			directionalLights.element( baseIndex.add( 4 ) ),
			directionalLights.element( baseIndex.add( 5 ) )
		),
		intensity: directionalLights.element( baseIndex.add( 6 ) ),
		angle: directionalLights.element( baseIndex.add( 7 ) )
	};

	return light;

} ).setLayout( {
	name: 'getDirectionalLight',
	type: 'DirectionalLight',
	inputs: [
		{ name: 'directionalLights', type: 'array<f32>' },
		{ name: 'index', type: 'int' }
	]
} );

/**
 * Get area light data from uniform array.
 * 
 * @param {TSLNode} areaLights - Uniform array of area light data (array<f32>)
 * @param {TSLNode} index - Light index (int)
 * @returns {TSLNode} AreaLight struct
 */
export const getAreaLight = Fn( ( [ areaLights, index ] ) => {

	const baseIndex = index.mul( 13 ).toVar(); // 13 floats per light

	const position = vec3(
		areaLights.element( baseIndex ),
		areaLights.element( baseIndex.add( 1 ) ),
		areaLights.element( baseIndex.add( 2 ) )
	).toVar();

	const u = vec3(
		areaLights.element( baseIndex.add( 3 ) ),
		areaLights.element( baseIndex.add( 4 ) ),
		areaLights.element( baseIndex.add( 5 ) )
	).toVar();

	const v = vec3(
		areaLights.element( baseIndex.add( 6 ) ),
		areaLights.element( baseIndex.add( 7 ) ),
		areaLights.element( baseIndex.add( 8 ) )
	).toVar();

	const color = vec3(
		areaLights.element( baseIndex.add( 9 ) ),
		areaLights.element( baseIndex.add( 10 ) ),
		areaLights.element( baseIndex.add( 11 ) )
	).toVar();

	const intensity = areaLights.element( baseIndex.add( 12 ) ).toVar();

	const light = {
		position: position,
		u: u,
		v: v,
		color: color,
		intensity: intensity,
		normal: normalize( cross( u, v ) ),
		area: cross( u, v ).length()
	};

	return light;

} ).setLayout( {
	name: 'getAreaLight',
	type: 'AreaLight',
	inputs: [
		{ name: 'areaLights', type: 'array<f32>' },
		{ name: 'index', type: 'int' }
	]
} );

/**
 * Get point light data from uniform array.
 * 
 * @param {TSLNode} pointLights - Uniform array of point light data (array<f32>)
 * @param {TSLNode} index - Light index (int)
 * @returns {TSLNode} PointLight struct
 */
export const getPointLight = Fn( ( [ pointLights, index ] ) => {

	const baseIndex = index.mul( 7 ).toVar(); // 7 floats per light

	const light = {
		position: vec3(
			pointLights.element( baseIndex ),
			pointLights.element( baseIndex.add( 1 ) ),
			pointLights.element( baseIndex.add( 2 ) )
		),
		color: vec3(
			pointLights.element( baseIndex.add( 3 ) ),
			pointLights.element( baseIndex.add( 4 ) ),
			pointLights.element( baseIndex.add( 5 ) )
		),
		intensity: pointLights.element( baseIndex.add( 6 ) )
	};

	return light;

} ).setLayout( {
	name: 'getPointLight',
	type: 'PointLight',
	inputs: [
		{ name: 'pointLights', type: 'array<f32>' },
		{ name: 'index', type: 'int' }
	]
} );

/**
 * Get spot light data from uniform array.
 * 
 * @param {TSLNode} spotLights - Uniform array of spot light data (array<f32>)
 * @param {TSLNode} index - Light index (int)
 * @returns {TSLNode} SpotLight struct
 */
export const getSpotLight = Fn( ( [ spotLights, index ] ) => {

	const baseIndex = index.mul( 11 ).toVar(); // 11 floats per light

	const light = {
		position: vec3(
			spotLights.element( baseIndex ),
			spotLights.element( baseIndex.add( 1 ) ),
			spotLights.element( baseIndex.add( 2 ) )
		),
		direction: normalize( vec3(
			spotLights.element( baseIndex.add( 3 ) ),
			spotLights.element( baseIndex.add( 4 ) ),
			spotLights.element( baseIndex.add( 5 ) )
		) ),
		color: vec3(
			spotLights.element( baseIndex.add( 6 ) ),
			spotLights.element( baseIndex.add( 7 ) ),
			spotLights.element( baseIndex.add( 8 ) )
		),
		intensity: spotLights.element( baseIndex.add( 9 ) ),
		angle: spotLights.element( baseIndex.add( 10 ) )
	};

	return light;

} ).setLayout( {
	name: 'getSpotLight',
	type: 'SpotLight',
	inputs: [
		{ name: 'spotLights', type: 'array<f32>' },
		{ name: 'index', type: 'int' }
	]
} );

// ================================================================================
// LIGHT UTILITY FUNCTIONS
// ================================================================================

/**
 * Get total number of lights in the scene.
 * NOTE: In TSL/WGSL, this should be passed as a uniform since preprocessor
 * directives don't exist. This is a placeholder implementation.
 * 
 * @param {TSLNode} maxDirectionalLights - Max directional lights (int)
 * @param {TSLNode} maxAreaLights - Max area lights (int)
 * @param {TSLNode} maxPointLights - Max point lights (int)
 * @param {TSLNode} maxSpotLights - Max spot lights (int)
 * @returns {TSLNode} Total light count (int)
 */
export const getTotalLightCount = Fn( ( [ maxDirectionalLights, maxAreaLights, maxPointLights, maxSpotLights ] ) => {

	const count = int( 0 ).toVar();
	count.assign( count.add( maxDirectionalLights ) );
	count.assign( count.add( maxAreaLights ) );
	count.assign( count.add( maxPointLights ) );
	count.assign( count.add( maxSpotLights ) );

	return count;

} ).setLayout( {
	name: 'getTotalLightCount',
	type: 'int',
	inputs: [
		{ name: 'maxDirectionalLights', type: 'int' },
		{ name: 'maxAreaLights', type: 'int' },
		{ name: 'maxPointLights', type: 'int' },
		{ name: 'maxSpotLights', type: 'int' }
	]
} );

/**
 * Utility function to validate ray direction.
 * Checks if direction points away from surface (dot product > 0).
 * 
 * @param {TSLNode} direction - Ray direction (vec3)
 * @param {TSLNode} surfaceNormal - Surface normal (vec3)
 * @returns {TSLNode} True if direction is valid (bool)
 */
export const isDirectionValid = Fn( ( [ direction, surfaceNormal ] ) => {

	return dot( direction, surfaceNormal ).greaterThan( 0.0 );

} ).setLayout( {
	name: 'isDirectionValid',
	type: 'bool',
	inputs: [
		{ name: 'direction', type: 'vec3' },
		{ name: 'surfaceNormal', type: 'vec3' }
	]
} );

/**
 * Distance attenuation based on Frostbite PBR.
 * Implements physically-based light falloff with cutoff distance.
 * 
 * @param {TSLNode} lightDistance - Distance to light (float)
 * @param {TSLNode} cutoffDistance - Maximum light distance (float)
 * @param {TSLNode} decayExponent - Decay rate (typically 2.0 for physical) (float)
 * @returns {TSLNode} Attenuation factor [0, 1] (float)
 */
export const getDistanceAttenuation = Fn( ( [ lightDistance, cutoffDistance, decayExponent ] ) => {

	// Basic inverse square law with minimum threshold
	const distanceFalloff = float( 1.0 ).div(
		max( pow( lightDistance, decayExponent ), float( 0.01 ) )
	).toVar();

	// Smooth cutoff if distance limit is set
	If( cutoffDistance.greaterThan( 0.0 ), () => {

		const cutoffFactor = pow(
			clamp(
				float( 1.0 ).sub( pow( lightDistance.div( cutoffDistance ), float( 4.0 ) ) ),
				float( 0.0 ),
				float( 1.0 )
			),
			float( 2.0 )
		);

		distanceFalloff.assign( distanceFalloff.mul( cutoffFactor ) );

	} );

	return distanceFalloff;

} ).setLayout( {
	name: 'getDistanceAttenuation',
	type: 'float',
	inputs: [
		{ name: 'lightDistance', type: 'float' },
		{ name: 'cutoffDistance', type: 'float' },
		{ name: 'decayExponent', type: 'float' }
	]
} );

/**
 * Spot light attenuation based on cone angle.
 * Smooth falloff from inner to outer cone.
 * 
 * @param {TSLNode} coneCosine - Cosine of outer cone angle (float)
 * @param {TSLNode} penumbraCosine - Cosine of inner cone angle (float)
 * @param {TSLNode} angleCosine - Cosine of angle to light direction (float)
 * @returns {TSLNode} Attenuation factor [0, 1] (float)
 */
export const getSpotAttenuation = Fn( ( [ coneCosine, penumbraCosine, angleCosine ] ) => {

	return smoothstep( coneCosine, penumbraCosine, angleCosine );

} ).setLayout( {
	name: 'getSpotAttenuation',
	type: 'float',
	inputs: [
		{ name: 'coneCosine', type: 'float' },
		{ name: 'penumbraCosine', type: 'float' },
		{ name: 'angleCosine', type: 'float' }
	]
} );

/**
 * Power heuristic for Multiple Importance Sampling (MIS).
 * Balance heuristic with exponent 2.
 * 
 * @param {TSLNode} a - PDF of strategy A (float)
 * @param {TSLNode} b - PDF of strategy B (float)
 * @returns {TSLNode} MIS weight for strategy A (float)
 */
export const misHeuristic = Fn( ( [ a, b ] ) => {

	const aa = a.mul( a ).toVar();
	const bb = b.mul( b ).toVar();

	return aa.div( max( aa.add( bb ), float( EPSILON ) ) );

} ).setLayout( {
	name: 'misHeuristic',
	type: 'float',
	inputs: [
		{ name: 'a', type: 'float' },
		{ name: 'b', type: 'float' }
	]
} );

// ================================================================================
// CONE SAMPLING FOR SOFT DIRECTIONAL SHADOWS
// ================================================================================

/**
 * Sample direction within a cone for soft shadows.
 * Used for directional lights with angular diameter.
 * 
 * @param {TSLNode} direction - Central cone direction (vec3)
 * @param {TSLNode} halfAngle - Half-angle of cone in radians (float)
 * @param {TSLNode} xi - Random sample [0, 1]² (vec2)
 * @returns {TSLNode} Sampled direction within cone (vec3)
 */
export const sampleCone = Fn( ( [ direction, halfAngle, xi ] ) => {

	// Sample within cone using spherical coordinates
	const cosHalfAngle = cos( halfAngle ).toVar();
	const cosTheta = mix( cosHalfAngle, float( 1.0 ), xi.x ).toVar();
	const sinTheta = sqrt( float( 1.0 ).sub( cosTheta.mul( cosTheta ) ) ).toVar();
	const phi = float( TWO_PI ).mul( xi.y ).toVar();

	// Create local coordinate system
	const up = abs( direction.z ).lessThan( 0.999 ).select(
		vec3( 0.0, 0.0, 1.0 ),
		vec3( 1.0, 0.0, 0.0 )
	).toVar();

	const tangent = normalize( cross( up, direction ) ).toVar();
	const bitangent = cross( direction, tangent ).toVar();

	// Convert to world space
	const localDir = vec3(
		sinTheta.mul( cos( phi ) ),
		sinTheta.mul( sin( phi ) ),
		cosTheta
	).toVar();

	return normalize(
		tangent.mul( localDir.x )
			.add( bitangent.mul( localDir.y ) )
			.add( direction.mul( localDir.z ) )
	);

} ).setLayout( {
	name: 'sampleCone',
	type: 'vec3',
	inputs: [
		{ name: 'direction', type: 'vec3' },
		{ name: 'halfAngle', type: 'float' },
		{ name: 'xi', type: 'vec2' }
	]
} );

// ================================================================================
// LIGHT INTERSECTION TESTS
// ================================================================================

/**
 * Intersect ray with area light.
 * Fast rectangle intersection test with backface culling.
 * 
 * @param {TSLNode} light - AreaLight struct
 * @param {TSLNode} rayOrigin - Ray origin point (vec3)
 * @param {TSLNode} rayDirection - Ray direction (vec3)
 * @param {TSLNode} t - Output: intersection distance (float, modified in place)
 * @returns {TSLNode} True if intersection occurs (bool)
 */
export const intersectAreaLight = Fn( ( [ light, rayOrigin, rayDirection, t ] ) => {

	// Fast path - precomputed normal
	const normal = light.normal.toVar();
	const denom = dot( normal, rayDirection ).toVar();

	// Quick rejection (backface culling and near-parallel rays)
	If( denom.greaterThanEqual( float( - 0.0001 ) ), () => {

		return tslBool( false );

	} );

	// Calculate intersection distance
	const invDenom = float( 1.0 ).div( denom ).toVar();
	t.assign( dot( light.position.sub( rayOrigin ), normal ).mul( invDenom ) );

	// Skip intersections behind the ray
	If( t.lessThanEqual( 0.001 ), () => {

		return tslBool( false );

	} );

	// Optimized rectangle test using vector rejection
	const hitPoint = rayOrigin.add( rayDirection.mul( t ) ).toVar();
	const localPoint = hitPoint.sub( light.position ).toVar();

	// Normalized u/v directions
	const u_dir = light.u.div( light.u.length() ).toVar();
	const v_dir = light.v.div( light.v.length() ).toVar();

	// Project onto axes
	const u_proj = dot( localPoint, u_dir ).toVar();
	const v_proj = dot( localPoint, v_dir ).toVar();

	// Check within rectangle bounds (half-lengths)
	return abs( u_proj ).lessThanEqual( light.u.length() )
		.and( abs( v_proj ).lessThanEqual( light.v.length() ) );

} ).setLayout( {
	name: 'intersectAreaLight',
	type: 'bool',
	inputs: [
		{ name: 'light', type: 'AreaLight' },
		{ name: 'rayOrigin', type: 'vec3' },
		{ name: 'rayDirection', type: 'vec3' },
		{ name: 't', type: 'float' }
	]
} );

/**
 * Evaluate area light helper function for debugging/visualization.
 * Returns light contribution if ray hits the light surface.
 * 
 * @param {TSLNode} light - AreaLight struct
 * @param {TSLNode} ray - Ray struct (origin, direction)
 * @param {TSLNode} didHit - Output: true if light was hit (bool, modified in place)
 * @returns {TSLNode} Light emission color (vec3)
 */
export const evaluateAreaLightHelper = Fn( ( [ light, ray, didHit ] ) => {

	// Get light plane normal
	const lightNormal = normalize( cross( light.u, light.v ) ).toVar();

	// Calculate intersection with the light plane
	const denom = dot( lightNormal, ray.direction ).toVar();

	// Skip if ray is parallel to plane
	If( abs( denom ).lessThan( float( 1e-6 ) ), () => {

		didHit.assign( tslBool( false ) );
		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Calculate intersection distance
	const t = dot( light.position.sub( ray.origin ), lightNormal ).div( denom ).toVar();

	// Skip if intersection is behind ray
	If( t.lessThan( 0.0 ), () => {

		didHit.assign( tslBool( false ) );
		return vec3( 0.0, 0.0, 0.0 );

	} );

	// Calculate intersection point
	const hitPoint = ray.origin.add( ray.direction.mul( t ) ).toVar();
	const localPoint = hitPoint.sub( light.position ).toVar();

	// Project onto light's axes
	const u = dot( localPoint, normalize( light.u ) ).toVar();
	const v = dot( localPoint, normalize( light.v ) ).toVar();

	// Check if point is within rectangle bounds
	If( abs( u ).lessThanEqual( light.u.length() )
		.and( abs( v ).lessThanEqual( light.v.length() ) ), () => {

		didHit.assign( tslBool( true ) );
		// Return visualization color based on light properties
		return light.color.mul( light.intensity ).mul( 0.1 ); // Scale for visibility

	} );

	didHit.assign( tslBool( false ) );
	return vec3( 0.0, 0.0, 0.0 );

} ).setLayout( {
	name: 'evaluateAreaLightHelper',
	type: 'vec3',
	inputs: [
		{ name: 'light', type: 'AreaLight' },
		{ name: 'ray', type: 'Ray' },
		{ name: 'didHit', type: 'bool' }
	]
} );

// Export light type constants for use in other modules
export { LIGHT_TYPE_DIRECTIONAL, LIGHT_TYPE_AREA, LIGHT_TYPE_POINT, LIGHT_TYPE_SPOT };
