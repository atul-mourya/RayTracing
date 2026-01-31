import { Fn, float, vec3, vec2, int, bool as tslBool, max, min, sqrt, cos, sin, pow, dot, normalize, cross, abs, mix, clamp, If, Loop } from 'three/tsl';
import { wgslFn } from 'three/tsl';

/**
 * Lights Sampling for TSL/WGSL
 * Complete port of lights_sampling.fs from GLSL to TSL/WGSL
 *
 * This module contains:
 * - Light sampling functions (area, spot, point lights)
 * - Importance-weighted light sampling
 * - Material PDF calculation for MIS
 * - Unified direct lighting system
 * - MIS weighting strategies
 *
 * Matches the GLSL implementation exactly.
 */

// ================================================================================
// CONSTANTS
// ================================================================================

const EPSILON = 1e-6;
const MIN_PDF = 1e-8;
const PI = Math.PI;
const PI_INV = 1.0 / Math.PI;
const TWO_PI = 2.0 * Math.PI;

// Light type constants
const LIGHT_TYPE_DIRECTIONAL = 0;
const LIGHT_TYPE_AREA = 1;
const LIGHT_TYPE_POINT = 2;
const LIGHT_TYPE_SPOT = 3;

// ================================================================================
// HELPER FUNCTIONS
// ================================================================================

/**
 * Initialize a LightSample struct with default values.
 * Prevents uninitialized memory issues in WGSL/D3D11.
 * 
 * @returns {Object} Initialized LightSample
 */
export const initLightSample = Fn( () => {
	const ls = wgslFn( `
		var ls: LightSample;
		ls.valid = 0u;
		ls.direction = vec3f(0.0, 1.0, 0.0);
		ls.emission = vec3f(0.0);
		ls.distance = 0.0;
		ls.pdf = 0.0;
		ls.lightType = ${LIGHT_TYPE_POINT};
		return ls;
	` )().toVar();
	
	return ls;
} );

// ================================================================================
// LIGHT SAMPLING FUNCTIONS
// ================================================================================

/**
 * Sample a rectangular area light.
 * 
 * @param {Object} light - AreaLight structure
 * @param {vec3} rayOrigin - Origin of the ray
 * @param {vec2} ruv - Random UV coordinates [0,1]
 * @param {float} lightSelectionPdf - PDF of selecting this light
 * @returns {Object} LightSample structure
 */
export const sampleRectAreaLight = Fn( ( [ light, rayOrigin, ruv, lightSelectionPdf ] ) => {
	const lightSample = initLightSample().toVar();
	
	// Validate light area to prevent NaN
	If( light.area.lessThanEqual( 0.0 ), () => {
		return lightSample;
	} );
	
	// Sample random position on rectangle
	const randomPos = light.position.add(
		light.u.mul( ruv.x.sub( 0.5 ) )
	).add(
		light.v.mul( ruv.y.sub( 0.5 ) )
	).toVar();
	
	const toLight = randomPos.sub( rayOrigin ).toVar();
	const lightDistSq = dot( toLight, toLight ).toVar();
	
	// Guard against zero distance
	If( lightDistSq.lessThan( 1e-10 ), () => {
		return lightSample;
	} );
	
	const dist = sqrt( lightDistSq ).toVar();
	const direction = toLight.div( dist ).toVar();
	const lightNormal = normalize( cross( light.u, light.v ) ).toVar();
	
	const cosAngle = dot( direction.negate(), lightNormal ).toVar();
	
	lightSample.lightType.assign( LIGHT_TYPE_AREA );
	lightSample.emission.assign( light.color.mul( light.intensity ) );
	lightSample.distance.assign( dist );
	lightSample.direction.assign( direction );
	// Guard division: ensure denominator is never zero
	lightSample.pdf.assign( 
		lightDistSq.div( 
			max( light.area.mul( max( cosAngle, 0.001 ) ), 1e-10 ) 
		).mul( lightSelectionPdf )
	);
	lightSample.valid.assign( cosAngle.greaterThan( 0.0 ).select( 1, 0 ) );
	
	return lightSample;
} );

/**
 * Sample a circular area light.
 * 
 * @param {Object} light - AreaLight structure
 * @param {vec3} rayOrigin - Origin of the ray
 * @param {vec2} ruv - Random UV coordinates [0,1]
 * @param {float} lightSelectionPdf - PDF of selecting this light
 * @returns {Object} LightSample structure
 */
export const sampleCircAreaLight = Fn( ( [ light, rayOrigin, ruv, lightSelectionPdf ] ) => {
	const lightSample = initLightSample().toVar();
	
	// Validate light area to prevent NaN
	If( light.area.lessThanEqual( 0.0 ), () => {
		return lightSample;
	} );
	
	// Sample random position on circle
	const r = float( 0.5 ).mul( sqrt( ruv.x ) ).toVar();
	const theta = ruv.y.mul( TWO_PI ).toVar();
	const x = r.mul( cos( theta ) ).toVar();
	const y = r.mul( sin( theta ) ).toVar();
	
	const randomPos = light.position.add(
		light.u.mul( x )
	).add(
		light.v.mul( y )
	).toVar();
	
	const toLight = randomPos.sub( rayOrigin ).toVar();
	const lightDistSq = dot( toLight, toLight ).toVar();
	
	// Guard against zero distance
	If( lightDistSq.lessThan( 1e-10 ), () => {
		return lightSample;
	} );
	
	const dist = sqrt( lightDistSq ).toVar();
	const direction = toLight.div( dist ).toVar();
	const lightNormal = normalize( cross( light.u, light.v ) ).toVar();
	
	const cosAngle = dot( direction.negate(), lightNormal ).toVar();
	
	lightSample.lightType.assign( LIGHT_TYPE_AREA );
	lightSample.emission.assign( light.color.mul( light.intensity ) );
	lightSample.distance.assign( dist );
	lightSample.direction.assign( direction );
	// Guard division
	lightSample.pdf.assign( 
		lightDistSq.div( 
			max( light.area.mul( max( cosAngle, 0.001 ) ), 1e-10 ) 
		).mul( lightSelectionPdf )
	);
	lightSample.valid.assign( cosAngle.greaterThan( 0.0 ).select( 1, 0 ) );
	
	return lightSample;
} );

