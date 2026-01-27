import { Fn, float, vec3, If, select } from 'three/tsl';
import { randomFloat } from './Random.js';

/**
 * BSDF (Bidirectional Scattering Distribution Function) module for TSL.
 * Implements GGX microfacet model and Lambertian diffuse.
 */

const PI = Math.PI;
const PI_INV = 1.0 / PI;

/**
 * Schlick's approximation for Fresnel reflectance.
 *
 * @param {TSLNode} cosTheta - Cosine of angle between view and half vector (VoH)
 * @param {TSLNode} F0 - Base reflectance at normal incidence (vec3)
 * @returns {TSLNode} Fresnel reflectance (vec3)
 */
export const fresnelSchlick = Fn( ( [ cosTheta, F0 ] ) => {

	const t = float( 1.0 ).sub( cosTheta ).clamp( 0.0, 1.0 );
	const t5 = t.mul( t ).mul( t ).mul( t ).mul( t ); // (1-cos)^5
	return F0.add( vec3( 1.0 ).sub( F0 ).mul( t5 ) );

} );

/**
 * GGX/Trowbridge-Reitz normal distribution function.
 *
 * @param {TSLNode} NoH - Cosine of angle between normal and half vector
 * @param {TSLNode} roughness - Surface roughness [0, 1]
 * @returns {TSLNode} Distribution value (float)
 */
export const distributionGGX = Fn( ( [ NoH, roughness ] ) => {

	const alpha = roughness.mul( roughness );
	const alpha2 = alpha.mul( alpha );

	const NoH2 = NoH.mul( NoH );
	const denom = NoH2.mul( alpha2.sub( 1.0 ) ).add( 1.0 );

	return alpha2.div( float( PI ).mul( denom ).mul( denom ) );

} );

/**
 * Smith's geometry function for GGX (single direction).
 *
 * @param {TSLNode} NdotV - Cosine of angle between normal and view/light
 * @param {TSLNode} roughness - Surface roughness
 * @returns {TSLNode} Geometry value (float)
 */
export const geometrySchlickGGX = Fn( ( [ NdotV, roughness ] ) => {

	const r = roughness.add( 1.0 );
	const k = r.mul( r ).div( 8.0 );

	const denom = NdotV.mul( float( 1.0 ).sub( k ) ).add( k );
	return NdotV.div( denom );

} );

/**
 * Smith's geometry function (combined view and light).
 *
 * @param {TSLNode} NoV - Cosine of angle between normal and view
 * @param {TSLNode} NoL - Cosine of angle between normal and light
 * @param {TSLNode} roughness - Surface roughness
 * @returns {TSLNode} Combined geometry value (float)
 */
export const geometrySmith = Fn( ( [ NoV, NoL, roughness ] ) => {

	const ggxV = geometrySchlickGGX( NoV, roughness );
	const ggxL = geometrySchlickGGX( NoL, roughness );
	return ggxV.mul( ggxL );

} );

/**
 * Constructs an orthonormal basis (TBN matrix) from a normal vector.
 * Used to transform hemisphere samples to world space.
 *
 * @param {TSLNode} N - Normal vector (vec3, normalized)
 * @returns {Object} Object with T (tangent), B (bitangent), N (normal)
 */
export const buildTBN = Fn( ( [ N ] ) => {

	// Choose a vector not parallel to N
	const upAlt = vec3( 1.0, 0.0, 0.0 );
	const up = vec3( 0.0, 1.0, 0.0 );

	// Use alternative up vector if N is nearly parallel to up
	const useAlt = N.y.abs().greaterThan( 0.999 );
	const helper = useAlt.select( upAlt, up );

	// Gram-Schmidt orthonormalization
	const T = helper.cross( N ).normalize();
	const B = N.cross( T );

	return { T, B, N };

} );

/**
 * Transforms a direction from tangent space to world space.
 *
 * @param {TSLNode} localDir - Direction in tangent space (z is up)
 * @param {TSLNode} T - Tangent vector
 * @param {TSLNode} B - Bitangent vector
 * @param {TSLNode} N - Normal vector
 * @returns {TSLNode} Direction in world space (vec3)
 */
export const tangentToWorld = Fn( ( [ localDir, T, B, N ] ) => {

	return T.mul( localDir.x ).add( B.mul( localDir.y ) ).add( N.mul( localDir.z ) );

} );

