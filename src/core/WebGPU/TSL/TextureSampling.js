import { Fn, float, vec2, vec3, vec4, mat3, bool as tslBool, If, Loop } from 'three/tsl';
import { wgslFn } from 'three/tsl';

/**
 * Texture Sampling Functions for TSL/WGSL
 * Complete port of texture_sampling.fs from GLSL to TSL/WGSL
 * 
 * Implements optimized batched texture sampling with:
 * - UV transform caching and redundancy detection
 * - Hash-based transform equality checking
 * - Batch sampling to minimize texture fetches
 * - Smart UV reuse across material channels
 * 
 * Note: Actual texture sampling calls are handled externally.
 * These functions compute UV coordinates and batch sampling strategies.
 */

// ================================================================================
// LOCAL STRUCT DEFINITIONS
// ================================================================================

/**
 * TextureBatch structure - batch texture sample results
 * Defined locally as it's only used within texture sampling
 */
export const textureBatchStruct = wgslFn( `
struct TextureBatch {
	albedoSample: vec4f,
	normalSample: vec4f,
	metalnessRoughnessSample: vec4f,
	emissiveSample: vec4f,
	bumpSample: vec4f,
	
	hasAlbedo: u32,  // bool as u32
	hasNormal: u32,  // bool as u32
	hasMetalnessRoughness: u32,  // bool as u32
	hasEmissive: u32,  // bool as u32
	hasBump: u32  // bool as u32
}
` );

// ================================================================================
// FAST UTILITY FUNCTIONS
// ================================================================================

/**
 * Check if a transform is the identity matrix
 * @param {mat3} transform - Transform matrix to check
 * @returns {bool} True if identity transform
 */
export const isIdentityTransform = Fn( ( [ transform ] ) => {
	const t = transform.toVar();
	
	const isIdentity = t.element( 0 ).element( 0 ).equal( 1.0 )
		.and( t.element( 1 ).element( 1 ).equal( 1.0 ) )
		.and( t.element( 0 ).element( 1 ).equal( 0.0 ) )
		.and( t.element( 1 ).element( 0 ).equal( 0.0 ) )
		.and( t.element( 2 ).element( 0 ).equal( 0.0 ) )
		.and( t.element( 2 ).element( 1 ).equal( 0.0 ) );
	
	return isIdentity;
} ).setLayout( {
	name: 'isIdentityTransform',
	type: 'bool',
	inputs: [
		{ name: 'transform', type: 'mat3' }
	]
} );

/**
 * Apply UV transform with fast path for identity
 * @param {vec2} uv - Base UV coordinates
 * @param {mat3} transform - Transform matrix
 * @returns {vec2} Transformed UV coordinates
 */
export const getTransformedUV = Fn( ( [ uv, transform ] ) => {
	const u = uv.toVar();
	const t = transform.toVar();
	
	If( isIdentityTransform( t ), () => {
		return u;
	} );
	
	// Apply transform: [t00 t10 t20] [u]
	//                  [t01 t11 t21] [v]
	const transformed = vec2(
		t.element( 0 ).element( 0 ).mul( u.x ).add( t.element( 1 ).element( 0 ).mul( u.y ) ).add( t.element( 2 ).element( 0 ) ),
		t.element( 0 ).element( 1 ).mul( u.x ).add( t.element( 1 ).element( 1 ).mul( u.y ) ).add( t.element( 2 ).element( 1 ) )
	).toVar();
	
	return transformed.fract();
} ).setLayout( {
	name: 'getTransformedUV',
	type: 'vec2',
	inputs: [
		{ name: 'uv', type: 'vec2' },
		{ name: 'transform', type: 'mat3' }
	]
} );

/**
 * Check if material has any texture maps
 * @param {RayTracingMaterial} material - Material to check
 * @returns {bool} True if material has textures
 */