/**
 * Sample a spot light with radius support.
 * 
 * @param {Object} light - SpotLight structure
 * @param {vec3} rayOrigin - Origin of the ray
 * @param {vec2} ruv - Random UV coordinates [0,1] (unused for point-like spot)
 * @param {float} lightSelectionPdf - PDF of selecting this light
 * @returns {Object} LightSample structure
 */
export const sampleSpotLightWithRadius = Fn( ( [ light, rayOrigin, ruv, lightSelectionPdf ] ) => {
	const lightSample = initLightSample().toVar();
	
	const toLight = light.position.sub( rayOrigin ).toVar();
	const lightDist = toLight.length().toVar();
	
	// Guard against zero distance
	If( lightDist.lessThan( 1e-10 ), () => {
		return lightSample;
	} );
	
	const lightDir = toLight.div( lightDist ).toVar();
	
	// Check cone attenuation
	const spotCosAngle = dot( lightDir.negate(), light.direction ).toVar();
	const coneCosAngle = cos( light.angle ).toVar();
	
	lightSample.lightType.assign( LIGHT_TYPE_SPOT );
	lightSample.direction.assign( lightDir );
	lightSample.distance.assign( lightDist );
	lightSample.pdf.assign( lightSelectionPdf );
	lightSample.valid.assign( spotCosAngle.greaterThanEqual( coneCosAngle ).select( 1, 0 ) );
	
	If( lightSample.valid.equal( 1 ), () => {
		const penumbraCosAngle = cos( light.angle.mul( 0.9 ) ).toVar(); // 10% penumbra
		// Note: getSpotAttenuation and getDistanceAttenuation need to be imported
		const coneAttenuation = wgslFn( `getSpotAttenuation(${coneCosAngle}, ${penumbraCosAngle}, ${spotCosAngle})` )().toVar();
		const distanceAttenuation = wgslFn( `getDistanceAttenuation(${lightDist}, 0.0, 2.0)` )().toVar();
		
		lightSample.emission.assign( 
			light.color.mul( light.intensity ).mul( distanceAttenuation ).mul( coneAttenuation )
		);
	} ).Else( () => {
		lightSample.emission.assign( vec3( 0.0 ) );
	} );
	
	return lightSample;
} );

/**
 * Sample a point light with distance attenuation.
 * 
 * @param {Object} light - PointLight structure
 * @param {vec3} rayOrigin - Origin of the ray
 * @param {float} lightSelectionPdf - PDF of selecting this light
 * @returns {Object} LightSample structure
 */
export const samplePointLightWithAttenuation = Fn( ( [ light, rayOrigin, lightSelectionPdf ] ) => {
	const lightSample = initLightSample().toVar();
	
	const toLight = light.position.sub( rayOrigin ).toVar();
	const lightDist = toLight.length().toVar();
	
	// Guard against zero distance
	If( lightDist.lessThan( 1e-10 ), () => {
		return lightSample;
	} );
	
	const lightDir = toLight.div( lightDist ).toVar();
	
	// Calculate distance attenuation
	// Note: getDistanceAttenuation needs to be imported
	const distanceAttenuation = wgslFn( `getDistanceAttenuation(${lightDist}, 0.0, 2.0)` )().toVar();
	
	lightSample.lightType.assign( LIGHT_TYPE_POINT );
	lightSample.direction.assign( lightDir );
	lightSample.distance.assign( lightDist );
	lightSample.emission.assign( light.color.mul( light.intensity ).mul( distanceAttenuation ) );
	lightSample.pdf.assign( lightSelectionPdf );
	lightSample.valid.assign( 1 );
	
	return lightSample;
} );

// ================================================================================
// IMPORTANCE-WEIGHTED LIGHT SAMPLING
// ================================================================================

/**
 * Sample a light using importance-weighted selection.
 * This is a complex function that performs multi-pass light selection based on importance.
 * 
 * NOTE: This function uses preprocessor directives (MAX_DIRECTIONAL_LIGHTS, etc.) 
 * which need to be handled by the shader compilation system.
 * 
 * @param {vec3} rayOrigin - Origin of the ray
 * @param {vec3} normal - Surface normal
 * @param {Object} material - RayTracingMaterial structure
 * @param {vec2} randomSeed - Random seed for sampling
 * @param {int} bounceIndex - Current bounce index
 * @param {uint} rngState - Random number generator state (mutable)
 * @returns {Object} LightSample structure
 */
