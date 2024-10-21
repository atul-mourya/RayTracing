uniform sampler2DArray albedoMaps;
uniform sampler2DArray normalMaps;
uniform sampler2DArray bumpMaps;
uniform sampler2DArray metalnessMaps;
uniform sampler2DArray roughnessMaps;
uniform sampler2DArray emissiveMaps;

vec2 transformUV(vec2 uv, mat3 transform) {
    vec3 transformedUV = transform * vec3(uv, 1.0);
	return fract(transformedUV.xy);
}

vec4 sampleMap( sampler2DArray mapArray, int layer, vec2 uv ) {
	if( layer >= 0 ) {
		return texture( mapArray, vec3( uv, float( layer ) ) );
	}
	return vec4( 1.0 );
}

vec4 sampleAlbedoTexture( RayTracingMaterial material, vec2 uv ) {
	if( material.albedoMapIndex >= 0 ) {
		uv = transformUV(uv, material.albedoTransform);
		vec4 albedo = sampleMap( albedoMaps, material.albedoMapIndex, uv );
		material.color *= vec4( sRGBToLinear( albedo.rgb ), albedo.a );
	}
	return material.color;
}

vec3 sampleEmissiveMap( RayTracingMaterial material, vec2 uv ) {
	vec3 emission = material.emissiveIntensity * material.emissive;
	if( material.emissiveMapIndex >= 0 ) {
		uv = transformUV(uv, material.emissiveTransform);
		emission *= sRGBToLinear( sampleMap( emissiveMaps, material.emissiveMapIndex, uv ).rgb );
	}
	return emission;
}

float sampleMetalnessMap( RayTracingMaterial material, vec2 uv ) {
	if( material.metalnessMapIndex >= 0 ) {
		// uv = transformUV(uv, material.metalnessTransform); // enabling this line causeing the issue
		material.metalness *= sampleMap( metalnessMaps, material.metalnessMapIndex, uv ).b;
	}
	return material.metalness;
}

float sampleRoughnessMap( RayTracingMaterial material, vec2 uv ) {
	if( material.roughnessMapIndex >= 0 ) {
		uv = transformUV(uv, material.roughnessTransform);
		material.roughness *= sampleMap( roughnessMaps, material.roughnessMapIndex, uv ).g;
	}
	return material.roughness;
}

vec3 perturbNormal( vec3 normal, vec3 tangent, vec3 bitangent, vec2 uv, RayTracingMaterial material ) {
	vec3 resultNormal = normal;
	vec2 normalScale = material.normalScale;

	// Sample normal map
	if( material.normalMapIndex >= 0 ) {
		uv = transformUV(uv, material.normalTransform);
		vec3 normalMap = sampleMap( normalMaps, material.normalMapIndex, uv ).xyz * 2.0 - 1.0;
		normalMap.xy *= normalScale;
		mat3 TBN = mat3( tangent, bitangent, normal );
		resultNormal = normalize( TBN * normalMap );
	}

	// Apply bump mapping
	// if( material.bumpMapIndex >= 0 ) {
	// 	float bumpScale = 0.05; // Adjust this value to control the strength of the bump effect
	// 	vec2 texelSize = 1.0 / vec2( textureSize( bumpMaps, 0 ).xy );

	// 	float h0 = sampleMap( bumpMaps, material.bumpMapIndex, uv, material.bumpTransform ).r;
	// 	float h1 = sampleMap( bumpMaps, material.bumpMapIndex, uv + vec2( texelSize.x, 0.0 ), material.bumpTransform ).r;
	// 	float h2 = sampleMap( bumpMaps, material.bumpMapIndex, uv + vec2( 0.0, texelSize.y ), material.bumpTransform ).r;

	// 	vec3 bumpNormal = normalize( vec3( h1 - h0, h2 - h0, bumpScale ) );
	// 	resultNormal = normalize( resultNormal + bumpNormal );
	// }

	return resultNormal;
}
