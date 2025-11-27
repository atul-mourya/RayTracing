vec3 fresnel( vec3 f0, float NoV, float roughness ) {
	return f0 + ( max( vec3( 1.0 - roughness ), f0 ) - f0 ) * pow( 1.0 - NoV, 5.0 );
}

float fresnelSchlick( float cosTheta, float F0 ) {
	float clampedCos = clamp( cosTheta, 0.0, 1.0 );
	return F0 + ( 1.0 - F0 ) * pow( 1.0 - clampedCos, 5.0 );
}

vec3 fresnelSchlick( float cosTheta, vec3 F0 ) {
	float clampedCos = clamp( cosTheta, 0.0, 1.0 );
	return F0 + ( 1.0 - F0 ) * pow( 1.0 - clampedCos, 5.0 );
}

vec3 fresnel0ToIor( vec3 fresnel0 ) {
	vec3 sqrtF0 = sqrt( fresnel0 );
	return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );
}

vec3 iorToFresnel0( vec3 transmittedIor, float incidentIor ) {
	return square( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );
}

float iorToFresnel0( float transmittedIor, float incidentIor ) {
	return square( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ) );
}
