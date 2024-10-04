uniform vec3 directionalLightDirection;
uniform vec3 directionalLightColor;
uniform float directionalLightIntensity;

struct DirectionalLight {
	vec3 direction;
	vec3 color;
	float intensity;
};

bool isPointInShadow( vec3 point, vec3 normal, vec3 lightDir, inout ivec2 stats ) {
	Ray shadowRay;
	shadowRay.origin = point + normal * 0.001; // Offset to avoid self-intersection
	shadowRay.direction = lightDir;
	HitInfo shadowHit = traverseBVH( shadowRay, stats );
	return shadowHit.didHit;
}


vec3 calculateDirectLightingMIS( HitInfo hitInfo, vec3 V, vec3 sampleDir, vec3 brdfValue, float brdfPdf, inout ivec2 stats ) {
	if( directionalLightIntensity <= 0.0 )
		return vec3( 0.0 );

	vec3 N = hitInfo.normal;
	vec3 L = normalize( - directionalLightDirection );
	float NoL = max( dot( N, L ), 0.0 );

	// check if light coming from behind
	if( NoL <= 0.0 ) {
		return vec3( 0.0 );
	}

	// Check for shadows
	if( isPointInShadow( hitInfo.hitPoint, N, L, stats ) ) {
		return vec3( 0.0 );
	}

	vec3 lightContribution = directionalLightColor * directionalLightIntensity;

	float lightPdf = 1.0; // For directional light, PDF is always 1
	// Evaluate BRDF for the light direction
	vec3 brdfValueForLight = evaluateBRDF( V, L, N, hitInfo.material );
	float misWeightLight = powerHeuristic( lightPdf, brdfPdf );
	vec3 lightSampleContribution = lightContribution * brdfValueForLight * NoL * misWeightLight / lightPdf;

	// BRDF sampling contribution
	float NoL_brdf = max( dot( N, sampleDir ), 0.0 );
	vec3 brdfSampleContribution = vec3( 0.0 );
	if( NoL_brdf > 0.0 && brdfPdf > 0.0 ) {
		// Check if the BRDF sample direction hits the light
		float alignment = dot( sampleDir, L );
		if( alignment > 0.99 ) { // Allow for some tolerance due to floating-point precision
			// MIS weight for BRDF sampling
			float misWeightBRDF = powerHeuristic( brdfPdf, lightPdf );
			brdfSampleContribution = lightContribution * brdfValue * NoL_brdf * misWeightBRDF / brdfPdf;
		}
	}

	vec3 final = max( lightSampleContribution + brdfSampleContribution, vec3( 0.001 ) );

	return final;
}