import { Fn, wgslFn, float, vec2, vec3, vec4, int, If, normalize, cross, abs, mix, clamp, texture } from 'three/tsl';

import {
	UVCache,
	MaterialSamples,
} from './Struct.js';

// ================================================================================
// FAST UTILITY FUNCTIONS
// ================================================================================

export const isIdentityTransform = /*@__PURE__*/ wgslFn( `
	fn isIdentityTransform( transform: mat3x3f ) -> bool {
		return transform[0][0] == 1.0f
			&& transform[1][1] == 1.0f
			&& transform[0][1] == 0.0f
			&& transform[1][0] == 0.0f
			&& transform[2][0] == 0.0f
			&& transform[2][1] == 0.0f;
	}
` );

export const getTransformedUV = /*@__PURE__*/ wgslFn( `
	fn getTransformedUV( uv: vec2f, transform: mat3x3f ) -> vec2f {
		if ( !isIdentityTransform( transform ) ) {
			return fract( vec2f(
				transform[0][0] * uv.x + transform[1][0] * uv.y + transform[2][0],
				transform[0][1] * uv.x + transform[1][1] * uv.y + transform[2][1]
			) );
		}
		return uv;
	}
`, [ isIdentityTransform ] );

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
export const hashTransform = /*@__PURE__*/ wgslFn( `
	fn hashTransform( t: mat3x3f ) -> f32 {
		return t[0][0] + t[1][1] * 7.0f + t[2][0] * 13.0f + t[2][1] * 17.0f;
	}
` );

// Fast transform equality using hash comparison
export const transformsEqual = /*@__PURE__*/ wgslFn( `
	fn transformsEqual( a: mat3x3f, b: mat3x3f ) -> i32 {
		let hashA = hashTransform( a );
		let hashB = hashTransform( b );
		if ( abs( hashA - hashB ) < 0.001f ) {
			if ( abs( a[0][0] - b[0][0] ) < 0.001f
				&& abs( a[1][1] - b[1][1] ) < 0.001f
				&& abs( a[2][0] - b[2][0] ) < 0.001f
				&& abs( a[2][1] - b[2][1] ) < 0.001f ) {
				return 1;
			}
		}
		return 0;
	}
`, [ hashTransform ] );

// ================================================================================
// OPTIMIZED UV CACHE WITH REDUNDANCY DETECTION
// ================================================================================

export const computeUVCache = Fn( ( [ baseUV, material ] ) => {

	// Pre-compute transform hashes for batch comparison
	const albedoHash = hashTransform( { t: material.albedoTransform } ).toVar();
	const normalHash = hashTransform( { t: material.normalTransform } ).toVar();
	const metalnessHash = hashTransform( { t: material.metalnessTransform } ).toVar();
	const roughnessHash = hashTransform( { t: material.roughnessTransform } ).toVar();
	const emissiveHash = hashTransform( { t: material.emissiveTransform } ).toVar();
	const bumpHash = hashTransform( { t: material.bumpTransform } ).toVar();

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

		const sharedUV = getTransformedUV( { uv: baseUV, transform: material.albedoTransform } );
		albedoUV.assign( sharedUV );
		normalUV.assign( sharedUV );
		metalnessUV.assign( sharedUV );
		roughnessUV.assign( sharedUV );
		emissiveUV.assign( sharedUV );
		bumpUV.assign( sharedUV );

	} ).Else( () => {

		// Always compute albedo as reference
		albedoUV.assign( getTransformedUV( { uv: baseUV, transform: material.albedoTransform } ) );

		// Reuse albedo UV for matching hashes
		normalUV.assign( albedoNormalSame.select( albedoUV, getTransformedUV( { uv: baseUV, transform: material.normalTransform } ) ) );
		emissiveUV.assign( albedoEmissiveSame.select( albedoUV, getTransformedUV( { uv: baseUV, transform: material.emissiveTransform } ) ) );

		// Handle bump UV with dependency chain optimization
		If( normalBumpSame, () => {

			bumpUV.assign( normalUV );

		} ).ElseIf( abs( bumpHash.sub( albedoHash ) ).lessThan( HASH_TOLERANCE ), () => {

			bumpUV.assign( albedoUV );

		} ).Else( () => {

			bumpUV.assign( getTransformedUV( { uv: baseUV, transform: material.bumpTransform } ) );

		} );

		// Handle metalness/roughness pair
		If( metalRoughSame, () => {

			metalnessUV.assign( getTransformedUV( { uv: baseUV, transform: material.metalnessTransform } ) );
			roughnessUV.assign( metalnessUV );

		} ).Else( () => {

			If( abs( metalnessHash.sub( albedoHash ) ).lessThan( HASH_TOLERANCE ), () => {

				metalnessUV.assign( albedoUV );

			} ).ElseIf( abs( metalnessHash.sub( normalHash ) ).lessThan( HASH_TOLERANCE ), () => {

				metalnessUV.assign( normalUV );

			} ).Else( () => {

				metalnessUV.assign( getTransformedUV( { uv: baseUV, transform: material.metalnessTransform } ) );

			} );

			If( abs( roughnessHash.sub( albedoHash ) ).lessThan( HASH_TOLERANCE ), () => {

				roughnessUV.assign( albedoUV );

			} ).ElseIf( abs( roughnessHash.sub( normalHash ) ).lessThan( HASH_TOLERANCE ), () => {

				roughnessUV.assign( normalUV );

			} ).ElseIf( abs( roughnessHash.sub( metalnessHash ) ).lessThan( HASH_TOLERANCE ), () => {

				roughnessUV.assign( metalnessUV );

			} ).Else( () => {

				roughnessUV.assign( getTransformedUV( { uv: baseUV, transform: material.roughnessTransform } ) );

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
		// sRGB→linear handled by GPU hardware (texture.colorSpace = SRGBColorSpace → rgba8unorm-srgb format)
		result.assign( vec4( material.color.rgb.mul( albedoSample.rgb ), material.color.a.mul( albedoSample.a ) ) );

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

	If( material.bumpMapIndex.greaterThanEqual( int( 0 ) ).and( material.bumpScale.greaterThan( 0.0 ) ), () => {

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
		// sRGB→linear handled by GPU hardware (texture.colorSpace = SRGBColorSpace → rgba8unorm-srgb format)
		emissionBase.assign( emissionBase.mul( emissiveSample.rgb ) );

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

		const transformedUV = getTransformedUV( { uv, transform } );
		result.assign( texture( displacementMaps, transformedUV ).depth( int( displacementMapIndex ) ).r );

	} );

	return result;

} );