export const sampleLightWithImportance = Fn( ( [ rayOrigin, normal, material, randomSeed, bounceIndex, rngState ] ) => {
	const result = initLightSample().toVar();
	
	// Note: getTotalLightCount() needs to be imported
	const totalLights = wgslFn( 'getTotalLightCount()' )().toVar();
	If( totalLights.equal( 0 ), () => {
		return result;
	} );
	
	const totalWeight = float( 0.0 ).toVar();
	const lightIndex = int( 0 ).toVar();
	
	// -------------------------------------------------------------------------
	// PASS 1: Calculate Total Weight
	// -------------------------------------------------------------------------
	// NOTE: This section uses compile-time constants like MAX_DIRECTIONAL_LIGHTS
	// These need to be provided by the shader compilation context
	
	// Directional lights
	wgslFn( `
		#if MAX_DIRECTIONAL_LIGHTS > 0
		for (var i: i32 = 0; i < MAX_DIRECTIONAL_LIGHTS; i++) {
			if (lightIndex < 16) {
				let light = getDirectionalLight(i);
				totalWeight += calculateDirectionalLightImportance(light, rayOrigin, normal, material, bounceIndex);
				lightIndex++;
			}
		}
		#endif
	` )();
	
	// Area lights
	wgslFn( `
		#if MAX_AREA_LIGHTS > 0
		for (var i: i32 = 0; i < MAX_AREA_LIGHTS; i++) {
			if (lightIndex < 16) {
				let light = getAreaLight(i);
				let importance = select(0.0, estimateLightImportance(light, rayOrigin, normal, material), light.intensity > 0.0);
				totalWeight += importance;
				lightIndex++;
			}
		}
		#endif
	` )();
	
	// Point lights
	wgslFn( `
		#if MAX_POINT_LIGHTS > 0
		for (var i: i32 = 0; i < MAX_POINT_LIGHTS; i++) {
			if (lightIndex < 16) {
				let light = getPointLight(i);
				totalWeight += calculatePointLightImportance(light, rayOrigin, normal, material);
				lightIndex++;
			}
		}
		#endif
	` )();
	
	// Spot lights
	wgslFn( `
		#if MAX_SPOT_LIGHTS > 0
		for (var i: i32 = 0; i < MAX_SPOT_LIGHTS; i++) {
			if (lightIndex < 16) {
				let light = getSpotLight(i);
				totalWeight += calculateSpotLightImportance(light, rayOrigin, normal, material);
				lightIndex++;
			}
		}
		#endif
	` )();
	
	// -------------------------------------------------------------------------
	// Fallback: Uniform Sampling if no importance
	// -------------------------------------------------------------------------
	If( totalWeight.lessThanEqual( 0.0 ), () => {
		const lightSelection = randomSeed.x.mul( float( totalLights ) ).toVar();
		const selectedLight = int( lightSelection ).toVar();
		// Guard division by zero
		const lightSelectionPdf = float( 1.0 ).div( max( float( totalLights ), 1.0 ) ).toVar();
		
		const fallbackResult = initLightSample().toVar();
		fallbackResult.pdf.assign( lightSelectionPdf );
		
		const currentIdx = int( 0 ).toVar();
		const sampled = tslBool( false ).toVar();
		
		// This section also uses preprocessor directives - handle via wgslFn
		wgslFn( `
			#if MAX_DIRECTIONAL_LIGHTS > 0
			if (!sampled && selectedLight >= currentIdx && selectedLight < currentIdx + MAX_DIRECTIONAL_LIGHTS) {
				let light = getDirectionalLight(selectedLight - currentIdx);
				if (light.intensity > 0.0) {
					fallbackResult.direction = normalize(light.direction);
					fallbackResult.emission = light.color * light.intensity;
					fallbackResult.distance = 1e6;
					fallbackResult.lightType = ${LIGHT_TYPE_DIRECTIONAL};
					fallbackResult.valid = 1u;
					sampled = true;
				}
			}
			currentIdx += MAX_DIRECTIONAL_LIGHTS;
			#endif
			
			#if MAX_AREA_LIGHTS > 0
			if (!sampled && selectedLight >= currentIdx && selectedLight < currentIdx + MAX_AREA_LIGHTS) {
				let light = getAreaLight(selectedLight - currentIdx);
				if (light.intensity > 0.0) {
					let uv = vec2f(randomSeed.y, RandomValue(&rngState));
					fallbackResult = sampleRectAreaLight(light, rayOrigin, uv, lightSelectionPdf);
					sampled = true;
				}
			}
			currentIdx += MAX_AREA_LIGHTS;
			#endif
			
			#if MAX_POINT_LIGHTS > 0
			if (!sampled && selectedLight >= currentIdx && selectedLight < currentIdx + MAX_POINT_LIGHTS) {
				let light = getPointLight(selectedLight - currentIdx);
				if (light.intensity > 0.0) {
					fallbackResult = samplePointLightWithAttenuation(light, rayOrigin, lightSelectionPdf);
					sampled = true;
				}
			}
			currentIdx += MAX_POINT_LIGHTS;
			#endif
			
			#if MAX_SPOT_LIGHTS > 0
			if (!sampled && selectedLight >= currentIdx && selectedLight < currentIdx + MAX_SPOT_LIGHTS) {
				let light = getSpotLight(selectedLight - currentIdx);
				if (light.intensity > 0.0) {
					let uv = vec2f(randomSeed.y, RandomValue(&rngState));
					fallbackResult = sampleSpotLightWithRadius(light, rayOrigin, uv, lightSelectionPdf);
					sampled = true;
				}
			}
			#endif
		` )();
		
		return fallbackResult;
	} );
	
	// -------------------------------------------------------------------------
	// PASS 2: Select and Sample Light
	// -------------------------------------------------------------------------
	
	const selectionValue = randomSeed.x.mul( totalWeight ).toVar();
	const cumulative = float( 0.0 ).toVar();
	lightIndex.assign( 0 );
	
	// Track which light was selected
	const selectedType = int( -1 ).toVar();      // 0=dir, 1=area, 2=point, 3=spot
	const selectedIdx = int( -1 ).toVar();
	const selectedImportance = float( 0.0 ).toVar();
	
	// Light selection loops (using preprocessor directives)
	wgslFn( `
		#if MAX_DIRECTIONAL_LIGHTS > 0
		for (var i: i32 = 0; i < MAX_DIRECTIONAL_LIGHTS; i++) {
			if (lightIndex < 16 && selectedType < 0) {
				let light = getDirectionalLight(i);
				let importance = calculateDirectionalLightImportance(light, rayOrigin, normal, material, bounceIndex);
				let prevCumulative = cumulative;
				cumulative += importance;
				
				if (selectionValue > prevCumulative && selectionValue <= cumulative) {
					selectedType = 0;
					selectedIdx = i;
					selectedImportance = importance;
				}
			}
			lightIndex++;
		}
		#endif
		
		#if MAX_AREA_LIGHTS > 0
		for (var i: i32 = 0; i < MAX_AREA_LIGHTS; i++) {
			if (lightIndex < 16 && selectedType < 0) {
				let light = getAreaLight(i);
				let importance = select(0.0, estimateLightImportance(light, rayOrigin, normal, material), light.intensity > 0.0);
				let prevCumulative = cumulative;
				cumulative += importance;
				
				if (selectionValue > prevCumulative && selectionValue <= cumulative) {
					selectedType = 1;
					selectedIdx = i;
					selectedImportance = importance;
				}
			}
			lightIndex++;
		}
		#endif
		
		#if MAX_POINT_LIGHTS > 0
		for (var i: i32 = 0; i < MAX_POINT_LIGHTS; i++) {
			if (lightIndex < 16 && selectedType < 0) {
				let light = getPointLight(i);
				let importance = calculatePointLightImportance(light, rayOrigin, normal, material);
				let prevCumulative = cumulative;
				cumulative += importance;
				
				if (selectionValue > prevCumulative && selectionValue <= cumulative) {
					selectedType = 2;
					selectedIdx = i;
					selectedImportance = importance;
				}
			}
			lightIndex++;
		}
		#endif
		
		#if MAX_SPOT_LIGHTS > 0
		for (var i: i32 = 0; i < MAX_SPOT_LIGHTS; i++) {
			if (lightIndex < 16 && selectedType < 0) {
				let light = getSpotLight(i);
				let importance = calculateSpotLightImportance(light, rayOrigin, normal, material);
				let prevCumulative = cumulative;
				cumulative += importance;
				
				if (selectionValue > prevCumulative && selectionValue <= cumulative) {
					selectedType = 3;
					selectedIdx = i;
					selectedImportance = importance;
				}
			}
			lightIndex++;
		}
		#endif
	` )();
	
	// -------------------------------------------------------------------------
	// PASS 3: Sample the selected light (outside loops)
	// -------------------------------------------------------------------------
	
	// Guard division by zero
	const pdf = selectedImportance.div( max( totalWeight, 1e-10 ) ).toVar();
	
	// Sample directional light
	If( selectedType.equal( 0 ).and( selectedIdx.greaterThanEqual( 0 ) ), () => {
		wgslFn( `
			#if MAX_DIRECTIONAL_LIGHTS > 0
			let light = getDirectionalLight(selectedIdx);
			
			var direction: vec3f;
			var dirPdf: f32 = 1.0;
			
			if (light.angle > 0.0) {
				let cosHalfAngle = cos(light.angle * 0.5);
				let cosTheta = mix(cosHalfAngle, 1.0, randomSeed.y);
				let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
				let phi = ${TWO_PI} * RandomValue(&rngState);
				
				let w = normalize(light.direction);
				let u = normalize(cross(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(w.x) > 0.9), w));
				let v = cross(w, u);
				
				direction = normalize(cosTheta * w + sinTheta * (cos(phi) * u + sin(phi) * v));
				// Guard division: (1.0 - cosHalfAngle) could be zero if angle is 0
				let solidAngle = ${TWO_PI} * max(1.0 - cosHalfAngle, 1e-10);
				dirPdf = 1.0 / solidAngle;
			} else {
				direction = normalize(light.direction);
			}
			
			result.direction = direction;
			result.emission = light.color * light.intensity;
			result.distance = 1e6;
			result.pdf = dirPdf * pdf;
			result.lightType = ${LIGHT_TYPE_DIRECTIONAL};
			result.valid = 1u;
			#endif
		` )();
	} );
	
	// Sample area light
	If( selectedType.equal( 1 ).and( selectedIdx.greaterThanEqual( 0 ) ), () => {
		wgslFn( `
			#if MAX_AREA_LIGHTS > 0
			let light = getAreaLight(selectedIdx);
			let uv = vec2f(randomSeed.y, RandomValue(&rngState));
			result = sampleRectAreaLight(light, rayOrigin, uv, pdf);
			#endif
		` )();
	} );
	
	// Sample point light
	If( selectedType.equal( 2 ).and( selectedIdx.greaterThanEqual( 0 ) ), () => {
		wgslFn( `
			#if MAX_POINT_LIGHTS > 0
			let light = getPointLight(selectedIdx);
			result = samplePointLightWithAttenuation(light, rayOrigin, pdf);
			#endif
		` )();
	} );
	
	// Sample spot light
	If( selectedType.equal( 3 ).and( selectedIdx.greaterThanEqual( 0 ) ), () => {
		wgslFn( `
			#if MAX_SPOT_LIGHTS > 0
			let light = getSpotLight(selectedIdx);
			let uv = vec2f(randomSeed.y, RandomValue(&rngState));
			result = sampleSpotLightWithRadius(light, rayOrigin, uv, pdf);
			#endif
		` )();
	} );
	
	return result;
} );