/**
 * Cosine-weighted hemisphere sampling (Lambertian diffuse).
 * Samples directions with probability proportional to cos(theta).
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} rngState - Mutable RNG state
 * @returns {Object} { direction, pdf }
 */
export const sampleCosineHemisphere = Fn( ( [ N, rngState ] ) => {

	const u1 = randomFloat( rngState );
	const u2 = randomFloat( rngState );

	// Cosine-weighted hemisphere in tangent space
	const r = u1.sqrt();
	const phi = u2.mul( float( 2.0 * PI ) );

	const x = r.mul( phi.cos() );
	const y = r.mul( phi.sin() );
	const z = float( 1.0 ).sub( u1 ).sqrt();

	const localDir = vec3( x, y, z );

	// Transform to world space
	const tbn = buildTBN( N );
	const worldDir = tangentToWorld( localDir, tbn.T, tbn.B, tbn.N );

	// PDF = cos(theta) / PI
	const pdf = z.mul( float( PI_INV ) );

	return { direction: worldDir.normalize(), pdf };

} );

/**
 * GGX importance sampling for specular reflection.
 * Samples microfacet normals (half vectors) according to GGX distribution.
 *
 * @param {TSLNode} V - View direction (pointing away from surface)
 * @param {TSLNode} N - Surface normal
 * @param {TSLNode} roughness - Surface roughness
 * @param {TSLNode} rngState - Mutable RNG state
 * @returns {Object} { direction (L), halfVector (H), pdf }
 */
export const sampleGGX = Fn( ( [ V, N, roughness, rngState ] ) => {

	const u1 = randomFloat( rngState );
	const u2 = randomFloat( rngState );

	const alpha = roughness.mul( roughness );
	const alpha2 = alpha.mul( alpha );

	// Sample microfacet normal (half vector) in tangent space
	const phi = u1.mul( float( 2.0 * PI ) );
	const cosTheta = float( 1.0 ).sub( u2 ).div( u2.mul( alpha2.sub( 1.0 ) ).add( 1.0 ) ).sqrt();
	const sinTheta = float( 1.0 ).sub( cosTheta.mul( cosTheta ) ).sqrt().max( 0.0 );

	// Half vector in tangent space
	const Hlocal = vec3(
		sinTheta.mul( phi.cos() ),
		sinTheta.mul( phi.sin() ),
		cosTheta
	);

	// Transform to world space
	const tbn = buildTBN( N );
	const H = tangentToWorld( Hlocal, tbn.T, tbn.B, tbn.N ).normalize();

	// Reflect view direction around half vector to get light direction
	const VdotH = V.dot( H ).max( 0.001 );
	const L = H.mul( VdotH.mul( 2.0 ) ).sub( V ).normalize();

	// PDF of sampling this half vector
	// PDF(H) = D(H) * NoH
	// PDF(L) = PDF(H) / (4 * VoH)
	const NoH = N.dot( H ).max( 0.001 );
	const D = distributionGGX( NoH, roughness );
	const pdfH = D.mul( NoH );
	const pdf = pdfH.div( VdotH.mul( 4.0 ) );

	return { direction: L, halfVector: H, pdf };

} );

/**
 * Evaluates the full specular BRDF (GGX).
 *
 * @param {TSLNode} V - View direction
 * @param {TSLNode} L - Light direction
 * @param {TSLNode} N - Surface normal
 * @param {TSLNode} F0 - Base reflectance
 * @param {TSLNode} roughness - Surface roughness
 * @returns {TSLNode} BRDF value (vec3)
 */
export const evaluateSpecularBRDF = Fn( ( [ V, L, N, F0, roughness ] ) => {

	const H = V.add( L ).normalize();

	const NoV = N.dot( V ).max( 0.001 );
	const NoL = N.dot( L ).max( 0.001 );
	const NoH = N.dot( H ).max( 0.001 );
	const VoH = V.dot( H ).max( 0.001 );

	// GGX terms
	const D = distributionGGX( NoH, roughness );
	const G = geometrySmith( NoV, NoL, roughness );
	const F = fresnelSchlick( VoH, F0 );

	// Specular BRDF: D * G * F / (4 * NoV * NoL)
	const denom = NoV.mul( NoL ).mul( 4.0 ).max( 0.001 );
	return F.mul( D ).mul( G ).div( denom );

} );

