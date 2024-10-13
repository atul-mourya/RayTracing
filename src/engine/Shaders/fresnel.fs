vec3 fresnel( vec3 f0, float NoV, float roughness ) {
	return f0 + ( max( vec3( 1.0 - roughness ), f0 ) - f0 ) * pow( 1.0 - NoV, 5.0 );
}

float fresnelSchlick( float cosTheta, float F0 ) {
	return F0 + ( 1.0 - F0 ) * pow( 1.0 - cosTheta, 5.0 );
}

vec3 fresnelSchlick3( float cosTheta, vec3 F0 ) {
	return F0 + ( 1.0 - F0 ) * pow( 1.0 - cosTheta, 5.0 );
}
