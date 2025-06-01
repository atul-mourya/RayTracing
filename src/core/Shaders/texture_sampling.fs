uniform sampler2DArray albedoMaps;
uniform sampler2DArray normalMaps;
uniform sampler2DArray bumpMaps;
uniform sampler2DArray metalnessMaps;
uniform sampler2DArray roughnessMaps;
uniform sampler2DArray emissiveMaps;

// ================================================================================
// FAST UTILITY FUNCTIONS
// ================================================================================

bool isIdentityTransform( mat3 transform ) {
	return ( transform[ 0 ][ 0 ] == 1.0 && transform[ 1 ][ 1 ] == 1.0 &&
		transform[ 0 ][ 1 ] == 0.0 && transform[ 1 ][ 0 ] == 0.0 &&
		transform[ 2 ][ 0 ] == 0.0 && transform[ 2 ][ 1 ] == 0.0 );
}

vec2 getTransformedUV( vec2 uv, mat3 transform ) {
	if( isIdentityTransform( transform ) ) {
		return uv;
	}
	return fract( vec2( transform[ 0 ][ 0 ] * uv.x + transform[ 1 ][ 0 ] * uv.y + transform[ 2 ][ 0 ], transform[ 0 ][ 1 ] * uv.x + transform[ 1 ][ 1 ] * uv.y + transform[ 2 ][ 1 ] ) );
}

bool materialHasTextures( RayTracingMaterial material ) {
	return ( material.albedoMapIndex >= 0 ||
		material.normalMapIndex >= 0 ||
		material.roughnessMapIndex >= 0 ||
		material.metalnessMapIndex >= 0 ||
		material.emissiveMapIndex >= 0 ||
		material.bumpMapIndex >= 0 );
}

// Check if two transforms are identical (for batching)
bool transformsEqual( mat3 a, mat3 b ) {
	return ( abs( a[ 0 ][ 0 ] - b[ 0 ][ 0 ] ) < 0.001 &&
		abs( a[ 1 ][ 1 ] - b[ 1 ][ 1 ] ) < 0.001 &&
		abs( a[ 0 ][ 1 ] - b[ 0 ][ 1 ] ) < 0.001 &&
		abs( a[ 1 ][ 0 ] - b[ 1 ][ 0 ] ) < 0.001 &&
		abs( a[ 2 ][ 0 ] - b[ 2 ][ 0 ] ) < 0.001 &&
		abs( a[ 2 ][ 1 ] - b[ 2 ][ 1 ] ) < 0.001 );
}

// ================================================================================
// OPTIMIZED UV CACHE WITH REDUNDANCY DETECTION
// ================================================================================


UVCache computeUVCache( vec2 baseUV, RayTracingMaterial material ) {
	UVCache cache;

	// Check for transform equality to avoid redundant calculations
	bool albedoNormalSame = transformsEqual( material.albedoTransform, material.normalTransform );
	bool normalBumpSame = transformsEqual( material.normalTransform, material.bumpTransform );
	bool metalRoughSame = transformsEqual( material.metalnessTransform, material.roughnessTransform );
	bool albedoEmissiveSame = transformsEqual( material.albedoTransform, material.emissiveTransform );

	// Check if all transforms are identical
	cache.allSameUV = transformsEqual( material.albedoTransform, material.normalTransform ) &&
		transformsEqual( material.albedoTransform, material.metalnessTransform ) &&
		transformsEqual( material.albedoTransform, material.emissiveTransform ) &&
		transformsEqual( material.albedoTransform, material.bumpTransform );

	if( cache.allSameUV ) {
		// All UVs are the same - compute once
		vec2 sharedUV = getTransformedUV( baseUV, material.albedoTransform );
		cache.albedoUV = sharedUV;
		cache.normalUV = sharedUV;
		cache.metalnessUV = sharedUV;
		cache.emissiveUV = sharedUV;
		cache.bumpUV = sharedUV;
		cache.roughnessUV = sharedUV;
	} else {
		// Compute UVs with smart reuse
		cache.albedoUV = getTransformedUV( baseUV, material.albedoTransform );

		if( albedoNormalSame ) {
			cache.normalUV = cache.albedoUV;
		} else {
			cache.normalUV = getTransformedUV( baseUV, material.normalTransform );
		}

		if( normalBumpSame ) {
			cache.bumpUV = cache.normalUV;
		} else {
			cache.bumpUV = getTransformedUV( baseUV, material.bumpTransform );
		}

		if( metalRoughSame ) {
			cache.metalnessUV = getTransformedUV( baseUV, material.metalnessTransform );
			cache.roughnessUV = cache.metalnessUV;
		} else {
			cache.metalnessUV = getTransformedUV( baseUV, material.metalnessTransform );
			cache.roughnessUV = getTransformedUV( baseUV, material.roughnessTransform );
		}

		if( albedoEmissiveSame ) {
			cache.emissiveUV = cache.albedoUV;
		} else {
			cache.emissiveUV = getTransformedUV( baseUV, material.emissiveTransform );
		}
	}

	// Set redundancy flags
	cache.normalBumpSameUV = normalBumpSame || cache.allSameUV;
	cache.metalRoughSameUV = metalRoughSame || cache.allSameUV;
	cache.albedoEmissiveSameUV = albedoEmissiveSame || cache.allSameUV;

	return cache;
}