/**
 * Evaluates the diffuse BRDF (Lambertian).
 *
 * @param {TSLNode} albedo - Diffuse albedo (vec3)
 * @returns {TSLNode} BRDF value (vec3)
 */
export const evaluateDiffuseBRDF = Fn( ( [ albedo ] ) => {

	return albedo.mul( float( PI_INV ) );

} );

/**
 * Samples the BSDF (combined diffuse + specular) based on material properties.
 * Uses Russian roulette to choose between diffuse and specular sampling.
 *
 * @param {TSLNode} V - View direction
 * @param {TSLNode} N - Surface normal
 * @param {TSLNode} albedo - Diffuse albedo
 * @param {TSLNode} F0 - Base reflectance
 * @param {TSLNode} roughness - Surface roughness
 * @param {TSLNode} metalness - Metalness
 * @param {TSLNode} rngState - Mutable RNG state
 * @returns {Object} { direction, brdf, pdf, isDiffuse }
 */
export const sampleBSDF = Fn( ( [ V, N, albedo, F0, roughness, metalness, rngState ] ) => {

	// Compute probability of diffuse vs specular sampling
	// Higher metalness = more specular, lower roughness = more specular
	const specularWeight = metalness.add( float( 1.0 ).sub( roughness ) ).mul( 0.5 ).clamp( 0.1, 0.9 );
	const diffuseWeight = float( 1.0 ).sub( specularWeight );

	// Random choice
	const xi = randomFloat( rngState );
	const chooseDiffuse = xi.lessThan( diffuseWeight );

	// Sample diffuse
	const diffuseSample = sampleCosineHemisphere( N, rngState );

	// Sample specular
	const specularSample = sampleGGX( V, N, roughness, rngState );

	// Choose direction based on random selection
	const direction = chooseDiffuse.select( diffuseSample.direction, specularSample.direction );

	// Compute BRDF values for the chosen direction
	const NoL = N.dot( direction ).max( 0.0 );

	// Diffuse contribution (reduced by metalness)
	const kD = vec3( 1.0 ).sub( fresnelSchlick( NoL, F0 ) ).mul( float( 1.0 ).sub( metalness ) );
	const diffuseBRDF = kD.mul( albedo ).mul( float( PI_INV ) );

	// Specular contribution
	const specularBRDF = evaluateSpecularBRDF( V, direction, N, F0, roughness );

	// Combined BRDF
	const brdf = diffuseBRDF.add( specularBRDF );

	// Combined PDF using MIS
	const diffusePDF = NoL.mul( float( PI_INV ) ).max( 0.001 );
	const pdf = chooseDiffuse.select(
		diffusePDF.mul( diffuseWeight ).add( specularSample.pdf.mul( specularWeight ) ),
		specularSample.pdf.mul( specularWeight ).add( diffusePDF.mul( diffuseWeight ) )
	);

	return {
		direction,
		brdf,
		pdf: pdf.max( 0.001 ),
		isDiffuse: chooseDiffuse
	};

} );

/**
 * Computes the reflection direction.
 *
 * @param {TSLNode} I - Incident direction (pointing towards surface)
 * @param {TSLNode} N - Surface normal
 * @returns {TSLNode} Reflected direction (vec3)
 */
export const reflect = Fn( ( [ I, N ] ) => {

	return I.sub( N.mul( N.dot( I ).mul( 2.0 ) ) );

} );

/**
 * Computes the refraction direction using Snell's law.
 *
 * @param {TSLNode} I - Incident direction (pointing towards surface)
 * @param {TSLNode} N - Surface normal (pointing outward)
 * @param {TSLNode} eta - Ratio of indices of refraction (n1/n2)
 * @returns {Object} { direction, totalInternalReflection }
 */
export const refract = Fn( ( [ I, N, eta ] ) => {

	const cosI = N.dot( I ).negate();
	const sin2T = eta.mul( eta ).mul( float( 1.0 ).sub( cosI.mul( cosI ) ) );

	// Total internal reflection check
	const tir = sin2T.greaterThan( 1.0 );

	const cosT = float( 1.0 ).sub( sin2T ).sqrt();
	const refracted = I.mul( eta ).add( N.mul( eta.mul( cosI ).sub( cosT ) ) );

	// If TIR, return reflection instead
	const reflected = reflect( I, N );

	return {
		direction: tir.select( reflected, refracted ).normalize(),
		totalInternalReflection: tir
	};

} );

