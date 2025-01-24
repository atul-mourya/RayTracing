BRDFWeights calculateBRDFWeights( RayTracingMaterial material ) {
	BRDFWeights weights;

    // Precalculate shared values
	float invRoughness = 1.0 - material.roughness;
	float metalFactor = 0.5 + 0.5 * material.metalness;

    // Consolidated weight calculations
	float baseSpecularWeight = invRoughness * metalFactor;
	weights.specular = baseSpecularWeight * material.specularIntensity;
	weights.diffuse = ( 1.0 - baseSpecularWeight ) * ( 1.0 - material.metalness );

	float maxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) );
	weights.sheen = material.sheen * maxSheenColor;
	weights.clearcoat = material.clearcoat * invRoughness * 0.35; // Combined scaling factors

    // transmission calculation
	float transmissionBase = invRoughness * 0.7; // Combined scaling
	weights.transmission = material.transmission * transmissionBase *
		( 0.5 + 0.5 * material.ior / 2.0 ) *
		( 1.0 + material.dispersion * 0.5 );

    // iridescence calculation
	float iridescenceBase = invRoughness * 0.5;
	weights.iridescence = material.iridescence * iridescenceBase *
		( 0.5 + 0.5 * ( material.iridescenceThicknessRange.y - material.iridescenceThicknessRange.x ) / 1000.0 ) *
		( 0.5 + 0.5 * material.iridescenceIOR / 2.0 );

    // Single normalization pass
	float total = weights.specular + weights.diffuse + weights.sheen +
		weights.clearcoat + weights.transmission + weights.iridescence;
	float invTotal = 1.0 / max( total, 0.001 );

    // Vectorized multiplication
	weights.specular *= invTotal;
	weights.diffuse *= invTotal;
	weights.sheen *= invTotal;
	weights.clearcoat *= invTotal;
	weights.transmission *= invTotal;
	weights.iridescence *= invTotal;

	return weights;
}

float getMaterialImportance( RayTracingMaterial material ) {
    // Early out for specialized materials
	if( material.transmission > 0.0 || material.clearcoat > 0.0 ) {
		return 0.95;
	}
	BRDFWeights weights = calculateBRDFWeights( material );

    // For importance sampling, we care about the most significant component
	return max( max( max( weights.specular, weights.diffuse ), weights.sheen ), max( weights.clearcoat, weights.transmission ) );
}

vec3 ImportanceSampleGGX( vec3 N, float roughness, vec2 Xi ) {
	float alpha = roughness * roughness;
	float phi = 2.0 * PI * Xi.x;
	float cosTheta = sqrt( ( 1.0 - Xi.y ) / ( 1.0 + ( alpha * alpha - 1.0 ) * Xi.y ) );
	float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );

    // Spherical to cartesian conversion
	vec3 H = vec3( cos( phi ) * sinTheta, sin( phi ) * sinTheta, cosTheta );

    // TBN construction
	vec3 up = abs( N.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 tangent = normalize( cross( up, N ) );
	vec3 bitangent = cross( N, tangent );

	return normalize( tangent * H.x + bitangent * H.y + N * H.z );
}

vec3 ImportanceSampleCosine( vec3 N, vec2 xi ) {
	vec3 T = normalize( cross( N, N.yzx + vec3( 0.1, 0.2, 0.3 ) ) );
	vec3 B = cross( N, T );

	// Cosine-weighted sampling
	float phi = 2.0 * PI * xi.x;
	float cosTheta = sqrt( 1.0 - xi.y );
	float sinTheta = sqrt( xi.y );

	// Convert from polar to Cartesian coordinates
	vec3 localDir = vec3( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );

	// Transform the sampled direction to world space
	return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
}

// VNDF sampling helper functions
vec3 sampleGGXVNDF( vec3 V, float roughness, vec2 Xi ) {
	float alpha = roughness * roughness;
    // Transform view direction to local space
	vec3 Vh = normalize( vec3( alpha * V.x, alpha * V.y, V.z ) );

    // Construct orthonormal basis around view direction
	float lensq = Vh.x * Vh.x + Vh.y * Vh.y;
	vec3 T1 = lensq > 0.0 ? vec3( - Vh.y, Vh.x, 0.0 ) / sqrt( lensq ) : vec3( 1.0, 0.0, 0.0 );
	vec3 T2 = cross( Vh, T1 );

    // Sample point with polar coordinates (r, phi)
	float r = sqrt( Xi.x );
	float phi = 2.0 * PI * Xi.y;
	float t1 = r * cos( phi );
	float t2 = r * sin( phi );
	float s = 0.5 * ( 1.0 + Vh.z );
	t2 = ( 1.0 - s ) * sqrt( 1.0 - t1 * t1 ) + s * t2;

    // Compute normal
	vec3 Nh = t1 * T1 + t2 * T2 + sqrt( max( 0.0, 1.0 - t1 * t1 - t2 * t2 ) ) * Vh;

    // Transform the normal back to the ellipsoid configuration
	vec3 Ne = normalize( vec3( alpha * Nh.x, alpha * Nh.y, max( 0.0, Nh.z ) ) );
	return Ne;
}

float DistributionGGX( float NoH, float roughness ) {
	float alpha = roughness * roughness;
	float alpha2 = alpha * alpha;
	float denom = ( NoH * NoH * ( alpha2 - 1.0 ) + 1.0 );
	return alpha2 / ( PI * denom * denom );
}

float GeometrySchlickGGX( float NdotV, float roughness ) {
	float r = roughness + 1.0;
	float k = ( r * r ) / 8.0;
	return NdotV / ( NdotV * ( 1.0 - k ) + k );
}

