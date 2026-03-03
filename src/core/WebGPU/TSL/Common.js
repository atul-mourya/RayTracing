import { Fn, wgslFn, float, vec2, vec3, vec4, int, mat3, If, max, min, dot, normalize, cross, abs, pow, clamp, step, mix, bool as tslBool } from 'three/tsl';

import {
	DotProducts,
	MaterialClassification,
	MISStrategy,
	RayTracingMaterial,
} from './Struct.js';

export const PI = 3.14159;
export const PI_INV = 1.0 / PI;
export const TWO_PI = 2.0 * PI;
export const EPSILON = 1e-6;
export const MIN_ROUGHNESS = 0.05;
export const MIN_CLEARCOAT_ROUGHNESS = 0.089;
export const MAX_ROUGHNESS = 1.0;
export const MIN_PDF = 0.001;
export const REC709_LUMINANCE_COEFFICIENTS = vec3( 0.2126, 0.7152, 0.0722 );
export const MATERIAL_SLOTS = 27;

// XYZ to sRGB color space conversion matrix
export const XYZ_TO_REC709 = mat3(
	3.2404542, - 0.9692660, 0.0556434,
	- 1.5371385, 1.8760108, - 0.2040259,
	- 0.4985314, 0.0415560, 1.0572252
);

export const sRGBToLinear = wgslFn( `
	fn sRGBToLinear( srgbColor: vec3f ) -> vec3f {

		return pow( srgbColor, vec3f( 2.2 ) );

	}
` );

export const gammaCorrection = wgslFn( `
	fn gammaCorrection( color: vec3f ) -> vec3f {

		return pow( color, vec3f( 1.0 / 2.2 ) );

	}
` );

export const square = wgslFn( `
	fn square( x: f32 ) -> f32 {

		return x * x;

	}
` );

export const squareVec3 = wgslFn( `
	fn squareVec3( x: vec3f ) -> vec3f {

		return x * x;

	}
` );

// Get maximum component of a vector
export const maxComponent = wgslFn( `
	fn maxComponent( v: vec3f ) -> f32 {

		return max( max( v.r, v.g ), v.b );

	}
` );

// Get minimum component of a vector
export const minComponent = wgslFn( `
	fn minComponent( v: vec3f ) -> f32 {

		return min( min( v.r, v.g ), v.b );

	}
` );

export const luminance = wgslFn( `
	fn luminance( color: vec3f ) -> f32 {

		return dot( color, vec3f( 0.2126, 0.7152, 0.0722 ) );

	}
` );

// Power heuristic for multiple importance sampling (balance heuristic, power=2)
export const powerHeuristic = wgslFn( `
	fn powerHeuristic( pdf1: f32, pdf2: f32 ) -> f32 {

		let p1 = pdf1 * pdf1;
		let p2 = pdf2 * pdf2;
		return p1 / max( p1 + p2, ${MIN_PDF} );

	}
` );

// Bayer matrix 4x4 dithering — exact port of GLSL
export const applyDithering = wgslFn( `
	fn applyDithering( color: vec3f, uv: vec2f, ditheringAmount: f32, resolution: vec2f ) -> vec3f {

		let bayerRow0 = vec4f( 0.0 / 16.0, 8.0 / 16.0, 2.0 / 16.0, 10.0 / 16.0 );
		let bayerRow1 = vec4f( 12.0 / 16.0, 4.0 / 16.0, 14.0 / 16.0, 6.0 / 16.0 );
		let bayerRow2 = vec4f( 3.0 / 16.0, 11.0 / 16.0, 1.0 / 16.0, 9.0 / 16.0 );
		let bayerRow3 = vec4f( 15.0 / 16.0, 7.0 / 16.0, 13.0 / 16.0, 5.0 / 16.0 );
		let bayer = mat4x4f( bayerRow0, bayerRow1, bayerRow2, bayerRow3 );

		let pixelCoord = vec2i( uv * resolution );
		let dither = bayer[ pixelCoord.x % 4 ][ pixelCoord.y % 4 ];

		return color + ( dither - 0.5 ) * ditheringAmount / 255.0;

	}
` );

// Firefly clamping — exact port of GLSL
export const reduceFireflies = wgslFn( `
	fn reduceFireflies( color: vec3f, maxValue: f32 ) -> vec3f {

		let lum = dot( color, vec3f( 0.2126, 0.7152, 0.0722 ) );
		if ( lum > maxValue ) {
			return color * ( maxValue / lum );
		}
		return color;

	}
` );

