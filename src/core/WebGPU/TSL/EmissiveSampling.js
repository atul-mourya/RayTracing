// Emissive Triangle Sampling - Ported from emissive_sampling.fs
// Direct lighting from emissive triangles (next-event estimation)

import {
	Fn,
	vec2,
	vec3,
	vec4,
	float,
	int,
	bool as tslBool,
	If,
	dot,
	normalize,
	cross,
	length,
	max,
	sqrt,
	clamp,
} from 'three/tsl';

import { struct } from './structProxy.js';
import { RayTracingMaterial, HitInfo } from './Struct.js';
import { MIN_PDF, getDatafromDataTexture, getMaterial } from './Common.js';
import { RandomValue } from './Random.js';

// ================================================================================
// STRUCTS
// ================================================================================

export const EmissiveSample = struct( {
	position: 'vec3', // Sample point on emissive triangle
	normal: 'vec3', // Normal at sample point
	emission: 'vec3', // Emissive color * intensity
	direction: 'vec3', // Direction from hit point to sample
	distance: 'float', // Distance to emissive surface
	pdf: 'float', // Probability density
	area: 'float', // Triangle area
	cosThetaLight: 'float', // Cosine of angle on light surface
	valid: 'bool', // Whether sample is valid
} );

export const EmissiveContributionResult = struct( {
	contribution: 'vec3',
	hasEmissive: 'bool',
	emissionOnly: 'vec3', // For debug visualization
	distance: 'float', // Distance to emissive surface
} );

// ================================================================================
// HELPER FUNCTIONS
// ================================================================================

// Sample a point on a triangle using barycentric coordinates
export const sampleTriangle = Fn( ( [ v0, v1, v2, xi ] ) => {

	const sqrtU = sqrt( xi.x );
	const u = float( 1.0 ).sub( sqrtU );
	const v = xi.y.mul( sqrtU );
	const w = float( 1.0 ).sub( u ).sub( v );
	return v0.mul( u ).add( v1.mul( v ) ).add( v2.mul( w ) );

} );

// Calculate triangle area
export const triangleArea = Fn( ( [ v0, v1, v2 ] ) => {

	const edge1 = v1.sub( v0 );
	const edge2 = v2.sub( v0 );
	return length( cross( edge1, edge2 ) ).mul( 0.5 );

} );

// Interpolate triangle normals using barycentric coordinates
export const interpolateNormal = Fn( ( [ n0, n1, n2, xi ] ) => {

	const sqrtU = sqrt( xi.x );
	const u = float( 1.0 ).sub( sqrtU );
	const v = xi.y.mul( sqrtU );
	const w = float( 1.0 ).sub( u ).sub( v );
	return normalize( n0.mul( u ).add( n1.mul( v ) ).add( n2.mul( w ) ) );

} );

// Check if a material is emissive
export const isEmissive = Fn( ( [ material ] ) => {

	return material.emissiveIntensity.greaterThan( 0.0 ).and( length( material.emissive ).greaterThan( 0.0 ) );

} );

// Calculate emissive power of a triangle
export const calculateEmissivePower = Fn( ( [ material, area ] ) => {

	const result = float( 0.0 ).toVar( 'emPower' );

	If( isEmissive( material ), () => {

		const avgEmissive = material.emissive.x.add( material.emissive.y ).add( material.emissive.z ).div( 3.0 );
		result.assign( avgEmissive.mul( material.emissiveIntensity ).mul( area ) );

	} );

	return result;

} );

// ================================================================================
// TRIANGLE DATA ACCESS
// ================================================================================

const TRI_STRIDE = 8;

const TriangleData = struct( {
	v0: 'vec3', v1: 'vec3', v2: 'vec3',
	n0: 'vec3', n1: 'vec3', n2: 'vec3',
	materialIndex: 'int',
} );

// Fetch triangle vertices from texture
// Returns data packed in a struct-like way
export const fetchTriangleData = Fn( ( [ triangleIndex, triangleTexture, triangleTexSize ] ) => {

	// Positions
	const pos0 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, int( 0 ), int( TRI_STRIDE ) );
	const pos1 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, int( 1 ), int( TRI_STRIDE ) );
	const pos2 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, int( 2 ), int( TRI_STRIDE ) );

	// Normals
	const norm0 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, int( 3 ), int( TRI_STRIDE ) );
	const norm1 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, int( 4 ), int( TRI_STRIDE ) );
	const norm2 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, int( 5 ), int( TRI_STRIDE ) );

	// Material index (stored in last vec4)
	const uvMat = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, int( 7 ), int( TRI_STRIDE ) );

	// Return all data as a struct
	return TriangleData( {
		v0: pos0.xyz, v1: pos1.xyz, v2: pos2.xyz,
		n0: norm0.xyz, n1: norm1.xyz, n2: norm2.xyz,
		materialIndex: int( uvMat.z ),
	} );

} );