float GeometrySmith( float NoV, float NoL, float roughness ) {
	float ggx2 = GeometrySchlickGGX( NoV, roughness );
	float ggx1 = GeometrySchlickGGX( NoL, roughness );
	return ggx1 * ggx2;
}

float SheenDistribution( float NoH, float roughness ) {
	float alpha = roughness * roughness;
	float invAlpha = 1.0 / alpha;
	float d = ( NoH * NoH * ( invAlpha * invAlpha - 1.0 ) + 1.0 );
	return invAlpha * invAlpha / ( PI * d * d );
}

vec3 evalSensitivity( float OPD, vec3 shift ) {
	float phase = 2.0 * PI * OPD * 1.0e-9;
	vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
	vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
	vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );

	vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) *
		exp( - square( phase ) * var );
	xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) *
		cos( 2.2399e+06 * phase + shift[ 0 ] ) *
		exp( - 4.5282e+09 * square( phase ) );
	return XYZ_TO_REC709 * ( xyz / 1.0685e-7 );
}

vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
    // Force iridescenceIor -> outsideIOR when thinFilmThickness -> 0.0
	float iridescenceIor = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );

    // Evaluate the cosTheta on the base layer (Snell law)
	float sinTheta2Sq = square( outsideIOR / iridescenceIor ) * ( 1.0 - square( cosTheta1 ) );

    // Handle TIR:
	float cosTheta2Sq = 1.0 - sinTheta2Sq;
	if( cosTheta2Sq < 0.0 ) {
		return vec3( 1.0 );
	}

	float cosTheta2 = sqrt( cosTheta2Sq );

    // First interface
	float R0 = iorToFresnel0( iridescenceIor, outsideIOR );
	float R12 = fresnelSchlick( cosTheta1, R0 );
	float T121 = 1.0 - R12;
	float phi12 = iridescenceIor < outsideIOR ? PI : 0.0;
	float phi21 = PI - phi12;

    // Second interface
	vec3 baseIOR = fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) ); // guard against 1.0
	vec3 R1 = iorToFresnel0( baseIOR, iridescenceIor );
	vec3 R23 = fresnelSchlick( cosTheta2, R1 );
	vec3 phi23 = vec3( 0.0 );
	phi23 = mix( phi23, vec3( PI ), lessThan( baseIOR, vec3( iridescenceIor ) ) );

	float OPD = 2.0 * iridescenceIor * thinFilmThickness * cosTheta2;
	vec3 phi = vec3( phi21 ) + phi23;

    // Compound terms
	vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
	vec3 r123 = sqrt( R123 );
	vec3 Rs = square( T121 ) * R23 / ( vec3( 1.0 ) - R123 );

    // Reflectance term for m = 0 (DC term amplitude)
	vec3 C0 = R12 + Rs;
	vec3 I = C0;
	vec3 Cm = Rs - T121;

	for( int m = 1; m <= 2; ++ m ) {
		Cm *= r123;
		vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
		I += Cm * Sm;
	}

	return max( I, vec3( 0.0 ) );
}

vec3 evaluateBRDF( vec3 V, vec3 L, vec3 N, RayTracingMaterial material ) {

	// Early exit for purely diffuse materials
	if( material.roughness > 0.98 && material.metalness < 0.02 &&
		material.transmission == 0.0 && material.clearcoat == 0.0 ) {
		return material.color.rgb * ( 1.0 - material.metalness ) * PI_INV;
	}

    // Calculate all dot products once
	DotProducts dots = computeDotProducts( N, V, L );
	vec3 H = normalize( V + L );

    // Calculate base F0 with specular parameters
	vec3 F0 = mix( vec3( 0.04 ) * material.specularColor, material.color.rgb, material.metalness ) * material.specularIntensity;

    // Add iridescence effect if enabled
	if( material.iridescence > 0.0 ) {
        // Calculate thickness based on the range
		float thickness = mix( material.iridescenceThicknessRange.x, material.iridescenceThicknessRange.y, 0.5 );
		vec3 iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, dots.VoH, thickness, F0 );
		F0 = mix( F0, iridescenceFresnel, material.iridescence );
	}

    // Precalculate shared terms
	float D = DistributionGGX( dots.NoH, material.roughness );
	float G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
	vec3 F = fresnelSchlick( dots.VoH, F0 );

    // Combined specular calculation
	vec3 specular = ( D * G * F ) / ( 4.0 * dots.NoV * dots.NoL );
	vec3 diffuse = material.color.rgb * ( 1.0 - material.metalness ) * PI_INV;
	vec3 baseLayer = diffuse + specular;

    // Optimize sheen calculation
	if( material.sheen > 0.0 ) {
		float sheenDist = SheenDistribution( dots.NoH, material.sheenRoughness );
		vec3 sheenTerm = material.sheenColor * material.sheen * sheenDist * dots.NoL;
		float maxSheen = max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b );
		float sheenScaling = 1.0 - material.sheen * maxSheen;
		return baseLayer * sheenScaling + sheenTerm;
	}

	return baseLayer;
}

vec3 cosineWeightedSample( vec3 N, vec2 xi ) {
	vec3 T = normalize( cross( N, N.yzx + vec3( 0.1, 0.2, 0.3 ) ) );
	vec3 B = cross( N, T );

	vec2 r = vec2( sqrt( xi.x ) * cos( 2.0 * PI * xi.y ), sqrt( xi.x ) * sin( 2.0 * PI * xi.y ) );
	float z = sqrt( 1.0 - xi.x );

	return normalize( T * r.x + B * r.y + N * z );
}

float cosineWeightedPDF( float NoL ) {
	return max( NoL, 0.001 ) * PI_INV;
}