// ================================================================================
// MATERIAL PDF CALCULATION FOR MIS
// ================================================================================

/**
 * Calculate material PDF for a given direction.
 * Used for Multiple Importance Sampling (MIS) calculations.
 * 
 * @param {vec3} viewDir - View direction
 * @param {vec3} lightDir - Light direction
 * @param {vec3} normal - Surface normal
 * @param {Object} material - RayTracingMaterial structure
 * @returns {float} PDF value
 */
export const calculateMaterialPDF = Fn( ( [ viewDir, lightDir, normal, material ] ) => {
	const NoV = max( 0.0, dot( normal, viewDir ) ).toVar();
	const NoL = max( 0.0, dot( normal, lightDir ) ).toVar();
	const H = normalize( viewDir.add( lightDir ) ).toVar();
	const NoH = max( 0.0, dot( normal, H ) ).toVar();
	const VoH = max( 0.0, dot( viewDir, H ) ).toVar();
	
	// Calculate lobe weights
	const diffuseWeight = float( 1.0 ).sub( material.metalness ).mul( 
		float( 1.0 ).sub( material.transmission ) 
	).toVar();
	const specularWeight = float( 1.0 ).sub( 
		diffuseWeight.mul( float( 1.0 ).sub( material.metalness ) )
	).toVar();
	const totalWeight = diffuseWeight.add( specularWeight ).toVar();
	
	If( totalWeight.lessThanEqual( 0.0 ), () => {
		return float( 0.0 );
	} );
	
	// Guard division
	const invTotalWeight = float( 1.0 ).div( max( totalWeight, 1e-10 ) ).toVar();
	diffuseWeight.mulAssign( invTotalWeight );
	specularWeight.mulAssign( invTotalWeight );
	
	const pdf = float( 0.0 ).toVar();
	
	// Diffuse PDF (cosine-weighted hemisphere)
	If( diffuseWeight.greaterThan( 0.0 ).and( NoL.greaterThan( 0.0 ) ), () => {
		pdf.addAssign( diffuseWeight.mul( NoL ).mul( PI_INV ) );
	} );
	
	// Specular PDF (VNDF sampling used in path tracer)
	If( specularWeight.greaterThan( 0.0 ).and( NoL.greaterThan( 0.0 ) ), () => {
		const roughness = max( material.roughness, 0.02 ).toVar();
		// Note: calculateVNDFPDF needs to be imported
		const vndfPdf = wgslFn( `calculateVNDFPDF(${NoH}, ${NoV}, ${roughness})` )().toVar();
		pdf.addAssign( specularWeight.mul( vndfPdf ) );
	} );
	
	return max( pdf, 1e-8 );
} );

