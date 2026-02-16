// Lights Core - Ported from lights_core.fs
// Light data structures, access functions, and utility functions

import {
	Fn,
	vec3,
	float,
	int,
	bool as tslBool,
	If,
	dot,
	normalize,
	cross,
	length,
	abs,
	max,
	min,
	pow,
	clamp,
	cos,
	sin,
	sqrt,
	smoothstep,
	select,
} from 'three/tsl';

import { struct } from './structProxy.js';
import { TWO_PI, EPSILON, REC709_LUMINANCE_COEFFICIENTS } from './Common.js';
import { Ray } from './Struct.js';

// ================================================================================
// LIGHT STRUCTURES
// ================================================================================

export const DirectionalLight = struct( {
	direction: 'vec3',
	color: 'vec3',
	intensity: 'float',
	angle: 'float', // Angular diameter in radians
} );

export const AreaLight = struct( {
	position: 'vec3',
	u: 'vec3', // First axis of the rectangular light
	v: 'vec3', // Second axis of the rectangular light
	color: 'vec3',
	intensity: 'float',
	normal: 'vec3',
	area: 'float',
} );

export const PointLight = struct( {
	position: 'vec3',
	color: 'vec3',
	intensity: 'float',
} );

export const SpotLight = struct( {
	position: 'vec3',
	direction: 'vec3',
	color: 'vec3',
	intensity: 'float',
	angle: 'float', // cone half-angle in radians
} );

export const LightSample = struct( {
	direction: 'vec3',
	emission: 'vec3',
	pdf: 'float',
	distance: 'float',
	lightType: 'int',
	valid: 'bool',
} );

export const IndirectLightingResult = struct( {
	direction: 'vec3', // Sampled direction for next bounce
	throughput: 'vec3', // Light throughput along this path
	misWeight: 'float', // MIS weight for this sample
	pdf: 'float', // PDF of the generated sample
} );

// Light type constants
export const LIGHT_TYPE_DIRECTIONAL = 0;
export const LIGHT_TYPE_AREA = 1;
export const LIGHT_TYPE_POINT = 2;
export const LIGHT_TYPE_SPOT = 3;

// ================================================================================
// LIGHT DATA ACCESS FUNCTIONS
// ================================================================================

export const getDirectionalLight = Fn( ( [ directionalLightsBuffer, index ] ) => {

	const baseIndex = index.mul( 8 );
	return DirectionalLight( {
		direction: normalize( vec3(
			directionalLightsBuffer.element( baseIndex ),
			directionalLightsBuffer.element( baseIndex.add( 1 ) ),
			directionalLightsBuffer.element( baseIndex.add( 2 ) ),
		) ),
		color: vec3(
			directionalLightsBuffer.element( baseIndex.add( 3 ) ),
			directionalLightsBuffer.element( baseIndex.add( 4 ) ),
			directionalLightsBuffer.element( baseIndex.add( 5 ) ),
		),
		intensity: directionalLightsBuffer.element( baseIndex.add( 6 ) ),
		angle: directionalLightsBuffer.element( baseIndex.add( 7 ) ),
	} );

} );

export const getAreaLight = Fn( ( [ areaLightsBuffer, index ] ) => {

	const baseIndex = index.mul( 13 );
	const u = vec3(
		areaLightsBuffer.element( baseIndex.add( 3 ) ),
		areaLightsBuffer.element( baseIndex.add( 4 ) ),
		areaLightsBuffer.element( baseIndex.add( 5 ) ),
	).toVar( 'alU' );
	const v = vec3(
		areaLightsBuffer.element( baseIndex.add( 6 ) ),
		areaLightsBuffer.element( baseIndex.add( 7 ) ),
		areaLightsBuffer.element( baseIndex.add( 8 ) ),
	).toVar( 'alV' );

	const crossUV = cross( u, v );

	return AreaLight( {
		position: vec3(
			areaLightsBuffer.element( baseIndex ),
			areaLightsBuffer.element( baseIndex.add( 1 ) ),
			areaLightsBuffer.element( baseIndex.add( 2 ) ),
		),
		u: u,
		v: v,
		color: vec3(
			areaLightsBuffer.element( baseIndex.add( 9 ) ),
			areaLightsBuffer.element( baseIndex.add( 10 ) ),
			areaLightsBuffer.element( baseIndex.add( 11 ) ),
		),
		intensity: areaLightsBuffer.element( baseIndex.add( 12 ) ),
		normal: normalize( crossUV ),
		area: length( crossUV ),
	} );

} );

