import { Fn, float, vec2, vec3, vec4, int, mat3, If, dot, normalize, cross, abs, sqrt, mix, clamp, fract, texture } from 'three/tsl';

import {
	UVCache,
	MaterialSamples,
} from './Struct.js';

// ================================================================================
// FAST UTILITY FUNCTIONS
// ================================================================================

export const isIdentityTransform = Fn( ( [ transform ] ) => {

	return transform.element( 0 ).element( 0 ).equal( 1.0 )
		.and( transform.element( 1 ).element( 1 ).equal( 1.0 ) )
		.and( transform.element( 0 ).element( 1 ).equal( 0.0 ) )
		.and( transform.element( 1 ).element( 0 ).equal( 0.0 ) )
		.and( transform.element( 2 ).element( 0 ).equal( 0.0 ) )
		.and( transform.element( 2 ).element( 1 ).equal( 0.0 ) );

} );

export const getTransformedUV = Fn( ( [ uv, transform ] ) => {

	const result = uv.toVar();

	If( isIdentityTransform( transform ).not(), () => {

		result.assign( fract( vec2(
			transform.element( 0 ).element( 0 ).mul( uv.x ).add( transform.element( 1 ).element( 0 ).mul( uv.y ) ).add( transform.element( 2 ).element( 0 ) ),
			transform.element( 0 ).element( 1 ).mul( uv.x ).add( transform.element( 1 ).element( 1 ).mul( uv.y ) ).add( transform.element( 2 ).element( 1 ) )
		) ) );

	} );

	return result;

} );

export const materialHasTextures = Fn( ( [ material ] ) => {

	return material.albedoMapIndex.greaterThanEqual( int( 0 ) )
		.or( material.normalMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.roughnessMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.metalnessMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.emissiveMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.bumpMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.displacementMapIndex.greaterThanEqual( int( 0 ) ) );

} );

// Fast transform hash for equality checking
export const hashTransform = Fn( ( [ t ] ) => {

	return t.element( 0 ).element( 0 )
		.add( t.element( 1 ).element( 1 ).mul( 7.0 ) )
		.add( t.element( 2 ).element( 0 ).mul( 13.0 ) )
		.add( t.element( 2 ).element( 1 ).mul( 17.0 ) );

} );

// Fast transform equality using hash comparison
export const transformsEqual = Fn( ( [ a, b ] ) => {

	const hashA = hashTransform( a );
	const hashB = hashTransform( b );
	const result = int( 0 ).toVar();

	If( abs( hashA.sub( hashB ) ).lessThan( 0.001 ), () => {

		If( abs( a.element( 0 ).element( 0 ).sub( b.element( 0 ).element( 0 ) ) ).lessThan( 0.001 )
			.and( abs( a.element( 1 ).element( 1 ).sub( b.element( 1 ).element( 1 ) ) ).lessThan( 0.001 ) )
			.and( abs( a.element( 2 ).element( 0 ).sub( b.element( 2 ).element( 0 ) ) ).lessThan( 0.001 ) )
			.and( abs( a.element( 2 ).element( 1 ).sub( b.element( 2 ).element( 1 ) ) ).lessThan( 0.001 ) ), () => {

			result.assign( 1 );

		} );

	} );

	return result;

} );

// ================================================================================
// OPTIMIZED UV CACHE WITH REDUNDANCY DETECTION
// ================================================================================

