import { Fn, float, int, vec2, vec3, texture, uniform } from 'three/tsl';
import { Vector2 } from 'three';

/**
 * Material texture reader for TSL.
 * Reads material properties from a packed texture.
 *
 * Material texture layout (27 pixels per material):
 * Pixel 1:  color.rgb, metalness
 * Pixel 2:  emissive.rgb, roughness
 * Pixel 3:  ior, transmission, thickness, emissiveIntensity
 * Pixel 4:  attenuationColor.rgb, attenuationDistance
 * Pixel 5:  dispersion, visible, sheen, sheenRoughness
 * Pixel 6:  sheenColor.rgb, 1
 * Pixel 7:  specularIntensity, specularColor.rgb
 * Pixel 8:  iridescence, iridescenceIOR, iridescenceThicknessMin, iridescenceThicknessMax
 * Pixel 9:  map, normalMap, roughnessMap, metalnessMap
 * Pixel 10: emissiveMap, bumpMap, clearcoat, clearcoatRoughness
 * Pixel 11: opacity, side, transparent, alphaTest
 * Pixel 12: alphaMode, depthWrite, normalScale.x, normalScale.y
 * ... (pixels 13-27 are texture matrices)
 */

/** Number of pixels per material in the texture */
const PIXELS_PER_MATERIAL = 27;

/**
 * Creates a material reader for accessing material properties from a texture.
 *
 * @param {DataTexture} materialTex - The material data texture
 * @param {Vector2} texSize - Texture dimensions
 * @returns {Object} Object with readMaterial function
 */
export const createMaterialReader = ( materialTex, texSize ) => {

	const matTex = texture( materialTex );
	const matTexSize = uniform( texSize );

	/**
	 * Reads a single vec4 from the material texture at a linear pixel index.
	 */
	const readPixel = ( pixelIndex ) => {

		const texWidth = matTexSize.x;
		const floatIndex = float( pixelIndex );
		const x = floatIndex.mod( texWidth ).add( 0.5 ).div( texWidth );
		const y = floatIndex.div( texWidth ).floor().add( 0.5 ).div( matTexSize.y );
		return matTex.sample( vec2( x, y ) );

	};

	/**
	 * Reads material properties for a given material index.
	 * Returns a simplified material object with the most important properties.
	 *
	 * @param {TSLNode} materialIndex - Material index (int)
	 * @returns {Object} Material properties
	 */
	const readMaterial = Fn( ( [ materialIndex ] ) => {

		// Calculate base pixel index for this material
		const basePixel = materialIndex.mul( PIXELS_PER_MATERIAL );

		// Read essential pixels
		const pixel1 = readPixel( basePixel );           // color.rgb, metalness
		const pixel2 = readPixel( basePixel.add( 1 ) );  // emissive.rgb, roughness
		const pixel3 = readPixel( basePixel.add( 2 ) );  // ior, transmission, thickness, emissiveIntensity
		const pixel5 = readPixel( basePixel.add( 4 ) );  // dispersion, visible, sheen, sheenRoughness
		const pixel7 = readPixel( basePixel.add( 6 ) );  // specularIntensity, specularColor.rgb
		const pixel10 = readPixel( basePixel.add( 9 ) ); // emissiveMap, bumpMap, clearcoat, clearcoatRoughness
		const pixel11 = readPixel( basePixel.add( 10 ) ); // opacity, side, transparent, alphaTest

		return {
			// Base color and metalness
			color: pixel1.xyz,
			metalness: pixel1.w,

			// Emissive
			emissive: pixel2.xyz,
			emissiveIntensity: pixel3.w,

			// Surface properties
			roughness: pixel2.w,
			ior: pixel3.x,

			// Transmission
			transmission: pixel3.y,
			thickness: pixel3.z,

			// Sheen
			sheen: pixel5.z,
			sheenRoughness: pixel5.w,

			// Specular
			specularIntensity: pixel7.x,
			specularColor: pixel7.yzw,

			// Clearcoat
			clearcoat: pixel10.z,
			clearcoatRoughness: pixel10.w,

			// Alpha/transparency
			opacity: pixel11.x,
			transparent: pixel11.z
		};

	} );

	/**
	 * Reads only the essential material properties needed for basic path tracing.
	 * More efficient when only basic properties are needed.
	 *
	 * @param {TSLNode} materialIndex - Material index (int)
	 * @returns {Object} Basic material properties
	 */
	const readBasicMaterial = Fn( ( [ materialIndex ] ) => {

		const basePixel = materialIndex.mul( PIXELS_PER_MATERIAL );

		const pixel1 = readPixel( basePixel );           // color.rgb, metalness
		const pixel2 = readPixel( basePixel.add( 1 ) );  // emissive.rgb, roughness
		const pixel3 = readPixel( basePixel.add( 2 ) );  // ior, transmission, thickness, emissiveIntensity

		return {
			color: pixel1.xyz,
			metalness: pixel1.w,
			emissive: pixel2.xyz,
			roughness: pixel2.w,
			ior: pixel3.x,
			transmission: pixel3.y,
			emissiveIntensity: pixel3.w
		};

	} );

	return {
		readMaterial,
		readBasicMaterial,
		readPixel
	};

};

/**
 * Computes the base reflectance (F0) for a material.
 * F0 determines Fresnel reflectance at normal incidence.
 *
 * For dielectrics: based on IOR
 * For metals: uses base color
 *
 * @param {TSLNode} color - Base color (vec3)
 * @param {TSLNode} metalness - Metalness value (float)
 * @param {TSLNode} ior - Index of refraction (float)
 * @returns {TSLNode} F0 reflectance (vec3)
 */
export const computeF0 = Fn( ( [ color, metalness, ior ] ) => {

	// Dielectric F0 based on IOR: ((n1 - n2) / (n1 + n2))^2
	// Assuming n1 = 1.0 (air)
	const dielectricF0 = ior.sub( 1.0 ).div( ior.add( 1.0 ) ).pow( 2.0 );

	// Dielectric F0 is grayscale (achromatic)
	const dielectricF0Vec = vec3( dielectricF0 );

	// Metals use base color as F0
	// Linear interpolation between dielectric and metallic F0
	return dielectricF0Vec.mix( color, metalness );

} );

/**
 * Classifies a material based on its properties.
 * Useful for choosing sampling strategies.
 *
 * @param {Object} material - Material properties object
 * @returns {Object} Classification flags
 */
export const classifyMaterial = Fn( ( [ color, metalness, roughness, transmission, clearcoat, emissive, emissiveIntensity ] ) => {

	const isMetallic = metalness.greaterThan( 0.7 );
	const isRough = roughness.greaterThan( 0.8 );
	const isSmooth = roughness.lessThan( 0.3 );
	const isTransmissive = transmission.greaterThan( 0.5 );
	const hasClearcoat = clearcoat.greaterThan( 0.01 );

	// Check if emissive (any component > 0 and intensity > 0)
	const emissiveLum = emissive.x.add( emissive.y ).add( emissive.z );
	const isEmissive = emissiveLum.greaterThan( 0.0 ).and( emissiveIntensity.greaterThan( 0.0 ) );

	return {
		isMetallic,
		isRough,
		isSmooth,
		isTransmissive,
		hasClearcoat,
		isEmissive
	};

} );

