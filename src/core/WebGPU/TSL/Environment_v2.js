/**
 * Environment_v2.js - Pure TSL HDR Environment Importance Sampling
 *
 * Provides efficient importance sampling for HDR environment maps (equirectangular).
 * Uses precomputed CDF (Cumulative Distribution Function) textures for:
 * - Row sampling based on vertical luminance distribution
 * - Column sampling based on horizontal luminance distribution per row
 *
 * This dramatically reduces noise in environment lighting compared to uniform sampling.
 *
 * NO wgslFn() - Pure TSL using Fn(), If(), Loop(), .toVar(), .assign()
 */

import { Fn, vec3, vec4, vec2, float, int, If, Loop, Return, texture, clamp, abs, atan2, asin } from 'three/tsl';
import { equirectDirectionToUv, luminance } from './Common_v2.js';

const PI = Math.PI;
const TWO_PI = 2.0 * PI;
const PI_INV = 1.0 / PI;
const TWO_PI_INV = 1.0 / TWO_PI;

/**
 * Sample environment map using uniform (non-importance) sampling
 *
 * Simple uniform hemisphere sampling - used as fallback when
 * importance sampling data is not available.
 *
 * @param {vec2} randomSample - Random values [0,1]
 * @returns {Object} { direction: vec3, pdf: float }
 */
export const sampleEnvironmentUniform = Fn( ( [ randomSample ] ) => {

	// Uniform sphere sampling
	const phi = randomSample.x.mul( TWO_PI ).toVar( 'phi' );
	const cosTheta = randomSample.y.mul( 2.0 ).sub( 1.0 ).toVar( 'cosTheta' ); // [-1, 1]
	const sinTheta = float( 1.0 ).sub( cosTheta.mul( cosTheta ) ).sqrt().toVar( 'sinTheta' );

	const direction = vec3(
		sinTheta.mul( phi.cos() ),
		cosTheta,
		sinTheta.mul( phi.sin() )
	).toVar( 'direction' );

	// Uniform sphere PDF = 1 / (4π)
	const pdf = float( 1.0 / ( 4.0 * PI ) ).toVar( 'pdf' );

	return vec4( direction, pdf );

} ).setLayout( {
	name: 'sampleEnvironmentUniform',
	type: 'vec4',
	inputs: [
		{ name: 'randomSample', type: 'vec2' }
	]
} );

/**
 * Binary search CDF texture to find value with target cumulative probability
 *
 * Uses iterative binary search to locate the CDF entry closest to the
 * target probability value.
 *
 * @param {sampler2D} cdfTexture - CDF texture (1D or row of 2D texture)
 * @param {int} size - Number of entries in CDF
 * @param {float} targetProb - Target cumulative probability [0,1]
 * @param {int} row - Row index (for 2D marginal CDF, 0 for conditional)
 * @returns {int} Index of CDF entry
 */
const binarySearchCDF = Fn( ( [ cdfTexture, size, targetProb, row ] ) => {

	const left = int( 0 ).toVar( 'left' );
	const right = size.sub( 1 ).toVar( 'right' );
	const result = int( 0 ).toVar( 'result' );
	// Binary search (max 16 iterations sufficient for 65536 entries)
	Loop( { start: int( 0 ), end: int( 16 ) }, () => {

		If( left.greaterThanEqual( right ), () => {

			result.assign( left );
			Return();

		} );

		const mid = left.add( right ).div( 2 ).toVar( 'mid' );

		// Read CDF value at mid
		const u = float( mid ).add( 0.5 ).div( float( size ) ).toVar( 'u' );
		const v = float( row ).add( 0.5 ).div( float( size ) ).toVar( 'v' ); // For 2D CDF
		const cdfValue = texture( cdfTexture, vec2( u, v ) ).x.toVar( 'cdfValue' );

		If( cdfValue.lessThan( targetProb ), () => {

			left.assign( mid.add( 1 ) );

		} ).Else( () => {

			right.assign( mid );

		} );

	} );

	result.assign( left );
	return result;

} ).setLayout( {
	name: 'binarySearchCDF',
	type: 'int'
} );

/**
 * Sample environment map using importance sampling
 *
 * Uses precomputed CDF textures for efficient importance sampling
 * based on environment luminance distribution.
 *
 * Requires two CDF textures:
 * - Marginal CDF: Vertical distribution (1D, stored in texture row)
 * - Conditional CDF: Horizontal distribution per row (2D texture)
 *
 * @param {sampler2D} envMap - Environment map texture (equirectangular)
 * @param {sampler2D} marginalCDF - Marginal CDF texture (vertical distribution)
 * @param {sampler2D} conditionalCDF - Conditional CDF texture (horizontal per row)
 * @param {ivec2} envSize - Environment map dimensions (width, height)
 * @param {vec2} randomSample - Random values [0,1]
 * @returns {Object} { direction: vec3, pdf: float, color: vec3 }
 */
