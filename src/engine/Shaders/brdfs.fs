vec3 ImportanceSampleGGX( vec3 N, float roughness, vec2 Xi ) {

	float alpha = roughness * roughness;
	float alpha2 = alpha * alpha;

	float phi = 2.0 * PI * Xi.x;
	float cosTheta = sqrt( ( 1.0 - Xi.y ) / ( 1.0 + ( alpha2 - 1.0 ) * Xi.y ) );
	float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );

	// from spherical coordinates to cartesian coordinates
	vec3 H;
	H.x = cos( phi ) * sinTheta;
	H.y = sin( phi ) * sinTheta;
	H.z = cosTheta;

	// from tangent-space vector to world-space sample vector
	vec3 up = abs( N.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 tangent = normalize( cross( up, N ) );
	vec3 bitangent = cross( N, tangent );

	vec3 sampleVec = tangent * H.x + bitangent * H.y + N * H.z;
	return normalize( sampleVec );
}

vec3 ImportanceSampleCosine( vec3 N, vec2 xi ) {
	// Create a local coordinate system where N is the Z axis
	vec3 T = normalize( cross( N, N.yzx + vec3( 0.1, 0.2, 0.3 ) ) );
	vec3 B = cross( N, T );

	// Cosine-weighted sampling
	float phi = 2.0 * PI * xi.x;
	float cosTheta = sqrt( 1.0 - xi.y );
	float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );

	// Convert from polar to Cartesian coordinates
	vec3 localDir = vec3( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );

	// Transform the sampled direction to world space
	return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
}

float DistributionGGX( vec3 N, vec3 H, float roughness ) {

	float alpha = roughness * roughness;
	float alpha2 = alpha * alpha;

	float NdotH = max( dot( N, H ), 0.0 );
	float NdotH2 = NdotH * NdotH;

	float nom = alpha2;
	float denom = ( NdotH2 * ( alpha2 - 1.0 ) + 1.0 );
	denom = PI * denom * denom;

	return nom / denom;
}

float GeometrySchlickGGX( float NdotV, float roughness ) {
	float r = ( roughness + 1.0 );
	float k = ( r * r ) / 8.0;

	float nom = NdotV;
	float denom = NdotV * ( 1.0 - k ) + k;

	return nom / denom;
}

float GeometrySmith( vec3 N, vec3 V, vec3 L, float roughness ) {
	float NdotV = max( dot( N, V ), 0.0 );
	float NdotL = max( dot( N, L ), 0.0 );
	float ggx2 = GeometrySchlickGGX( NdotV, roughness );
	float ggx1 = GeometrySchlickGGX( NdotL, roughness );

	return ggx1 * ggx2;
}

vec3 evaluateBRDF( vec3 V, vec3 L, vec3 N, RayTracingMaterial material ) {
	vec3 H = normalize( V + L );
	float NoL = max( dot( N, L ), 0.001 );
	float NoV = max( dot( N, V ), 0.001 );
	float NoH = max( dot( N, H ), 0.001 );
	float VoH = max( dot( V, H ), 0.001 );

	vec3 F0 = mix( vec3( 0.04 ), material.color.rgb, material.metalness );

	// Specular BRDF
	float D = DistributionGGX( N, H, material.roughness );
	float G = GeometrySmith( N, V, L, material.roughness );
	vec3 F = fresnelSchlick3( VoH, F0 );
	vec3 specular = ( D * G * F ) / ( 4.0 * NoV * NoL );

	// Diffuse BRDF
	vec3 diffuse = material.color.rgb * ( 1.0 - material.metalness ) / PI;

	return diffuse + specular;
}

// calculate pixel variance
float calculateVariance( vec4 mean, vec4 squaredMean, int n ) {
	if( n < 2 )
		return 0.0;
	vec4 variance = squaredMean - mean * mean;
	return ( variance.r + variance.g + variance.b ) / 3.0;
}

vec3 cosineWeightedSample(vec3 N, vec2 xi) {
    vec3 T = normalize(cross(N, N.yzx + vec3(0.1, 0.2, 0.3)));
    vec3 B = cross(N, T);
    
    float r = sqrt(xi.x);
    float phi = 2.0 * PI * xi.y;
    
    float x = r * cos(phi);
    float y = r * sin(phi);
    float z = sqrt(1.0 - xi.x);
    
    return normalize(T * x + B * y + N * z);
}

float cosineWeightedPDF(float NoL) {
    return max(NoL, 0.001) / PI;  // Ensure PDF is never zero
}