// Construct tangent-bitangent-normal matrix — exact port of GLSL
export const constructTBN = wgslFn( `
	fn constructTBN( N: vec3f ) -> mat3x3f {

		var majorAxis: vec3f;
		if ( abs( N.x ) < 0.999 ) {
			majorAxis = vec3f( 1.0, 0.0, 0.0 );
		} else {
			majorAxis = vec3f( 0.0, 1.0, 0.0 );
		}
		let T = normalize( cross( N, majorAxis ) );
		let B = normalize( cross( N, T ) );
		return mat3x3f( T, B, N );

	}
` );

export const computeDotProducts = Fn( ( [ N, V, L ] ) => {

	const H = V.add( L ).toVar();
	const lenSq = dot( H, H ).toVar();
	H.assign( lenSq.greaterThan( EPSILON ).select( H.div( lenSq.sqrt() ), vec3( 0.0, 0.0, 1.0 ) ) );

	return DotProducts( {
		NoL: max( dot( N, L ), 0.001 ),
		NoV: max( dot( N, V ), 0.001 ),
		NoH: max( dot( N, H ), 0.001 ),
		VoH: max( dot( V, H ), 0.001 ),
		LoH: max( dot( L, H ), 0.001 ),
	} );

} );

export const calculateFireflyThreshold = wgslFn( `
	fn calculateFireflyThreshold( baseThreshold: f32, contextMultiplier: f32, bounceIndex: i32 ) -> f32 {

		let depthFactor = 1.0 / pow( f32( bounceIndex + 1 ), 0.5 );
		return baseThreshold * contextMultiplier * depthFactor;

	}
` );

// Apply soft suppression to prevent harsh clipping — exact port of GLSL
export const applySoftSuppression = wgslFn( `
	fn applySoftSuppression( value: f32, threshold: f32, dampingFactor: f32 ) -> f32 {

		if ( value <= threshold ) {
			return value;
		}
		let excess = value - threshold;
		let suppressionFactor = threshold / ( threshold + excess * dampingFactor );
		return value * suppressionFactor;

	}
` );

// Apply soft suppression to RGB color while preserving hue — exact port of GLSL
export const applySoftSuppressionRGB = wgslFn( `
	fn applySoftSuppressionRGB( color: vec3f, threshold: f32, dampingFactor: f32 ) -> vec3f {

		let lum = dot( color, vec3f( 0.2126, 0.7152, 0.0722 ) );
		if ( lum <= threshold ) {
			return color;
		}
		let suppressedLum = applySoftSuppression( lum, threshold, dampingFactor );
		if ( lum > ${EPSILON} ) {
			return color * ( suppressedLum / lum );
		}
		return color;

	}
`, [ applySoftSuppression ] );

// Get material-specific firefly tolerance multiplier — exact port of GLSL
export const getMaterialFireflyTolerance = wgslFn( `
	fn getMaterialFireflyTolerance( metalness: f32, roughness: f32, transmission: f32, dispersion: f32 ) -> f32 {

		var tolerance = 1.0;
		tolerance *= mix( 1.0, 1.5, step( 0.7, metalness ) );
		tolerance *= mix( 0.8, 1.2, roughness );
		tolerance *= mix( 1.0, 0.9, transmission );
		tolerance *= mix( 1.0, 0.7, clamp( dispersion * 0.1, 0.0, 1.0 ) );
		return tolerance;

	}
` );

// Calculate view-dependent firefly tolerance for specular materials — exact port of GLSL
export const getViewDependentTolerance = wgslFn( `
	fn getViewDependentTolerance( roughness: f32, sampleDir: vec3f, viewDir: vec3f, normal: vec3f ) -> f32 {

		var tolerance = 1.0;
		if ( roughness < 0.2 ) {
			let reflectDir = reflect( -viewDir, normal );
			let specularAlignment = max( 0.0, dot( sampleDir, reflectDir ) );
			let viewDependentScale = mix( 1.0, 2.5, pow( specularAlignment, 4.0 ) );
			tolerance *= viewDependentScale;
		}
		return tolerance;

	}
` );

