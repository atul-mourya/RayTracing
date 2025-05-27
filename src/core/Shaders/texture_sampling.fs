// ================================================================================
// OPTIMIZED TEXTURE SAMPLING SYSTEM - Clean Implementation
// Direct replacement for texture_sampling.fs
// ================================================================================

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

UVCache computeUVCache( vec2 baseUV, RayTracingMaterial material ) {
	UVCache cache;
	cache.albedoUV = getTransformedUV( baseUV, material.albedoTransform );
	cache.normalUV = getTransformedUV( baseUV, material.normalTransform );
	cache.metalnessUV = getTransformedUV( baseUV, material.metalnessTransform );
	cache.emissiveUV = getTransformedUV( baseUV, material.emissiveTransform );
	cache.bumpUV = getTransformedUV( baseUV, material.bumpTransform );
	return cache;
}

// ================================================================================
// OPTIMIZED SAMPLING FUNCTIONS
// ================================================================================

vec4 sampleMap( sampler2DArray mapArray, int layer, vec2 uv ) {
	return layer >= 0 ? texture( mapArray, vec3( uv, float( layer ) ) ) : vec4( 1.0 );
}

vec4 sampleAlbedo( sampler2DArray albedoArray, int layer, vec2 uv, vec4 materialColor ) {
	if( layer < 0 )
		return materialColor;

	vec4 texSample = texture( albedoArray, vec3( uv, float( layer ) ) );
	vec3 linear = texSample.rgb * texSample.rgb * sqrt( texSample.rgb ); // Fast sRGB approximation
	return vec4( materialColor.rgb * linear, materialColor.a * texSample.a );
}

vec2 sampleMetalnessRoughness( sampler2DArray morArray, int layer, vec2 uv, float baseMetal, float baseRough ) {
	if( layer < 0 )
		return vec2( baseMetal, baseRough );

	vec4 morSample = texture( morArray, vec3( uv, float( layer ) ) );
	return vec2( baseMetal * morSample.b, baseRough * morSample.g ); // MOR format: B=Metal, G=Rough
}

