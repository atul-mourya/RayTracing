import { Fn, float, vec3, max, clamp, sqrt } from 'three/tsl';

const EPSILON = 1e-6;

// Schlick exponent factored as 4 multiplies — pow(x, 5.0) compiles to
// exp2(5*log2(x)) on most backends, far slower than (x²)²·x.
const pow5 = ( c ) => {

	const c2 = c.mul( c );
	return c2.mul( c2 ).mul( c );

};

export const fresnel = Fn( ( [ f0, NoV, roughness ] ) => {

	const maxR = max( vec3( float( 1.0 ).sub( roughness ) ), f0 );
	return f0.add( maxR.sub( f0 ).mul( pow5( float( 1.0 ).sub( NoV ) ) ) );

} );

export const fresnelSchlickFloat = Fn( ( [ cosTheta, F0 ] ) => {

	const clampedCos = clamp( cosTheta, 0.0, 1.0 );
	return F0.add( float( 1.0 ).sub( F0 ).mul( pow5( float( 1.0 ).sub( clampedCos ) ) ) );

} );

export const fresnelSchlick = Fn( ( [ cosTheta, F0 ] ) => {

	const clampedCos = clamp( cosTheta, 0.0, 1.0 );
	return F0.add( vec3( 1.0 ).sub( F0 ).mul( pow5( float( 1.0 ).sub( clampedCos ) ) ) );

} );

export const fresnel0ToIor = Fn( ( [ fresnel0 ] ) => {

	const sqrtF0 = sqrt( fresnel0 );
	return vec3( 1.0 ).add( sqrtF0 ).div( max( vec3( 1.0 ).sub( sqrtF0 ), vec3( EPSILON ) ) );

} );

export const iorToFresnel0Vec3 = Fn( ( [ transmittedIor, incidentIor ] ) => {

	const diff = transmittedIor.sub( vec3( incidentIor ) );
	const sum = max( transmittedIor.add( vec3( incidentIor ) ), vec3( EPSILON ) );
	const ratio = diff.div( sum );
	return ratio.mul( ratio );

} );

export const iorToFresnel0 = Fn( ( [ transmittedIor, incidentIor ] ) => {

	const diff = transmittedIor.sub( incidentIor );
	const sum = max( transmittedIor.add( incidentIor ), EPSILON );
	const ratio = diff.div( sum );
	return ratio.mul( ratio );

} );

export const dielectricF0 = ( ior ) => vec3( iorToFresnel0( ior, float( 1.0 ) ) );
