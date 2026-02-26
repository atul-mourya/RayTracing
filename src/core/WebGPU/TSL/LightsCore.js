// Lights Core - Ported from lights_core.fs
// Light data structures, access functions, and utility functions

import {
	Fn, wgslFn,
	vec3,
	float,
	bool as tslBool,
	If,
	dot,
	normalize,
	cross,
	length,
	abs,
} from 'three/tsl';

import { struct } from './structProxy.js';
import { REC709_LUMINANCE_COEFFICIENTS } from './Common.js';
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
	).toVar();
	const v = vec3(
		areaLightsBuffer.element( baseIndex.add( 6 ) ),
		areaLightsBuffer.element( baseIndex.add( 7 ) ),
		areaLightsBuffer.element( baseIndex.add( 8 ) ),
	).toVar();

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
export const isDirectionValid = /*@__PURE__*/ wgslFn( `
	fn isDirectionValid( direction: vec3f, surfaceNormal: vec3f ) -> bool {
		return dot( direction, surfaceNormal ) > 0.0f;
	}
` );

// Distance attenuation based on Frostbite PBR
export const getDistanceAttenuation = /*@__PURE__*/ wgslFn( `
	fn getDistanceAttenuation( lightDistance: f32, cutoffDistance: f32, decayExponent: f32 ) -> f32 {
		var distanceFalloff = 1.0f / max( pow( lightDistance, decayExponent ), 0.01f );
		if ( cutoffDistance > 0.0f ) {
			let ratio = pow( lightDistance / cutoffDistance, 4.0f );
			distanceFalloff *= pow( clamp( 1.0f - ratio, 0.0f, 1.0f ), 2.0f );
		}
		return distanceFalloff;
	}
` );

// Spot light attenuation
export const getSpotAttenuation = /*@__PURE__*/ wgslFn( `
	fn getSpotAttenuation( coneCosine: f32, penumbraCosine: f32, angleCosine: f32 ) -> f32 {
		return smoothstep( coneCosine, penumbraCosine, angleCosine );
	}
` );

// Power heuristic for MIS
export const misHeuristic = /*@__PURE__*/ wgslFn( `
	fn misHeuristic( a: f32, b: f32 ) -> f32 {
		let aa = a * a;
		let bb = b * b;
		return aa / max( aa + bb, 1e-6f );
	}
` );

// ================================================================================
// CONE SAMPLING FOR SOFT DIRECTIONAL SHADOWS
// ================================================================================

export const sampleCone = /*@__PURE__*/ wgslFn( `
	fn sampleCone( direction: vec3f, halfAngle: f32, xi: vec2f ) -> vec3f {
		let cosHalfAngle = cos( halfAngle );
		let cosTheta = cosHalfAngle + xi.x * ( 1.0f - cosHalfAngle );
		let sinTheta = sqrt( 1.0f - cosTheta * cosTheta );
		let phi = 6.28318530717958647692f * xi.y;
		// Create local coordinate system
		let up = select( vec3f( 1.0f, 0.0f, 0.0f ), vec3f( 0.0f, 0.0f, 1.0f ), abs( direction.z ) < 0.999f );
		let tangent = normalize( cross( up, direction ) );
		let bitangent = cross( direction, tangent );
		// Convert to world space
		let localDir = vec3f( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );
		return normalize( tangent * localDir.x + bitangent * localDir.y + direction * localDir.z );
	}
` );

// ================================================================================
// AREA LIGHT INTERSECTION TEST
// ================================================================================

// Returns float: t distance if hit, -1.0 if no hit
export const intersectAreaLight = Fn( ( [ light, rayOrigin, rayDirection ] ) => {

	const normal = light.normal;
	const denom = dot( normal, rayDirection );

	const result = float( - 1.0 ).toVar();

	// Quick rejection (backface culling and near-parallel rays)
	If( denom.lessThan( - 0.0001 ), () => {

		const invDenom = float( 1.0 ).div( denom );
		const t = dot( light.position.sub( rayOrigin ), normal ).mul( invDenom ).toVar();

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

	const result = vec3( 0.0 ).toVar();
	const didHit = tslBool( false ).toVar();

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