export const computeUVCache = Fn( ( [ baseUV, material ] ) => {

	// Pre-compute transform hashes for batch comparison
	const albedoHash = hashTransform( material.albedoTransform ).toVar();
	const normalHash = hashTransform( material.normalTransform ).toVar();
	const metalnessHash = hashTransform( material.metalnessTransform ).toVar();
	const roughnessHash = hashTransform( material.roughnessTransform ).toVar();
	const emissiveHash = hashTransform( material.emissiveTransform ).toVar();
	const bumpHash = hashTransform( material.bumpTransform ).toVar();

	const HASH_TOLERANCE = 0.001;
	const albedoNormalSame = abs( albedoHash.sub( normalHash ) ).lessThan( HASH_TOLERANCE ).toVar();
	const normalBumpSame = abs( normalHash.sub( bumpHash ) ).lessThan( HASH_TOLERANCE ).toVar();
	const metalRoughSame = abs( metalnessHash.sub( roughnessHash ) ).lessThan( HASH_TOLERANCE ).toVar();
	const albedoEmissiveSame = abs( albedoHash.sub( emissiveHash ) ).lessThan( HASH_TOLERANCE ).toVar();

	const allSameUV = albedoNormalSame
		.and( abs( albedoHash.sub( metalnessHash ) ).lessThan( HASH_TOLERANCE ) )
		.and( abs( albedoHash.sub( emissiveHash ) ).lessThan( HASH_TOLERANCE ) )
		.and( abs( albedoHash.sub( bumpHash ) ).lessThan( HASH_TOLERANCE ) )
		.toVar();

	const albedoUV = vec2( 0.0 ).toVar();
	const normalUV = vec2( 0.0 ).toVar();
	const metalnessUV = vec2( 0.0 ).toVar();
	const roughnessUV = vec2( 0.0 ).toVar();
	const emissiveUV = vec2( 0.0 ).toVar();
	const bumpUV = vec2( 0.0 ).toVar();
	const normalBumpSameUV = normalBumpSame.or( allSameUV ).toVar();
	const metalRoughSameUV = metalRoughSame.or( allSameUV ).toVar();
	const albedoEmissiveSameUV = albedoEmissiveSame.or( allSameUV ).toVar();

	If( allSameUV, () => {

		const sharedUV = getTransformedUV( baseUV, material.albedoTransform );
		albedoUV.assign( sharedUV );
		normalUV.assign( sharedUV );
		metalnessUV.assign( sharedUV );
		roughnessUV.assign( sharedUV );
		emissiveUV.assign( sharedUV );
		bumpUV.assign( sharedUV );

	} ).Else( () => {

		// Always compute albedo as reference
		albedoUV.assign( getTransformedUV( baseUV, material.albedoTransform ) );

		// Reuse albedo UV for matching hashes
		normalUV.assign( albedoNormalSame.select( albedoUV, getTransformedUV( baseUV, material.normalTransform ) ) );
		emissiveUV.assign( albedoEmissiveSame.select( albedoUV, getTransformedUV( baseUV, material.emissiveTransform ) ) );

		// Handle bump UV with dependency chain optimization
		If( normalBumpSame, () => {

			bumpUV.assign( normalUV );

		} ).ElseIf( abs( bumpHash.sub( albedoHash ) ).lessThan( HASH_TOLERANCE ), () => {

			bumpUV.assign( albedoUV );

		} ).Else( () => {

			bumpUV.assign( getTransformedUV( baseUV, material.bumpTransform ) );

		} );

		// Handle metalness/roughness pair
		If( metalRoughSame, () => {

			metalnessUV.assign( getTransformedUV( baseUV, material.metalnessTransform ) );
			roughnessUV.assign( metalnessUV );

		} ).Else( () => {

			If( abs( metalnessHash.sub( albedoHash ) ).lessThan( HASH_TOLERANCE ), () => {

				metalnessUV.assign( albedoUV );

			} ).ElseIf( abs( metalnessHash.sub( normalHash ) ).lessThan( HASH_TOLERANCE ), () => {

				metalnessUV.assign( normalUV );

			} ).Else( () => {

				metalnessUV.assign( getTransformedUV( baseUV, material.metalnessTransform ) );

			} );

			If( abs( roughnessHash.sub( albedoHash ) ).lessThan( HASH_TOLERANCE ), () => {

				roughnessUV.assign( albedoUV );

			} ).ElseIf( abs( roughnessHash.sub( normalHash ) ).lessThan( HASH_TOLERANCE ), () => {

				roughnessUV.assign( normalUV );

			} ).ElseIf( abs( roughnessHash.sub( metalnessHash ) ).lessThan( HASH_TOLERANCE ), () => {

				roughnessUV.assign( metalnessUV );

			} ).Else( () => {

				roughnessUV.assign( getTransformedUV( baseUV, material.roughnessTransform ) );

			} );

		} );

	} );

	return UVCache( {
		albedoUV,
		normalUV,
		metalnessUV,
		roughnessUV,
		emissiveUV,
		bumpUV,
		allSameUV,
		normalBumpSameUV,
		metalRoughSameUV,
		albedoEmissiveSameUV,
	} );

} );

// ================================================================================
// PROCESSING FUNCTIONS
// ================================================================================

