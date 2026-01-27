import { Fn, float, vec3, vec4, If, select, int, Loop, Break } from 'three/tsl';
import { randomFloat } from './Random.js';
import {
	fresnelSchlick,
	distributionGGX,
	geometrySmith,
	buildTBN,
	tangentToWorld,
	reflect,
	refract
} from './BSDF.js';

/**
 * Disney BSDF Implementation for TSL.
 *
 * Implements the full Disney Principled BSDF with:
 * - Lambertian diffuse
 * - GGX specular
 * - Clearcoat (separate specular layer)
 * - Sheen (fabric-like surface)
 * - Transmission/Refraction (glass-like materials)
 * - Iridescence (thin-film interference)
 */

const PI = Math.PI;
const PI_INV = 1.0 / PI;

/**
 * Fresnel for dielectrics using full Fresnel equations.
 * More accurate than Schlick for transmission.
 *
 * @param {TSLNode} cosI - Cosine of incident angle
 * @param {TSLNode} eta - IOR ratio (n1/n2)
 * @returns {TSLNode} Fresnel reflectance
 */
export const fresnelDielectric = Fn( ( [ cosI, eta ] ) => {

	const sin2T = eta.mul( eta ).mul( float( 1.0 ).sub( cosI.mul( cosI ) ) );

	// Total internal reflection
	const tir = sin2T.greaterThan( 1.0 );

	const cosT = float( 1.0 ).sub( sin2T ).sqrt();
	const cosIAbs = cosI.abs();

	// Fresnel equations
	const Rs = cosIAbs.sub( eta.mul( cosT ) ).div( cosIAbs.add( eta.mul( cosT ) ) );
	const Rp = eta.mul( cosIAbs ).sub( cosT ).div( eta.mul( cosIAbs ).add( cosT ) );

	const fresnel = Rs.mul( Rs ).add( Rp.mul( Rp ) ).mul( 0.5 );

	return tir.select( float( 1.0 ), fresnel );

} );

/**
 * GTR1 (Generalized Trowbridge-Reitz) distribution for clearcoat.
 * Has a longer tail than GGX, suitable for clearcoat layer.
 *
 * @param {TSLNode} NoH - Cosine of angle between normal and half vector
 * @param {TSLNode} alpha - Roughness parameter
 * @returns {TSLNode} Distribution value
 */
export const distributionGTR1 = Fn( ( [ NoH, alpha ] ) => {

	const alpha2 = alpha.mul( alpha );
	const cosTheta2 = NoH.mul( NoH );

	// GTR1 formula: (alpha^2 - 1) / (PI * log(alpha^2) * (1 + (alpha^2 - 1) * cos^2(theta)))
	const denom = float( 1.0 ).add( alpha2.sub( 1.0 ).mul( cosTheta2 ) );

	// Handle the special case when alpha is very small
	const result = alpha2.sub( 1.0 ).div( float( PI ).mul( alpha2.log() ).mul( denom ) );

	return alpha.lessThan( 0.001 ).select( float( 0.0 ), result );

} );

/**
 * Sheen distribution (Ashikhmin/Shirley-style).
 * Used for fabric and velvet-like surfaces.
 *
 * @param {TSLNode} NoH - Cosine of angle between normal and half vector
 * @returns {TSLNode} Distribution value
 */
export const distributionSheen = Fn( ( [ NoH ] ) => {

	// Simple sheen distribution: (1 + 4*(1-NoH)^5) / (PI)
	const t = float( 1.0 ).sub( NoH );
	const t2 = t.mul( t );
	const t4 = t2.mul( t2 );
	const t5 = t4.mul( t );

	return float( 1.0 ).add( t5.mul( 4.0 ) ).mul( float( PI_INV ) );

} );

/**
 * Thin-film iridescence Fresnel.
 * Models interference patterns in thin films (soap bubbles, oil slicks, etc.)
 *
 * @param {TSLNode} cosTheta - Cosine of view angle
 * @param {TSLNode} filmIOR - IOR of the thin film
 * @param {TSLNode} filmThickness - Thickness of the film in nanometers
 * @param {TSLNode} baseIOR - IOR of the base material
 * @returns {TSLNode} Iridescent color (vec3)
 */
