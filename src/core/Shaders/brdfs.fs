// Pre-computed material classification for faster branching
MaterialClassification classifyMaterial( RayTracingMaterial material ) {
	MaterialClassification mc;

	mc.isMetallic = material.metalness > 0.7;
	mc.isRough = material.roughness > 0.8;
	mc.isSmooth = material.roughness < 0.3;
	mc.isTransmissive = material.transmission > 0.5;
	mc.hasClearcoat = material.clearcoat > 0.5;
	mc.isEmissive = dot( material.emissive, vec3( 1.0 ) ) > 0.0;

    // Calculate complexity score for importance sampling
	mc.complexityScore = 0.2 * float( mc.isMetallic ) +
		0.3 * float( mc.isSmooth ) +
		0.4 * float( mc.isTransmissive ) +
		0.3 * float( mc.hasClearcoat ) +
		0.2 * float( mc.isEmissive );

	return mc;
}

BRDFWeights calculateBRDFWeights( RayTracingMaterial material ) {
	BRDFWeights weights;

    // Precalculate shared values
	float invRoughness = 1.0 - material.roughness;
	float metalFactor = 0.5 + 0.5 * material.metalness;

    // Ensure minimum specular contribution for metals regardless of roughness
	float baseSpecularWeight = max( invRoughness * metalFactor, material.metalness * 0.1 );
	weights.specular = baseSpecularWeight * material.specularIntensity;
	weights.diffuse = ( 1.0 - baseSpecularWeight ) * ( 1.0 - material.metalness );

	float maxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) );
	weights.sheen = material.sheen * maxSheenColor;
	weights.clearcoat = material.clearcoat * invRoughness * 0.35; // Combined scaling factors

    // transmission calculation
	float iorFactor = min( 2.0 / material.ior, 1.0 ); // Higher IOR = more likely to have TIR
	float transmissionBase = iorFactor * invRoughness * 0.7; // Combined scaling

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

    // Use classification for faster computation
	MaterialClassification mc = classifyMaterial( material );

    // Base importance from complexity score
	float baseImportance = mc.complexityScore;

    // Consider emissive properties
	float emissiveImportance = 0.0;
	if( mc.isEmissive ) {
		float emissiveLuminance = dot( material.emissive, vec3( 0.2126, 0.7152, 0.0722 ) );
		emissiveImportance = min( 0.5, emissiveLuminance * material.emissiveIntensity * 0.2 );
	}

    // Material-specific boosts
	float materialBoost = 0.0;
	if( mc.isMetallic || mc.isTransmissive ) {
		materialBoost = 0.2;
	}

    // Combine both factors
	return max( baseImportance + materialBoost, emissiveImportance );
}

ImportanceSamplingInfo getImportanceSamplingInfo( RayTracingMaterial material, int bounceIndex ) {
	ImportanceSamplingInfo info;

    // Base BRDF weights
	BRDFWeights weights = calculateBRDFWeights( material );

    // Classify material once
	MaterialClassification mc = classifyMaterial( material );

    // Base importances on BRDF weights
	info.diffuseImportance = weights.diffuse;
	info.specularImportance = weights.specular;
	info.transmissionImportance = weights.transmission;
	info.clearcoatImportance = weights.clearcoat;

    // Vectorized environment importance calculation
	float baseEnvStrength = backgroundIntensity * environmentIntensity * 0.05;

    // Material-based environment factor (vectorized calculations)
	float envMaterialFactor = 1.0;
	envMaterialFactor *= mix( 1.0, 2.5, float( mc.isMetallic ) );           // Metals reflect environment strongly
	envMaterialFactor *= mix( 1.0, 1.8, float( mc.isRough ) );              // Rough materials sample diffusely  
	envMaterialFactor *= mix( 1.0, 0.4, float( mc.isTransmissive ) );       // Transmissive materials interact less
	envMaterialFactor *= mix( 1.0, 1.6, float( mc.hasClearcoat ) );         // Clearcoat adds reflection

    // Bounce-based environment importance (optimized for useEnvMapIS = true)
	float bounceFactor = 1.0;
	if( bounceIndex > maxEnvSamplingBounce ) {
		bounceFactor = 0.1;
	} else if( bounceIndex > 2 ) {
		bounceFactor = 1.0 / ( 1.0 + float( bounceIndex - 2 ) * 0.5 );
	}

    // Enhanced factor for importance sampling
	if( useEnvMapIS && bounceIndex <= 2 ) {
		bounceFactor *= 1.4; // Boost for early bounces when IS is available
	}

	info.envmapImportance = baseEnvStrength * envMaterialFactor * bounceFactor;

    // Material-specific adjustments using classification
	if( bounceIndex > 2 ) {
		float depthFactor = 1.0 / float( bounceIndex - 1 );

        // Vectorized depth adjustments
		info.specularImportance *= ( 0.7 + depthFactor * 0.3 );
		info.clearcoatImportance *= ( 0.6 + depthFactor * 0.4 );
		info.diffuseImportance *= ( 1.2 + depthFactor * 0.3 );
	}

    // Fast material-specific boosts using pre-computed classification
	if( mc.isMetallic && bounceIndex < 3 ) {
		info.specularImportance = max( info.specularImportance, 0.6 );
		info.envmapImportance = max( info.envmapImportance, 0.3 );
		info.diffuseImportance *= 0.4;
	}

	if( mc.isTransmissive ) {
		info.transmissionImportance = max( info.transmissionImportance, 0.8 );
		info.diffuseImportance *= 0.2;
		info.specularImportance *= 0.6;
		info.envmapImportance *= 0.7;
	}

	if( mc.hasClearcoat ) {
		info.clearcoatImportance = max( info.clearcoatImportance, 0.4 );
		info.envmapImportance = max( info.envmapImportance, 0.2 );
	}

    // Normalize to sum to 1.0
	float sum = info.diffuseImportance + info.specularImportance +
		info.transmissionImportance + info.clearcoatImportance +
		info.envmapImportance;

	if( sum > 0.001 ) {
		float invSum = 1.0 / sum;
		info.diffuseImportance *= invSum;
		info.specularImportance *= invSum;
		info.transmissionImportance *= invSum;
		info.clearcoatImportance *= invSum;
		info.envmapImportance *= invSum;
	} else {
        // Fallback - prefer environment sampling when IS is available
		if( useEnvMapIS && enableEnvironmentLight ) {
			info.diffuseImportance = 0.4;
			info.envmapImportance = 0.6;
		} else {
			info.diffuseImportance = 0.6;
			info.envmapImportance = 0.4;
		}
		info.specularImportance = 0.0;
		info.transmissionImportance = 0.0;
		info.clearcoatImportance = 0.0;
	}

	return info;
}

