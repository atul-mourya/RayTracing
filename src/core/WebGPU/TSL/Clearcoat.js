// Clearcoat BRDF - Ported from clearcoat.fs
// Note: evaluateLayeredBRDF and calculateLayerAttenuation functions
// are in MaterialEvaluation.js

import {
	Fn,
	vec3,
	float,
	dot,
	normalize,
	reflect,
	max,
	If,
} from 'three/tsl';

import { struct } from './structProxy.js';

import { Ray, HitInfo, RayTracingMaterial, DotProducts } from './Struct.js';
import { PI, MIN_CLEARCOAT_ROUGHNESS, computeDotProducts } from './Common.js';
import { DistributionGGX } from './MaterialProperties.js';
import { ImportanceSampleGGX, ImportanceSampleCosine } from './MaterialSampling.js';
import { evaluateLayeredBRDF } from './MaterialEvaluation.js';
import { RandomValue } from './Random.js';

export const ClearcoatResult = struct( {
	brdf: 'vec3',
	L: 'vec3',
	pdf: 'float',
} );

// Improved clearcoat sampling function
// Returns vec4: xyz = brdf color, w = pdf
// L (light direction) is returned via the out pattern as a separate return
export const sampleClearcoat = Fn( ( [
	ray, hitInfo, material, randomSample, rngState,
] ) => {

	const N = hitInfo.normal;
	const V = ray.direction.negate();

	// Clamp clearcoat roughness to avoid artifacts
	const clearcoatRoughness = max( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS );
	const baseRoughness = max( material.roughness, MIN_CLEARCOAT_ROUGHNESS );

	// Calculate sampling weights based on material properties
	const specularWeight = float( 1.0 ).sub( baseRoughness ).mul( float( 0.5 ).add( float( 0.5 ).mul( material.metalness ) ) ).toVar();
	const clearcoatWeight = material.clearcoat.mul( float( 1.0 ).sub( clearcoatRoughness ) ).toVar();
	const diffuseWeight = float( 1.0 ).sub( specularWeight ).mul( float( 1.0 ).sub( material.metalness ) ).toVar();

	// Normalize weights
	const total = specularWeight.add( clearcoatWeight ).add( diffuseWeight );
	specularWeight.divAssign( total );
	clearcoatWeight.divAssign( total );
	diffuseWeight.divAssign( total );

	// Choose which layer to sample
	const rand = RandomValue( rngState );

	const L = vec3( 0.0 ).toVar();
	const H = vec3( 0.0 ).toVar();

	If( rand.lessThan( clearcoatWeight ), () => {

		// Sample clearcoat layer
		H.assign( ImportanceSampleGGX( N, clearcoatRoughness, randomSample ) );
		L.assign( reflect( V.negate(), H ) );

	} ).ElseIf( rand.lessThan( clearcoatWeight.add( specularWeight ) ), () => {

		// Sample base specular
		H.assign( ImportanceSampleGGX( N, baseRoughness, randomSample ) );
		L.assign( reflect( V.negate(), H ) );

	} ).Else( () => {

		// Sample diffuse
		L.assign( ImportanceSampleCosine( N, randomSample ) );
		H.assign( normalize( V.add( L ) ) );

	} );

	// Calculate dot products
	const dots = DotProducts.wrap( computeDotProducts( N, V, L ) );

	// Calculate individual PDFs
	const clearcoatPDF = DistributionGGX( dots.NoH, clearcoatRoughness ).mul( dots.NoH ).div( float( 4.0 ).mul( dots.VoH ) ).mul( clearcoatWeight );
	const specularPDF = DistributionGGX( dots.NoH, baseRoughness ).mul( dots.NoH ).div( float( 4.0 ).mul( dots.VoH ) ).mul( specularWeight );
	const diffusePDF = dots.NoL.div( PI ).mul( diffuseWeight );

	// Combined PDF using MIS
	const pdf = max( clearcoatPDF.add( specularPDF ).add( diffusePDF ), 0.001 );

	// Evaluate complete BRDF
	const brdf = evaluateLayeredBRDF( dots, material );

	// Return brdf, L direction, and pdf packed together
	// Caller needs L and pdf - return as struct-like output
	// We pack: result.xyz = brdf, result.w = pdf, L stored in separate output
	return ClearcoatResult( { brdf, L, pdf } );

} );