export const fresnelIridescence = Fn( ( [ cosTheta, filmIOR, filmThickness, baseIOR ] ) => {

	// Simplified iridescence model
	// Full implementation would use Airy summation

	// Path difference in the film
	const cosT = float( 1.0 ).sub( cosTheta.mul( cosTheta ).div( filmIOR.mul( filmIOR ) ) ).sqrt();
	const pathDiff = filmThickness.mul( 2.0 ).mul( filmIOR ).mul( cosT );

	// Wavelength-dependent phase shift (simplified RGB model)
	// Red ~700nm, Green ~550nm, Blue ~450nm
	const phaseR = pathDiff.div( 700.0 ).mul( float( 2.0 * PI ) );
	const phaseG = pathDiff.div( 550.0 ).mul( float( 2.0 * PI ) );
	const phaseB = pathDiff.div( 450.0 ).mul( float( 2.0 * PI ) );

	// Interference pattern (simplified)
	const r = phaseR.cos().mul( 0.5 ).add( 0.5 );
	const g = phaseG.cos().mul( 0.5 ).add( 0.5 );
	const b = phaseB.cos().mul( 0.5 ).add( 0.5 );

	// Modulate by base Fresnel
	const baseFresnel = fresnelDielectric( cosTheta, filmIOR );

	return vec3( r, g, b ).mul( baseFresnel );

} );

/**
 * Beer-Lambert law for volumetric absorption.
 * Models color tinting in transmissive materials.
 *
 * @param {TSLNode} distance - Distance traveled through medium
 * @param {TSLNode} attenuationColor - Color of the medium
 * @param {TSLNode} attenuationDistance - Distance at which color is attenuated
 * @returns {TSLNode} Transmittance (vec3)
 */
export const beerLambertAttenuation = Fn( ( [ distance, attenuationColor, attenuationDistance ] ) => {

	// T = exp(-sigma * d) where sigma = -log(color) / attenuationDistance
	const sigma = attenuationColor.log().negate().div( attenuationDistance.max( 0.001 ) );

	return sigma.negate().mul( distance ).exp();

} );

/**
 * Samples the clearcoat layer (GTR1 distribution).
 *
 * @param {TSLNode} V - View direction
 * @param {TSLNode} N - Surface normal
 * @param {TSLNode} clearcoatRoughness - Clearcoat roughness
 * @param {TSLNode} rngState - RNG state
 * @returns {Object} { direction, pdf }
 */
export const sampleClearcoat = Fn( ( [ V, N, clearcoatRoughness, rngState ] ) => {

	const u1 = randomFloat( rngState );
	const u2 = randomFloat( rngState );

	const alpha = clearcoatRoughness.mul( clearcoatRoughness ).max( 0.001 );
	const alpha2 = alpha.mul( alpha );

	// Sample GTR1 distribution
	const phi = u1.mul( float( 2.0 * PI ) );
	const cosTheta = float( 1.0 ).sub( alpha2.pow( float( 1.0 ).sub( u2 ) ) ).div( float( 1.0 ).sub( alpha2 ) ).sqrt().clamp( 0.0, 1.0 );
	const sinTheta = float( 1.0 ).sub( cosTheta.mul( cosTheta ) ).sqrt();

	// Half vector in tangent space
	const Hlocal = vec3(
		sinTheta.mul( phi.cos() ),
		sinTheta.mul( phi.sin() ),
		cosTheta
	);

	// Transform to world space
	const tbn = buildTBN( N );
	const H = tangentToWorld( Hlocal, tbn.T, tbn.B, tbn.N ).normalize();

	// Reflect to get light direction
	const VdotH = V.dot( H ).max( 0.001 );
	const L = H.mul( VdotH.mul( 2.0 ) ).sub( V ).normalize();

	// PDF
	const NoH = N.dot( H ).max( 0.001 );
	const D = distributionGTR1( NoH, alpha );
	const pdf = D.mul( NoH ).div( VdotH.mul( 4.0 ) ).max( 0.001 );

	return { direction: L, pdf };

} );

/**
 * Samples transmission (refraction).
 *
 * @param {TSLNode} V - View direction (pointing away from surface)
 * @param {TSLNode} N - Surface normal
 * @param {TSLNode} ior - Index of refraction
 * @param {TSLNode} roughness - Surface roughness
 * @param {TSLNode} rngState - RNG state
 * @returns {Object} { direction, pdf, isRefraction }
 */