vec3 ImportanceSampleGGX( vec3 N, float roughness, vec2 Xi ) {
	float alpha = roughness * roughness;
	float phi = TWO_PI * Xi.x;
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
	float phi = TWO_PI * xi.x;
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
	float phi = TWO_PI * Xi.y;
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
	float phase = TWO_PI * OPD * 1.0e-9;
	vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
	vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
	vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );

	vec3 xyz = val * sqrt( TWO_PI * var ) * cos( pos * phase + shift ) *
		exp( - square( phase ) * var );
	xyz.x += 9.7470e-14 * sqrt( TWO_PI * 4.5282e+09 ) *
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

vec3 evaluateMaterialResponse( vec3 V, vec3 L, vec3 N, RayTracingMaterial material ) {

	// Early exit for purely diffuse materials
	if( material.roughness > 0.98 && material.metalness < 0.02 &&
		material.transmission == 0.0 && material.clearcoat == 0.0 ) {
		return material.color.rgb * ( 1.0 - material.metalness ) * PI_INV;
	}

    // Calculate all dot products once
	DotProducts dots = computeDotProducts( N, V, L );

    // Surface BRDF evaluation only
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
	vec3 kD = ( vec3( 1.0 ) - F ) * ( 1.0 - material.metalness );
	vec3 diffuse = kD * material.color.rgb * PI_INV;

	vec3 baseLayer = diffuse + specular;

    // Optimize sheen calculation
	if( material.sheen > 0.0 ) {
		float sheenDist = SheenDistribution( dots.NoH, material.sheenRoughness );
		vec3 sheenTerm = material.sheenColor * material.sheen * sheenDist * dots.NoL;

        // Physically-based sheen attenuation
		float maxSheen = max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b );
		float sheenReflectance = material.sheen * maxSheen * sheenDist;
		float sheenAttenuation = 1.0 - clamp( sheenReflectance, 0.0, 1.0 );

		return baseLayer * sheenAttenuation + sheenTerm;
	}

	return baseLayer;
}

MaterialCache createMaterialCache( vec3 N, vec3 V, RayTracingMaterial material, MaterialSamples samples ) {
	MaterialCache cache;

	cache.NoV = max( dot( N, V ), 0.001 );

    // Use material classification for faster checks
	MaterialClassification mc = classifyMaterial( material );
	cache.isPurelyDiffuse = mc.isRough && ! mc.isMetallic &&
		material.transmission == 0.0 && material.clearcoat == 0.0;
	cache.isMetallic = mc.isMetallic;
	cache.hasSpecialFeatures = mc.isTransmissive || mc.hasClearcoat ||
		material.sheen > 0.0 || material.iridescence > 0.0;

    // Pre-compute frequently used values
	cache.alpha = samples.roughness * samples.roughness;
	cache.alpha2 = cache.alpha * cache.alpha;
	float r = samples.roughness + 1.0;
	cache.k = ( r * r ) / 8.0;

    // Pre-compute F0 and colors
	vec3 dielectricF0 = vec3( 0.04 ) * material.specularColor;
	cache.F0 = mix( dielectricF0, samples.albedo.rgb, samples.metalness ) * material.specularIntensity;
	cache.diffuseColor = samples.albedo.rgb * ( 1.0 - samples.metalness );
	cache.specularColor = samples.albedo.rgb;
	cache.texSamples = samples;

	return cache;
}

