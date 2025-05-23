uniform sampler2DArray albedoMaps;
uniform sampler2DArray normalMaps;
uniform sampler2DArray bumpMaps;
uniform sampler2DArray metalnessMaps;
uniform sampler2DArray roughnessMaps;
uniform sampler2DArray emissiveMaps;

// Pre-compute UV transformation once and reuse
vec2 getTransformedUV( vec2 uv, mat3 transform ) {
    // Skip transformation if it's identity matrix
	if( transform[ 0 ][ 0 ] == 1.0 && transform[ 1 ][ 1 ] == 1.0 &&
		transform[ 0 ][ 1 ] == 0.0 && transform[ 1 ][ 0 ] == 0.0 &&
		transform[ 2 ][ 0 ] == 0.0 && transform[ 2 ][ 1 ] == 0.0 ) {
		return uv;
	}
	vec3 transformedUV = transform * vec3( uv, 1.0 );
	return fract( transformedUV.xy );
}

// sampling with early exit
vec4 sampleMap( sampler2DArray mapArray, int layer, vec2 uv ) {
	return layer >= 0 ? texture( mapArray, vec3( uv, float( layer ) ) ) : vec4( 1.0 );
}

vec4 sampleAlbedoTexture( RayTracingMaterial material, vec2 uv ) {
	if( material.albedoMapIndex < 0 )
		return material.color;

	vec2 transformedUV = getTransformedUV( uv, material.albedoTransform );
	vec4 albedo = sampleMap( albedoMaps, material.albedoMapIndex, transformedUV );
	return material.color * sRGBTransferEOTF( albedo );
}

vec3 sampleEmissiveMap( RayTracingMaterial material, vec2 uv ) {
	vec3 emission = material.emissiveIntensity * material.emissive;

	// Check if emissive map is available
	if( material.emissiveMapIndex >= 0 ) {
		vec2 transformedUV = getTransformedUV( uv, material.emissiveTransform );
		return emission * sRGBTransferEOTF( sampleMap( emissiveMaps, material.emissiveMapIndex, transformedUV ) ).rgb;
	}
	// If no emissive map but albedo map is available, use albedo as emissive
	else if( material.albedoMapIndex >= 0 ) {
		vec2 transformedUV = getTransformedUV( uv, material.albedoTransform );
		vec4 albedo = sampleMap( albedoMaps, material.albedoMapIndex, transformedUV );
		return emission * sRGBTransferEOTF( albedo ).rgb;
	}
	// Otherwise return just the emission value
	return emission;
}

float sampleMetalnessMap( RayTracingMaterial material, vec2 uv ) {
	if( material.metalnessMapIndex < 0 )
		return material.metalness;

	vec2 transformedUV = getTransformedUV( uv, material.metalnessTransform );
	return material.metalness * sampleMap( metalnessMaps, material.metalnessMapIndex, transformedUV ).b;
}

float sampleRoughnessMap( RayTracingMaterial material, vec2 uv ) {
	if( material.metalnessMapIndex < 0 ) // roughness map is stored in the metalness map texture in its green channel
		return material.roughness;

	vec2 transformedUV = getTransformedUV( uv, material.roughnessTransform );
	return material.roughness * sampleMap( roughnessMaps, material.metalnessMapIndex, transformedUV ).g;
}

vec3 sampleNormalMap( RayTracingMaterial material, vec2 uv, vec3 normal ) {
	vec3 resultNormal = normal;

	// Apply normal mapping if available
	if( material.normalMapIndex >= 0 ) {
		vec2 transformedUV = getTransformedUV( uv, material.normalTransform );
		vec3 normalMap = sampleMap( normalMaps, material.normalMapIndex, transformedUV ).xyz * 2.0 - 1.0;
		normalMap.xy *= material.normalScale;

		mat3 TBN = constructTBN( normal );
		resultNormal = normalize( TBN * normalMap );
	}

	// Apply bump mapping if available
	if( material.bumpMapIndex >= 0 ) {
		vec2 texelSize = 1.0 / vec2( textureSize( bumpMaps, 0 ).xy );
		vec2 transformedUV = getTransformedUV( uv, material.bumpTransform );

		// Sample height at current position and neighboring texels
		float h0 = sampleMap( bumpMaps, material.bumpMapIndex, transformedUV ).r;
		float h1 = sampleMap( bumpMaps, material.bumpMapIndex, transformedUV + vec2( texelSize.x, 0.0 ) ).r;
		float h2 = sampleMap( bumpMaps, material.bumpMapIndex, transformedUV + vec2( 0.0, texelSize.y ) ).r;

		// Calculate a simple normal from the height difference
		vec3 bumpNormal = normalize( vec3( h0 - h1, h0 - h2, material.bumpScale ) );
		
		// Create TBN matrix for the current normal
		mat3 TBN = constructTBN( resultNormal );
		
		// Transform bump normal to world space and blend with existing normal
		bumpNormal = TBN * bumpNormal;
		resultNormal = normalize( mix(resultNormal, bumpNormal, material.normalScale.x) );
	}

	return resultNormal;
}