export const sampleTransmission = Fn( ( [ V, N, ior, roughness, rngState ] ) => {

	// Determine if we're entering or exiting the medium
	const entering = N.dot( V ).greaterThan( 0.0 );
	const eta = entering.select( float( 1.0 ).div( ior ), ior );
	const faceN = entering.select( N, N.negate() );

	// Sample microfacet normal using GGX
	const u1 = randomFloat( rngState );
	const u2 = randomFloat( rngState );

	const alpha = roughness.mul( roughness ).max( 0.001 );
	const alpha2 = alpha.mul( alpha );

	const phi = u1.mul( float( 2.0 * PI ) );
	const cosTheta = float( 1.0 ).sub( u2 ).div( u2.mul( alpha2.sub( 1.0 ) ).add( 1.0 ) ).sqrt();
	const sinTheta = float( 1.0 ).sub( cosTheta.mul( cosTheta ) ).sqrt().max( 0.0 );

	const Hlocal = vec3(
		sinTheta.mul( phi.cos() ),
		sinTheta.mul( phi.sin() ),
		cosTheta
	);

	const tbn = buildTBN( faceN );
	const H = tangentToWorld( Hlocal, tbn.T, tbn.B, tbn.N ).normalize();

	// Compute refraction
	const VdotH = V.dot( H );
	const refractResult = refract( V.negate(), H, eta );

	// Fresnel determines reflection vs refraction
	const fresnel = fresnelDielectric( VdotH.abs(), eta );
	const xi = randomFloat( rngState );
	const doReflect = xi.lessThan( fresnel );

	// Reflect or refract
	const reflected = reflect( V.negate(), H ).negate().normalize();
	const direction = doReflect.select( reflected, refractResult.direction );

	// PDF
	const NoH = faceN.dot( H ).max( 0.001 );
	const D = distributionGGX( NoH, roughness );
	const pdf = D.mul( NoH ).div( VdotH.abs().mul( 4.0 ) ).max( 0.001 );

	return {
		direction,
		pdf,
		isRefraction: doReflect.not()
	};

} );

/**
 * Full Disney BSDF sampling with multiple lobes.
 *
 * @param {Object} material - Material properties object
 * @param {TSLNode} V - View direction
 * @param {TSLNode} N - Surface normal
 * @param {TSLNode} rngState - RNG state
 * @returns {Object} { direction, throughput, pdf }
 */
