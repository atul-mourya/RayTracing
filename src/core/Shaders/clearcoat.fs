// ===== CLEARCOAT BRDF (Conditional Compilation) =====
#ifdef ENABLE_CLEARCOAT

// Note: evaluateLayeredBRDF and calculateLayerAttenuation functions
// have been moved to material_evaluation.fs

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

#endif // ENABLE_CLEARCOAT