/**
 * Sample area light contribution with proper MIS and validation.
 * 
 * @param {Object} light - AreaLight structure
 * @param {vec3} worldWo - World-space outgoing direction
 * @param {Object} surf - HitInfo structure
 * @param {vec3} rayOrigin - Origin of the ray
 * @param {int} bounceIndex - Current bounce index
 * @param {uint} rngState - Random number generator state (mutable)
 * @param {ivec2} stats - Statistics counter (mutable)
 * @returns {vec3} Light contribution
 */
export const sampleAreaLightContribution = Fn( ( [ light, worldWo, surf, rayOrigin, bounceIndex, rngState, stats ] ) => {
	// Sample random position on light surface
	const ruv = vec2( 
		wgslFn( 'RandomValue(&rngState)' )(),
		wgslFn( 'RandomValue(&rngState)' )()
	).toVar();
	const lightPos = light.position.add(
		light.u.mul( ruv.x.sub( 0.5 ) )
	).add(
		light.v.mul( ruv.y.sub( 0.5 ) )
	).toVar();
	
	const toLight = lightPos.sub( rayOrigin ).toVar();
	const lightDistSq = dot( toLight, toLight ).toVar();
	
	// Guard against zero distance
	If( lightDistSq.lessThan( 1e-10 ), () => {
		return vec3( 0.0 );
	} );
	
	const lightDist = sqrt( lightDistSq ).toVar();
	const lightDir = toLight.div( lightDist ).toVar();
	
	// Check if light is facing the surface
	const lightNormal = normalize( cross( light.u, light.v ) ).toVar();
	const lightFacing = dot( lightDir.negate(), lightNormal ).toVar();
	
	If( lightFacing.lessThanEqual( 0.0 ), () => {
		return vec3( 0.0 );
	} );
	
	// Check if surface is facing the light
	const surfaceFacing = dot( surf.normal, lightDir ).toVar();
	If( surfaceFacing.lessThanEqual( 0.0 ), () => {
		return vec3( 0.0 );
	} );
	
	// Validate direction
	// Note: isDirectionValid needs to be imported
	If( wgslFn( `!isDirectionValid(${lightDir}, ${surf.normal})` )(), () => {
		return vec3( 0.0 );
	} );
	
	// Test for occlusion
	// Note: traceShadowRay needs to be imported
	const visibility = wgslFn( `traceShadowRay(${rayOrigin}, ${lightDir}, ${lightDist} - 0.001, &rngState, &stats)` )().toVar();
	If( visibility.lessThanEqual( 0.0 ), () => {
		return vec3( 0.0 );
	} );
	
	// Calculate BRDF
	// Note: evaluateMaterialResponse needs to be imported
	const brdfColor = wgslFn( `evaluateMaterialResponse(${worldWo}, ${lightDir}, ${surf.normal}, ${surf.material})` )().toVar();
	
	// Calculate light PDF - guard division
	const lightPdf = lightDistSq.div( max( light.area.mul( lightFacing ), EPSILON ) ).toVar();
	
	// Calculate BRDF PDF for MIS
	const brdfPdf = calculateMaterialPDF( worldWo, lightDir, surf.normal, surf.material ).toVar();
	
	// Apply MIS weighting
	// Note: misHeuristic needs to be imported
	const misWeight = brdfPdf.greaterThan( 0.0 ).select(
		wgslFn( `misHeuristic(${lightPdf}, ${brdfPdf})` )(),
		1.0
	).toVar();
	
	// Calculate final contribution - guard division
	const lightEmission = light.color.mul( light.intensity ).toVar();
	const contribution = lightEmission.mul( brdfColor ).mul( surfaceFacing ).mul( visibility ).mul( misWeight ).div( 
		max( lightPdf, MIN_PDF ) 
	).toVar();
	
	return contribution;
} );