export const sampleDisneyBSDF = Fn( ( [ material, V, N, rngState ] ) => {

	// Extract material properties
	const albedo = material.color;
	const metalness = material.metalness;
	const roughness = material.roughness;
	const ior = material.ior;
	const transmission = material.transmission;
	const clearcoat = material.clearcoat;
	const clearcoatRoughness = material.clearcoatRoughness;
	const sheen = material.sheen;
	const sheenRoughness = material.sheenRoughness;
	const sheenColor = material.sheenColor;

	// Compute lobe weights
	const diffuseWeight = float( 1.0 ).sub( metalness ).mul( float( 1.0 ).sub( transmission ) );
	const specularWeight = float( 1.0 ).sub( transmission ).mul( float( 0.5 ).add( metalness.mul( 0.5 ) ) );
	const transmissionWeight = transmission;
	const clearcoatWeight = clearcoat.mul( 0.25 );
	const sheenWeight = sheen.mul( float( 1.0 ).sub( metalness ) );

	// Normalize weights
	const totalWeight = diffuseWeight.add( specularWeight ).add( transmissionWeight ).add( clearcoatWeight ).add( sheenWeight ).max( 0.001 );
	const normDiffuse = diffuseWeight.div( totalWeight );
	const normSpecular = specularWeight.div( totalWeight );
	const normTransmission = transmissionWeight.div( totalWeight );
	const normClearcoat = clearcoatWeight.div( totalWeight );

	// Cumulative probabilities for lobe selection
	const cumDiffuse = normDiffuse;
	const cumSpecular = cumDiffuse.add( normSpecular );
	const cumTransmission = cumSpecular.add( normTransmission );
	const cumClearcoat = cumTransmission.add( normClearcoat );

	// Random lobe selection
	const xi = randomFloat( rngState );

	// Initialize outputs
	const direction = vec3( 0.0, 1.0, 0.0 ).toVar( 'direction' );
	const throughput = vec3( 0.0 ).toVar( 'throughput' );
	const pdf = float( 1.0 ).toVar( 'pdf' );

	// Compute F0 for Fresnel
	const dielectricF0 = ior.sub( 1.0 ).div( ior.add( 1.0 ) );
	const dielectricF0Sq = dielectricF0.mul( dielectricF0 );
	const F0 = vec3( dielectricF0Sq ).mix( albedo, metalness );

	// === DIFFUSE LOBE ===
	If( xi.lessThan( cumDiffuse ), () => {

		// Cosine-weighted hemisphere sampling
		const u1 = randomFloat( rngState );
		const u2 = randomFloat( rngState );

		const r = u1.sqrt();
		const phi = u2.mul( float( 2.0 * PI ) );

		const x = r.mul( phi.cos() );
		const y = r.mul( phi.sin() );
		const z = float( 1.0 ).sub( u1 ).sqrt();

		const localDir = vec3( x, y, z );
		const tbn = buildTBN( N );
		const L = tangentToWorld( localDir, tbn.T, tbn.B, tbn.N ).normalize();

		direction.assign( L );

		// Diffuse BRDF: (1-F)(1-metalness) * albedo / PI
		const NoL = N.dot( L ).max( 0.001 );
		const F = fresnelSchlick( NoL, F0 );
		const kD = vec3( 1.0 ).sub( F ).mul( float( 1.0 ).sub( metalness ) ).mul( float( 1.0 ).sub( transmission ) );
		const diffuseBRDF = kD.mul( albedo ).mul( float( PI_INV ) );

		throughput.assign( diffuseBRDF.mul( NoL ).div( NoL.mul( float( PI_INV ) ).max( 0.001 ) ) );
		pdf.assign( NoL.mul( float( PI_INV ) ).mul( normDiffuse ) );

	} );

	// === SPECULAR LOBE ===
	If( xi.greaterThanEqual( cumDiffuse ).and( xi.lessThan( cumSpecular ) ), () => {

		const u1 = randomFloat( rngState );
		const u2 = randomFloat( rngState );

		const alpha = roughness.mul( roughness ).max( 0.001 );
		const alpha2 = alpha.mul( alpha );

		const phi = u1.mul( float( 2.0 * PI ) );
		const cosTheta = float( 1.0 ).sub( u2 ).div( u2.mul( alpha2.sub( 1.0 ) ).add( 1.0 ) ).sqrt();
		const sinTheta = float( 1.0 ).sub( cosTheta.mul( cosTheta ) ).sqrt();

		const Hlocal = vec3( sinTheta.mul( phi.cos() ), sinTheta.mul( phi.sin() ), cosTheta );
		const tbn = buildTBN( N );
		const H = tangentToWorld( Hlocal, tbn.T, tbn.B, tbn.N ).normalize();

		const VdotH = V.dot( H ).max( 0.001 );
		const L = H.mul( VdotH.mul( 2.0 ) ).sub( V ).normalize();

		direction.assign( L );

		// Evaluate GGX specular
		const NoV = N.dot( V ).max( 0.001 );
		const NoL = N.dot( L ).max( 0.001 );
		const NoH = N.dot( H ).max( 0.001 );

		const D = distributionGGX( NoH, roughness );
		const G = geometrySmith( NoV, NoL, roughness );
		const F = fresnelSchlick( VdotH, F0 );

		const specBRDF = F.mul( D ).mul( G ).div( NoV.mul( NoL ).mul( 4.0 ).max( 0.001 ) );
		throughput.assign( specBRDF.mul( NoL ) );

		const specPDF = D.mul( NoH ).div( VdotH.mul( 4.0 ) ).max( 0.001 );
		pdf.assign( specPDF.mul( normSpecular ) );

	} );

	// === TRANSMISSION LOBE ===
	If( xi.greaterThanEqual( cumSpecular ).and( xi.lessThan( cumTransmission ) ), () => {

		const transSample = sampleTransmission( V, N, ior, roughness, rngState );
		direction.assign( transSample.direction );

		// Transmission throughput (with color tinting)
		throughput.assign( albedo.mul( float( 1.0 ).sub( metalness ) ) );
		pdf.assign( transSample.pdf.mul( normTransmission ) );

	} );

	// === CLEARCOAT LOBE ===
	If( xi.greaterThanEqual( cumTransmission ).and( xi.lessThan( cumClearcoat ) ), () => {

		const ccSample = sampleClearcoat( V, N, clearcoatRoughness, rngState );
		direction.assign( ccSample.direction );

		// Clearcoat uses fixed IOR of 1.5
		const ccF0 = float( 0.04 ); // ((1.5-1)/(1.5+1))^2
		const NoL = N.dot( ccSample.direction ).max( 0.001 );
		const F = fresnelSchlick( NoL, vec3( ccF0 ) );

		throughput.assign( F.mul( clearcoat ) );
		pdf.assign( ccSample.pdf.mul( normClearcoat ) );

	} );

	// === SHEEN LOBE (added to existing lobes, not sampled separately) ===
	// Sheen is typically added as a hemispherical contribution
	// For simplicity, we add it as a boost to diffuse-like directions
	If( sheen.greaterThan( 0.0 ), () => {

		const NoL = N.dot( direction ).max( 0.001 );
		const t = float( 1.0 ).sub( NoL );
		const sheenTerm = sheenColor.mul( sheen ).mul( t.mul( t ).mul( t ).mul( t ).mul( t ) );
		throughput.addAssign( sheenTerm );

	} );

	return {
		direction,
		throughput,
		pdf: pdf.max( 0.001 )
	};

} );