// Pre-computed material classification for faster branching
export const classifyMaterial = Fn( ( [ metalness, roughness, transmission, clearcoat, emissive ] ) => {

	const isMetallic = metalness.greaterThan( 0.7 ).toVar();
	const isRough = roughness.greaterThan( 0.8 ).toVar();
	const isSmooth = roughness.lessThan( 0.3 ).toVar();
	const isTransmissive = transmission.greaterThan( 0.5 ).toVar();
	const hasClearcoat = clearcoat.greaterThan( 0.5 ).toVar();

	// Fast emissive check using sum
	const emissiveMag = emissive.x.add( emissive.y ).add( emissive.z );
	const isEmissive = emissiveMag.greaterThan( 0.0 ).toVar();

	// Enhanced complexity score with better material importance weighting
	const baseComplexity = float( 0.15 ).mul( float( isMetallic ) )
		.add( float( 0.25 ).mul( float( isSmooth ) ) )
		.add( float( 0.45 ).mul( float( isTransmissive ) ) )
		.add( float( 0.35 ).mul( float( hasClearcoat ) ) )
		.add( float( 0.3 ).mul( float( isEmissive ) ) )
		.toVar();

	// Add material interaction complexity
	const interactionComplexity = float( 0.0 ).toVar();
	If( isMetallic.and( isSmooth ), () => {

		interactionComplexity.addAssign( 0.15 );

	} );
	If( isTransmissive.and( hasClearcoat ), () => {

		interactionComplexity.addAssign( 0.2 );

	} );
	If( isEmissive.and( isTransmissive.or( isMetallic ) ), () => {

		interactionComplexity.addAssign( 0.1 );

	} );

	const complexityScore = clamp( baseComplexity.add( interactionComplexity ), 0.0, 1.0 );

	return MaterialClassification( { isMetallic, isRough, isSmooth, isTransmissive, hasClearcoat, isEmissive, complexityScore } );

} );

// Dynamic MIS strategy based on material properties
export const selectOptimalMISStrategy = Fn( ( [ roughness, metalness, transmission, bounceIndex, throughput ] ) => {

	const throughputStrength = maxComponent( { v: throughput } ).toVar();

	const isSecondaryBounce = bounceIndex.greaterThan( int( 0 ) );
	const envBoostForIndirect = isSecondaryBounce.select( float( 1.5 ), float( 1.0 ) ).toVar();

	const brdfWeight = float( 0.35 ).toVar();
	const lightWeight = float( 0.3 ).toVar();
	const envWeight = float( 0.35 ).toVar();
	const useBRDFSampling = tslBool( true );
	const useLightSampling = throughputStrength.greaterThan( 0.01 ).toVar();
	const useEnvSampling = tslBool( true );

	If( roughness.lessThan( 0.1 ).and( metalness.greaterThan( 0.8 ) ), () => {

		// Highly specular materials
		brdfWeight.assign( 0.6 );
		lightWeight.assign( 0.15 );
		envWeight.assign( float( 0.25 ).mul( envBoostForIndirect ) );

	} ).ElseIf( roughness.greaterThan( 0.7 ), () => {

		// Diffuse materials
		brdfWeight.assign( 0.25 );
		lightWeight.assign( 0.35 );
		envWeight.assign( float( 0.4 ).mul( envBoostForIndirect ) );

	} ).Else( () => {

		// Balanced approach for mixed materials
		brdfWeight.assign( 0.35 );
		lightWeight.assign( 0.3 );
		envWeight.assign( float( 0.35 ).mul( envBoostForIndirect ) );

	} );

	// Normalize weights
	const totalWeight = brdfWeight.add( lightWeight ).add( envWeight ).toVar();
	If( totalWeight.greaterThan( 0.0 ), () => {

		const invTotal = float( 1.0 ).div( totalWeight );
		brdfWeight.mulAssign( invTotal );
		lightWeight.mulAssign( invTotal );
		envWeight.mulAssign( invTotal );

	} );

	// Gentle adjustment for very deep bounces
	If( bounceIndex.greaterThan( int( 5 ) ), () => {

		lightWeight.mulAssign( 0.85 );

	} );

	return MISStrategy( {
		brdfWeight,
		lightWeight,
		envWeight,
		useBRDFSampling,
		useLightSampling,
		useEnvSampling
	} );

} );

// Storage buffer access — flat 1D indexing (WebGPU native)
// No 2D coordinate math needed: directly indexes into the buffer
export const getDatafromStorageBuffer = Fn( ( [ buffer, stride, sampleIndex, dataOffset ] ) => {

	const elementIndex = stride.mul( dataOffset ).add( sampleIndex );
	return buffer.element( elementIndex );

} );

// Reconstruct mat3 from two vec4s — exact port of GLSL
export const arrayToMat3 = wgslFn( `
	fn arrayToMat3( data1: vec4f, data2: vec4f ) -> mat3x3f {

		return mat3x3f(
			data1.xyz,
			vec3f( data1.w, data2.xy ),
			vec3f( data2.zw, 1.0 )
		);

	}
` );

