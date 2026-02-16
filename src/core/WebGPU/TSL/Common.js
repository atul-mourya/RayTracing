import { Fn, float, vec2, vec3, vec4, int, mat3, If, max, min, dot, normalize, cross, abs, pow, clamp, step, mix, texture } from 'three/tsl';

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

export const sRGBToLinear = Fn( ( [ srgbColor ] ) => {

	return pow( srgbColor, vec3( 2.2 ) );

} );

export const gammaCorrection = Fn( ( [ color ] ) => {

	return pow( color, vec3( 1.0 / 2.2 ) );

} );

export const square = Fn( ( [ x ] ) => {

	return x.mul( x );

} );

export const squareVec3 = Fn( ( [ x ] ) => {

	return x.mul( x );

} );

// Get maximum component of a vector
export const maxComponent = Fn( ( [ v ] ) => {

	return max( max( v.r, v.g ), v.b );

} );

// Get minimum component of a vector
export const minComponent = Fn( ( [ v ] ) => {

	return min( min( v.r, v.g ), v.b );

} );

export const luminance = Fn( ( [ color ] ) => {

	return dot( color, REC709_LUMINANCE_COEFFICIENTS );

} );

// Optimized power heuristic for multiple importance sampling
export const powerHeuristic = Fn( ( [ pdf1, pdf2 ] ) => {

	const ratio = pdf1.div( max( pdf2, MIN_PDF ) ).toVar( 'ratio' );

	const result = float( 0.0 ).toVar( 'phResult' );

	If( ratio.greaterThan( 10.0 ), () => {

		result.assign( 1.0 );

	} ).ElseIf( ratio.lessThan( 0.1 ), () => {

		result.assign( 0.0 );

	} ).ElseIf( ratio.greaterThan( 5.0 ), () => {

		result.assign( 0.95 );

	} ).ElseIf( ratio.lessThan( 0.2 ), () => {

		result.assign( 0.05 );

	} ).Else( () => {

		// Standard power heuristic calculation for intermediate cases
		const p1 = pdf1.mul( pdf1 );
		const p2 = pdf2.mul( pdf2 );
		result.assign( p1.div( max( p1.add( p2 ), MIN_PDF ) ) );

	} );

	return result;

} );

export const applyDithering = Fn( ( [ color, uv, ditheringAmount, resolution ] ) => {

	const pixelCoord = uv.mul( resolution ).floor();
	const dither = pixelCoord.x.mod( 4.0 ).mul( 4.0 ).add( pixelCoord.y.mod( 4.0 ) ).div( 16.0 );
	return color.add( dither.sub( 0.5 ).mul( ditheringAmount ).div( 255.0 ) );

} );

export const reduceFireflies = Fn( ( [ color, maxValue ] ) => {

	const lum = dot( color, REC709_LUMINANCE_COEFFICIENTS ).toVar( 'ffLum' );
	const result = color.toVar( 'ffResult' );

	If( lum.greaterThan( maxValue ), () => {

		result.assign( color.mul( maxValue.div( lum ) ) );

	} );

	return result;

} );

export const constructTBN = Fn( ( [ N ] ) => {

	// Create tangent and bitangent vectors
	const majorAxis = abs( N.x ).lessThan( 0.999 ).select( vec3( 1, 0, 0 ), vec3( 0, 1, 0 ) );
	const T = normalize( cross( N, majorAxis ) );
	const B = normalize( cross( N, T ) );
	return mat3( T.x, T.y, T.z, B.x, B.y, B.z, N.x, N.y, N.z );

} );

export const computeDotProducts = Fn( ( [ N, V, L ] ) => {

	const H = V.add( L ).toVar( 'dpH' );
	const lenSq = dot( H, H ).toVar( 'dpLenSq' );
	H.assign( lenSq.greaterThan( EPSILON ).select( H.div( lenSq.sqrt() ), vec3( 0.0, 0.0, 1.0 ) ) );

	return DotProducts( {
		NoL: max( dot( N, L ), 0.001 ),
		NoV: max( dot( N, V ), 0.001 ),
		NoH: max( dot( N, H ), 0.001 ),
		VoH: max( dot( V, H ), 0.001 ),
		LoH: max( dot( L, H ), 0.001 ),
	} );

} );

export const calculateFireflyThreshold = Fn( ( [ baseThreshold, contextMultiplier, bounceIndex ] ) => {

	const depthFactor = float( 1.0 ).div( pow( float( bounceIndex ).add( 1.0 ), 0.5 ) );
	return baseThreshold.mul( contextMultiplier ).mul( depthFactor );

} );