export const getPointLight = Fn( ( [ pointLightsBuffer, index ] ) => {

	const baseIndex = index.mul( 7 );
	return PointLight( {
		position: vec3(
			pointLightsBuffer.element( baseIndex ),
			pointLightsBuffer.element( baseIndex.add( 1 ) ),
			pointLightsBuffer.element( baseIndex.add( 2 ) ),
		),
		color: vec3(
			pointLightsBuffer.element( baseIndex.add( 3 ) ),
			pointLightsBuffer.element( baseIndex.add( 4 ) ),
			pointLightsBuffer.element( baseIndex.add( 5 ) ),
		),
		intensity: pointLightsBuffer.element( baseIndex.add( 6 ) ),
	} );

} );

export const getSpotLight = Fn( ( [ spotLightsBuffer, index ] ) => {

	const baseIndex = index.mul( 11 );
	return SpotLight( {
		position: vec3(
			spotLightsBuffer.element( baseIndex ),
			spotLightsBuffer.element( baseIndex.add( 1 ) ),
			spotLightsBuffer.element( baseIndex.add( 2 ) ),
		),
		direction: normalize( vec3(
			spotLightsBuffer.element( baseIndex.add( 3 ) ),
			spotLightsBuffer.element( baseIndex.add( 4 ) ),
			spotLightsBuffer.element( baseIndex.add( 5 ) ),
		) ),
		color: vec3(
			spotLightsBuffer.element( baseIndex.add( 6 ) ),
			spotLightsBuffer.element( baseIndex.add( 7 ) ),
			spotLightsBuffer.element( baseIndex.add( 8 ) ),
		),
		intensity: spotLightsBuffer.element( baseIndex.add( 9 ) ),
		angle: spotLightsBuffer.element( baseIndex.add( 10 ) ),
	} );

} );

// ================================================================================
// UTILITY FUNCTIONS
// ================================================================================

// Utility function to validate ray direction
export const isDirectionValid = Fn( ( [ direction, surfaceNormal ] ) => {

	return dot( direction, surfaceNormal ).greaterThan( 0.0 );

} );

// Distance attenuation based on Frostbite PBR
export const getDistanceAttenuation = Fn( ( [ lightDistance, cutoffDistance, decayExponent ] ) => {

	const distanceFalloff = float( 1.0 ).div( max( pow( lightDistance, decayExponent ), 0.01 ) ).toVar( 'distFalloff' );

	If( cutoffDistance.greaterThan( 0.0 ), () => {

		const ratio = pow( lightDistance.div( cutoffDistance ), float( 4.0 ) );
		distanceFalloff.mulAssign( pow( clamp( float( 1.0 ).sub( ratio ), 0.0, 1.0 ), float( 2.0 ) ) );

	} );

	return distanceFalloff;

} );

// Spot light attenuation
export const getSpotAttenuation = Fn( ( [ coneCosine, penumbraCosine, angleCosine ] ) => {

	return smoothstep( coneCosine, penumbraCosine, angleCosine );

} );

// Power heuristic for MIS
export const misHeuristic = Fn( ( [ a, b ] ) => {

	const aa = a.mul( a );
	const bb = b.mul( b );
	return aa.div( max( aa.add( bb ), EPSILON ) );

} );

// ================================================================================
// CONE SAMPLING FOR SOFT DIRECTIONAL SHADOWS
// ================================================================================