export const getMaterial = Fn( ( [ materialIndex, materialBuffer ] ) => {

	const data0 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 0 ), int( MATERIAL_SLOTS ) ).toVar();
	const data1 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 1 ), int( MATERIAL_SLOTS ) ).toVar();
	const data2 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 2 ), int( MATERIAL_SLOTS ) ).toVar();
	const data3 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 3 ), int( MATERIAL_SLOTS ) ).toVar();
	const data4 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 4 ), int( MATERIAL_SLOTS ) ).toVar();
	const data5 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 5 ), int( MATERIAL_SLOTS ) ).toVar();
	const data6 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 6 ), int( MATERIAL_SLOTS ) ).toVar();
	const data7 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 7 ), int( MATERIAL_SLOTS ) ).toVar();
	const data8 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 8 ), int( MATERIAL_SLOTS ) ).toVar();
	const data9 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 9 ), int( MATERIAL_SLOTS ) ).toVar();
	const data10 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 10 ), int( MATERIAL_SLOTS ) ).toVar();
	const data11 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 11 ), int( MATERIAL_SLOTS ) ).toVar();
	const data12 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 12 ), int( MATERIAL_SLOTS ) ).toVar();
	const data13 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 13 ), int( MATERIAL_SLOTS ) ).toVar();
	const data14 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 14 ), int( MATERIAL_SLOTS ) ).toVar();
	const data15 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 15 ), int( MATERIAL_SLOTS ) ).toVar();
	const data16 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 16 ), int( MATERIAL_SLOTS ) ).toVar();
	const data17 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 17 ), int( MATERIAL_SLOTS ) ).toVar();
	const data18 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 18 ), int( MATERIAL_SLOTS ) ).toVar();
	const data19 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 19 ), int( MATERIAL_SLOTS ) ).toVar();
	const data20 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 20 ), int( MATERIAL_SLOTS ) ).toVar();
	const data21 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 21 ), int( MATERIAL_SLOTS ) ).toVar();
	const data22 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 22 ), int( MATERIAL_SLOTS ) ).toVar();
	const data23 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 23 ), int( MATERIAL_SLOTS ) ).toVar();
	const data24 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 24 ), int( MATERIAL_SLOTS ) ).toVar();
	const data25 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 25 ), int( MATERIAL_SLOTS ) ).toVar();
	const data26 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 26 ), int( MATERIAL_SLOTS ) ).toVar();

	return RayTracingMaterial( {
		color: vec4( data0.rgb, 1.0 ),
		metalness: data0.a,
		emissive: data1.rgb,
		roughness: data1.a,
		ior: data2.r,
		transmission: data2.g,
		thickness: data2.b,
		emissiveIntensity: data2.a,
		attenuationColor: data3.rgb,
		attenuationDistance: data3.a,
		dispersion: data4.r,
		visible: data4.g,
		sheen: data4.b,
		sheenRoughness: data4.a,
		sheenColor: data5.rgb,
		specularIntensity: data6.r,
		specularColor: data6.gba,
		iridescence: data7.r,
		iridescenceIOR: data7.g,
		iridescenceThicknessRange: data7.ba,
		albedoMapIndex: int( data8.r ),
		normalMapIndex: int( data8.g ),
		roughnessMapIndex: int( data8.b ),
		metalnessMapIndex: int( data8.a ),
		emissiveMapIndex: int( data9.r ),
		bumpMapIndex: int( data9.g ),
		clearcoat: data9.b,
		clearcoatRoughness: data9.a,
		opacity: data10.r,
		side: int( data10.g ),
		transparent: data10.b,
		alphaTest: data10.a,
		alphaMode: int( data11.r ),
		depthWrite: int( data11.g ),
		normalScale: vec2( data11.b, data11.b ),
		bumpScale: data12.r,
		displacementScale: data12.g,
		displacementMapIndex: int( data12.b ),
		albedoTransform: arrayToMat3( { data1: data13, data2: data14 } ),
		normalTransform: arrayToMat3( { data1: data15, data2: data16 } ),
		roughnessTransform: arrayToMat3( { data1: data17, data2: data18 } ),
		metalnessTransform: arrayToMat3( { data1: data19, data2: data20 } ),
		emissiveTransform: arrayToMat3( { data1: data21, data2: data22 } ),
		bumpTransform: arrayToMat3( { data1: data23, data2: data24 } ),
		displacementTransform: arrayToMat3( { data1: data25, data2: data26 } ),
	} );

} );