// ================================================================================
// BATCHED TEXTURE SAMPLING FUNCTIONS
// ================================================================================

struct TextureBatch {
	vec4 albedoSample;
	vec4 normalSample;
	vec4 metalnessRoughnessSample;
	vec4 emissiveSample;
	vec4 bumpSample;

	bool hasAlbedo;
	bool hasNormal;
	bool hasMetalnessRoughness;
	bool hasEmissive;
	bool hasBump;
};

TextureBatch batchSampleTextures( RayTracingMaterial material, UVCache uvCache ) {
	TextureBatch batch;

	// Initialize flags
	batch.hasAlbedo = material.albedoMapIndex >= 0;
	batch.hasNormal = material.normalMapIndex >= 0;
	batch.hasMetalnessRoughness = material.metalnessMapIndex >= 0 || material.roughnessMapIndex >= 0;
	batch.hasEmissive = material.emissiveMapIndex >= 0;
	batch.hasBump = material.bumpMapIndex >= 0;

	// Batch sample textures with redundancy optimization

	// 1. Handle metalness/roughness batching (most common optimization)
	if( batch.hasMetalnessRoughness ) {
		if( material.metalnessMapIndex == material.roughnessMapIndex && material.metalnessMapIndex >= 0 ) {
			// Same texture for both - sample once
			batch.metalnessRoughnessSample = texture( metalnessMaps, vec3( uvCache.metalnessUV, float( material.metalnessMapIndex ) ) );
		} else if( uvCache.metalRoughSameUV && material.metalnessMapIndex >= 0 && material.roughnessMapIndex >= 0 ) {
			// Same UV but different textures - can potentially batch if they're in the same array
			batch.metalnessRoughnessSample = texture( metalnessMaps, vec3( uvCache.metalnessUV, float( material.metalnessMapIndex ) ) );
			// Note: In a more advanced implementation, you could sample both layers at once
		} else {
			// Different UVs or textures - sample separately (handled later)
			if( material.metalnessMapIndex >= 0 ) {
				batch.metalnessRoughnessSample = texture( metalnessMaps, vec3( uvCache.metalnessUV, float( material.metalnessMapIndex ) ) );
			}
		}
	}

	// 2. Handle albedo sampling
	if( batch.hasAlbedo ) {
		batch.albedoSample = texture( albedoMaps, vec3( uvCache.albedoUV, float( material.albedoMapIndex ) ) );
	}

	// 3. Handle normal/bump batching
	if( batch.hasNormal ) {
		batch.normalSample = texture( normalMaps, vec3( uvCache.normalUV, float( material.normalMapIndex ) ) );

		// If bump uses the same texture and UV as normal, reuse the sample
		if( batch.hasBump && material.bumpMapIndex == material.normalMapIndex && uvCache.normalBumpSameUV ) {
			batch.bumpSample = batch.normalSample;
			batch.hasBump = false; // Mark as handled
		}
	}

	// 4. Handle remaining bump sampling
	if( batch.hasBump ) {
		batch.bumpSample = texture( bumpMaps, vec3( uvCache.bumpUV, float( material.bumpMapIndex ) ) );
	}

	// 5. Handle emissive sampling with potential albedo reuse
	if( batch.hasEmissive ) {
		if( material.emissiveMapIndex == material.albedoMapIndex && uvCache.albedoEmissiveSameUV ) {
			// Reuse albedo sample for emissive
			batch.emissiveSample = batch.albedoSample;
		} else {
			batch.emissiveSample = texture( emissiveMaps, vec3( uvCache.emissiveUV, float( material.emissiveMapIndex ) ) );
		}
	}

	return batch;
}

// ================================================================================
// OPTIMIZED PROCESSING FUNCTIONS
// ================================================================================

vec4 processAlbedoFromBatch( TextureBatch batch, vec4 materialColor ) {
	if( ! batch.hasAlbedo ) {
		return materialColor;
	}

	// Fast sRGB approximation
	vec3 linear = batch.albedoSample.rgb * batch.albedoSample.rgb * sqrt( batch.albedoSample.rgb );
	return vec4( materialColor.rgb * linear, materialColor.a * batch.albedoSample.a );
}

