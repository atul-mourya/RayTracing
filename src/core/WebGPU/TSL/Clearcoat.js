import { Fn, float, vec3, max, If } from 'three/tsl';
import { MIN_CLEARCOAT_ROUGHNESS, PI } from './Common.js';
import { randomValue } from './Random.js';
import { importanceSampleGGX, importanceSampleCosine } from './MaterialSampling.js';
import { distributionGGX } from './MaterialProperties.js';
import { evaluateLayeredBRDF } from './MaterialEvaluation.js';
import { computeDotProducts } from './Common.js';

/**
 * Clearcoat BRDF implementation for TSL/WGSL.
 *
 * Provides importance sampling for clearcoat layered materials using
 * Multiple Importance Sampling (MIS) across:
 * - Clearcoat specular layer (GGX distribution)
 * - Base specular layer (GGX distribution)
 * - Base diffuse layer (cosine-weighted hemisphere)
 *
 * The clearcoat layer attenuates the underlying base material according
 * to Fresnel reflection, creating realistic coated appearances like
 * car paint, lacquered wood, or glossy plastic.
 *
 * References:
 * - "Material Advances in Call of Duty: WWII" (Drobot, 2017)
 * - "Enterprise PBR Shading Model" (Kulla & Conty, 2017)
 *
 * Matches clearcoat.fs from GLSL implementation.
 */

// -----------------------------------------------------------------------------
// Clearcoat Sampling
// -----------------------------------------------------------------------------

/**
 * Improved clearcoat sampling function using Multiple Importance Sampling.
 *
 * Samples from one of three layers based on material weights:
 * 1. Clearcoat specular (top layer) - GGX microfacet
 * 2. Base specular - GGX microfacet (attenuated by clearcoat)
 * 3. Base diffuse - Cosine-weighted hemisphere (attenuated by clearcoat)
 *
 * Uses MIS to combine PDFs from all three sampling strategies, ensuring
 * robust variance reduction across different material configurations.
 *
 * @param {TSLNode} ray - Current ray (direction modified in-place)
 * @param {TSLNode} hitInfo - Surface hit information with normal
 * @param {TSLNode} material - RayTracingMaterial struct with clearcoat parameters
 * @param {TSLNode} randomSample - vec2 random sample [0,1]²
 * @param {TSLNode} L - Output: sampled light direction (outgoing parameter)
 * @param {TSLNode} pdf - Output: probability density of sample (outgoing parameter)
 * @param {TSLNode} rngState - Random number generator state (modified in-place)
 * @returns {TSLNode} vec3 - BRDF evaluation for the sampled direction
 */
export const sampleClearcoat = Fn( ( [ ray, hitInfo, material, randomSample, L, pdf, rngState ] ) => {

	const N = hitInfo.normal.toVar();
	const V = ray.direction.negate().toVar();

	// Clamp clearcoat roughness to avoid artifacts
	const clearcoatRoughness = max( material.clearcoatRoughness, float( MIN_CLEARCOAT_ROUGHNESS ) ).toVar();
	const baseRoughness = max( material.roughness, float( MIN_CLEARCOAT_ROUGHNESS ) ).toVar();

	// Calculate sampling weights based on material properties
	const specularWeight = float( 1.0 ).sub( baseRoughness ).mul( float( 0.5 ).add( material.metalness.mul( 0.5 ) ) ).toVar();
	const clearcoatWeight = material.clearcoat.mul( float( 1.0 ).sub( clearcoatRoughness ) ).toVar();
	const diffuseWeight = float( 1.0 ).sub( specularWeight ).mul( float( 1.0 ).sub( material.metalness ) ).toVar();

	// Normalize weights
	const total = specularWeight.add( clearcoatWeight ).add( diffuseWeight ).toVar();
	specularWeight.divAssign( total );
	clearcoatWeight.divAssign( total );
	diffuseWeight.divAssign( total );

	// Choose which layer to sample
	const rand = randomValue( rngState ).toVar();
	const H = vec3().toVar();

	// Sample clearcoat layer
	If( rand.lessThan( clearcoatWeight ), () => {

		H.assign( importanceSampleGGX( N, clearcoatRoughness, randomSample ) );
		L.assign( V.negate().reflect( H ) );

	} ).ElseIf( rand.lessThan( clearcoatWeight.add( specularWeight ) ), () => {

		// Sample base specular
		H.assign( importanceSampleGGX( N, baseRoughness, randomSample ) );
		L.assign( V.negate().reflect( H ) );

	} ).Else( () => {

		// Sample diffuse
		L.assign( importanceSampleCosine( N, randomSample ) );
		H.assign( V.add( L ).normalize() );

	} );

	// Calculate dot products
	const dots = computeDotProducts( N, V, L ).toVar();

	// Calculate individual PDFs
	const clearcoatPDF = distributionGGX( dots.NoH, clearcoatRoughness )
		.mul( dots.NoH )
		.div( dots.VoH.mul( 4.0 ) )
		.mul( clearcoatWeight )
		.toVar();

	const specularPDF = distributionGGX( dots.NoH, baseRoughness )
		.mul( dots.NoH )
		.div( dots.VoH.mul( 4.0 ) )
		.mul( specularWeight )
		.toVar();

	const diffusePDF = dots.NoL.div( float( PI ) ).mul( diffuseWeight ).toVar();

	// Combined PDF using MIS
	pdf.assign( clearcoatPDF.add( specularPDF ).add( diffusePDF ) );
	pdf.assign( max( pdf, float( 0.001 ) ) ); // Ensure PDF is never zero

	// Evaluate complete BRDF
	return evaluateLayeredBRDF( dots, material );

} ).setLayout( {
	name: 'sampleClearcoat',
	type: 'vec3',
	inputs: [
		{ name: 'ray', type: 'Ray' },
		{ name: 'hitInfo', type: 'HitInfo' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'randomSample', type: 'vec2' },
		{ name: 'L', type: 'vec3' },
		{ name: 'pdf', type: 'float' },
		{ name: 'rngState', type: 'uint' },
	],
} );

/**
 * Exported functions:
 * - sampleClearcoat(ray, hitInfo, material, randomSample, L, pdf, rngState) - Sample clearcoat BRDF with MIS
 *
 * Note: evaluateLayeredBRDF and calculateLayerAttenuation are in MaterialEvaluation.js
 */
