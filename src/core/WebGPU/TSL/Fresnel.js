import { Fn, float, vec3, pow, sqrt, clamp, max } from 'three/tsl';
import { square } from './Common.js';

/**
 * Fresnel Functions for TSL/WGSL
 * Complete port of fresnel.fs from GLSL to TSL/WGSL
 *
 * Provides comprehensive Fresnel calculations for physically-based rendering:
 * - Fresnel reflectance with roughness
 * - Schlick's approximation (note: also available in BSDF.js)
 * - IOR to Fresnel0 conversion
 * - Fresnel0 to IOR conversion
 *
 * Note: fresnelSchlick is also exported from BSDF.js for convenience.
 * Import from either module depending on your needs.
 */

// ================================================================================
// EPSILON CONSTANT
// ================================================================================

const EPSILON = 1e-6;

// ================================================================================
// FRESNEL REFLECTANCE FUNCTIONS
// ================================================================================

/**
 * Fresnel reflectance with roughness consideration.
 * Combines Schlick approximation with roughness-dependent max reflectance.
 *
 * @param {TSLNode} f0 - Base reflectance at normal incidence (vec3)
 * @param {TSLNode} NoV - Cosine of angle between normal and view direction (float)
 * @param {TSLNode} roughness - Surface roughness [0, 1] (float)
 * @returns {TSLNode} Fresnel reflectance (vec3)
 */
export const fresnel = Fn( ( [ f0, NoV, roughness ] ) => {

	const maxReflectance = max( vec3( float( 1.0 ).sub( roughness ) ), f0 ).toVar();
	const oneMinusNoV = float( 1.0 ).sub( NoV ).toVar();
	const power5 = pow( oneMinusNoV, float( 5.0 ) ).toVar();

	return f0.add( maxReflectance.sub( f0 ).mul( power5 ) );

} ).setLayout( {
	name: 'fresnel',
	type: 'vec3',
	inputs: [
		{ name: 'f0', type: 'vec3' },
		{ name: 'NoV', type: 'float' },
		{ name: 'roughness', type: 'float' }
	]
} );

/**
 * Schlick's approximation for Fresnel reflectance (float variant).
 * Efficient approximation of the Fresnel equations.
 *
 * @param {TSLNode} cosTheta - Cosine of angle between view and surface normal (float)
 * @param {TSLNode} F0 - Base reflectance at normal incidence (float)
 * @returns {TSLNode} Fresnel reflectance (float)
 */
export const fresnelSchlickFloat = Fn( ( [ cosTheta, F0 ] ) => {

	const clampedCos = clamp( cosTheta, float( 0.0 ), float( 1.0 ) ).toVar();
	const oneMinusCos = float( 1.0 ).sub( clampedCos ).toVar();
	const power5 = pow( oneMinusCos, float( 5.0 ) ).toVar();

	return F0.add( float( 1.0 ).sub( F0 ).mul( power5 ) );

} ).setLayout( {
	name: 'fresnelSchlickFloat',
	type: 'float',
	inputs: [
		{ name: 'cosTheta', type: 'float' },
		{ name: 'F0', type: 'float' }
	]
} );

/**
 * Schlick's approximation for Fresnel reflectance (vec3 variant).
 * Efficient approximation of the Fresnel equations.
 *
 * Note: This is also available in BSDF.js as fresnelSchlick.
 * This version is provided for completeness of the Fresnel module.
 *
 * @param {TSLNode} cosTheta - Cosine of angle between view and surface normal (float)
 * @param {TSLNode} F0 - Base reflectance at normal incidence (vec3)
 * @returns {TSLNode} Fresnel reflectance (vec3)
 */