// ================================================================================
// EMISSIVE TRIANGLE SAMPLING
// ================================================================================

// Sample from emissive triangle index
export const sampleEmissiveTriangle = Fn( ( [
	hitPoint, surfaceNormal, totalTriangleCount,
	rngState,
	emissiveTriangleTexture, emissiveTriangleTexSize, emissiveTriangleCount,
	triangleTexture, triangleTexSize,
	materialTexture, materialTexSize,
] ) => {

	const result = EmissiveSample( {
		position: vec3( 0.0 ),
		normal: vec3( 0.0 ),
		emission: vec3( 0.0 ),
		direction: vec3( 0.0 ),
		distance: float( 0.0 ),
		pdf: float( 0.0 ),
		area: float( 0.0 ),
		cosThetaLight: float( 0.0 ),
		valid: false,
	} ).toVar( 'emissiveSample' );

	// Check if we have emissive triangles
	If( emissiveTriangleCount.greaterThan( int( 0 ) ), () => {

		// Select random emissive triangle from the index
		const randEmissive = RandomValue( rngState );
		const emissiveIndex = clamp(
			int( randEmissive.mul( float( emissiveTriangleCount ) ) ),
			int( 0 ),
			emissiveTriangleCount.sub( 1 )
		).toVar( 'emIdx' );

		// Fetch emissive triangle data from texture
		// Texture layout: R=triangleIndex, G=power, B=cdf, A=unused
		const emissiveTexCoord = vec2(
			float( emissiveIndex.modInt( emissiveTriangleTexSize.x ) ).add( 0.5 ).div( float( emissiveTriangleTexSize.x ) ),
			float( emissiveIndex.div( emissiveTriangleTexSize.x ) ).add( 0.5 ).div( float( emissiveTriangleTexSize.y ) )
		);
		const emissiveData = emissiveTriangleTexture.sample( emissiveTexCoord );
		const triangleIndex = int( emissiveData.r );

		// Fetch triangle geometry
		const triData = TriangleData.wrap( fetchTriangleData( triangleIndex, triangleTexture, triangleTexSize ) );

		// Get material
		const material = RayTracingMaterial.wrap( getMaterial( triData.materialIndex, materialTexture, materialTexSize ) );

		// Sample point on triangle
		const xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );
		const samplePos = sampleTriangle( triData.v0, triData.v1, triData.v2, xi );
		const sampleNormal = interpolateNormal( triData.n0, triData.n1, triData.n2, xi );

		// Direction from surface to emissive triangle
		const toEmissive = samplePos.sub( hitPoint );
		const distSq = dot( toEmissive, toEmissive );
		const dist = sqrt( distSq );
		const dir = toEmissive.div( dist );

		// Check if facing the surface
		const surfaceFacing = dot( dir, surfaceNormal );
		const emissiveFacing = dot( dir, sampleNormal.negate() );

		If( surfaceFacing.greaterThan( 0.0 ).and( emissiveFacing.greaterThan( 0.0 ) ), () => {

			// Calculate triangle area for PDF
			const area = triangleArea( triData.v0, triData.v1, triData.v2 );

			// PDF for area sampling converted to solid angle
			const pdfArea = float( 1.0 ).div( float( emissiveTriangleCount ).mul( area ) );
			const pdfSolidAngle = pdfArea.mul( distSq ).div( emissiveFacing );

			// Build result
			result.position.assign( samplePos );
			result.normal.assign( sampleNormal );
			result.emission.assign( material.emissive.mul( material.emissiveIntensity ) );
			result.direction.assign( dir );
			result.distance.assign( dist );
			result.pdf.assign( max( pdfSolidAngle, MIN_PDF ) );
			result.area.assign( area );
			result.cosThetaLight.assign( emissiveFacing );
			result.valid.assign( true );

		} );

	} );

	return result;

} );