/**
 * Evaluates the Disney BSDF for a given light direction.
 * Used for direct lighting calculations.
 *
 * @param {Object} material - Material properties
 * @param {TSLNode} V - View direction
 * @param {TSLNode} L - Light direction
 * @param {TSLNode} N - Surface normal
 * @returns {Object} { brdf, pdf }
 */
export const evaluateDisneyBSDF = Fn( ( [ material, V, L, N ] ) => {

	const albedo = material.color;
	const metalness = material.metalness;
	const roughness = material.roughness;
	const ior = material.ior;
	const transmission = material.transmission;
	const clearcoat = material.clearcoat;
	const clearcoatRoughness = material.clearcoatRoughness;
	const sheen = material.sheen;
	const sheenColor = material.sheenColor;

	const NoL = N.dot( L ).max( 0.001 );
	const NoV = N.dot( V ).max( 0.001 );
	const H = V.add( L ).normalize();
	const NoH = N.dot( H ).max( 0.001 );
	const VoH = V.dot( H ).max( 0.001 );

	// Compute F0
	const dielectricF0 = ior.sub( 1.0 ).div( ior.add( 1.0 ) );
	const dielectricF0Sq = dielectricF0.mul( dielectricF0 );
	const F0 = vec3( dielectricF0Sq ).mix( albedo, metalness );

	// Fresnel
	const F = fresnelSchlick( VoH, F0 );

	// === DIFFUSE ===
	const kD = vec3( 1.0 ).sub( F ).mul( float( 1.0 ).sub( metalness ) ).mul( float( 1.0 ).sub( transmission ) );
	const diffuse = kD.mul( albedo ).mul( float( PI_INV ) );

	// === SPECULAR (GGX) ===
	const D = distributionGGX( NoH, roughness );
	const G = geometrySmith( NoV, NoL, roughness );
	const specular = F.mul( D ).mul( G ).div( NoV.mul( NoL ).mul( 4.0 ).max( 0.001 ) );

	// === CLEARCOAT ===
	const ccAlpha = clearcoatRoughness.mul( clearcoatRoughness ).max( 0.001 );
	const ccD = distributionGTR1( NoH, ccAlpha );
	const ccG = geometrySmith( NoV, NoL, float( 0.25 ) ); // Fixed roughness for geometry
	const ccF = fresnelSchlick( VoH, vec3( 0.04 ) );
	const clearcoatBRDF = ccF.mul( ccD ).mul( ccG ).div( NoV.mul( NoL ).mul( 4.0 ).max( 0.001 ) ).mul( clearcoat );

	// === SHEEN ===
	const t = float( 1.0 ).sub( NoL );
	const sheenBRDF = sheenColor.mul( sheen ).mul( t.mul( t ).mul( t ).mul( t ).mul( t ) );

	// Combined BRDF
	const brdf = diffuse.add( specular ).add( clearcoatBRDF ).add( sheenBRDF );

	// Combined PDF (simplified - uses diffuse + specular)
	const diffusePDF = NoL.mul( float( PI_INV ) );
	const specularPDF = D.mul( NoH ).div( VoH.mul( 4.0 ) ).max( 0.001 );
	const pdf = diffusePDF.add( specularPDF ).mul( 0.5 );

	return { brdf, pdf };

} );