// Apply soft suppression to prevent harsh clipping
export const applySoftSuppression = Fn( ( [ value, threshold, dampingFactor ] ) => {

	const result = value.toVar( 'ssResult' );

	If( value.greaterThan( threshold ), () => {

		const excess = value.sub( threshold );
		const suppressionFactor = threshold.div( threshold.add( excess.mul( dampingFactor ) ) );
		result.assign( value.mul( suppressionFactor ) );

	} );

	return result;

} );

// Apply soft suppression to RGB color while preserving hue
export const applySoftSuppressionRGB = Fn( ( [ color, threshold, dampingFactor ] ) => {

	const lum = dot( color, REC709_LUMINANCE_COEFFICIENTS ).toVar( 'ssrgbLum' );
	const result = color.toVar( 'ssrgbResult' );

	If( lum.greaterThan( threshold ), () => {

		const suppressedLum = applySoftSuppression( lum, threshold, dampingFactor );
		result.assign( lum.greaterThan( EPSILON ).select( color.mul( suppressedLum.div( lum ) ), color ) );

	} );

	return result;

} );

// Get material-specific firefly tolerance multiplier
export const getMaterialFireflyTolerance = Fn( ( [ metalness, roughness, transmission, dispersion ] ) => {

	const tolerance = float( 1.0 ).toVar( 'ffTol' );

	// Metals can handle brighter values legitimately
	tolerance.mulAssign( mix( float( 1.0 ), float( 1.5 ), step( 0.7, metalness ) ) );

	// Rough surfaces need less aggressive clamping
	tolerance.mulAssign( mix( float( 0.8 ), float( 1.2 ), roughness ) );

	// Transmissive materials have different brightness characteristics
	tolerance.mulAssign( mix( float( 1.0 ), float( 0.9 ), transmission ) );

	// Dispersive materials need more aggressive clamping to reduce color noise
	tolerance.mulAssign( mix( float( 1.0 ), float( 0.7 ), clamp( dispersion.mul( 0.1 ), 0.0, 1.0 ) ) );

	return tolerance;

} );

// Calculate view-dependent firefly tolerance for specular materials
export const getViewDependentTolerance = Fn( ( [ roughness, sampleDir, viewDir, normal ] ) => {

	const tolerance = float( 1.0 ).toVar( 'vdTol' );

	// For very smooth materials, allow brighter values in specular direction
	If( roughness.lessThan( 0.2 ), () => {

		const reflectDir = sampleDir.reflect( normal.negate() );
		const specularAlignment = max( 0.0, dot( sampleDir, reflectDir ) );
		const viewDependentScale = mix( float( 1.0 ), float( 2.5 ), pow( specularAlignment, 4.0 ) );
		tolerance.mulAssign( viewDependentScale );

	} );

	return tolerance;

} );