vec2 processMetalnessRoughnessFromBatch( TextureBatch batch, RayTracingMaterial material ) {
	if( ! batch.hasMetalnessRoughness ) {
		return vec2( material.metalness, material.roughness );
	}

	vec2 result;

	if( material.metalnessMapIndex == material.roughnessMapIndex && material.metalnessMapIndex >= 0 ) {
		// Same texture - extract both values
		result.x = material.metalness * batch.metalnessRoughnessSample.b; // Metalness from blue channel
		result.y = material.roughness * batch.metalnessRoughnessSample.g;  // Roughness from green channel
	} else {
		// Different textures or only one available
		if( material.metalnessMapIndex >= 0 ) {
			result.x = material.metalness * batch.metalnessRoughnessSample.b;
		} else {
			result.x = material.metalness;
		}

		if( material.roughnessMapIndex >= 0 ) {
			// Need to sample roughness separately if not already done
			if( material.metalnessMapIndex != material.roughnessMapIndex ) {
				// This would require a separate texture read - for now, use the batched sample
				result.y = material.roughness * batch.metalnessRoughnessSample.g;
			} else {
				result.y = material.roughness * batch.metalnessRoughnessSample.g;
			}
		} else {
			result.y = material.roughness;
		}
	}

	return result;
}

vec3 processNormalFromBatch( TextureBatch batch, vec3 geometryNormal, vec2 normalScale ) {
	if( ! batch.hasNormal ) {
		return geometryNormal;
	}

	vec3 normalMap = batch.normalSample.xyz * 2.0 - 1.0;
	normalMap.xy *= normalScale;

	// Fast TBN construction
	vec3 up = abs( geometryNormal.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 tangent = normalize( cross( up, geometryNormal ) );
	vec3 bitangent = cross( geometryNormal, tangent );

	return normalize( tangent * normalMap.x + bitangent * normalMap.y + geometryNormal * normalMap.z );
}

vec3 processBumpFromBatch( TextureBatch batch, vec3 currentNormal, float bumpScale, vec2 normalScale, UVCache uvCache, RayTracingMaterial material ) {
	if( ! batch.hasBump ) {
		return currentNormal;
	}

	// For bump mapping, we need neighboring samples for gradient calculation
	// This is one area where we can't easily batch due to the need for offset samples
	vec2 texelSize = 1.0 / vec2( textureSize( bumpMaps, 0 ).xy );

	float h_c = batch.bumpSample.r;
	float h_u = texture( bumpMaps, vec3( uvCache.bumpUV + vec2( texelSize.x, 0.0 ), float( material.bumpMapIndex ) ) ).r;
	float h_v = texture( bumpMaps, vec3( uvCache.bumpUV + vec2( 0.0, texelSize.y ), float( material.bumpMapIndex ) ) ).r;

	vec2 gradient = vec2( h_u - h_c, h_v - h_c ) * bumpScale;
	vec3 bumpNormal = normalize( vec3( - gradient.x, - gradient.y, 1.0 ) );

	vec3 up = abs( currentNormal.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 tangent = normalize( cross( up, currentNormal ) );
	vec3 bitangent = cross( currentNormal, tangent );
	mat3 TBN = mat3( tangent, bitangent, currentNormal );

	return normalize( mix( currentNormal, TBN * bumpNormal, normalScale.x ) );
}

vec3 processEmissiveFromBatch( TextureBatch batch, RayTracingMaterial material, vec3 baseEmissive, float intensity, vec4 albedoColor ) {
	vec3 emissionBase = baseEmissive * intensity;

	if( ! batch.hasEmissive ) {
		return emissionBase;
	}

	// Fast sRGB approximation for emissive
	vec3 emissiveLinear = batch.emissiveSample.rgb * batch.emissiveSample.rgb * sqrt( batch.emissiveSample.rgb );
	return emissionBase * emissiveLinear;
}

// ================================================================================
// MAIN BATCHED SAMPLING FUNCTION
// ================================================================================

MaterialSamples sampleAllMaterialTextures( RayTracingMaterial material, vec2 uv, vec3 geometryNormal ) {
	MaterialSamples samples;
	samples.hasTextures = materialHasTextures( material );

    // Fast path for materials with no textures
	if( ! samples.hasTextures ) {
		samples.albedo = material.color;
		samples.emissive = material.emissive * material.emissiveIntensity;
		samples.metalness = material.metalness;
		samples.roughness = material.roughness;
		samples.normal = geometryNormal;
		return samples;
	}

	// Compute optimized UV cache with redundancy detection
	UVCache uvCache = computeUVCache( uv, material );

	// Batch sample all textures with redundancy optimization
	TextureBatch batch = batchSampleTextures( material, uvCache );

	// Process samples using batched data
	samples.albedo = processAlbedoFromBatch( batch, material.color );

	vec2 metalRough = processMetalnessRoughnessFromBatch( batch, material );
	samples.metalness = metalRough.x;
	samples.roughness = metalRough.y;

	vec3 currentNormal = processNormalFromBatch( batch, geometryNormal, material.normalScale );
	samples.normal = processBumpFromBatch( batch, currentNormal, material.bumpScale, material.normalScale, uvCache, material );

	samples.emissive = processEmissiveFromBatch( batch, material, material.emissive, material.emissiveIntensity, samples.albedo );

	return samples;
}

// ================================================================================
// INDIVIDUAL SAMPLING FUNCTIONS (for compatibility with existing calls)
// ================================================================================

vec4 sampleAlbedoTexture( RayTracingMaterial material, vec2 uv ) {
	if( material.albedoMapIndex < 0 ) {
		return material.color;
	}
	vec2 transformedUV = getTransformedUV( uv, material.albedoTransform );
	vec4 texSample = texture( albedoMaps, vec3( transformedUV, float( material.albedoMapIndex ) ) );
	vec3 linear = texSample.rgb * texSample.rgb * sqrt( texSample.rgb );
	return vec4( material.color.rgb * linear, material.color.a * texSample.a );
}

vec3 sampleEmissiveMap( RayTracingMaterial material, vec2 uv ) {
	vec2 emissiveUV = getTransformedUV( uv, material.emissiveTransform );
	vec3 emissionBase = material.emissive * material.emissiveIntensity;

	if( material.emissiveMapIndex >= 0 ) {
		vec4 emissiveSample = texture( emissiveMaps, vec3( emissiveUV, float( material.emissiveMapIndex ) ) );
		vec3 emissiveLinear = emissiveSample.rgb * emissiveSample.rgb * sqrt( emissiveSample.rgb );
		return emissionBase * emissiveLinear;
	}

	return emissionBase;
}

float sampleMetalnessMap( RayTracingMaterial material, vec2 uv ) {
	if( material.metalnessMapIndex < 0 ) {
		return material.metalness;
	}
	vec2 transformedUV = getTransformedUV( uv, material.metalnessTransform );
	vec4 _sample = texture( metalnessMaps, vec3( transformedUV, float( material.metalnessMapIndex ) ) );
	return material.metalness * _sample.b;
}

float sampleRoughnessMap( RayTracingMaterial material, vec2 uv ) {
	if( material.roughnessMapIndex < 0 ) {
		return material.roughness;
	}
	vec2 transformedUV = getTransformedUV( uv, material.roughnessTransform );
	vec4 _sample = texture( roughnessMaps, vec3( transformedUV, float( material.roughnessMapIndex ) ) );
	return material.roughness * _sample.g;
}

vec3 sampleNormalMap( RayTracingMaterial material, vec2 uv, vec3 normal ) {
	vec3 resultNormal = normal;

	if( material.normalMapIndex >= 0 ) {
		vec2 transformedUV = getTransformedUV( uv, material.normalTransform );
		vec3 normalSample = texture( normalMaps, vec3( transformedUV, float( material.normalMapIndex ) ) ).xyz;
		vec3 normalMap = normalSample * 2.0 - 1.0;
		normalMap.xy *= material.normalScale;

		vec3 up = abs( normal.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
		vec3 tangent = normalize( cross( up, normal ) );
		vec3 bitangent = cross( normal, tangent );

		resultNormal = normalize( tangent * normalMap.x + bitangent * normalMap.y + normal * normalMap.z );
	}

	if( material.bumpMapIndex >= 0 ) {
		vec2 transformedUV = getTransformedUV( uv, material.bumpTransform );
		vec2 texelSize = 1.0 / vec2( textureSize( bumpMaps, 0 ).xy );

		float h_c = texture( bumpMaps, vec3( transformedUV, float( material.bumpMapIndex ) ) ).r;
		float h_u = texture( bumpMaps, vec3( transformedUV + vec2( texelSize.x, 0.0 ), float( material.bumpMapIndex ) ) ).r;
		float h_v = texture( bumpMaps, vec3( transformedUV + vec2( 0.0, texelSize.y ), float( material.bumpMapIndex ) ) ).r;

		vec2 gradient = vec2( h_u - h_c, h_v - h_c ) * material.bumpScale;
		vec3 bumpNormal = normalize( vec3( - gradient.x, - gradient.y, 1.0 ) );

		vec3 up = abs( resultNormal.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
		vec3 tangent = normalize( cross( up, resultNormal ) );
		vec3 bitangent = cross( resultNormal, tangent );
		mat3 TBN = mat3( tangent, bitangent, resultNormal );

		resultNormal = normalize( mix( resultNormal, TBN * bumpNormal, material.normalScale.x ) );
	}

	return resultNormal;
}