vec3 sampleNormal( sampler2DArray normalArray, int layer, vec2 uv, vec3 geometryNormal, vec2 normalScale ) {
	if( layer < 0 )
		return geometryNormal;

	vec3 normalSample = texture( normalArray, vec3( uv, float( layer ) ) ).xyz;
	vec3 normalMap = normalSample * 2.0 - 1.0;
	normalMap.xy *= normalScale;

    // Fast TBN construction
	vec3 up = abs( geometryNormal.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 tangent = normalize( cross( up, geometryNormal ) );
	vec3 bitangent = cross( geometryNormal, tangent );

	return normalize( tangent * normalMap.x + bitangent * normalMap.y + geometryNormal * normalMap.z );
}

vec3 sampleBump( sampler2DArray bumpArray, int layer, vec2 uv, vec3 currentNormal, float bumpScale, vec2 normalScale ) {
	if( layer < 0 )
		return currentNormal;

	vec2 texelSize = 1.0 / vec2( textureSize( bumpArray, 0 ).xy );

	float h_c = texture( bumpArray, vec3( uv, float( layer ) ) ).r;
	float h_u = texture( bumpArray, vec3( uv + vec2( texelSize.x, 0.0 ), float( layer ) ) ).r;
	float h_v = texture( bumpArray, vec3( uv + vec2( 0.0, texelSize.y ), float( layer ) ) ).r;

	vec2 gradient = vec2( h_u - h_c, h_v - h_c ) * bumpScale;
	vec3 bumpNormal = normalize( vec3( - gradient.x, - gradient.y, 1.0 ) );

	vec3 up = abs( currentNormal.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 tangent = normalize( cross( up, currentNormal ) );
	vec3 bitangent = cross( currentNormal, tangent );
	mat3 TBN = mat3( tangent, bitangent, currentNormal );

	return normalize( mix( currentNormal, TBN * bumpNormal, normalScale.x ) );
}

vec3 sampleEmissive(
	sampler2DArray emissiveArray,
	int emissiveLayer,
	sampler2DArray albedoArray,
	int albedoLayer,
	vec2 emissiveUV,
	vec2 albedoUV,
	vec3 baseEmissive,
	float intensity,
	vec4 albedoColor
) {
	vec3 emissionBase = baseEmissive * intensity;

	if( emissiveLayer >= 0 ) {
		vec4 emissiveSample = texture( emissiveArray, vec3( emissiveUV, float( emissiveLayer ) ) );
		vec3 emissiveLinear = emissiveSample.rgb * emissiveSample.rgb * sqrt( emissiveSample.rgb );
		return emissionBase * emissiveLinear;
	} else if( albedoLayer >= 0 ) {
		return emissionBase * albedoColor.rgb;
	} else {
		return emissionBase;
	}
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

    // Compute all UV transformations once
	UVCache uvCache = computeUVCache( uv, material );

    // Sample albedo
	samples.albedo = sampleAlbedo( albedoMaps, material.albedoMapIndex, uvCache.albedoUV, material.color );

    // Sample metalness and roughness
	vec2 metalRough = sampleMetalnessRoughness( metalnessMaps, material.metalnessMapIndex, uvCache.metalnessUV, material.metalness, material.roughness );
	samples.metalness = metalRough.x;
	samples.roughness = metalRough.y;

    // Sample normal map
	vec3 currentNormal = sampleNormal( normalMaps, material.normalMapIndex, uvCache.normalUV, geometryNormal, material.normalScale );

    // Apply bump mapping on top
	samples.normal = sampleBump( bumpMaps, material.bumpMapIndex, uvCache.bumpUV, currentNormal, material.bumpScale, material.normalScale );

    // Sample emissive
	samples.emissive = sampleEmissive( emissiveMaps, material.emissiveMapIndex, albedoMaps, material.albedoMapIndex, uvCache.emissiveUV, uvCache.albedoUV, material.emissive, material.emissiveIntensity, samples.albedo );

	return samples;
}

// ================================================================================
// INDIVIDUAL SAMPLING FUNCTIONS (for compatibility with existing calls)
// ================================================================================

vec4 sampleAlbedoTexture( RayTracingMaterial material, vec2 uv ) {
	if( material.albedoMapIndex < 0 )
		return material.color;
	vec2 transformedUV = getTransformedUV( uv, material.albedoTransform );
	return sampleAlbedo( albedoMaps, material.albedoMapIndex, transformedUV, material.color );
}

vec3 sampleEmissiveMap( RayTracingMaterial material, vec2 uv ) {
	vec2 emissiveUV = getTransformedUV( uv, material.emissiveTransform );
	vec2 albedoUV = getTransformedUV( uv, material.albedoTransform );
	return sampleEmissive( emissiveMaps, material.emissiveMapIndex, albedoMaps, material.albedoMapIndex, emissiveUV, albedoUV, material.emissive, material.emissiveIntensity, material.color );
}

float sampleMetalnessMap( RayTracingMaterial material, vec2 uv ) {
	if( material.metalnessMapIndex < 0 )
		return material.metalness;
	vec2 transformedUV = getTransformedUV( uv, material.metalnessTransform );
	return sampleMetalnessRoughness( metalnessMaps, material.metalnessMapIndex, transformedUV, material.metalness, material.roughness ).x;
}

float sampleRoughnessMap( RayTracingMaterial material, vec2 uv ) {
	if( material.metalnessMapIndex < 0 )
		return material.roughness;
	vec2 transformedUV = getTransformedUV( uv, material.roughnessTransform );
	return sampleMetalnessRoughness( roughnessMaps, material.metalnessMapIndex, transformedUV, material.metalness, material.roughness ).y;
}

vec3 sampleNormalMap( RayTracingMaterial material, vec2 uv, vec3 normal ) {
	vec3 resultNormal = normal;

	if( material.normalMapIndex >= 0 ) {
		vec2 transformedUV = getTransformedUV( uv, material.normalTransform );
		resultNormal = sampleNormal( normalMaps, material.normalMapIndex, transformedUV, normal, material.normalScale );
	}

	if( material.bumpMapIndex >= 0 ) {
		vec2 transformedUV = getTransformedUV( uv, material.bumpTransform );
		resultNormal = sampleBump( bumpMaps, material.bumpMapIndex, transformedUV, resultNormal, material.bumpScale, material.normalScale );
	}

	return resultNormal;
}