export const materialHasTextures = Fn( ( [ material ] ) => {
	const mat = material.toVar();
	
	const hasTextures = mat.albedoMapIndex.greaterThanEqual( 0 )
		.or( mat.normalMapIndex.greaterThanEqual( 0 ) )
		.or( mat.roughnessMapIndex.greaterThanEqual( 0 ) )
		.or( mat.metalnessMapIndex.greaterThanEqual( 0 ) )
		.or( mat.emissiveMapIndex.greaterThanEqual( 0 ) )
		.or( mat.bumpMapIndex.greaterThanEqual( 0 ) )
		.or( mat.displacementMapIndex.greaterThanEqual( 0 ) );
	
	return hasTextures;
} ).setLayout( {
	name: 'materialHasTextures',
	type: 'bool',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

/**
 * Fast transform hash for equality checking
 * Performance gain: Reduces 6 float comparisons to 4 multiply-adds + 1 comparison
 * @param {mat3} t - Transform matrix
 * @returns {float} Hash value
 */
export const hashTransform = Fn( ( [ t ] ) => {
	const transform = t.toVar();
	
	// Create a simple hash from key matrix components
	// Uses prime multipliers to reduce hash collisions
	const hash = transform.element( 0 ).element( 0 )
		.add( transform.element( 1 ).element( 1 ).mul( 7.0 ) )
		.add( transform.element( 2 ).element( 0 ).mul( 13.0 ) )
		.add( transform.element( 2 ).element( 1 ).mul( 17.0 ) );
	
	return hash;
} ).setLayout( {
	name: 'hashTransform',
	type: 'float',
	inputs: [
		{ name: 't', type: 'mat3' }
	]
} );

/**
 * Fast transform equality using hash comparison
 * @param {mat3} a - First transform
 * @param {mat3} b - Second transform
 * @returns {bool} True if transforms are equal
 */
export const transformsEqual = Fn( ( [ a, b ] ) => {
	const transformA = a.toVar();
	const transformB = b.toVar();
	
	// Quick hash-based rejection for most cases
	const hashA = hashTransform( transformA ).toVar();
	const hashB = hashTransform( transformB ).toVar();
	
	If( hashA.sub( hashB ).abs().greaterThan( 0.001 ), () => {
		return false;
	} );
	
	// Only do expensive comparison if hashes match
	const isEqual = transformA.element( 0 ).element( 0 ).sub( transformB.element( 0 ).element( 0 ) ).abs().lessThan( 0.001 )
		.and( transformA.element( 1 ).element( 1 ).sub( transformB.element( 1 ).element( 1 ) ).abs().lessThan( 0.001 ) )
		.and( transformA.element( 2 ).element( 0 ).sub( transformB.element( 2 ).element( 0 ) ).abs().lessThan( 0.001 ) )
		.and( transformA.element( 2 ).element( 1 ).sub( transformB.element( 2 ).element( 1 ) ).abs().lessThan( 0.001 ) );
	
	return isEqual;
} ).setLayout( {
	name: 'transformsEqual',
	type: 'bool',
	inputs: [
		{ name: 'a', type: 'mat3' },
		{ name: 'b', type: 'mat3' }
	]
} );

// ================================================================================
// OPTIMIZED UV CACHE WITH REDUNDANCY DETECTION
// ================================================================================

/**
 * Compute optimized UV cache with hash-based transform optimization
 * Performance improvement: 60-80% reduction in transform operations
 * BEFORE: Up to 11 expensive transformsEqual() calls (66 float comparisons)
 * AFTER: 6 hash computations + selective reuse (24-30 operations typical)
 * 
 * @param {vec2} baseUV - Base UV coordinates
 * @param {RayTracingMaterial} material - Material with transforms
 * @returns {UVCache} Cached UV coordinates with redundancy flags
 */
export const computeUVCache = Fn( ( [ baseUV, material ] ) => {
	const uv = baseUV.toVar();
	const mat = material.toVar();
	const cache = UVCache().toVar();
	
	// Pre-compute transform hashes for batch comparison
	const albedoHash = hashTransform( mat.albedoTransform ).toVar();
	const normalHash = hashTransform( mat.normalTransform ).toVar();
	const metalnessHash = hashTransform( mat.metalnessTransform ).toVar();
	const roughnessHash = hashTransform( mat.roughnessTransform ).toVar();
	const emissiveHash = hashTransform( mat.emissiveTransform ).toVar();
	const bumpHash = hashTransform( mat.bumpTransform ).toVar();
	
	const HASH_TOLERANCE = float( 0.001 ).toVar();
	
	// Fast hash-based equality checks with tolerance
	const albedoNormalSame = albedoHash.sub( normalHash ).abs().lessThan( HASH_TOLERANCE ).toVar();
	const normalBumpSame = normalHash.sub( bumpHash ).abs().lessThan( HASH_TOLERANCE ).toVar();
	const metalRoughSame = metalnessHash.sub( roughnessHash ).abs().lessThan( HASH_TOLERANCE ).toVar();
	const albedoEmissiveSame = albedoHash.sub( emissiveHash ).abs().lessThan( HASH_TOLERANCE ).toVar();
	
	// Check if all transforms are identical using hashes first
	cache.allSameUV.assign( 
		albedoHash.sub( normalHash ).abs().lessThan( HASH_TOLERANCE )
		.and( albedoHash.sub( metalnessHash ).abs().lessThan( HASH_TOLERANCE ) )
		.and( albedoHash.sub( emissiveHash ).abs().lessThan( HASH_TOLERANCE ) )
		.and( albedoHash.sub( bumpHash ).abs().lessThan( HASH_TOLERANCE ) )
		.select( 1, 0 )
	);
	
	If( cache.allSameUV.equal( 1 ), () => {
		// All UVs are the same - compute once
		const sharedUV = getTransformedUV( uv, mat.albedoTransform ).toVar();
		cache.albedoUV.assign( sharedUV );
		cache.normalUV.assign( sharedUV );
		cache.metalnessUV.assign( sharedUV );
		cache.emissiveUV.assign( sharedUV );
		cache.bumpUV.assign( sharedUV );
		cache.roughnessUV.assign( sharedUV );
	} ).Else( () => {
		// Smart UV computation with minimal transform operations
		
		// Always compute albedo as reference
		cache.albedoUV.assign( getTransformedUV( uv, mat.albedoTransform ) );
		
		// Reuse albedo UV for matching hashes, compute unique ones
		cache.normalUV.assign( 
			albedoNormalSame.select( cache.albedoUV, getTransformedUV( uv, mat.normalTransform ) )
		);
		cache.emissiveUV.assign( 
			albedoEmissiveSame.select( cache.albedoUV, getTransformedUV( uv, mat.emissiveTransform ) )
		);
		
		// Handle bump UV with dependency chain optimization
		If( normalBumpSame, () => {
			cache.bumpUV.assign( cache.normalUV );
		} ).ElseIf( bumpHash.sub( albedoHash ).abs().lessThan( HASH_TOLERANCE ), () => {
			cache.bumpUV.assign( cache.albedoUV );
		} ).Else( () => {
			cache.bumpUV.assign( getTransformedUV( uv, mat.bumpTransform ) );
		} );
		
		// Handle metalness/roughness pair efficiently
		If( metalRoughSame, () => {
			// Both use same transform
			cache.metalnessUV.assign( getTransformedUV( uv, mat.metalnessTransform ) );
			cache.roughnessUV.assign( cache.metalnessUV );
		} ).Else( () => {
			// Check for reuse opportunities with already computed UVs
			If( metalnessHash.sub( albedoHash ).abs().lessThan( HASH_TOLERANCE ), () => {
				cache.metalnessUV.assign( cache.albedoUV );
			} ).ElseIf( metalnessHash.sub( normalHash ).abs().lessThan( HASH_TOLERANCE ), () => {
				cache.metalnessUV.assign( cache.normalUV );
			} ).Else( () => {
				cache.metalnessUV.assign( getTransformedUV( uv, mat.metalnessTransform ) );
			} );
			
			If( roughnessHash.sub( albedoHash ).abs().lessThan( HASH_TOLERANCE ), () => {
				cache.roughnessUV.assign( cache.albedoUV );
			} ).ElseIf( roughnessHash.sub( normalHash ).abs().lessThan( HASH_TOLERANCE ), () => {
				cache.roughnessUV.assign( cache.normalUV );
			} ).ElseIf( roughnessHash.sub( metalnessHash ).abs().lessThan( HASH_TOLERANCE ), () => {
				cache.roughnessUV.assign( cache.metalnessUV );
			} ).Else( () => {
				cache.roughnessUV.assign( getTransformedUV( uv, mat.roughnessTransform ) );
			} );
		} );
	} );
	
	// Set redundancy flags
	cache.normalBumpSameUV.assign( normalBumpSame.or( cache.allSameUV.equal( 1 ) ).select( 1, 0 ) );
	cache.metalRoughSameUV.assign( metalRoughSame.or( cache.allSameUV.equal( 1 ) ).select( 1, 0 ) );
	cache.albedoEmissiveSameUV.assign( albedoEmissiveSame.or( cache.allSameUV.equal( 1 ) ).select( 1, 0 ) );
	
	return cache;
} ).setLayout( {
	name: 'computeUVCache',
	type: 'UVCache',
	inputs: [
		{ name: 'baseUV', type: 'vec2' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

// ================================================================================
// BATCHED TEXTURE SAMPLING FUNCTIONS
// ================================================================================

/**
 * Batch sample textures with redundancy optimization
 * Note: Actual texture sampling handled externally - this computes sampling strategy
 * 
 * @param {RayTracingMaterial} material - Material to sample
 * @param {UVCache} uvCache - Cached UV coordinates
 * @param {sampler2DArray} albedoMaps - Albedo texture array
 * @param {sampler2DArray} normalMaps - Normal texture array
 * @param {sampler2DArray} metalnessMaps - Metalness texture array
 * @param {sampler2DArray} roughnessMaps - Roughness texture array
 * @param {sampler2DArray} emissiveMaps - Emissive texture array
 * @param {sampler2DArray} bumpMaps - Bump texture array
 * @returns {TextureBatch} Batched texture samples
 */
export const batchSampleTextures = Fn( ( [ material, uvCache, albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps ] ) => {
	const mat = material.toVar();
	const cache = uvCache.toVar();
	const batch = TextureBatch().toVar();
	
	// Initialize flags
	batch.hasAlbedo.assign( mat.albedoMapIndex.greaterThanEqual( 0 ).select( 1, 0 ) );
	batch.hasNormal.assign( mat.normalMapIndex.greaterThanEqual( 0 ).select( 1, 0 ) );
	batch.hasMetalnessRoughness.assign( 
		mat.metalnessMapIndex.greaterThanEqual( 0 ).or( mat.roughnessMapIndex.greaterThanEqual( 0 ) ).select( 1, 0 )
	);
	batch.hasEmissive.assign( mat.emissiveMapIndex.greaterThanEqual( 0 ).select( 1, 0 ) );
	batch.hasBump.assign( mat.bumpMapIndex.greaterThanEqual( 0 ).select( 1, 0 ) );
	
	// 1. Handle metalness/roughness batching (most common optimization)
	If( batch.hasMetalnessRoughness.equal( 1 ), () => {
		If( mat.metalnessMapIndex.equal( mat.roughnessMapIndex ).and( mat.metalnessMapIndex.greaterThanEqual( 0 ) ), () => {
			// Same texture for both - sample once
			batch.metalnessRoughnessSample.assign( 
				metalnessMaps.textureLod( vec3( cache.metalnessUV, float( mat.metalnessMapIndex ) ), 0.0 )
			);
		} ).ElseIf( cache.metalRoughSameUV.equal( 1 ).and( mat.metalnessMapIndex.greaterThanEqual( 0 ) ).and( mat.roughnessMapIndex.greaterThanEqual( 0 ) ), () => {
			// Same UV but different textures
			batch.metalnessRoughnessSample.assign( 
				metalnessMaps.textureLod( vec3( cache.metalnessUV, float( mat.metalnessMapIndex ) ), 0.0 )
			);
		} ).Else( () => {
			// Different UVs or textures - sample separately
			If( mat.metalnessMapIndex.greaterThanEqual( 0 ), () => {
				batch.metalnessRoughnessSample.assign( 
					metalnessMaps.textureLod( vec3( cache.metalnessUV, float( mat.metalnessMapIndex ) ), 0.0 )
				);
			} );
		} );
	} );
	
	// 2. Handle albedo sampling
	If( batch.hasAlbedo.equal( 1 ), () => {
		batch.albedoSample.assign( 
			albedoMaps.textureLod( vec3( cache.albedoUV, float( mat.albedoMapIndex ) ), 0.0 )
		);
	} );
	
	// 3. Handle normal/bump batching
	If( batch.hasNormal.equal( 1 ), () => {
		batch.normalSample.assign( 
			normalMaps.textureLod( vec3( cache.normalUV, float( mat.normalMapIndex ) ), 0.0 )
		);
		
		// If bump uses the same texture and UV as normal, reuse the sample
		If( batch.hasBump.equal( 1 )
			.and( mat.bumpMapIndex.equal( mat.normalMapIndex ) )
			.and( cache.normalBumpSameUV.equal( 1 ) ), () => {
			batch.bumpSample.assign( batch.normalSample );
			batch.hasBump.assign( 0 ); // Mark as handled
		} );
	} );
	
	// 4. Handle remaining bump sampling
	If( batch.hasBump.equal( 1 ), () => {
		batch.bumpSample.assign( 
			bumpMaps.textureLod( vec3( cache.bumpUV, float( mat.bumpMapIndex ) ), 0.0 )
		);
	} );
	
	// 5. Handle emissive sampling with potential albedo reuse
	If( batch.hasEmissive.equal( 1 ), () => {
		If( mat.emissiveMapIndex.equal( mat.albedoMapIndex ).and( cache.albedoEmissiveSameUV.equal( 1 ) ), () => {
			// Reuse albedo sample for emissive
			batch.emissiveSample.assign( batch.albedoSample );
		} ).Else( () => {
			batch.emissiveSample.assign( 
				emissiveMaps.textureLod( vec3( cache.emissiveUV, float( mat.emissiveMapIndex ) ), 0.0 )
			);
		} );
	} );
	
	return batch;
} ).setLayout( {
	name: 'batchSampleTextures',
	type: 'TextureBatch',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'uvCache', type: 'UVCache' },
		{ name: 'albedoMaps', type: 'sampler2DArray' },
		{ name: 'normalMaps', type: 'sampler2DArray' },
		{ name: 'metalnessMaps', type: 'sampler2DArray' },
		{ name: 'roughnessMaps', type: 'sampler2DArray' },
		{ name: 'emissiveMaps', type: 'sampler2DArray' },
		{ name: 'bumpMaps', type: 'sampler2DArray' }
	]
} );

// ================================================================================
// OPTIMIZED PROCESSING FUNCTIONS
// ================================================================================

/**
 * Process albedo from batched texture samples
 * @param {TextureBatch} batch - Batched texture samples
 * @param {vec4} materialColor - Base material color
 * @returns {vec4} Processed albedo color
 */
export const processAlbedoFromBatch = Fn( ( [ batch, materialColor ] ) => {
	const b = batch.toVar();
	const matColor = materialColor.toVar();
	
	If( b.hasAlbedo.equal( 0 ), () => {
		return matColor;
	} );
	
	// Fast sRGB approximation: linear = srgb^2 * sqrt(srgb) ≈ srgb^2.2
	const linear = b.albedoSample.rgb.mul( b.albedoSample.rgb ).mul( b.albedoSample.rgb.sqrt() ).toVar();
	
	return vec4( matColor.rgb.mul( linear ), matColor.a.mul( b.albedoSample.a ) );
} ).setLayout( {
	name: 'processAlbedoFromBatch',
	type: 'vec4',
	inputs: [
		{ name: 'batch', type: 'TextureBatch' },
		{ name: 'materialColor', type: 'vec4' }
	]
} );

/**
 * Process metalness and roughness from batched texture samples
 * @param {TextureBatch} batch - Batched texture samples
 * @param {RayTracingMaterial} material - Material with base values
 * @returns {vec2} (metalness, roughness)
 */
export const processMetalnessRoughnessFromBatch = Fn( ( [ batch, material ] ) => {
	const b = batch.toVar();
	const mat = material.toVar();
	const result = vec2( 0.0 ).toVar();
	
	If( b.hasMetalnessRoughness.equal( 0 ), () => {
		return vec2( mat.metalness, mat.roughness );
	} );
	
	If( mat.metalnessMapIndex.equal( mat.roughnessMapIndex ).and( mat.metalnessMapIndex.greaterThanEqual( 0 ) ), () => {
		// Same texture - extract both values and multiply with uniforms
		result.x.assign( mat.metalness.mul( b.metalnessRoughnessSample.b ) ); // Metalness from blue channel
		result.y.assign( mat.roughness.mul( b.metalnessRoughnessSample.g ) );  // Roughness from green channel
	} ).Else( () => {
		// Different textures or only one available
		If( mat.metalnessMapIndex.greaterThanEqual( 0 ), () => {
			result.x.assign( mat.metalness.mul( b.metalnessRoughnessSample.b ) );
		} ).Else( () => {
			result.x.assign( mat.metalness );
		} );
		
		If( mat.roughnessMapIndex.greaterThanEqual( 0 ), () => {
			result.y.assign( mat.roughness.mul( b.metalnessRoughnessSample.g ) );
		} ).Else( () => {
			result.y.assign( mat.roughness );
		} );
	} );
	
	return result;
} ).setLayout( {
	name: 'processMetalnessRoughnessFromBatch',
	type: 'vec2',
	inputs: [
		{ name: 'batch', type: 'TextureBatch' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

/**
 * Process normal from batched texture samples
 * @param {TextureBatch} batch - Batched texture samples
 * @param {vec3} geometryNormal - Base geometry normal
 * @param {vec2} normalScale - Normal map scale
 * @returns {vec3} Processed normal
 */
export const processNormalFromBatch = Fn( ( [ batch, geometryNormal, normalScale ] ) => {
	const b = batch.toVar();
	const geomNormal = geometryNormal.toVar();
	const scale = normalScale.toVar();
	
	If( b.hasNormal.equal( 0 ), () => {
		return geomNormal;
	} );
	
	const normalMap = b.normalSample.xyz.mul( 2.0 ).sub( 1.0 ).toVar();
	// Apply normal scale - use the X component since we duplicate the value
	normalMap.xy.assign( normalMap.xy.mul( scale.x ) );
	// Fix inverted normal map by flipping Y coordinate
	normalMap.y.assign( normalMap.y.negate() );
	
	// Fast TBN construction
	const up = geomNormal.z.abs().lessThan( 0.999 ).select( vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) ).toVar();
	const tangent = up.cross( geomNormal ).normalize().toVar();
	const bitangent = geomNormal.cross( tangent ).toVar();
	
	return tangent.mul( normalMap.x ).add( bitangent.mul( normalMap.y ) ).add( geomNormal.mul( normalMap.z ) ).normalize();
} ).setLayout( {
	name: 'processNormalFromBatch',
	type: 'vec3',
	inputs: [
		{ name: 'batch', type: 'TextureBatch' },
		{ name: 'geometryNormal', type: 'vec3' },
		{ name: 'normalScale', type: 'vec2' }
	]
} );

/**
 * Process bump mapping from batched texture samples
 * @param {TextureBatch} batch - Batched texture samples
 * @param {vec3} currentNormal - Current normal (possibly from normal map)
 * @param {float} bumpScale - Bump map scale
 * @param {vec2} normalScale - Normal map scale (unused in bump processing)
 * @param {UVCache} uvCache - UV cache for bump sampling
 * @param {RayTracingMaterial} material - Material with bump map index
 * @param {sampler2DArray} bumpMaps - Bump texture array
 * @returns {vec3} Processed normal with bump perturbation
 */
export const processBumpFromBatch = Fn( ( [ batch, currentNormal, bumpScale, normalScale, uvCache, material, bumpMaps ] ) => {
	const b = batch.toVar();
	const normal = currentNormal.toVar();
	const scale = bumpScale.toVar();
	const cache = uvCache.toVar();
	const mat = material.toVar();
	
	If( b.hasBump.equal( 0 ).or( mat.bumpMapIndex.lessThan( 0 ) ), () => {
		return normal;
	} );
	
	// For bump mapping, we need neighboring samples for gradient calculation
	// Note: textureSize needs to be provided externally or computed
	const texelSize = vec2( 1.0 ).div( vec2( 512.0 ) ).toVar(); // Placeholder - should be actual texture size
	
	const h_c = b.bumpSample.r.toVar();
	const h_u = bumpMaps.textureLod( 
		vec3( cache.bumpUV.add( vec2( texelSize.x, 0.0 ) ), float( mat.bumpMapIndex ) ), 
		0.0 
	).r.toVar();
	const h_v = bumpMaps.textureLod( 
		vec3( cache.bumpUV.add( vec2( 0.0, texelSize.y ) ), float( mat.bumpMapIndex ) ), 
		0.0 
	).r.toVar();
	
	const gradient = vec2( h_u.sub( h_c ), h_v.sub( h_c ) ).mul( scale ).toVar();
	const bumpNormal = vec3( gradient.x.negate(), gradient.y.negate(), 1.0 ).normalize().toVar();
	
	// Build TBN matrix using the current normal
	const up = normal.z.abs().lessThan( 0.999 ).select( vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) ).toVar();
	const tangent = up.cross( normal ).normalize().toVar();
	const bitangent = normal.cross( tangent ).toVar();
	const TBN = mat3( tangent, bitangent, normal ).toVar();
	
	// Transform bump normal to world space
	const perturbedNormal = TBN.mul( bumpNormal ).toVar();
	
	// Apply bumpScale as a blend factor
	return normal.mix( perturbedNormal, scale.clamp( 0.0, 1.0 ) ).normalize();
} ).setLayout( {
	name: 'processBumpFromBatch',
	type: 'vec3',
	inputs: [
		{ name: 'batch', type: 'TextureBatch' },
		{ name: 'currentNormal', type: 'vec3' },
		{ name: 'bumpScale', type: 'float' },
		{ name: 'normalScale', type: 'vec2' },
		{ name: 'uvCache', type: 'UVCache' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'bumpMaps', type: 'sampler2DArray' }
	]
} );

/**
 * Process emissive from batched texture samples
 * @param {TextureBatch} batch - Batched texture samples
 * @param {RayTracingMaterial} material - Material (unused but kept for consistency)
 * @param {vec3} baseEmissive - Base emissive color
 * @param {float} intensity - Emissive intensity
 * @param {vec4} albedoColor - Albedo color (unused but kept for consistency)
 * @returns {vec3} Processed emissive color
 */
export const processEmissiveFromBatch = Fn( ( [ batch, material, baseEmissive, intensity, albedoColor ] ) => {
	const b = batch.toVar();
	const emissive = baseEmissive.toVar();
	const emissiveIntensity = intensity.toVar();
	
	const emissionBase = emissive.mul( emissiveIntensity ).toVar();
	
	If( b.hasEmissive.equal( 0 ), () => {
		return emissionBase;
	} );
	
	// Fast sRGB approximation for emissive
	const emissiveLinear = b.emissiveSample.rgb.mul( b.emissiveSample.rgb ).mul( b.emissiveSample.rgb.sqrt() ).toVar();
	
	return emissionBase.mul( emissiveLinear );
} ).setLayout( {
	name: 'processEmissiveFromBatch',
	type: 'vec3',
	inputs: [
		{ name: 'batch', type: 'TextureBatch' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'baseEmissive', type: 'vec3' },
		{ name: 'intensity', type: 'float' },
		{ name: 'albedoColor', type: 'vec4' }
	]
} );

// ================================================================================
// MAIN BATCHED SAMPLING FUNCTION
// ================================================================================

/**
 * Sample all material textures using batched sampling optimization
 * Main entry point for texture sampling with full optimization
 * 
 * @param {RayTracingMaterial} material - Material to sample
 * @param {vec2} uv - Base UV coordinates
 * @param {vec3} geometryNormal - Geometry normal
 * @param {sampler2DArray} albedoMaps - Albedo texture array
 * @param {sampler2DArray} normalMaps - Normal texture array
 * @param {sampler2DArray} metalnessMaps - Metalness texture array
 * @param {sampler2DArray} roughnessMaps - Roughness texture array
 * @param {sampler2DArray} emissiveMaps - Emissive texture array
 * @param {sampler2DArray} bumpMaps - Bump texture array
 * @returns {MaterialSamples} Complete material sample results
 */
export const sampleAllMaterialTextures = Fn( ( [ material, uv, geometryNormal, albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps ] ) => {
	const mat = material.toVar();
	const baseUV = uv.toVar();
	const geomNormal = geometryNormal.toVar();
	const samples = MaterialSamples().toVar();
	
	// Initialize defaults
	samples.albedo.assign( vec4( 0.0 ) );
	samples.emissive.assign( vec3( 0.0 ) );
	samples.metalness.assign( 0.0 );
	samples.roughness.assign( 0.0 );
	samples.normal.assign( vec3( 0.0 ) );
	samples.hasTextures.assign( materialHasTextures( mat ).select( 1, 0 ) );
	
	// Fast path for materials with no textures
	If( samples.hasTextures.equal( 0 ), () => {
		samples.albedo.assign( mat.color );
		samples.emissive.assign( mat.emissive.mul( mat.emissiveIntensity ) );
		samples.metalness.assign( mat.metalness );
		samples.roughness.assign( mat.roughness );
		samples.normal.assign( geomNormal );
		return samples;
	} );
	
	// Compute optimized UV cache with redundancy detection
	const uvCache = computeUVCache( baseUV, mat ).toVar();
	
	// Batch sample all textures with redundancy optimization
	const batch = batchSampleTextures( mat, uvCache, albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps ).toVar();
	
	// Process samples using batched data
	samples.albedo.assign( processAlbedoFromBatch( batch, mat.color ) );
	
	const metalRough = processMetalnessRoughnessFromBatch( batch, mat ).toVar();
	samples.metalness.assign( metalRough.x );
	samples.roughness.assign( metalRough.y );
	
	const currentNormal = processNormalFromBatch( batch, geomNormal, mat.normalScale ).toVar();
	samples.normal.assign( processBumpFromBatch( batch, currentNormal, mat.bumpScale, mat.normalScale, uvCache, mat, bumpMaps ) );
	
	samples.emissive.assign( processEmissiveFromBatch( batch, mat, mat.emissive, mat.emissiveIntensity, samples.albedo ) );
	
	return samples;
} ).setLayout( {
	name: 'sampleAllMaterialTextures',
	type: 'MaterialSamples',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'geometryNormal', type: 'vec3' },
		{ name: 'albedoMaps', type: 'sampler2DArray' },
		{ name: 'normalMaps', type: 'sampler2DArray' },
		{ name: 'metalnessMaps', type: 'sampler2DArray' },
		{ name: 'roughnessMaps', type: 'sampler2DArray' },
		{ name: 'emissiveMaps', type: 'sampler2DArray' },
		{ name: 'bumpMaps', type: 'sampler2DArray' }
	]
} );

// ================================================================================
// LEGACY SAMPLING FUNCTIONS (DEPRECATED - USE sampleAllMaterialTextures)
// ================================================================================

/**
 * Sample albedo texture (DEPRECATED - redirects to batched sampling)
 * @param {RayTracingMaterial} material - Material to sample
 * @param {vec2} uv - UV coordinates
 * @param {sampler2DArray} albedoMaps - Albedo texture array
 * @param {sampler2DArray} normalMaps - Normal texture array
 * @param {sampler2DArray} metalnessMaps - Metalness texture array
 * @param {sampler2DArray} roughnessMaps - Roughness texture array
 * @param {sampler2DArray} emissiveMaps - Emissive texture array
 * @param {sampler2DArray} bumpMaps - Bump texture array
 * @returns {vec4} Albedo color
 */
export const sampleAlbedoTexture = Fn( ( [ material, uv, albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps ] ) => {
	const samples = sampleAllMaterialTextures( 
		material, uv, vec3( 0.0, 1.0, 0.0 ), 
		albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps 
	).toVar();
	return samples.albedo;
} ).setLayout( {
	name: 'sampleAlbedoTexture',
	type: 'vec4',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'albedoMaps', type: 'sampler2DArray' },
		{ name: 'normalMaps', type: 'sampler2DArray' },
		{ name: 'metalnessMaps', type: 'sampler2DArray' },
		{ name: 'roughnessMaps', type: 'sampler2DArray' },
		{ name: 'emissiveMaps', type: 'sampler2DArray' },
		{ name: 'bumpMaps', type: 'sampler2DArray' }
	]
} );

/**
 * Sample emissive map (DEPRECATED - redirects to batched sampling)
 */
export const sampleEmissiveMap = Fn( ( [ material, uv, albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps ] ) => {
	const samples = sampleAllMaterialTextures( 
		material, uv, vec3( 0.0, 1.0, 0.0 ), 
		albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps 
	).toVar();
	return samples.emissive;
} ).setLayout( {
	name: 'sampleEmissiveMap',
	type: 'vec3',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'albedoMaps', type: 'sampler2DArray' },
		{ name: 'normalMaps', type: 'sampler2DArray' },
		{ name: 'metalnessMaps', type: 'sampler2DArray' },
		{ name: 'roughnessMaps', type: 'sampler2DArray' },
		{ name: 'emissiveMaps', type: 'sampler2DArray' },
		{ name: 'bumpMaps', type: 'sampler2DArray' }
	]
} );