export const sampleCone = Fn( ( [ direction, halfAngle, xi ] ) => {

	// Sample within cone using spherical coordinates
	const cosHalfAngle = cos( halfAngle );
	const cosTheta = cosHalfAngle.add( xi.x.mul( float( 1.0 ).sub( cosHalfAngle ) ) );
	const sinTheta = sqrt( float( 1.0 ).sub( cosTheta.mul( cosTheta ) ) );
	const phi = TWO_PI.mul( xi.y );

	// Create local coordinate system
	const up = select( abs( direction.z ).lessThan( 0.999 ), vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) );
	const tangent = normalize( cross( up, direction ) );
	const bitangent = cross( direction, tangent );

	// Convert to world space
	const localDir = vec3( sinTheta.mul( cos( phi ) ), sinTheta.mul( sin( phi ) ), cosTheta );
	return normalize(
		tangent.mul( localDir.x ).add( bitangent.mul( localDir.y ) ).add( direction.mul( localDir.z ) )
	);

} );

// ================================================================================
// AREA LIGHT INTERSECTION TEST
// ================================================================================

// Returns float: t distance if hit, -1.0 if no hit
export const intersectAreaLight = Fn( ( [ light, rayOrigin, rayDirection ] ) => {

	const normal = light.normal;
	const denom = dot( normal, rayDirection );

	const result = float( - 1.0 ).toVar( 'areaHitT' );

	// Quick rejection (backface culling and near-parallel rays)
	If( denom.lessThan( - 0.0001 ), () => {

		const invDenom = float( 1.0 ).div( denom );
		const t = dot( light.position.sub( rayOrigin ), normal ).mul( invDenom ).toVar( 'aLitT' );

		// Skip intersections behind the ray
		If( t.greaterThan( 0.001 ), () => {

			// Optimized rectangle test using vector rejection
			const hitPoint = rayOrigin.add( rayDirection.mul( t ) );
			const localPoint = hitPoint.sub( light.position );

			// Normalized u/v directions
			const uLen = length( light.u );
			const vLen = length( light.v );
			const u_dir = light.u.div( uLen );
			const v_dir = light.v.div( vLen );

			// Project onto axes
			const u_proj = dot( localPoint, u_dir );
			const v_proj = dot( localPoint, v_dir );

			// Check within rectangle bounds (half-lengths)
			If( abs( u_proj ).lessThanEqual( uLen ).and( abs( v_proj ).lessThanEqual( vLen ) ), () => {

				result.assign( t );

			} );

		} );

	} );

	return result;

} );

// ================================================================================
// DEBUG/HELPER FUNCTIONS
// ================================================================================

export const evaluateAreaLightHelper = Fn( ( [ light, ray ] ) => {

	// Get light plane normal
	const lightNormal = normalize( cross( light.u, light.v ) );

	// Calculate intersection with the light plane
	const denom = dot( lightNormal, ray.direction );

	const result = vec3( 0.0 ).toVar( 'areaLightDebug' );
	const didHit = tslBool( false ).toVar( 'areaHit' );

	// Skip if ray is parallel to plane
	If( abs( denom ).greaterThanEqual( 1e-6 ), () => {

		// Calculate intersection distance
		const t = dot( light.position.sub( ray.origin ), lightNormal ).div( denom );

		// Skip if intersection is behind ray
		If( t.greaterThanEqual( 0.0 ), () => {

			// Calculate intersection point
			const hitPoint = ray.origin.add( ray.direction.mul( t ) );
			const localPoint = hitPoint.sub( light.position );

			// Project onto light's axes
			const u = dot( localPoint, normalize( light.u ) );
			const v = dot( localPoint, normalize( light.v ) );

			// Check if point is within rectangle bounds
			If( abs( u ).lessThanEqual( length( light.u ) ).and( abs( v ).lessThanEqual( length( light.v ) ) ), () => {

				didHit.assign( true );
				// Return visualization color based on light properties
				result.assign( light.color.mul( light.intensity ).mul( 0.1 ) );

			} );

		} );

	} );

	// Return vec4: xyz = color, w = didHit (1.0 or 0.0)
	return result;

} );