export const sampleEnvironmentImportance = Fn( ( [ envMap, marginalCDF, conditionalCDF, envSize, randomSample ] ) => {

	const width = envSize.x.toVar( 'width' );
	const height = envSize.y.toVar( 'height' );

	// Sample row (vertical) from marginal CDF
	const rowIndex = binarySearchCDF( marginalCDF, height, randomSample.y, int( 0 ) ).toVar( 'rowIndex' );
	const v = float( rowIndex ).add( 0.5 ).div( float( height ) ).toVar( 'v' );

	// Sample column (horizontal) from conditional CDF for this row
	const colIndex = binarySearchCDF( conditionalCDF, width, randomSample.x, rowIndex ).toVar( 'colIndex' );
	const u = float( colIndex ).add( 0.5 ).div( float( width ) ).toVar( 'u' );
	// Convert UV to equirectangular direction
	const phi = u.mul( TWO_PI ).toVar( 'phi' );
	const theta = v.mul( PI ).toVar( 'theta' );

	const sinTheta = theta.sin().toVar( 'sinTheta' );
	const cosTheta = theta.cos().toVar( 'cosTheta' );
	const sinPhi = phi.sin().toVar( 'sinPhi' );
	const cosPhi = phi.cos().toVar( 'cosPhi' );

	const direction = vec3(
		sinTheta.mul( sinPhi ),
		cosTheta,
		sinTheta.mul( cosPhi )
	).toVar( 'direction' );

	// Sample environment color at this direction
	const envColor = texture( envMap, vec2( u, v ) ).rgb.toVar( 'envColor' );

	// Calculate PDF from CDF
	// Read marginal PDF value for this row
	const marginalPDF = texture( marginalCDF, vec2( v, 0.5 ) ).y.toVar( 'marginalPDF' ); // PDF stored in y channel
	// Read conditional PDF value for this column
	const conditionalPDF = texture( conditionalCDF, vec2( u, v ) ).y.toVar( 'conditionalPDF' );

	// Combined PDF = marginal * conditional / sin(theta)
	// Division by sin(theta) accounts for sphere area element
	const sinThetaClamped = sinTheta.max( 0.001 ).toVar( 'sinThetaClamped' ); // Avoid division by zero at poles
	const pdf = marginalPDF.mul( conditionalPDF ).div( sinThetaClamped ).toVar( 'pdf' );

	return vec4( direction, pdf );

} ).setLayout( {
	name: 'sampleEnvironmentImportance',
	type: 'vec4',
	inputs: [
		{ name: 'envMap', type: 'sampler2D' },
		{ name: 'marginalCDF', type: 'sampler2D' },
		{ name: 'conditionalCDF', type: 'sampler2D' },
		{ name: 'envSize', type: 'ivec2' },
		{ name: 'randomSample', type: 'vec2' }
	]
} );

/**
 * Evaluate environment PDF for a given direction
 *
 * Computes the probability density for a specific direction based on
 * the importance sampling distribution. Used for MIS weight calculation.
 *
 * @param {vec3} direction - Direction to evaluate (world space, normalized)
 * @param {sampler2D} marginalCDF - Marginal CDF texture
 * @param {sampler2D} conditionalCDF - Conditional CDF texture
 * @param {ivec2} envSize - Environment map dimensions
 * @returns {float} PDF value
 */
export const evaluateEnvironmentPDF = Fn( ( [ direction, marginalCDF, conditionalCDF, envSize ] ) => {

	// Convert direction to UV coordinates
	const uv = equirectDirectionToUv( direction ).toVar( 'uv' );

	// Get marginal and conditional PDFs from CDF textures
	const marginalPDF = texture( marginalCDF, vec2( uv.y, 0.5 ) ).y.toVar( 'marginalPDF' );
	const conditionalPDF = texture( conditionalCDF, uv ).y.toVar( 'conditionalPDF' );
	// Calculate sin(theta) for area element correction
	const theta = uv.y.mul( PI ).toVar( 'theta' );
	const sinTheta = theta.sin().max( 0.001 ).toVar( 'sinTheta' );

	const pdf = marginalPDF.mul( conditionalPDF ).div( sinTheta ).toVar( 'pdf' );

	return pdf;

} ).setLayout( {
	name: 'evaluateEnvironmentPDF',
	type: 'float',
	inputs: [
		{ name: 'direction', type: 'vec3' },
		{ name: 'marginalCDF', type: 'sampler2D' },
		{ name: 'conditionalCDF', type: 'sampler2D' },
		{ name: 'envSize', type: 'ivec2' }
	]
} );

