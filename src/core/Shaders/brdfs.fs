BRDFWeights calculateBRDFWeights( RayTracingMaterial material ) {
	BRDFWeights weights;

    // Base calculations
	float baseSpecularWeight = ( 1.0 - material.roughness ) * ( 0.5 + 0.5 * material.metalness );
	weights.specular = baseSpecularWeight * material.specularIntensity;
	weights.diffuse = ( 1.0 - baseSpecularWeight ) * ( 1.0 - material.metalness );
	weights.sheen = material.sheen * max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b );
	weights.clearcoat = material.clearcoat * ( 1.0 - material.clearcoatRoughness ) * 0.5;
	weights.transmission = material.transmission * ( 1.0 - material.roughness ) *
		( 0.5 + 0.5 * material.ior / 2.0 ) * ( 1.0 + material.dispersion * 0.5 ) * 0.7;

    // Normalize weights
	float total = weights.specular + weights.diffuse + weights.sheen + weights.clearcoat + weights.transmission;
	weights.specular /= total;
	weights.diffuse /= total;
	weights.sheen /= total;
	weights.clearcoat /= total;
	weights.transmission /= total;

	return weights;
}

float getMaterialImportance( RayTracingMaterial material ) {
    // Base specular and diffuse weights
	float specularWeight = ( 1.0 - material.roughness ) * ( 0.75 + 0.25 * material.metalness );
	float diffuseWeight = ( 1.0 - material.metalness ) * material.roughness;

    // Specular intensity contribution
	specularWeight *= material.specularIntensity;

    // Clearcoat contribution
	float clearcoatWeight = material.clearcoat * ( 1.0 - material.clearcoatRoughness ) * 0.5;

    // Sheen contribution
	float sheenLuminance = dot( material.sheenColor, vec3( 0.2126, 0.7152, 0.0722 ) );
	float sheenWeight = material.sheen * ( 1.0 - material.sheenRoughness ) * sheenLuminance * 0.5;

    // Iridescence contribution
	float iridescenceThicknessRange = material.iridescenceThicknessRange.y - material.iridescenceThicknessRange.x;
	float iridescenceWeight = material.iridescence *
		( 1.0 - material.roughness ) * // More prominent on smooth surfaces
		( 0.5 + 0.5 * iridescenceThicknessRange / 1000.0 ) * // Scale based on thickness range
		( 0.5 + 0.5 * material.iridescenceIOR / 2.0 ) * // Consider IOR influence
		0.5; // Overall scaling factor for iridescence

    // Transmission/Refraction contribution with improved dispersion consideration
	float transmissionWeight = material.transmission *
		( 1.0 - material.roughness ) * // Smoother surfaces show more transmission effects
		( 0.5 + 0.5 * material.ior / 2.0 ) * // Base IOR influence
		( 1.0 + material.dispersion * 0.5 ) * // Increase importance with dispersion (changed from reduction)
		0.7; // Overall scaling for transmission

    // Emissive contribution
	float emissiveWeight = length( material.emissive ) * material.emissiveIntensity * 0.5;

    // Combine all weights
	float total = specularWeight +
		diffuseWeight +
		clearcoatWeight +
		sheenWeight +
		iridescenceWeight +
		transmissionWeight +
		emissiveWeight;

    // Return normalized importance value, prioritizing the most significant component
	return max( max( max( specularWeight, clearcoatWeight ), max( sheenWeight, iridescenceWeight ) ), max( max( transmissionWeight, emissiveWeight ), diffuseWeight ) ) / total;
}

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

// VNDF sampling helper functions
vec3 sampleGGXVNDF(vec3 V, float roughness, vec2 Xi) {
    float alpha = roughness * roughness;
    
    // Approximate orthonormal basis without cross products
    vec3 N = vec3(0.0, 0.0, 1.0); // Assuming we're in local space already
    vec3 T = (V.z < 0.999) ? normalize(vec3(-V.y, V.x, 0.0)) : vec3(1.0, 0.0, 0.0);
    vec3 B = vec3(-T.y, T.x, 0.0); // Cheaper than cross product

    // Sample point with polar coordinates (r, phi)
    float r = sqrt(Xi.x);
    float phi = 2.0 * PI * Xi.y;
    float t = r * cos(phi);
    float b = r * sin(phi);
    float s = 0.5 * (1.0 + V.z);
    b = mix(sqrt(1.0 - t * t), b, s);

    // Compute normal in local space
    vec3 H = t * T + b * B + sqrt(max(0.0, 1.0 - t * t - b * b)) * N;
    
    // Apply roughness stretching
    H = normalize(vec3(alpha * H.x, alpha * H.y, max(0.0, H.z)));
    
    return H;
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

float SheenDistribution( vec3 N, vec3 H, float roughness ) {
	float alpha = roughness * roughness;
	float invAlpha = 1.0 / alpha;
	float cos_theta = max( dot( N, H ), 0.0 );
	float cos_theta_2 = cos_theta * cos_theta;

	float inv_a2 = invAlpha * invAlpha;
	float d = ( cos_theta_2 * ( inv_a2 - 1.0 ) + 1.0 );
	return inv_a2 / ( PI * d * d );
}

vec3 evalSensitivity( float OPD, vec3 shift ) {
	float phase = 2.0 * PI * OPD * 1.0e-9;
	vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
	vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
	vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );
	vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - square( phase ) * var );
	xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * square( phase ) );
	xyz /= 1.0685e-7;
	return XYZ_TO_REC709 * xyz;
}

vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
	vec3 I;
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
	float R21 = R12;
	float T121 = 1.0 - R12;
	float phi12 = 0.0;
	if( iridescenceIor < outsideIOR )
		phi12 = PI;
	float phi21 = PI - phi12;

    // Second interface
	vec3 baseIOR = fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) ); // guard against 1.0
	vec3 R1 = iorToFresnel0( baseIOR, iridescenceIor );
	vec3 R23 = fresnelSchlick( cosTheta2, R1 );
	vec3 phi23 = vec3( 0.0 );
	if( baseIOR[ 0 ] < iridescenceIor )
		phi23[ 0 ] = PI;
	if( baseIOR[ 1 ] < iridescenceIor )
		phi23[ 1 ] = PI;
	if( baseIOR[ 2 ] < iridescenceIor )
		phi23[ 2 ] = PI;

    // Phase shift
	float OPD = 2.0 * iridescenceIor * thinFilmThickness * cosTheta2;
	vec3 phi = vec3( phi21 ) + phi23;

    // Compound terms
	vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
	vec3 r123 = sqrt( R123 );
	vec3 Rs = square( T121 ) * R23 / ( vec3( 1.0 ) - R123 );

    // Reflectance term for m = 0 (DC term amplitude)
	vec3 C0 = R12 + Rs;
	I = C0;

    // Reflectance term for m > 0 (pairs of diracs)
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
	if (material.roughness > 0.98 && material.metalness < 0.02 && 
		material.transmission == 0.0 && material.clearcoat == 0.0) {
		return material.color.rgb * (1.0 - material.metalness) / PI;
	}

	// Calculate half vector
	vec3 H = normalize( V + L );
	float NoL = max( dot( N, L ), 0.001 );
	float NoV = max( dot( N, V ), 0.001 );
	float NoH = max( dot( N, H ), 0.001 );
	float VoH = max( dot( V, H ), 0.001 );

    // Base F0 calculation with specular parameters
	vec3 baseF0 = vec3( 0.04 );
	vec3 F0 = mix( baseF0 * material.specularColor, material.color.rgb, material.metalness );
	F0 *= material.specularIntensity;

    // Add iridescence effect if enabled
	if( material.iridescence > 0.0 ) {
        // Calculate thickness based on the range
		float thickness = mix( material.iridescenceThicknessRange.x, material.iridescenceThicknessRange.y, 0.5 );

        // Calculate iridescent fresnel
		vec3 iridescenceFresnel = evalIridescence( 1.0, // air IOR
		material.iridescenceIOR, VoH, thickness, F0 );

        // Blend iridescence with base F0
		F0 = mix( F0, iridescenceFresnel, material.iridescence );
	}

    // Specular BRDF
	float D = DistributionGGX( N, H, material.roughness );
	float G = GeometrySmith( N, V, L, material.roughness );
	vec3 F = fresnelSchlick( VoH, F0 );
	vec3 specular = ( D * G * F ) / ( 4.0 * NoV * NoL );

    // Diffuse BRDF
	vec3 diffuse = material.color.rgb * ( 1.0 - material.metalness ) / PI;

    // Base layer without sheen
	vec3 baseLayer = diffuse + specular;

    // Only add sheen if it's enabled
	if( material.sheen > 0.0 ) {
        // Sheen BRDF
		float sheenDistribution = SheenDistribution( N, H, material.sheenRoughness );
		vec3 sheenColor = material.sheenColor * material.sheen;
		vec3 sheen = sheenColor * sheenDistribution * NoL;

        // Energy compensation - only apply scaling when sheen is present
		float sheenScaling = 1.0 - material.sheen * max( max( sheenColor.r, sheenColor.g ), sheenColor.b );
		return baseLayer * sheenScaling + sheen;
	}

	return baseLayer;

}

vec3 cosineWeightedSample( vec3 N, vec2 xi ) {
	vec3 T = normalize( cross( N, N.yzx + vec3( 0.1, 0.2, 0.3 ) ) );
	vec3 B = cross( N, T );

	float r = sqrt( xi.x );
	float phi = 2.0 * PI * xi.y;

	float x = r * cos( phi );
	float y = r * sin( phi );
	float z = sqrt( 1.0 - xi.x );

	return normalize( T * x + B * y + N * z );
}

float cosineWeightedPDF( float NoL ) {
	return max( NoL, 0.001 ) / PI;  // Ensure PDF is never zero
}