/**
 * Sample metalness map (DEPRECATED - redirects to batched sampling)
 */
export const sampleMetalnessMap = Fn( ( [ material, uv, albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps ] ) => {
	const samples = sampleAllMaterialTextures( 
		material, uv, vec3( 0.0, 1.0, 0.0 ), 
		albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps 
	).toVar();
	return samples.metalness;
} ).setLayout( {
	name: 'sampleMetalnessMap',
	type: 'float',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'albedoMaps', type: 'sampler2DArray' },
		{ name: 'normalMaps', type: 'sampler2DArray' },
		{ name: 'metalnessMaps', type: 'sampler2DArray' },
		{ name: 'roughnessMaps', type: 'sampler2DArray' },
		{ name: 'emissiveMaps', type: 'sampler2DArray' },
		{ name: 'bumpMaps', type: 'sampler2DArray' }
	]
} );

/**
 * Sample roughness map (DEPRECATED - redirects to batched sampling)
 */
export const sampleRoughnessMap = Fn( ( [ material, uv, albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps ] ) => {
	const samples = sampleAllMaterialTextures( 
		material, uv, vec3( 0.0, 1.0, 0.0 ), 
		albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps 
	).toVar();
	return samples.roughness;
} ).setLayout( {
	name: 'sampleRoughnessMap',
	type: 'float',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'albedoMaps', type: 'sampler2DArray' },
		{ name: 'normalMaps', type: 'sampler2DArray' },
		{ name: 'metalnessMaps', type: 'sampler2DArray' },
		{ name: 'roughnessMaps', type: 'sampler2DArray' },
		{ name: 'emissiveMaps', type: 'sampler2DArray' },
		{ name: 'bumpMaps', type: 'sampler2DArray' }
	]
} );