// Pre-computed material classification for faster branching
export const classifyMaterial = Fn( ( [ metalness, roughness, transmission, clearcoat, emissive ] ) => {

	const isMetallic = metalness.greaterThan( 0.7 ).toVar( 'isMetallic' );
	const isRough = roughness.greaterThan( 0.8 ).toVar( 'isRough' );
	const isSmooth = roughness.lessThan( 0.3 ).toVar( 'isSmooth' );
	const isTransmissive = transmission.greaterThan( 0.5 ).toVar( 'isTransmissive' );
	const hasClearcoat = clearcoat.greaterThan( 0.5 ).toVar( 'hasClearcoat' );

	// Fast emissive check using sum
	const emissiveMag = emissive.x.add( emissive.y ).add( emissive.z );
	const isEmissive = emissiveMag.greaterThan( 0.0 ).toVar( 'isEmissive' );

	// Enhanced complexity score with better material importance weighting
	const baseComplexity = float( 0.15 ).mul( float( isMetallic ) )
		.add( float( 0.25 ).mul( float( isSmooth ) ) )
		.add( float( 0.45 ).mul( float( isTransmissive ) ) )
		.add( float( 0.35 ).mul( float( hasClearcoat ) ) )
		.add( float( 0.3 ).mul( float( isEmissive ) ) )
		.toVar( 'baseComplexity' );

	// Add material interaction complexity
	const interactionComplexity = float( 0.0 ).toVar( 'interactionComplexity' );
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

	const throughputStrength = maxComponent( throughput ).toVar( 'misTS' );

	const isSecondaryBounce = bounceIndex.greaterThan( int( 0 ) );
	const envBoostForIndirect = isSecondaryBounce.select( float( 1.5 ), float( 1.0 ) ).toVar( 'envBoost' );

	const brdfWeight = float( 0.35 ).toVar( 'misBrdf' );
	const lightWeight = float( 0.3 ).toVar( 'misLight' );
	const envWeight = float( 0.35 ).toVar( 'misEnv' );
	const useBRDFSampling = true;
	const useLightSampling = throughputStrength.greaterThan( 0.01 ).toVar( 'misUseLs' );
	const useEnvSampling = true;

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
	const totalWeight = brdfWeight.add( lightWeight ).add( envWeight ).toVar( 'misTotalW' );
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

// Material data texture access functions
export const getDatafromDataTexture = Fn( ( [ tex, texSize, stride, sampleIndex, dataOffset ] ) => {

	const pixelIndex = stride.mul( dataOffset ).add( sampleIndex );
	const x = pixelIndex.mod( int( texSize.x ) );
	const y = pixelIndex.div( int( texSize.x ) );
	const uv = vec2(
		float( x ).add( 0.5 ).div( float( texSize.x ) ),
		float( y ).add( 0.5 ).div( float( texSize.y ) )
	);
	return texture( tex, uv );

} );

export const arrayToMat3 = Fn( ( [ data1, data2 ] ) => {

	return mat3(
		data1.x, data1.y, data1.z,
		data1.w, data2.x, data2.y,
		data2.z, data2.w, 1.0
	);

} );

export const getMaterial = Fn( ( [ materialIndex, materialTexture, materialTexSize ] ) => {

	const data0 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 0 ), int( MATERIAL_SLOTS ) ).toVar( 'md0' );
	const data1 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 1 ), int( MATERIAL_SLOTS ) ).toVar( 'md1' );
	const data2 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 2 ), int( MATERIAL_SLOTS ) ).toVar( 'md2' );
	const data3 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 3 ), int( MATERIAL_SLOTS ) ).toVar( 'md3' );
	const data4 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 4 ), int( MATERIAL_SLOTS ) ).toVar( 'md4' );
	const data5 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 5 ), int( MATERIAL_SLOTS ) ).toVar( 'md5' );
	const data6 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 6 ), int( MATERIAL_SLOTS ) ).toVar( 'md6' );
	const data7 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 7 ), int( MATERIAL_SLOTS ) ).toVar( 'md7' );
	const data8 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 8 ), int( MATERIAL_SLOTS ) ).toVar( 'md8' );
	const data9 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 9 ), int( MATERIAL_SLOTS ) ).toVar( 'md9' );
	const data10 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 10 ), int( MATERIAL_SLOTS ) ).toVar( 'md10' );
	const data11 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 11 ), int( MATERIAL_SLOTS ) ).toVar( 'md11' );
	const data12 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 12 ), int( MATERIAL_SLOTS ) ).toVar( 'md12' );
	const data13 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 13 ), int( MATERIAL_SLOTS ) ).toVar( 'md13' );
	const data14 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 14 ), int( MATERIAL_SLOTS ) ).toVar( 'md14' );
	const data15 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 15 ), int( MATERIAL_SLOTS ) ).toVar( 'md15' );
	const data16 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 16 ), int( MATERIAL_SLOTS ) ).toVar( 'md16' );
	const data17 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 17 ), int( MATERIAL_SLOTS ) ).toVar( 'md17' );
	const data18 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 18 ), int( MATERIAL_SLOTS ) ).toVar( 'md18' );
	const data19 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 19 ), int( MATERIAL_SLOTS ) ).toVar( 'md19' );
	const data20 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 20 ), int( MATERIAL_SLOTS ) ).toVar( 'md20' );
	const data21 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 21 ), int( MATERIAL_SLOTS ) ).toVar( 'md21' );
	const data22 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 22 ), int( MATERIAL_SLOTS ) ).toVar( 'md22' );
	const data23 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 23 ), int( MATERIAL_SLOTS ) ).toVar( 'md23' );
	const data24 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 24 ), int( MATERIAL_SLOTS ) ).toVar( 'md24' );
	const data25 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 25 ), int( MATERIAL_SLOTS ) ).toVar( 'md25' );
	const data26 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, int( 26 ), int( MATERIAL_SLOTS ) ).toVar( 'md26' );

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
		albedoTransform: arrayToMat3( data13, data14 ),
		normalTransform: arrayToMat3( data15, data16 ),
		roughnessTransform: arrayToMat3( data17, data18 ),
		metalnessTransform: arrayToMat3( data19, data20 ),
		emissiveTransform: arrayToMat3( data21, data22 ),
		bumpTransform: arrayToMat3( data23, data24 ),
		displacementTransform: arrayToMat3( data25, data26 ),
	} );

} );