// ================================================================================
// EMISSIVE TRIANGLE DIRECT LIGHTING CONTRIBUTION
// ================================================================================

// Note: calculateEmissiveTriangleContributionDebug requires traceShadowRay and
// evaluateMaterialResponse which creates circular dependencies.
// These are passed as function parameters to avoid the cycle.

export const calculateEmissiveTriangleContributionDebug = Fn( ( [
	hitPoint, normal, viewDir, material,
	totalTriangleCount, bounceIndex, rngState,
	emissiveBoost,
	emissiveTriangleTexture, emissiveTriangleTexSize, emissiveTriangleCount,
	triangleTexture, triangleTexSize,
	materialTexture, materialTexSize,
	// Callback functions to avoid circular deps
	traceShadowRayFn,
	evaluateMaterialResponseFn,
	calculateRayOffsetFn,
] ) => {

	const result = EmissiveContributionResult( {
		contribution: vec3( 0.0 ),
		hasEmissive: false,
		emissionOnly: vec3( 0.0 ),
		distance: float( 0.0 ),
	} ).toVar( 'emContrib' );

	// Skip for very rough diffuse surfaces on secondary bounces
	const skip = bounceIndex.greaterThan( int( 1 ) ).and( material.roughness.greaterThan( 0.9 ) ).and( material.metalness.lessThan( 0.1 ) );

	If( skip.not(), () => {

		// Sample emissive triangle
		const emissiveSample = EmissiveSample.wrap( sampleEmissiveTriangle(
			hitPoint, normal, totalTriangleCount, rngState,
			emissiveTriangleTexture, emissiveTriangleTexSize, emissiveTriangleCount,
			triangleTexture, triangleTexSize,
			materialTexture, materialTexSize,
		) );

		If( emissiveSample.valid.and( emissiveSample.pdf.greaterThan( 0.0 ) ), () => {

			result.hasEmissive.assign( true );
			result.emissionOnly.assign( emissiveSample.emission );
			result.distance.assign( emissiveSample.distance );

			// Check geometric validity
			const NoL = max( float( 0.0 ), dot( normal, emissiveSample.direction ) );

			If( NoL.greaterThan( 0.0 ), () => {

				// Calculate ray offset for shadow ray
				const rayOffset = calculateRayOffsetFn( hitPoint, normal, material );
				const rayOrigin = hitPoint.add( rayOffset );

				// Trace shadow ray
				const shadowDist = emissiveSample.distance.sub( 0.001 );
				const visibility = traceShadowRayFn( rayOrigin, emissiveSample.direction, shadowDist, rngState );

				If( visibility.greaterThan( 0.0 ), () => {

					// Evaluate BRDF
					const brdfValue = evaluateMaterialResponseFn( viewDir, emissiveSample.direction, normal, material );

					// Calculate solid angle term
					const distSq = emissiveSample.distance.mul( emissiveSample.distance );
					const solidAngleTerm = emissiveSample.area.mul( emissiveSample.cosThetaLight ).div( distSq );

					// Final contribution
					result.contribution.assign(
						emissiveSample.emission.mul( brdfValue ).mul( NoL ).mul( solidAngleTerm ).mul( visibility ).mul( emissiveBoost )
					);

				} );

			} );

		} );

	} );

	return result;

} );

// Wrapper function for backward compatibility
export const calculateEmissiveTriangleContribution = Fn( ( [
	hitPoint, normal, viewDir, material,
	totalTriangleCount, bounceIndex, rngState,
	emissiveBoost,
	emissiveTriangleTexture, emissiveTriangleTexSize, emissiveTriangleCount,
	triangleTexture, triangleTexSize,
	materialTexture, materialTexSize,
	traceShadowRayFn,
	evaluateMaterialResponseFn,
	calculateRayOffsetFn,
] ) => {

	const result = EmissiveContributionResult.wrap( calculateEmissiveTriangleContributionDebug(
		hitPoint, normal, viewDir, material,
		totalTriangleCount, bounceIndex, rngState,
		emissiveBoost,
		emissiveTriangleTexture, emissiveTriangleTexSize, emissiveTriangleCount,
		triangleTexture, triangleTexSize,
		materialTexture, materialTexSize,
		traceShadowRayFn,
		evaluateMaterialResponseFn,
		calculateRayOffsetFn,
	) );
	return result.contribution;

} );