/**
 * Sample normal map (DEPRECATED - redirects to batched sampling)
 */
export const sampleNormalMap = Fn( ( [ material, uv, normal, albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps ] ) => {
	const samples = sampleAllMaterialTextures( 
		material, uv, normal, 
		albedoMaps, normalMaps, metalnessMaps, roughnessMaps, emissiveMaps, bumpMaps 
	).toVar();
	return samples.normal;
} ).setLayout( {
	name: 'sampleNormalMap',
	type: 'vec3',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'albedoMaps', type: 'sampler2DArray' },
		{ name: 'normalMaps', type: 'sampler2DArray' },
		{ name: 'metalnessMaps', type: 'sampler2DArray' },
		{ name: 'roughnessMaps', type: 'sampler2DArray' },
		{ name: 'emissiveMaps', type: 'sampler2DArray' },
		{ name: 'bumpMaps', type: 'sampler2DArray' }
	]
} );

/**
 * Sample displacement map at given UV coordinates
 * @param {int} displacementMapIndex - Index of displacement map
 * @param {vec2} uv - Base UV coordinates
 * @param {mat3} transform - UV transform matrix
 * @param {sampler2DArray} displacementMaps - Displacement texture array
 * @returns {float} Displacement value
 */
export const sampleDisplacementMap = Fn( ( [ displacementMapIndex, uv, transform, displacementMaps ] ) => {
	const mapIndex = displacementMapIndex.toVar();
	const baseUV = uv.toVar();
	const uvTransform = transform.toVar();
	
	If( mapIndex.lessThan( 0 ), () => {
		return float( 0.0 );
	} );
	
	// Apply texture transform
	const transformedUV = getTransformedUV( baseUV, uvTransform ).toVar();
	
	// Sample displacement texture (assuming it's in the red channel)
	return displacementMaps.textureLod( vec3( transformedUV, float( mapIndex ) ), 0.0 ).r;
} ).setLayout( {
	name: 'sampleDisplacementMap',
	type: 'float',
	inputs: [
		{ name: 'displacementMapIndex', type: 'int' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'transform', type: 'mat3' },
		{ name: 'displacementMaps', type: 'sampler2DArray' }
	]
} );