export const processAlbedo = Fn( ( [ albedoMaps, material, uvCache ] ) => {

	const result = material.color.toVar();

	If( material.albedoMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const albedoSample = texture( albedoMaps, uvCache.albedoUV ).depth( int( material.albedoMapIndex ) ).toVar();
		// Fast sRGB approximation
		const linear = albedoSample.rgb.mul( albedoSample.rgb ).mul( sqrt( albedoSample.rgb ) );
		result.assign( vec4( material.color.rgb.mul( linear ), material.color.a.mul( albedoSample.a ) ) );

	} );

	return result;

} );

export const processMetalnessRoughness = Fn( ( [ metalnessMaps, roughnessMaps, material, uvCache ] ) => {

	const metalness = material.metalness.toVar();
	const roughness = material.roughness.toVar();

	If( material.metalnessMapIndex.greaterThanEqual( int( 0 ) ).and( material.metalnessMapIndex.equal( material.roughnessMapIndex ) ), () => {

		// Same texture for both
		const sample = texture( metalnessMaps, uvCache.metalnessUV ).depth( int( material.metalnessMapIndex ) );
		metalness.assign( material.metalness.mul( sample.b ) );
		roughness.assign( material.roughness.mul( sample.g ) );

	} ).Else( () => {

		If( material.metalnessMapIndex.greaterThanEqual( int( 0 ) ), () => {

			const metSample = texture( metalnessMaps, uvCache.metalnessUV ).depth( int( material.metalnessMapIndex ) );
			metalness.assign( material.metalness.mul( metSample.b ) );

		} );

		If( material.roughnessMapIndex.greaterThanEqual( int( 0 ) ), () => {

			const rghSample = texture( roughnessMaps, uvCache.roughnessUV ).depth( int( material.roughnessMapIndex ) );
			roughness.assign( material.roughness.mul( rghSample.g ) );

		} );

	} );

	return vec2( metalness, roughness );

} );

export const processNormal = Fn( ( [ normalMaps, geometryNormal, material, uvCache ] ) => {

	const result = geometryNormal.toVar();

	If( material.normalMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const normalSample = texture( normalMaps, uvCache.normalUV ).depth( int( material.normalMapIndex ) );
		const normalMap = normalSample.xyz.mul( 2.0 ).sub( 1.0 ).toVar();
		normalMap.x.mulAssign( material.normalScale.x );
		normalMap.y.assign( normalMap.y.negate().mul( material.normalScale.x ) );

		// Fast TBN construction
		const up = abs( geometryNormal.z ).lessThan( 0.999 ).select( vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) );
		const tangent = normalize( cross( up, geometryNormal ) );
		const bitangent = cross( geometryNormal, tangent );

		result.assign( normalize(
			tangent.mul( normalMap.x ).add( bitangent.mul( normalMap.y ) ).add( geometryNormal.mul( normalMap.z ) )
		) );

	} );

	return result;

} );

export const processBump = Fn( ( [ bumpMaps, currentNormal, material, uvCache ] ) => {

	const result = currentNormal.toVar();

	If( material.bumpMapIndex.greaterThanEqual( int( 0 ) ), () => {

		// Approximate texel size
		const texelSize = vec2( 1.0 / 1024.0 ).toVar();

		const h_c = texture( bumpMaps, uvCache.bumpUV ).depth( int( material.bumpMapIndex ) ).r;
		const h_u = texture( bumpMaps, vec2( uvCache.bumpUV.x.add( texelSize.x ), uvCache.bumpUV.y ) ).depth( int( material.bumpMapIndex ) ).r;
		const h_v = texture( bumpMaps, vec2( uvCache.bumpUV.x, uvCache.bumpUV.y.add( texelSize.y ) ) ).depth( int( material.bumpMapIndex ) ).r;

		const gradient = vec2( h_u.sub( h_c ), h_v.sub( h_c ) ).mul( material.bumpScale );
		const bumpNormal = normalize( vec3( gradient.x.negate(), gradient.y.negate(), 1.0 ) );

		// Build TBN matrix using current normal
		const up = abs( currentNormal.z ).lessThan( 0.999 ).select( vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) );
		const tangent = normalize( cross( up, currentNormal ) );
		const bitangent = cross( currentNormal, tangent );

		const perturbedNormal = tangent.mul( bumpNormal.x ).add( bitangent.mul( bumpNormal.y ) ).add( currentNormal.mul( bumpNormal.z ) );
		result.assign( normalize( mix( currentNormal, perturbedNormal, clamp( material.bumpScale, 0.0, 1.0 ) ) ) );

	} );

	return result;

} );