export const fresnelSchlickVec3 = Fn( ( [ cosTheta, F0 ] ) => {

	const clampedCos = clamp( cosTheta, float( 0.0 ), float( 1.0 ) ).toVar();
	const oneMinusCos = float( 1.0 ).sub( clampedCos ).toVar();
	const power5 = pow( oneMinusCos, float( 5.0 ) ).toVar();

	return F0.add( vec3( 1.0 ).sub( F0 ).mul( power5 ) );

} ).setLayout( {
	name: 'fresnelSchlickVec3',
	type: 'vec3',
	inputs: [
		{ name: 'cosTheta', type: 'float' },
		{ name: 'F0', type: 'vec3' }
	]
} );

// ================================================================================
// IOR CONVERSION FUNCTIONS
// ================================================================================

/**
 * Convert Fresnel reflectance (F0) to index of refraction (IOR).
 * Uses the Fresnel equations to derive IOR from reflectance.
 *
 * @param {TSLNode} fresnel0 - Base reflectance at normal incidence (vec3)
 * @returns {TSLNode} Index of refraction (vec3)
 */
export const fresnel0ToIor = Fn( ( [ fresnel0 ] ) => {

	const sqrtF0 = sqrt( fresnel0 ).toVar();
	const numerator = vec3( 1.0 ).add( sqrtF0 ).toVar();
	const denominator = max( vec3( 1.0 ).sub( sqrtF0 ), vec3( EPSILON ) ).toVar();

	return numerator.div( denominator );

} ).setLayout( {
	name: 'fresnel0ToIor',
	type: 'vec3',
	inputs: [
		{ name: 'fresnel0', type: 'vec3' }
	]
} );

/**
 * Convert index of refraction to Fresnel reflectance (F0) - vec3 variant.
 * Calculates normal incidence reflectance from IOR values.
 *
 * @param {TSLNode} transmittedIor - IOR of transmitted medium (vec3)
 * @param {TSLNode} incidentIor - IOR of incident medium, typically air (1.0) (float)
 * @returns {TSLNode} Base reflectance at normal incidence (vec3)
 */
export const iorToFresnel0Vec3 = Fn( ( [ transmittedIor, incidentIor ] ) => {

	const numerator = transmittedIor.sub( vec3( incidentIor ) ).toVar();
	const denominator = max( transmittedIor.add( vec3( incidentIor ) ), vec3( EPSILON ) ).toVar();
	const ratio = numerator.div( denominator ).toVar();

	return square( ratio );

} ).setLayout( {
	name: 'iorToFresnel0Vec3',
	type: 'vec3',
	inputs: [
		{ name: 'transmittedIor', type: 'vec3' },
		{ name: 'incidentIor', type: 'float' }
	]
} );

/**
 * Convert index of refraction to Fresnel reflectance (F0) - float variant.
 * Calculates normal incidence reflectance from IOR values.
 *
 * @param {TSLNode} transmittedIor - IOR of transmitted medium (float)
 * @param {TSLNode} incidentIor - IOR of incident medium, typically air (1.0) (float)
 * @returns {TSLNode} Base reflectance at normal incidence (float)
 */
export const iorToFresnel0Float = Fn( ( [ transmittedIor, incidentIor ] ) => {

	const numerator = transmittedIor.sub( incidentIor ).toVar();
	const denominator = max( transmittedIor.add( incidentIor ), float( EPSILON ) ).toVar();
	const ratio = numerator.div( denominator ).toVar();

	return square( ratio );

} ).setLayout( {
	name: 'iorToFresnel0Float',
	type: 'float',
	inputs: [
		{ name: 'transmittedIor', type: 'float' },
		{ name: 'incidentIor', type: 'float' }
	]
} );

// ================================================================================
// CONVENIENCE ALIASES
// ================================================================================

/**
 * Alias for vec3 variant of iorToFresnel0 (matches GLSL overload pattern).
 */
export const iorToFresnel0 = iorToFresnel0Vec3;

/**
 * Alias for vec3 variant of fresnelSchlick (matches GLSL overload pattern).
 * Note: Also available in BSDF.js
 */
export const fresnelSchlick = fresnelSchlickVec3;