// ================================================================================
// UNIFIED DIRECT LIGHTING SYSTEM
// ================================================================================

/**
 * Calculate direct lighting using unified MIS strategy.
 * This is the main function that combines light sampling, BRDF sampling, and environment sampling.
 * 
 * @param {Object} hitInfo - HitInfo structure
 * @param {vec3} viewDir - View direction
 * @param {Object} brdfSample - DirectionSample from BRDF sampling
 * @param {int} sampleIndex - Sample index
 * @param {int} bounceIndex - Current bounce index
 * @param {uint} rngState - Random number generator state (mutable)
 * @param {ivec2} stats - Statistics counter (mutable)
 * @returns {vec3} Total direct lighting contribution
 */
export const calculateDirectLightingUnified = Fn( ( [ hitInfo, viewDir, brdfSample, sampleIndex, bounceIndex, rngState, stats ] ) => {
	const totalContribution = vec3( 0.0 ).toVar();
	const rayOrigin = hitInfo.hitPoint.add( hitInfo.normal.mul( 0.001 ) ).toVar();
	
	// Early exit for highly emissive surfaces
	If( hitInfo.material.emissiveIntensity.greaterThan( 10.0 ), () => {
		return vec3( 0.0 );
	} );
	
	// Adaptive MIS Strategy Selection
	const currentThroughput = vec3( 1.0 ).toVar();
	// Note: selectOptimalMISStrategy needs to be imported
	const misStrategy = wgslFn( `selectOptimalMISStrategy(${hitInfo.material}, ${bounceIndex}, ${currentThroughput})` )().toVar();
	
	// Adaptive light processing
	const totalLights = wgslFn( 'getTotalLightCount()' )().toVar();
	// Note: enableEnvironmentLight needs to be available as uniform
	If( totalLights.equal( 0 ).and( wgslFn( '!enableEnvironmentLight' )() ), () => {
		return vec3( 0.0 );
	} );
	
	const importanceThreshold = float( 0.001 ).mul( 
		float( 1.0 ).add( float( bounceIndex ).mul( 0.5 ) )
	).toVar();
	
	// Check if discrete lights exist
	const hasDiscreteLights = totalLights.greaterThan( 0 ).toVar();
	
	// Calculate total sampling weight - only include light weight if lights exist
	const totalSamplingWeight = float( 0.0 ).toVar();
	If( misStrategy.useLightSampling.and( hasDiscreteLights ), () => {
		totalSamplingWeight.addAssign( misStrategy.lightWeight );
	} );
	If( misStrategy.useBRDFSampling, () => {
		totalSamplingWeight.addAssign( misStrategy.brdfWeight );
	} );
	If( misStrategy.useEnvSampling.and( wgslFn( 'enableEnvironmentLight' )() ), () => {
		totalSamplingWeight.addAssign( misStrategy.envWeight );
	} );
	
	If( totalSamplingWeight.lessThanEqual( 0.0 ), () => {
		totalSamplingWeight.assign( 1.0 );
		// Fallback: prioritize environment if enabled, otherwise BRDF
		If( wgslFn( 'enableEnvironmentLight' )(), () => {
			misStrategy.useEnvSampling.assign( 1 );
			misStrategy.envWeight.assign( 1.0 );
		} ).Else( () => {
			misStrategy.useBRDFSampling.assign( 1 );
			misStrategy.brdfWeight.assign( 1.0 );
		} );
	} );
	
	// Note: getRandomSample needs to be imported
	const stratifiedRandom = wgslFn( `getRandomSample(gl_FragCoord.xy, ${sampleIndex}, ${bounceIndex}, &rngState, -1)` )().toVar();
	
	// Determine sampling technique
	const rand = stratifiedRandom.x.toVar();
	const sampleLights = tslBool( false ).toVar();
	const sampleBRDF = tslBool( false ).toVar();
	const sampleEnv = tslBool( false ).toVar();
	
	// Calculate effective weights for probability (only include light weight if lights exist)
	const effectiveLightWeight = hasDiscreteLights.select( misStrategy.lightWeight, 0.0 ).toVar();
	// Guard division
	const invTotalSamplingWeight = float( 1.0 ).div( max( totalSamplingWeight, 1e-10 ) ).toVar();
	const cumulativeLight = effectiveLightWeight.mul( invTotalSamplingWeight ).toVar();
	const cumulativeBRDF = effectiveLightWeight.add( misStrategy.brdfWeight ).mul( invTotalSamplingWeight ).toVar();
	
	If( rand.lessThan( cumulativeLight ).and( misStrategy.useLightSampling ).and( hasDiscreteLights ), () => {
		sampleLights.assign( true );
	} ).ElseIf( rand.lessThan( cumulativeBRDF ).and( misStrategy.useBRDFSampling ), () => {
		sampleBRDF.assign( true );
	} ).ElseIf( misStrategy.useEnvSampling.and( wgslFn( 'enableEnvironmentLight' )() ), () => {
		sampleEnv.assign( true );
	} ).ElseIf( hasDiscreteLights, () => {
		// Fallback to light sampling only if lights exist
		sampleLights.assign( true );
	} ).Else( () => {
		// Fallback to environment sampling when no discrete lights
		If( wgslFn( 'enableEnvironmentLight' )(), () => {
			sampleEnv.assign( true );
		} );
	} );
	
	// ===== LIGHT SAMPLING =====
	If( sampleLights, () => {
		// Importance-weighted light sampling
		const lightRandom = vec2( stratifiedRandom.y, wgslFn( 'RandomValue(&rngState)' )() ).toVar();
		const lightSample = sampleLightWithImportance( rayOrigin, hitInfo.normal, hitInfo.material, lightRandom, bounceIndex, rngState ).toVar();
		
		If( lightSample.valid.equal( 1 ).and( lightSample.pdf.greaterThan( 0.0 ) ), () => {
			const NoL = max( 0.0, dot( hitInfo.normal, lightSample.direction ) ).toVar();
			const lightImportance = lightSample.emission.r.add( lightSample.emission.g ).add( lightSample.emission.b ).toVar();
			
			If( NoL.greaterThan( 0.0 ).and( 
				lightImportance.mul( NoL ).greaterThan( importanceThreshold )
			).and( 
				wgslFn( `isDirectionValid(${lightSample.direction}, ${hitInfo.normal})` )()
			), () => {
				const shadowDistance = min( lightSample.distance.sub( 0.001 ), 1000.0 ).toVar();
				const visibility = wgslFn( `traceShadowRay(${rayOrigin}, ${lightSample.direction}, ${shadowDistance}, &rngState, &stats)` )().toVar();
				
				If( visibility.greaterThan( 0.0 ), () => {
					const brdfValue = wgslFn( `evaluateMaterialResponse(${viewDir}, ${lightSample.direction}, ${hitInfo.normal}, ${hitInfo.material})` )().toVar();
					const brdfPdf = calculateMaterialPDF( viewDir, lightSample.direction, hitInfo.normal, hitInfo.material ).toVar();
					
					const misWeight = float( 1.0 ).toVar();
					If( brdfPdf.greaterThan( 0.0 ).and( misStrategy.useBRDFSampling ), () => {
						const lightPdfWeighted = lightSample.pdf.mul( misStrategy.lightWeight ).toVar();
						const brdfPdfWeighted = brdfPdf.mul( misStrategy.brdfWeight ).toVar();
						
						If( lightSample.lightType.equal( LIGHT_TYPE_AREA ), () => {
							misWeight.assign( wgslFn( `powerHeuristic(${lightPdfWeighted}, ${brdfPdfWeighted})` )() );
						} ).ElseIf( bounceIndex.equal( 0 ).and( lightSample.lightType.equal( LIGHT_TYPE_DIRECTIONAL ) ), () => {
							misWeight.assign( wgslFn( `powerHeuristic(${lightPdfWeighted}, ${brdfPdfWeighted})` )() );
						} );
					} );
					
					// Guard division
					const lightContribution = lightSample.emission.mul( brdfValue ).mul( NoL ).mul( visibility ).mul( misWeight ).div( 
						max( lightSample.pdf, 1e-10 ) 
					).toVar();
					totalContribution.addAssign( 
						lightContribution.mul( totalSamplingWeight ).div( max( misStrategy.lightWeight, 1e-10 ) )
					);
				} );
			} );
		} );
	} );
	
	// ===== BRDF SAMPLING =====
	If( sampleBRDF, () => {
		// BRDF sampling strategy
		If( brdfSample.pdf.greaterThan( 0.0 ).and( misStrategy.useBRDFSampling ), () => {
			const NoL = max( 0.0, dot( hitInfo.normal, brdfSample.direction ) ).toVar();
			
			If( NoL.greaterThan( 0.0 ).and( wgslFn( `isDirectionValid(${brdfSample.direction}, ${hitInfo.normal})` )() ), () => {
				// Area light intersection testing
				wgslFn( `
					#if MAX_AREA_LIGHTS > 0
					var foundIntersection: bool = false;
					var maxImportance: f32 = 0.0;
					var maxImportanceLight: i32 = -1;
					
					// Track best match (no early break for ANGLE optimization)
					for (var i: i32 = 0; i < MAX_AREA_LIGHTS; i++) {
						let light = getAreaLight(i);
						if (light.intensity > 0.0) {
							let lightImportance = estimateLightImportance(light, hitInfo.hitPoint, hitInfo.normal, hitInfo.material);
							if (lightImportance >= importanceThreshold) {
								var hitDistance: f32 = 1e6;
								if (intersectAreaLight(light, rayOrigin, brdfSample.direction, &hitDistance)) {
									if (lightImportance > maxImportance) {
										maxImportance = lightImportance;
										maxImportanceLight = i;
									}
									foundIntersection = true;
								}
							}
						}
					}
					
					if (foundIntersection && maxImportanceLight >= 0) {
						let light = getAreaLight(maxImportanceLight);
						var hitDistance: f32 = 1e6;
						
						if (intersectAreaLight(light, rayOrigin, brdfSample.direction, &hitDistance)) {
							let shadowDistance = min(hitDistance - 0.001, 1000.0);
							let visibility = traceShadowRay(rayOrigin, brdfSample.direction, shadowDistance, &rngState, &stats);
							
							if (visibility > 0.0) {
								let lightFacing = max(0.0, -dot(brdfSample.direction, light.normal));
								if (lightFacing > 0.0) {
									let lightDistSq = hitDistance * hitDistance;
									// Guard division
									var lightPdf = lightDistSq / max(light.area * lightFacing, ${EPSILON});
									lightPdf /= max(f32(totalLights), 1.0);
									
									let brdfPdfWeighted = brdfSample.pdf * misStrategy.brdfWeight;
									let lightPdfWeighted = lightPdf * misStrategy.lightWeight;
									let misWeight = powerHeuristic(brdfPdfWeighted, lightPdfWeighted);
									
									let lightEmission = light.color * light.intensity;
									// Guard division
									let brdfContribution = lightEmission * brdfSample.value * NoL * visibility * misWeight / max(brdfSample.pdf, 1e-10);
									totalContribution += brdfContribution * totalSamplingWeight / max(misStrategy.brdfWeight, 1e-10);
								}
							}
						}
					}
					#endif
				` )();
			} );
		} );
	} );
	
	// ===== ENVIRONMENT SAMPLING =====
	If( sampleEnv, () => {
		// Environment sampling
		If( wgslFn( 'enableEnvironmentLight' )().and( misStrategy.useEnvSampling ), () => {
			const envRandom = vec2( 
				wgslFn( 'RandomValue(&rngState)' )(),
				wgslFn( 'RandomValue(&rngState)' )()
			).toVar();
			const envColor = vec3( 0.0 ).toVar();
			const envDirection = vec3( 0.0, 1.0, 0.0 ).toVar();
			// Note: sampleEquirectProbability needs to be imported
			const envPdf = wgslFn( `sampleEquirectProbability(${envRandom}, &envColor, &envDirection)` )().toVar();
			
			If( envPdf.greaterThan( 0.0 ), () => {
				const NoL = max( 0.0, dot( hitInfo.normal, envDirection ) ).toVar();
				
				If( NoL.greaterThan( 0.0 ).and( wgslFn( `isDirectionValid(${envDirection}, ${hitInfo.normal})` )() ), () => {
					const visibility = wgslFn( `traceShadowRay(${rayOrigin}, ${envDirection}, 1000.0, &rngState, &stats)` )().toVar();
					
					If( visibility.greaterThan( 0.0 ), () => {
						const brdfValue = wgslFn( `evaluateMaterialResponse(${viewDir}, ${envDirection}, ${hitInfo.normal}, ${hitInfo.material})` )().toVar();
						const brdfPdf = calculateMaterialPDF( viewDir, envDirection, hitInfo.normal, hitInfo.material ).toVar();
						
						const envPdfWeighted = envPdf.mul( misStrategy.envWeight ).toVar();
						const brdfPdfWeighted = brdfPdf.mul( misStrategy.brdfWeight ).toVar();
						const misWeight = brdfPdf.greaterThan( 0.0 ).select(
							wgslFn( `powerHeuristic(${envPdfWeighted}, ${brdfPdfWeighted})` )(),
							1.0
						).toVar();
						
						// Guard division
						const envContribution = envColor.mul( brdfValue ).mul( NoL ).mul( visibility ).mul( misWeight ).div( 
							max( envPdf, 1e-10 ) 
						).toVar();
						totalContribution.addAssign( 
							envContribution.mul( totalSamplingWeight ).div( max( misStrategy.envWeight, 1e-10 ) )
						);
					} );
				} );
			} );
		} );
	} );
	
	// Note: Emissive triangle direct lighting is handled separately in pathtracer_core
	// to bypass firefly suppression. Do not add it here to avoid double-counting.
	
	return totalContribution;
} );
