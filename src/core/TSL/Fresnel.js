import { Fn, float, vec3, max, pow, clamp, sqrt } from 'three/tsl';

const EPSILON = 1e-6;

export const fresnel = Fn( ( [ f0, NoV, roughness ] ) => {

	const maxR = max( vec3( float( 1.0 ).sub( roughness ) ), f0 );
	return f0.add( maxR.sub( f0 ).mul( pow( float( 1.0 ).sub( NoV ), 5.0 ) ) );

} );

export const fresnelSchlickFloat = Fn( ( [ cosTheta, F0 ] ) => {

	const clampedCos = clamp( cosTheta, 0.0, 1.0 );
	return F0.add( float( 1.0 ).sub( F0 ).mul( pow( float( 1.0 ).sub( clampedCos ), 5.0 ) ) );

} );

export const fresnelSchlick = Fn( ( [ cosTheta, F0 ] ) => {

	const clampedCos = clamp( cosTheta, 0.0, 1.0 );
	return F0.add( vec3( 1.0 ).sub( F0 ).mul( pow( float( 1.0 ).sub( clampedCos ), 5.0 ) ) );

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