MaterialCache createMaterialCacheLegacy( vec3 N, vec3 V, RayTracingMaterial material ) {
	MaterialCache cache;

	cache.NoV = max( dot( N, V ), 0.001 );
	cache.isPurelyDiffuse = material.roughness > 0.98 && material.metalness < 0.02 &&
		material.transmission == 0.0 && material.clearcoat == 0.0;
	cache.isMetallic = material.metalness > 0.7;
	cache.hasSpecialFeatures = material.transmission > 0.0 || material.clearcoat > 0.0 ||
		material.sheen > 0.0 || material.iridescence > 0.0;

	cache.alpha = material.roughness * material.roughness;
	cache.alpha2 = cache.alpha * cache.alpha;
	float r = material.roughness + 1.0;
	cache.k = ( r * r ) / 8.0;

	vec3 dielectricF0 = vec3( 0.04 ) * material.specularColor;
	cache.F0 = mix( dielectricF0, material.color.rgb, material.metalness ) * material.specularIntensity;
	cache.diffuseColor = material.color.rgb * ( 1.0 - material.metalness );
	cache.specularColor = material.color.rgb;

    // Create dummy MaterialSamples for compatibility
	cache.texSamples.albedo = material.color;
	cache.texSamples.emissive = material.emissive * material.emissiveIntensity;
	cache.texSamples.metalness = material.metalness;
	cache.texSamples.roughness = material.roughness;
	cache.texSamples.normal = N;
	cache.texSamples.hasTextures = false;

	return cache;
}

// Optimized material response evaluation using cache
vec3 evaluateMaterialResponseCached( vec3 V, vec3 L, vec3 N, RayTracingMaterial material, MaterialCache cache ) {
	if( cache.isPurelyDiffuse ) {
		return cache.diffuseColor;
	}

	vec3 H = normalize( V + L );
	float NoL = max( dot( N, L ), EPSILON );
	float NoH = max( dot( N, H ), EPSILON );
	float VoH = max( dot( V, H ), EPSILON );

	bool isTransmission = cache.NoV * NoL < 0.0;
	if( isTransmission && material.transmission > 0.0 ) {
		return evaluateMaterialResponse( V, L, N, material );
	}

	vec3 F0 = cache.F0;
	if( material.iridescence > 0.0 ) {
		float thickness = mix( material.iridescenceThicknessRange.x, material.iridescenceThicknessRange.y, 0.5 );
		vec3 iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, VoH, thickness, F0 );
		F0 = mix( F0, iridescenceFresnel, material.iridescence );
	}

    // Use precomputed values
	float denom = ( NoH * NoH * ( cache.alpha2 - 1.0 ) + 1.0 );
	float D = cache.alpha2 / max( PI * denom * denom, EPSILON );

	float ggx1 = NoL / ( NoL * ( 1.0 - cache.k ) + cache.k );
	float ggx2 = cache.NoV / ( cache.NoV * ( 1.0 - cache.k ) + cache.k );
	float G = ggx1 * ggx2;

	vec3 F = fresnelSchlick( VoH, F0 );

    // Safer division for specular term
	float specularDenom = max( 4.0 * cache.NoV * NoL, EPSILON );
	vec3 specular = ( D * G * F ) / specularDenom;

    // Energy conservation: ensure diffuse + specular doesn't exceed 1
	vec3 kD = ( vec3( 1.0 ) - F ) * ( 1.0 - material.metalness );
	vec3 diffuse = kD * material.color.rgb * PI_INV;

    // Clamp specular to prevent fireflies
	specular = min( specular, vec3( 16.0 ) ); // Reasonable upper bound

	vec3 baseLayer = diffuse + specular;

	if( material.sheen > 0.0 ) {
		float sheenDist = SheenDistribution( NoH, material.sheenRoughness );
		vec3 sheenTerm = material.sheenColor * material.sheen * sheenDist * NoL;
		float maxSheen = max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b );
		float sheenReflectance = material.sheen * maxSheen * sheenDist;
		float sheenAttenuation = 1.0 - clamp( sheenReflectance, 0.0, 1.0 );

		return baseLayer * sheenAttenuation + sheenTerm;
	}

	return baseLayer;
}

vec3 cosineWeightedSample( vec3 N, vec2 xi ) {
    // Construct a local coordinate system (TBN)
	vec3 T = normalize( cross( N, N.yzx + vec3( 0.1, 0.2, 0.3 ) ) );
	vec3 B = cross( N, T );

    // Cosine-weighted sampling using concentric disk mapping
    // Convert to polar coordinates
	float phi = TWO_PI * xi.y;
	float cosTheta = sqrt( 1.0 - xi.x );
	float sinTheta = sqrt( xi.x );

    // Convert from polar to Cartesian coordinates in tangent space
	vec3 localDir = vec3( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );

    // Transform the sampled direction to world space
	return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
}

float cosineWeightedPDF( float NoL ) {
	return max( NoL, MIN_PDF ) * PI_INV;
}