export const processEmissive = Fn( ( [ emissiveMaps, material, albedoColor, uvCache ] ) => {

	const emissionBase = material.emissive.mul( material.emissiveIntensity ).toVar();

	If( material.emissiveMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const emissiveSample = texture( emissiveMaps, uvCache.emissiveUV ).depth( int( material.emissiveMapIndex ) ).toVar();
		// Fast sRGB approximation for emissive
		const emissiveLinear = emissiveSample.rgb.mul( emissiveSample.rgb ).mul( sqrt( emissiveSample.rgb ) );
		emissionBase.assign( emissionBase.mul( emissiveLinear ) );

	} );

	return emissionBase;

} );

// ================================================================================
// MAIN BATCHED SAMPLING FUNCTION
// ================================================================================

export const sampleAllMaterialTextures = Fn( ( [
	albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
	material, uv, geometryNormal
] ) => {

	const albedo = vec4( 0.0 ).toVar();
	const emissive = vec3( 0.0 ).toVar();
	const metalness = float( 0.0 ).toVar();
	const roughness = float( 0.0 ).toVar();
	const normal = vec3( 0.0 ).toVar();
	const hasTextures = materialHasTextures( material ).toVar();

	// Always use base material values first
	albedo.assign( material.color );
	emissive.assign( material.emissive.mul( material.emissiveIntensity ) );
	metalness.assign( material.metalness );
	roughness.assign( material.roughness );
	normal.assign( geometryNormal );

	If( hasTextures, () => {

		// Compute optimized UV cache with redundancy detection
		const uvCache = UVCache.wrap( computeUVCache( uv, material ) ).toVar();

		// Process samples
		albedo.assign( processAlbedo( albedoMaps, material, uvCache ) );

		const metalRough = processMetalnessRoughness( metalnessMaps, roughnessMaps, material, uvCache );
		metalness.assign( metalRough.x );
		roughness.assign( metalRough.y );

		const currentNormal = processNormal( normalMaps, geometryNormal, material, uvCache ).toVar();
		normal.assign( processBump( bumpMaps, currentNormal, material, uvCache ) );

		emissive.assign( processEmissive( emissiveMaps, material, albedo, uvCache ) );

	} );

	return MaterialSamples( { albedo, emissive, metalness, roughness, normal, hasTextures } );

} );

// ================================================================================
// LEGACY SAMPLING FUNCTIONS
// ================================================================================

export const sampleAlbedoTexture = Fn( ( [
	albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
	material, uv
] ) => {

	const samples = MaterialSamples.wrap( sampleAllMaterialTextures(
		albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
		material, uv, vec3( 0.0, 1.0, 0.0 )
	) );
	return samples.albedo;

} );

export const sampleEmissiveMap = Fn( ( [
	albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
	material, uv
] ) => {

	const samples = MaterialSamples.wrap( sampleAllMaterialTextures(
		albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
		material, uv, vec3( 0.0, 1.0, 0.0 )
	) );
	return samples.emissive;

} );

export const sampleMetalnessMap = Fn( ( [
	albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
	material, uv
] ) => {

	const samples = MaterialSamples.wrap( sampleAllMaterialTextures(
		albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
		material, uv, vec3( 0.0, 1.0, 0.0 )
	) );
	return samples.metalness;

} );

export const sampleRoughnessMap = Fn( ( [
	albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
	material, uv
] ) => {

	const samples = MaterialSamples.wrap( sampleAllMaterialTextures(
		albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
		material, uv, vec3( 0.0, 1.0, 0.0 )
	) );
	return samples.roughness;

} );

export const sampleNormalMap = Fn( ( [
	albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
	material, uv, normal
] ) => {

	const samples = MaterialSamples.wrap( sampleAllMaterialTextures(
		albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
		material, uv, normal
	) );
	return samples.normal;

} );

// Sample displacement map at given UV coordinates
export const sampleDisplacementMap = Fn( ( [ displacementMaps, displacementMapIndex, uv, transform ] ) => {

	const result = float( 0.0 ).toVar();

	If( displacementMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const transformedUV = getTransformedUV( uv, transform );
		result.assign( texture( displacementMaps, transformedUV ).depth( int( displacementMapIndex ) ).r );

	} );

	return result;

} );
