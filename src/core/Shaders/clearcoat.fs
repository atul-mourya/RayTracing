// Helper function to calculate energy conservation for layered materials
float calculateLayerAttenuation( float clearcoat, float VoH ) {
    // Fresnel term for clearcoat layer (using f0 = 0.04 for dielectric)
	float F = fresnelSchlick( VoH, 0.04 );
    // Attenuate base layer by clearcoat layer's reflection
	return ( 1.0 - clearcoat * F );
}

// Evaluate both clearcoat and base layer BRDFs
vec3 evaluateLayeredBRDF( DotProducts dots, RayTracingMaterial material ) {

    // Base F0 calculation with specular parameters
	vec3 baseF0 = vec3( 0.04 );
	vec3 F0 = mix( baseF0 * material.specularColor, material.color.rgb, material.metalness );
	F0 *= material.specularIntensity;

	float D = DistributionGGX( dots.NoH, material.roughness );
	float G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
	vec3 F = fresnelSchlick( dots.VoH, F0 );
	vec3 baseBRDF = ( D * G * F ) / ( 4.0 * dots.NoV * dots.NoL );

    // Fresnel masking for diffuse component
	vec3 kD = ( vec3( 1.0 ) - F ) * ( 1.0 - material.metalness );
	vec3 diffuse = kD * material.color.rgb / PI;
	vec3 baseLayer = diffuse + baseBRDF;

    // Clearcoat layer
	float clearcoatRoughness = max( material.clearcoatRoughness, 0.089 );
	float clearcoatD = DistributionGGX( dots.NoH, clearcoatRoughness );
	float clearcoatG = GeometrySmith( dots.NoV, dots.NoL, clearcoatRoughness );
	float clearcoatF = fresnelSchlick( dots.VoH, 0.04 );
	float clearcoatBRDF = ( clearcoatD * clearcoatG * clearcoatF ) /
		( 4.0 * dots.NoV * dots.NoL );

    //  Energy conservation for clearcoat
	float clearcoatAttenuation = 1.0 - material.clearcoat * clearcoatF;

	return baseLayer * clearcoatAttenuation + vec3( clearcoatBRDF ) * material.clearcoat;
}

// Improved clearcoat sampling function
vec3 sampleClearcoat( inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, vec2 randomSample, out vec3 L, out float pdf, inout uint rngState ) {
	vec3 N = hitInfo.normal;
	vec3 V = - ray.direction;

    // Clamp clearcoat roughness to avoid artifacts
	float clearcoatRoughness = max( material.clearcoatRoughness, 0.089 );
	float baseRoughness = max( material.roughness, 0.089 );

    // Calculate sampling weights based on material properties
	float specularWeight = ( 1.0 - baseRoughness ) * ( 0.5 + 0.5 * material.metalness );
	float clearcoatWeight = material.clearcoat * ( 1.0 - clearcoatRoughness );
	float diffuseWeight = ( 1.0 - specularWeight ) * ( 1.0 - material.metalness );

    // Normalize weights
	float total = specularWeight + clearcoatWeight + diffuseWeight;
	specularWeight /= total;
	clearcoatWeight /= total;
	diffuseWeight /= total;

    // Choose which layer to sample
	float rand = RandomValue( rngState );
	vec3 H;

	if( rand < clearcoatWeight ) {
        // Sample clearcoat layer
		H = ImportanceSampleGGX( N, clearcoatRoughness, randomSample );
		L = reflect( - V, H );
	} else if( rand < clearcoatWeight + specularWeight ) {
        // Sample base specular
		H = ImportanceSampleGGX( N, baseRoughness, randomSample );
		L = reflect( - V, H );
	} else {
        // Sample diffuse
		L = ImportanceSampleCosine( N, randomSample );
		H = normalize( V + L );
	}

	// Calculate dot products
	DotProducts dots = computeDotProducts( N, V, L );

    // Calculate individual PDFs
	float clearcoatPDF = DistributionGGX( dots.NoH, clearcoatRoughness ) * dots.NoH / ( 4.0 * dots.VoH ) * clearcoatWeight;
	float specularPDF = DistributionGGX( dots.NoH, baseRoughness ) * dots.NoH / ( 4.0 * dots.VoH ) * specularWeight;
	float diffusePDF = dots.NoL / PI * diffuseWeight;

    // Combined PDF using MIS
	pdf = clearcoatPDF + specularPDF + diffusePDF;
	pdf = max( pdf, 0.001 ); // Ensure PDF is never zero

    // Evaluate complete BRDF
	return evaluateLayeredBRDF( dots, material );
}