/**
 * Sample environment with automatic fallback
 *
 * Attempts importance sampling if CDF textures available,
 * otherwise falls back to uniform sampling.
 *
 * @param {sampler2D} envMap - Environment map
 * @param {sampler2D} marginalCDF - Marginal CDF (null for uniform sampling)
 * @param {sampler2D} conditionalCDF - Conditional CDF (null for uniform sampling)
 * @param {ivec2} envSize - Environment dimensions
 * @param {float} hasImportanceSampling - 1.0 if CDF available, 0.0 otherwise
 * @param {vec2} randomSample - Random values
 * @returns {Object} { direction: vec3, pdf: float }
 */
export const sampleEnvironment = Fn( ( [ envMap, marginalCDF, conditionalCDF, envSize, hasImportanceSampling, randomSample ] ) => {

	const result = vec4().toVar( 'sampleResult' );

	If( hasImportanceSampling.greaterThan( 0.5 ), () => {

		// Use importance sampling
		result.assign( sampleEnvironmentImportance( envMap, marginalCDF, conditionalCDF, envSize, randomSample ) );

	} ).Else( () => {

		// Fallback to uniform sampling
		const uniformResult = sampleEnvironmentUniform( randomSample ).toVar( 'uniformResult' );
		const direction = uniformResult.xyz.toVar( 'direction' );
		const pdf = uniformResult.w.toVar( 'pdf' );

		result.assign( vec4( direction, pdf ) );

	} );

	return result;

} ).setLayout( {
	name: 'sampleEnvironment',
	type: 'vec4',
	inputs: [
		{ name: 'envMap', type: 'sampler2D' },
		{ name: 'marginalCDF', type: 'sampler2D' },
		{ name: 'conditionalCDF', type: 'sampler2D' },
		{ name: 'envSize', type: 'ivec2' },
		{ name: 'hasImportanceSampling', type: 'float' },
		{ name: 'randomSample', type: 'vec2' }
	]
} );

/**
 * Evaluate environment radiance in a given direction
 *
 * Samples the environment map and returns the radiance value.
 * Handles equirectangular projection properly.
 *
 * @param {sampler2D} envMap - Environment map texture
 * @param {vec3} direction - Direction to sample (world space, normalized)
 * @param {float} envIntensity - Environment intensity multiplier
 * @returns {vec3} Environment radiance (RGB)
 */
export const evaluateEnvironment = Fn( ( [ envMap, direction, envIntensity ] ) => {

	const uv = equirectDirectionToUv( direction ).toVar( 'uv' );
	const envColor = texture( envMap, uv ).rgb.toVar( 'envColor' );
	const radiance = envColor.mul( envIntensity ).toVar( 'radiance' );

	return radiance;

} ).setLayout( {
	name: 'evaluateEnvironment',
	type: 'vec3',
	inputs: [
		{ name: 'envMap', type: 'sampler2D' },
		{ name: 'direction', type: 'vec3' },
		{ name: 'envIntensity', type: 'float' }
	]
} );

/**
 * Calculate MIS weight between BRDF and environment sampling
 *
 * Uses power heuristic (beta=2) to combine BRDF importance sampling
 * with environment importance sampling for optimal variance reduction.
 *
 * @param {float} pdfBRDF - PDF from BRDF sampling
 * @param {float} pdfEnv - PDF from environment sampling
 * @param {float} numBRDFSamples - Number of BRDF samples (typically 1)
 * @param {float} numEnvSamples - Number of environment samples (typically 1)
 * @returns {float} MIS weight for BRDF sample
 */
export const environmentMISWeight = Fn( ( [ pdfBRDF, pdfEnv, numBRDFSamples, numEnvSamples ] ) => {

	// Power heuristic with beta=2
	const nf_pdf_f = numBRDFSamples.mul( pdfBRDF ).toVar( 'nf_pdf_f' );
	const ng_pdf_g = numEnvSamples.mul( pdfEnv ).toVar( 'ng_pdf_g' );

	const nf_pdf_f_sq = nf_pdf_f.mul( nf_pdf_f ).toVar( 'nf_pdf_f_sq' );
	const ng_pdf_g_sq = ng_pdf_g.mul( ng_pdf_g ).toVar( 'ng_pdf_g_sq' );
	const weight = nf_pdf_f_sq.div( nf_pdf_f_sq.add( ng_pdf_g_sq ) ).toVar( 'weight' );

	return weight;

} ).setLayout( {
	name: 'environmentMISWeight',
	type: 'float',
	inputs: [
		{ name: 'pdfBRDF', type: 'float' },
		{ name: 'pdfEnv', type: 'float' },
		{ name: 'numBRDFSamples', type: 'float' },
		{ name: 'numEnvSamples', type: 'float' }
	]
} );
