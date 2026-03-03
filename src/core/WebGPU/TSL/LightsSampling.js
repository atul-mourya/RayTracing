/**
 * LightsSampling.js - Light Sampling and Unified Direct Lighting
 *
 * Exact port of lights_sampling.fs
 * Pure TSL: Fn(), If(), Loop(), .toVar(), .assign() — NO wgslFn()
 *
 * Contains:
 *  - initLightSample                  — fully initialize LightSample
 *  - sampleRectAreaLight              — rectangle area light sampling
 *  - sampleCircAreaLight              — circle area light sampling
 *  - sampleSpotLightWithRadius        — spot light sampling with radius
 *  - samplePointLightWithAttenuation  — point light sampling with attenuation
 *  - sampleLightWithImportance        — importance-weighted light selection (3-pass)
 *  - calculateMaterialPDF             — material PDF for MIS
 *  - sampleAreaLightContribution      — area light with MIS
 *  - calculateDirectLightingUnified   — unified direct lighting (main entry)
 */

import {
	Fn,
	float,
	vec2,
	vec3,
	vec4,
	int,
	uint,
	bool as tslBool,
	max,
	min,
	abs,
	sqrt,
	cos,
	sin,
	dot,
	cross,
	normalize,
	length,
	clamp,
	mix,
	select,
	If,
	Loop,
	Break,
	texture,
} from 'three/tsl';

import {
	DirectionalLight, AreaLight, PointLight, SpotLight,
	LightSample,
	LIGHT_TYPE_DIRECTIONAL,
	LIGHT_TYPE_AREA,
	LIGHT_TYPE_POINT,
	LIGHT_TYPE_SPOT,
	getDirectionalLight,
	getAreaLight,
	getPointLight,
	getSpotLight,
	isDirectionValid,
	getDistanceAttenuation,
	getSpotAttenuation,
	intersectAreaLight,
} from './LightsCore.js';

import { MISStrategy } from './Struct.js';
import {
	calculateDirectionalLightImportance,
	estimateLightImportance,
	calculatePointLightImportance,
	calculateSpotLightImportance,
	traceShadowRay,
} from './LightsDirect.js';

import { traverseBVHShadow } from './BVHTraversal.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { calculateVNDFPDF } from './MaterialProperties.js';
import { RandomValue } from './Random.js';
import {
	selectOptimalMISStrategy,
	PI,
	PI_INV,
	EPSILON,
	MIN_PDF,
	powerHeuristic,
} from './Common.js';
import {
	sampleEquirectProbability,
	sampleEquirect,
} from './Environment.js';

const TWO_PI = 2.0 * PI;

// =============================================================================
// Helper: Fully Initialize LightSample
// =============================================================================

export const initLightSample = Fn( () => {

	return LightSample( {
		valid: tslBool( false ),
		direction: vec3( 0.0, 1.0, 0.0 ),
		emission: vec3( 0.0 ),
		distance: float( 0.0 ),
		pdf: float( 0.0 ),
		lightType: int( LIGHT_TYPE_POINT ),
	} );

} );

// =============================================================================
// Light Sampling Functions
// =============================================================================

// Enhanced area light sampling - rectangle
export const sampleRectAreaLight = Fn( ( [ light, rayOrigin, ruv, lightSelectionPdf ] ) => {

	// Result variables (no early return in TSL)
	const ls_valid = tslBool( false ).toVar();
	const ls_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const ls_emission = vec3( 0.0 ).toVar();
	const ls_distance = float( 0.0 ).toVar();
	const ls_pdf = float( 0.0 ).toVar();
	const ls_lightType = int( LIGHT_TYPE_POINT ).toVar();

	// Validate light area to prevent NaN
	If( light.area.greaterThan( 0.0 ), () => {

		// Sample random position on rectangle
		const randomPos = light.position
			.add( light.u.mul( ruv.x.sub( 0.5 ) ) )
			.add( light.v.mul( ruv.y.sub( 0.5 ) ) )
			.toVar();

		const toLight = randomPos.sub( rayOrigin ).toVar();
		const lightDistSq = dot( toLight, toLight ).toVar();

		// Guard against zero distance
		If( lightDistSq.greaterThanEqual( 1e-10 ), () => {

			const dist = sqrt( lightDistSq ).toVar();
			const direction = toLight.div( dist ).toVar();
			const lightNormal = normalize( cross( light.u, light.v ) ).toVar();
			const cosAngle = dot( direction.negate(), lightNormal ).toVar();

			ls_lightType.assign( int( LIGHT_TYPE_AREA ) );
			ls_emission.assign( light.color.mul( light.intensity ) );
			ls_distance.assign( dist );
			ls_direction.assign( direction );
			// Guard division: ensure denominator is never zero
			ls_pdf.assign(
				lightDistSq.div( max( light.area.mul( max( cosAngle, 0.001 ) ), 1e-10 ) ).mul( lightSelectionPdf )
			);
			ls_valid.assign( cosAngle.greaterThan( 0.0 ) );

		} );

	} );

	return LightSample( {
		valid: ls_valid,
		direction: ls_direction,
		emission: ls_emission,
		distance: ls_distance,
		pdf: ls_pdf,
		lightType: ls_lightType,
	} );

} );

// Enhanced area light sampling - circle
export const sampleCircAreaLight = Fn( ( [ light, rayOrigin, ruv, lightSelectionPdf ] ) => {

	const ls_valid = tslBool( false ).toVar();
	const ls_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const ls_emission = vec3( 0.0 ).toVar();
	const ls_distance = float( 0.0 ).toVar();
	const ls_pdf = float( 0.0 ).toVar();
	const ls_lightType = int( LIGHT_TYPE_POINT ).toVar();

	// Validate light area to prevent NaN
	If( light.area.greaterThan( 0.0 ), () => {

		// Sample random position on circle
		const r = float( 0.5 ).mul( sqrt( ruv.x ) ).toVar();
		const theta = ruv.y.mul( TWO_PI ).toVar();
		const x = r.mul( cos( theta ) ).toVar();
		const y = r.mul( sin( theta ) ).toVar();

		const randomPos = light.position
			.add( light.u.mul( x ) )
			.add( light.v.mul( y ) )
			.toVar();

		const toLight = randomPos.sub( rayOrigin ).toVar();
		const lightDistSq = dot( toLight, toLight ).toVar();

		// Guard against zero distance
		If( lightDistSq.greaterThanEqual( 1e-10 ), () => {

			const dist = sqrt( lightDistSq ).toVar();
			const direction = toLight.div( dist ).toVar();
			const lightNormal = normalize( cross( light.u, light.v ) ).toVar();
			const cosAngle = dot( direction.negate(), lightNormal ).toVar();

			ls_lightType.assign( int( LIGHT_TYPE_AREA ) );
			ls_emission.assign( light.color.mul( light.intensity ) );
			ls_distance.assign( dist );
			ls_direction.assign( direction );
			// Guard division
			ls_pdf.assign(
				lightDistSq.div( max( light.area.mul( max( cosAngle, 0.001 ) ), 1e-10 ) ).mul( lightSelectionPdf )
			);
			ls_valid.assign( cosAngle.greaterThan( 0.0 ) );

		} );

	} );

	return LightSample( {
		valid: ls_valid,
		direction: ls_direction,
		emission: ls_emission,
		distance: ls_distance,
		pdf: ls_pdf,
		lightType: ls_lightType,
	} );

} );

// Enhanced spot light sampling with radius support
export const sampleSpotLightWithRadius = Fn( ( [ light, rayOrigin, ruv, lightSelectionPdf ] ) => {

	const ls_valid = tslBool( false ).toVar();
	const ls_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const ls_emission = vec3( 0.0 ).toVar();
	const ls_distance = float( 0.0 ).toVar();
	const ls_pdf = float( 0.0 ).toVar();
	const ls_lightType = int( LIGHT_TYPE_SPOT ).toVar();

	const toLight = light.position.sub( rayOrigin ).toVar();
	const lightDist = length( toLight ).toVar();

	// Guard against zero distance
	If( lightDist.greaterThanEqual( 1e-10 ), () => {

		const lightDir = toLight.div( lightDist ).toVar();

		// Check cone attenuation
		const spotCosAngle = dot( lightDir.negate(), light.direction ).toVar();
		const coneCosAngle = cos( light.angle ).toVar();

		ls_direction.assign( lightDir );
		ls_distance.assign( lightDist );
		ls_pdf.assign( lightSelectionPdf );
		ls_valid.assign( spotCosAngle.greaterThanEqual( coneCosAngle ) );

		If( ls_valid, () => {

			const penumbraCosAngle = cos( light.angle.mul( 0.9 ) ).toVar(); // 10% penumbra
			const coneAttenuation = getSpotAttenuation( { coneCosine: coneCosAngle, penumbraCosine: penumbraCosAngle, angleCosine: spotCosAngle } );
			const distanceAttenuation = getDistanceAttenuation( { lightDistance: lightDist, cutoffDistance: float( 0.0 ), decayExponent: float( 2.0 ) } );

			ls_emission.assign( light.color.mul( light.intensity ).mul( distanceAttenuation ).mul( coneAttenuation ) );

		} );

	} );

	return LightSample( {
		valid: ls_valid,
		direction: ls_direction,
		emission: ls_emission,
		distance: ls_distance,
		pdf: ls_pdf,
		lightType: ls_lightType,
	} );

} );

// Enhanced point light sampling with distance attenuation
export const samplePointLightWithAttenuation = Fn( ( [ light, rayOrigin, lightSelectionPdf ] ) => {

	const ls_valid = tslBool( false ).toVar();
	const ls_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const ls_emission = vec3( 0.0 ).toVar();
	const ls_distance = float( 0.0 ).toVar();
	const ls_pdf = float( 0.0 ).toVar();
	const ls_lightType = int( LIGHT_TYPE_POINT ).toVar();

	const toLight = light.position.sub( rayOrigin ).toVar();
	const lightDist = length( toLight ).toVar();

	// Guard against zero distance
	If( lightDist.greaterThanEqual( 1e-10 ), () => {

		const lightDir = toLight.div( lightDist ).toVar();

		// Calculate distance attenuation
		const distanceAttenuation = getDistanceAttenuation( { lightDistance: lightDist, cutoffDistance: float( 0.0 ), decayExponent: float( 2.0 ) } );

		ls_lightType.assign( int( LIGHT_TYPE_POINT ) );
		ls_direction.assign( lightDir );
		ls_distance.assign( lightDist );
		ls_emission.assign( light.color.mul( light.intensity ).mul( distanceAttenuation ) );
		ls_pdf.assign( lightSelectionPdf );
		ls_valid.assign( tslBool( true ) );

	} );

	return LightSample( {
		valid: ls_valid,
		direction: ls_direction,
		emission: ls_emission,
		distance: ls_distance,
		pdf: ls_pdf,
		lightType: ls_lightType,
	} );

} );

// =============================================================================
// Importance-Weighted Light Sampling
// =============================================================================

// ANGLE-optimized: No early returns in loops, full initialization
// 3-pass approach: 1) calculate total weight, 2) select light via CDF, 3) sample selected light
export const sampleLightWithImportance = Fn( ( [
	rayOrigin, normal, material, randomSeed, bounceIndex, rngState,
	// Light buffers + counts
	directionalLightsBuffer, numDirectionalLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
] ) => {

	// Result variables
	const r_valid = tslBool( false ).toVar();
	const r_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const r_emission = vec3( 0.0 ).toVar();
	const r_distance = float( 0.0 ).toVar();
	const r_pdf = float( 0.0 ).toVar();
	const r_lightType = int( LIGHT_TYPE_POINT ).toVar();

	const totalLights = numDirectionalLights.add( numAreaLights ).add( numPointLights ).add( numSpotLights ).toVar();

	If( totalLights.greaterThan( int( 0 ) ), () => {

		const totalWeight = float( 0.0 ).toVar();
		const lightIndex = int( 0 ).toVar();

		// =====================================================================
		// PASS 1: Calculate Total Weight (no early exits)
		// =====================================================================

		If( numDirectionalLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numDirectionalLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( lightIndex.lessThan( int( 16 ) ), () => {

					const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, i ) );
					totalWeight.addAssign( calculateDirectionalLightImportance( light, rayOrigin, normal, material, bounceIndex ) );
					lightIndex.addAssign( 1 );

				} );

			} );

		} );

		If( numAreaLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numAreaLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( lightIndex.lessThan( int( 16 ) ), () => {

					const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, i ) );
					const importance = select( light.intensity.greaterThan( 0.0 ), estimateLightImportance( light, rayOrigin, normal, material ), float( 0.0 ) );
					totalWeight.addAssign( importance );
					lightIndex.addAssign( 1 );

				} );

			} );

		} );

		If( numPointLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numPointLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( lightIndex.lessThan( int( 16 ) ), () => {

					const light = PointLight.wrap( getPointLight( pointLightsBuffer, i ) );
					totalWeight.addAssign( calculatePointLightImportance( light, rayOrigin, normal, material ) );
					lightIndex.addAssign( 1 );

				} );

			} );

		} );

		If( numSpotLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numSpotLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( lightIndex.lessThan( int( 16 ) ), () => {

					const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, i ) );
					totalWeight.addAssign( calculateSpotLightImportance( light, rayOrigin, normal, material ) );
					lightIndex.addAssign( 1 );

				} );

			} );

		} );

		// =====================================================================
		// Fallback: Uniform Sampling if no importance
		// =====================================================================

		If( totalWeight.lessThanEqual( 0.0 ), () => {

			const lightSelection = randomSeed.x.mul( float( totalLights ) ).toVar();
			const selectedLight = int( lightSelection ).toVar();
			// Guard division by zero
			const lightSelectionPdf = float( 1.0 ).div( max( float( totalLights ), 1.0 ) ).toVar();

			r_pdf.assign( lightSelectionPdf );
			const sampled = tslBool( false ).toVar();
			const currentIdx = int( 0 ).toVar();

			// Directional lights fallback
			If( numDirectionalLights.greaterThan( int( 0 ) ), () => {

				If( sampled.not().and( selectedLight.greaterThanEqual( currentIdx ) ).and( selectedLight.lessThan( currentIdx.add( numDirectionalLights ) ) ), () => {

					const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, selectedLight.sub( currentIdx ) ) );

					If( light.intensity.greaterThan( 0.0 ), () => {

						r_direction.assign( normalize( light.direction ) );
						r_emission.assign( light.color.mul( light.intensity ) );
						r_distance.assign( 1e6 );
						r_lightType.assign( int( LIGHT_TYPE_DIRECTIONAL ) );
						r_valid.assign( tslBool( true ) );
						sampled.assign( tslBool( true ) );

					} );

				} );
				currentIdx.addAssign( numDirectionalLights );

			} );

			// Area lights fallback
			If( numAreaLights.greaterThan( int( 0 ) ), () => {

				If( sampled.not().and( selectedLight.greaterThanEqual( currentIdx ) ).and( selectedLight.lessThan( currentIdx.add( numAreaLights ) ) ), () => {

					const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, selectedLight.sub( currentIdx ) ) );

					If( light.intensity.greaterThan( 0.0 ), () => {

						const uv = vec2( randomSeed.y, RandomValue( rngState ) ).toVar();
						const areaSample = LightSample.wrap( sampleRectAreaLight( light, rayOrigin, uv, lightSelectionPdf ) );
						r_valid.assign( areaSample.valid );
						r_direction.assign( areaSample.direction );
						r_emission.assign( areaSample.emission );
						r_distance.assign( areaSample.distance );
						r_pdf.assign( areaSample.pdf );
						r_lightType.assign( areaSample.lightType );
						sampled.assign( tslBool( true ) );

					} );

				} );
				currentIdx.addAssign( numAreaLights );

			} );

			// Point lights fallback
			If( numPointLights.greaterThan( int( 0 ) ), () => {

				If( sampled.not().and( selectedLight.greaterThanEqual( currentIdx ) ).and( selectedLight.lessThan( currentIdx.add( numPointLights ) ) ), () => {

					const light = PointLight.wrap( getPointLight( pointLightsBuffer, selectedLight.sub( currentIdx ) ) );

					If( light.intensity.greaterThan( 0.0 ), () => {

						const ptSample = LightSample.wrap( samplePointLightWithAttenuation( light, rayOrigin, lightSelectionPdf ) );
						r_valid.assign( ptSample.valid );
						r_direction.assign( ptSample.direction );
						r_emission.assign( ptSample.emission );
						r_distance.assign( ptSample.distance );
						r_pdf.assign( ptSample.pdf );
						r_lightType.assign( ptSample.lightType );
						sampled.assign( tslBool( true ) );

					} );

				} );
				currentIdx.addAssign( numPointLights );

			} );

			// Spot lights fallback
			If( numSpotLights.greaterThan( int( 0 ) ), () => {

				If( sampled.not().and( selectedLight.greaterThanEqual( currentIdx ) ).and( selectedLight.lessThan( currentIdx.add( numSpotLights ) ) ), () => {

					const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, selectedLight.sub( currentIdx ) ) );

					If( light.intensity.greaterThan( 0.0 ), () => {

						const uv = vec2( randomSeed.y, RandomValue( rngState ) ).toVar();
						const spotSample = LightSample.wrap( sampleSpotLightWithRadius( light, rayOrigin, uv, lightSelectionPdf ) );
						r_valid.assign( spotSample.valid );
						r_direction.assign( spotSample.direction );
						r_emission.assign( spotSample.emission );
						r_distance.assign( spotSample.distance );
						r_pdf.assign( spotSample.pdf );
						r_lightType.assign( spotSample.lightType );
						sampled.assign( tslBool( true ) );

					} );

				} );

			} );

		} ).Else( () => {

			// =================================================================
			// PASS 2: Select and Sample Light (no early returns in loops)
			// =================================================================

			const selectionValue = randomSeed.x.mul( totalWeight ).toVar();
			const cumulative = float( 0.0 ).toVar();
			lightIndex.assign( 0 );

			// Track which light was selected
			const selectedType = int( - 1 ).toVar(); // 0=dir, 1=area, 2=point, 3=spot
			const selectedIdx = int( - 1 ).toVar();
			const selectedImportance = float( 0.0 ).toVar();

			// Directional lights
			If( numDirectionalLights.greaterThan( int( 0 ) ), () => {

				Loop( { start: int( 0 ), end: numDirectionalLights, type: 'int', condition: '<' }, ( { i } ) => {

					If( lightIndex.lessThan( int( 16 ) ).and( selectedType.lessThan( int( 0 ) ) ), () => {

						const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, i ) );
						const importance = calculateDirectionalLightImportance( light, rayOrigin, normal, material, bounceIndex ).toVar();
						const prevCumulative = cumulative.toVar();
						cumulative.addAssign( importance );

						If( selectionValue.greaterThan( prevCumulative ).and( selectionValue.lessThanEqual( cumulative ) ), () => {

							selectedType.assign( 0 );
							selectedIdx.assign( i );
							selectedImportance.assign( importance );

						} );

					} );
					lightIndex.addAssign( 1 );

				} );

			} );

			// Area lights
			If( numAreaLights.greaterThan( int( 0 ) ), () => {

				Loop( { start: int( 0 ), end: numAreaLights, type: 'int', condition: '<' }, ( { i } ) => {

					If( lightIndex.lessThan( int( 16 ) ).and( selectedType.lessThan( int( 0 ) ) ), () => {

						const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, i ) );
						const importance = select( light.intensity.greaterThan( 0.0 ), estimateLightImportance( light, rayOrigin, normal, material ), float( 0.0 ) ).toVar();
						const prevCumulative = cumulative.toVar();
						cumulative.addAssign( importance );

						If( selectionValue.greaterThan( prevCumulative ).and( selectionValue.lessThanEqual( cumulative ) ), () => {

							selectedType.assign( 1 );
							selectedIdx.assign( i );
							selectedImportance.assign( importance );

						} );

					} );
					lightIndex.addAssign( 1 );

				} );

			} );

			// Point lights
			If( numPointLights.greaterThan( int( 0 ) ), () => {

				Loop( { start: int( 0 ), end: numPointLights, type: 'int', condition: '<' }, ( { i } ) => {

					If( lightIndex.lessThan( int( 16 ) ).and( selectedType.lessThan( int( 0 ) ) ), () => {

						const light = PointLight.wrap( getPointLight( pointLightsBuffer, i ) );
						const importance = calculatePointLightImportance( light, rayOrigin, normal, material ).toVar();
						const prevCumulative = cumulative.toVar();
						cumulative.addAssign( importance );

						If( selectionValue.greaterThan( prevCumulative ).and( selectionValue.lessThanEqual( cumulative ) ), () => {

							selectedType.assign( 2 );
							selectedIdx.assign( i );
							selectedImportance.assign( importance );

						} );

					} );
					lightIndex.addAssign( 1 );

				} );

			} );

			// Spot lights
			If( numSpotLights.greaterThan( int( 0 ) ), () => {

				Loop( { start: int( 0 ), end: numSpotLights, type: 'int', condition: '<' }, ( { i } ) => {

					If( lightIndex.lessThan( int( 16 ) ).and( selectedType.lessThan( int( 0 ) ) ), () => {

						const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, i ) );
						const importance = calculateSpotLightImportance( light, rayOrigin, normal, material ).toVar();
						const prevCumulative = cumulative.toVar();
						cumulative.addAssign( importance );

						If( selectionValue.greaterThan( prevCumulative ).and( selectionValue.lessThanEqual( cumulative ) ), () => {

							selectedType.assign( 3 );
							selectedIdx.assign( i );
							selectedImportance.assign( importance );

						} );

					} );
					lightIndex.addAssign( 1 );

				} );

			} );

			// =================================================================
			// PASS 3: Sample the selected light (outside loops)
			// =================================================================

			// Guard division by zero
			const pdf = selectedImportance.div( max( totalWeight, 1e-10 ) ).toVar();

			// Directional light sampling
			If( selectedType.equal( int( 0 ) ).and( selectedIdx.greaterThanEqual( int( 0 ) ) ), () => {

				const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, selectedIdx ) );

				const direction = normalize( light.direction ).toVar();
				const dirPdf = float( 1.0 ).toVar();

				If( light.angle.greaterThan( 0.0 ), () => {

					const cosHalfAngle = cos( light.angle.mul( 0.5 ) ).toVar();
					const cosTheta = mix( cosHalfAngle, float( 1.0 ), randomSeed.y ).toVar();
					const sinTheta = sqrt( max( float( 0.0 ), float( 1.0 ).sub( cosTheta.mul( cosTheta ) ) ) ).toVar();
					const phi = float( TWO_PI ).mul( RandomValue( rngState ) ).toVar();

					const w = normalize( light.direction ).toVar();
					const u = normalize( cross(
						select( abs( w.x ).greaterThan( 0.9 ), vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ) ),
						w
					) ).toVar();
					const v = cross( w, u ).toVar();

					direction.assign( normalize(
						w.mul( cosTheta ).add( u.mul( cos( phi ) ).add( v.mul( sin( phi ) ) ).mul( sinTheta ) )
					) );
					// Guard division: (1.0 - cosHalfAngle) could be zero if angle is 0
					const solidAngle = float( TWO_PI ).mul( max( float( 1.0 ).sub( cosHalfAngle ), 1e-10 ) ).toVar();
					dirPdf.assign( float( 1.0 ).div( solidAngle ) );

				} );

				r_direction.assign( direction );
				r_emission.assign( light.color.mul( light.intensity ) );
				r_distance.assign( 1e6 );
				r_pdf.assign( dirPdf.mul( pdf ) );
				r_lightType.assign( int( LIGHT_TYPE_DIRECTIONAL ) );
				r_valid.assign( tslBool( true ) );

			} );

			// Area light sampling
			If( selectedType.equal( int( 1 ) ).and( selectedIdx.greaterThanEqual( int( 0 ) ) ), () => {

				const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, selectedIdx ) );
				const uv = vec2( randomSeed.y, RandomValue( rngState ) ).toVar();
				const areaSample = LightSample.wrap( sampleRectAreaLight( light, rayOrigin, uv, pdf ) );
				r_valid.assign( areaSample.valid );
				r_direction.assign( areaSample.direction );
				r_emission.assign( areaSample.emission );
				r_distance.assign( areaSample.distance );
				r_pdf.assign( areaSample.pdf );
				r_lightType.assign( areaSample.lightType );

			} );

			// Point light sampling
			If( selectedType.equal( int( 2 ) ).and( selectedIdx.greaterThanEqual( int( 0 ) ) ), () => {

				const light = PointLight.wrap( getPointLight( pointLightsBuffer, selectedIdx ) );
				const ptSample = LightSample.wrap( samplePointLightWithAttenuation( light, rayOrigin, pdf ) );
				r_valid.assign( ptSample.valid );
				r_direction.assign( ptSample.direction );
				r_emission.assign( ptSample.emission );
				r_distance.assign( ptSample.distance );
				r_pdf.assign( ptSample.pdf );
				r_lightType.assign( ptSample.lightType );

			} );

			// Spot light sampling
			If( selectedType.equal( int( 3 ) ).and( selectedIdx.greaterThanEqual( int( 0 ) ) ), () => {

				const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, selectedIdx ) );
				const uv = vec2( randomSeed.y, RandomValue( rngState ) ).toVar();
				const spotSample = LightSample.wrap( sampleSpotLightWithRadius( light, rayOrigin, uv, pdf ) );
				r_valid.assign( spotSample.valid );
				r_direction.assign( spotSample.direction );
				r_emission.assign( spotSample.emission );
				r_distance.assign( spotSample.distance );
				r_pdf.assign( spotSample.pdf );
				r_lightType.assign( spotSample.lightType );

			} );

		} ); // End of Else (totalWeight > 0)

	} ); // End of totalLights > 0

	return LightSample( {
		valid: r_valid,
		direction: r_direction,
		emission: r_emission,
		distance: r_distance,
		pdf: r_pdf,
		lightType: r_lightType,
	} );

} );

// =============================================================================
// Material PDF Calculation for MIS
// =============================================================================

// Helper function to calculate material PDF for a given direction
export const calculateMaterialPDF = Fn( ( [ viewDir, lightDir, normal, material ] ) => {

	const NoV = max( float( 0.0 ), dot( normal, viewDir ) ).toVar();
	const NoL = max( float( 0.0 ), dot( normal, lightDir ) ).toVar();
	const H = normalize( viewDir.add( lightDir ) ).toVar();
	const NoH = max( float( 0.0 ), dot( normal, H ) ).toVar();
	const VoH = max( float( 0.0 ), dot( viewDir, H ) ).toVar();

	// Calculate lobe weights
	const diffuseWeight = float( 1.0 ).sub( material.metalness ).mul(
		float( 1.0 ).sub( material.transmission )
	).toVar();

	const specularWeight = float( 1.0 ).sub(
		diffuseWeight.mul( float( 1.0 ).sub( material.metalness ) )
	).toVar();

	const totalWeight = diffuseWeight.add( specularWeight ).toVar();

	const pdf = float( 0.0 ).toVar();

	If( totalWeight.greaterThan( 0.0 ), () => {

		// Guard division
		const invTotalWeight = float( 1.0 ).div( max( totalWeight, 1e-10 ) ).toVar();
		diffuseWeight.mulAssign( invTotalWeight );
		specularWeight.mulAssign( invTotalWeight );

		// Diffuse PDF (cosine-weighted hemisphere)
		If( diffuseWeight.greaterThan( 0.0 ).and( NoL.greaterThan( 0.0 ) ), () => {

			pdf.addAssign( diffuseWeight.mul( NoL ).mul( PI_INV ) );

		} );

		// Specular PDF (VNDF sampling used in path tracer)
		If( specularWeight.greaterThan( 0.0 ).and( NoL.greaterThan( 0.0 ) ), () => {

			const roughness = max( material.roughness, 0.02 ).toVar();
			pdf.addAssign( specularWeight.mul( calculateVNDFPDF( NoH, NoV, roughness ) ) );

		} );

	} );

	return max( pdf, 1e-8 );

} );

// =============================================================================
// Enhanced Area Light Sampling with MIS
// =============================================================================

export const sampleAreaLightContribution = Fn( ( [
	light,
	worldWo,
	hitPoint, hitNormal, material,
	rayOrigin,
	bounceIndex,
	rngState,
	// Shadow ray resources
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
] ) => {

	const result = vec3( 0.0 ).toVar();

	// Sample random position on light surface
	const ruv_r1 = RandomValue( rngState ).toVar();
	const ruv_r2 = RandomValue( rngState ).toVar();
	const ruv = vec2( ruv_r1, ruv_r2 ).toVar();
	const lightPos = light.position.add( light.u.mul( ruv.x.sub( 0.5 ) ) ).add( light.v.mul( ruv.y.sub( 0.5 ) ) ).toVar();

	const toLight = lightPos.sub( rayOrigin ).toVar();
	const lightDistSq = dot( toLight, toLight ).toVar();

	// Guard against zero distance
	If( lightDistSq.greaterThanEqual( 1e-10 ), () => {

		const lightDist = sqrt( lightDistSq ).toVar();
		const lightDir = toLight.div( lightDist ).toVar();

		// Check if light is facing the surface
		const lightNormal = normalize( cross( light.u, light.v ) ).toVar();
		const lightFacing = dot( lightDir.negate(), lightNormal ).toVar();

		If( lightFacing.greaterThan( 0.0 ), () => {

			// Check if surface is facing the light
			const surfaceFacing = dot( hitNormal, lightDir ).toVar();

			If( surfaceFacing.greaterThan( 0.0 ), () => {

				// Validate direction
				If( isDirectionValid( { direction: lightDir, surfaceNormal: hitNormal } ), () => {

					// Test for occlusion
					const visibility = traceShadowRay(
						rayOrigin, lightDir, lightDist.sub( 0.001 ), rngState,
						traverseBVHShadow,
						bvhBuffer,
						triangleBuffer,
						materialBuffer,
					);

					If( visibility.greaterThan( 0.0 ), () => {

						// Calculate BRDF
						const brdfColor = evaluateMaterialResponse( worldWo, lightDir, hitNormal, material );

						// Calculate light PDF - guard division
						const lightPdf = lightDistSq.div( max( light.area.mul( lightFacing ), EPSILON ) ).toVar();

						// Calculate BRDF PDF for MIS
						const brdfPdf = calculateMaterialPDF( worldWo, lightDir, hitNormal, material ).toVar();

						// Apply MIS weighting
						const misWeight = select( brdfPdf.greaterThan( 0.0 ), powerHeuristic( { pdf1: lightPdf, pdf2: brdfPdf } ), float( 1.0 ) ).toVar();

						// Calculate final contribution - guard division
						const lightEmission = light.color.mul( light.intensity ).toVar();
						result.assign(
							lightEmission.mul( brdfColor ).mul( surfaceFacing ).mul( visibility ).mul( misWeight ).div( max( lightPdf, MIN_PDF ) )
						);

					} );

				} );

			} );

		} );

	} );

	return result;

} );

// =============================================================================
// Unified Direct Lighting System
// =============================================================================

// Optimized direct lighting function with importance-based sampling and better MIS
export const calculateDirectLightingUnified = Fn( ( [
	// Surface hit data
	hitPoint, hitNormal, material,
	// View direction
	viewDir,
	// BRDF sample (DirectionSample fields)
	brdfSampleDirection, brdfSamplePdf, brdfSampleValue,
	// Tracing context
	sampleIndex, bounceIndex, rngState,
	// Light data
	directionalLightsBuffer, numDirectionalLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
	// Shadow ray resources
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
	// Environment resources
	envTexture, environmentIntensity, envMatrix,
	envMarginalWeights, envConditionalWeights,
	envTotalSum, envResolution,
	enableEnvironmentLight,
] ) => {

	const totalContribution = vec3( 0.0 ).toVar();
	const rayOrigin = hitPoint.add( hitNormal.mul( 0.001 ) ).toVar();

	// Early exit for highly emissive surfaces
	If( material.emissiveIntensity.lessThanEqual( 10.0 ), () => {

		// Adaptive MIS Strategy Selection
		const currentThroughput = vec3( 1.0 ).toVar();
		const misResult = MISStrategy.wrap( selectOptimalMISStrategy(
			material.roughness, material.metalness, material.transmission, bounceIndex, currentThroughput
		) );

		// Extract MIS fields to mutable variables
		const useBRDFSampling = misResult.useBRDFSampling.toVar();
		const useLightSampling = misResult.useLightSampling.toVar();
		const useEnvSampling = misResult.useEnvSampling.toVar();
		const brdfWeight = misResult.brdfWeight.toVar();
		const lightWeight = misResult.lightWeight.toVar();
		const envWeight = misResult.envWeight.toVar();

		// Adaptive light processing
		const totalLights = numDirectionalLights.add( numAreaLights ).add( numPointLights ).add( numSpotLights ).toVar();

		const importanceThreshold = float( 0.001 ).mul( float( 1.0 ).add( float( bounceIndex ).mul( 0.5 ) ) ).toVar();

		// Check if discrete lights exist
		const hasDiscreteLights = totalLights.greaterThan( int( 0 ) ).toVar();

		// Calculate total sampling weight only include light weight if lights exist
		const totalSamplingWeight = float( 0.0 ).toVar();

		If( useLightSampling.and( hasDiscreteLights ), () => {

			totalSamplingWeight.addAssign( lightWeight );

		} );

		If( useBRDFSampling, () => {

			totalSamplingWeight.addAssign( brdfWeight );

		} );

		If( useEnvSampling.and( enableEnvironmentLight ), () => {

			totalSamplingWeight.addAssign( envWeight );

		} );

		If( totalSamplingWeight.lessThanEqual( 0.0 ), () => {

			totalSamplingWeight.assign( 1.0 );
			// Fallback: prioritize environment if enabled, otherwise BRDF
			If( enableEnvironmentLight, () => {

				useEnvSampling.assign( tslBool( true ) );
				envWeight.assign( 1.0 );

			} ).Else( () => {

				useBRDFSampling.assign( tslBool( true ) );
				brdfWeight.assign( 1.0 );

			} );

		} );

		const stratRand1 = RandomValue( rngState ).toVar();
		const stratRand2 = RandomValue( rngState ).toVar();

		// Determine sampling technique
		const rand = stratRand1;
		const sampleLights = tslBool( false ).toVar();
		const sampleBRDF = tslBool( false ).toVar();
		const sampleEnv = tslBool( false ).toVar();

		// Calculate effective weights for probability (only include light weight if lights exist)
		const effectiveLightWeight = select( hasDiscreteLights, lightWeight, float( 0.0 ) ).toVar();
		// Guard division
		const invTotalSamplingWeight = float( 1.0 ).div( max( totalSamplingWeight, 1e-10 ) ).toVar();
		const cumulativeLight = effectiveLightWeight.mul( invTotalSamplingWeight ).toVar();
		const cumulativeBRDF = effectiveLightWeight.add( brdfWeight ).mul( invTotalSamplingWeight ).toVar();

		If( rand.lessThan( cumulativeLight ).and( useLightSampling ).and( hasDiscreteLights ), () => {

			sampleLights.assign( tslBool( true ) );

		} ).ElseIf( rand.lessThan( cumulativeBRDF ).and( useBRDFSampling ), () => {

			sampleBRDF.assign( tslBool( true ) );

		} ).ElseIf( useEnvSampling.and( enableEnvironmentLight ), () => {

			sampleEnv.assign( tslBool( true ) );

		} ).ElseIf( hasDiscreteLights, () => {

			// Fallback to light sampling only if lights exist
			sampleLights.assign( tslBool( true ) );

		} ).ElseIf( enableEnvironmentLight, () => {

			// Fallback to environment sampling when no discrete lights
			sampleEnv.assign( tslBool( true ) );

		} );

		// =====================================================================
		// LIGHT SAMPLING PATH
		// =====================================================================

		If( sampleLights, () => {

			// Importance-weighted light sampling
			const lightRandom = vec2( stratRand2, RandomValue( rngState ) ).toVar();
			const lightSample = LightSample.wrap( sampleLightWithImportance(
				rayOrigin, hitNormal, material, lightRandom, bounceIndex, rngState,
				directionalLightsBuffer, numDirectionalLights,
				areaLightsBuffer, numAreaLights,
				pointLightsBuffer, numPointLights,
				spotLightsBuffer, numSpotLights,
			) );

			If( lightSample.valid.and( lightSample.pdf.greaterThan( 0.0 ) ), () => {

				const NoL = max( float( 0.0 ), dot( hitNormal, lightSample.direction ) ).toVar();
				const lightImportance = lightSample.emission.x.add( lightSample.emission.y ).add( lightSample.emission.z ).toVar();

				If( NoL.greaterThan( 0.0 ).and( lightImportance.mul( NoL ).greaterThan( importanceThreshold ) ).and( isDirectionValid( { direction: lightSample.direction, surfaceNormal: hitNormal } ) ), () => {

					const shadowDistance = min( lightSample.distance.sub( 0.001 ), float( 1000.0 ) ).toVar();
					const visibility = traceShadowRay(
						rayOrigin, lightSample.direction, shadowDistance, rngState,
						traverseBVHShadow,
						bvhBuffer,
						triangleBuffer,
						materialBuffer,
					);

					If( visibility.greaterThan( 0.0 ), () => {

						const brdfValue = evaluateMaterialResponse( viewDir, lightSample.direction, hitNormal, material );
						const bPdf = calculateMaterialPDF( viewDir, lightSample.direction, hitNormal, material ).toVar();

						const misW = float( 1.0 ).toVar();

						If( bPdf.greaterThan( 0.0 ).and( useBRDFSampling ), () => {

							const lightPdfWeighted = lightSample.pdf.mul( lightWeight ).toVar();
							const brdfPdfWeighted = bPdf.mul( brdfWeight ).toVar();

							// Apply power heuristic for area lights and primary directional lights
							If( lightSample.lightType.equal( int( LIGHT_TYPE_AREA ) ), () => {

								misW.assign( powerHeuristic( { pdf1: lightPdfWeighted, pdf2: brdfPdfWeighted } ) );

							} ).ElseIf( bounceIndex.equal( int( 0 ) ).and( lightSample.lightType.equal( int( LIGHT_TYPE_DIRECTIONAL ) ) ), () => {

								misW.assign( powerHeuristic( { pdf1: lightPdfWeighted, pdf2: brdfPdfWeighted } ) );

							} );

						} );

						// Guard division
						const lightContribution = lightSample.emission.mul( brdfValue ).mul( NoL ).mul( visibility ).mul( misW ).div( max( lightSample.pdf, 1e-10 ) );
						totalContribution.addAssign( lightContribution.mul( totalSamplingWeight ).div( max( lightWeight, 1e-10 ) ) );

					} );

				} );

			} );

		} );

		// =====================================================================
		// BRDF SAMPLING PATH
		// =====================================================================

		If( sampleBRDF, () => {

			If( brdfSamplePdf.greaterThan( 0.0 ).and( useBRDFSampling ), () => {

				const NoL = max( float( 0.0 ), dot( hitNormal, brdfSampleDirection ) ).toVar();

				If( NoL.greaterThan( 0.0 ).and( isDirectionValid( { direction: brdfSampleDirection, surfaceNormal: hitNormal } ) ), () => {

					// Check intersection with area lights
					If( numAreaLights.greaterThan( int( 0 ) ), () => {

						const foundIntersection = tslBool( false ).toVar();
						const maxImportance = float( 0.0 ).toVar();
						const maxImportanceLight = int( - 1 ).toVar();

						// Track best match (no early break)
						Loop( { start: int( 0 ), end: numAreaLights, type: 'int', condition: '<' }, ( { i } ) => {

							const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, i ) );

							If( light.intensity.greaterThan( 0.0 ), () => {

								const lightImp = estimateLightImportance( light, hitPoint, hitNormal, material ).toVar();

								If( lightImp.greaterThanEqual( importanceThreshold ), () => {

									const hitDistance = intersectAreaLight( light, rayOrigin, brdfSampleDirection ).toVar();

									If( hitDistance.greaterThan( 0.0 ), () => {

										If( lightImp.greaterThan( maxImportance ), () => {

											maxImportance.assign( lightImp );
											maxImportanceLight.assign( i );

										} );
										foundIntersection.assign( tslBool( true ) );

									} );

								} );

							} );

						} );

						If( foundIntersection.and( maxImportanceLight.greaterThanEqual( int( 0 ) ) ), () => {

							const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, maxImportanceLight ) );
							const hitDistance = intersectAreaLight( light, rayOrigin, brdfSampleDirection ).toVar();

							If( hitDistance.greaterThan( 0.0 ), () => {

								const shadowDistance = min( hitDistance.sub( 0.001 ), float( 1000.0 ) ).toVar();
								const visibility = traceShadowRay(
									rayOrigin, brdfSampleDirection, shadowDistance, rngState,
									traverseBVHShadow,
									bvhBuffer,
									triangleBuffer,
									materialBuffer,
								);

								If( visibility.greaterThan( 0.0 ), () => {

									const lightFacing = max( float( 0.0 ), dot( brdfSampleDirection, light.normal ).negate() ).toVar();

									If( lightFacing.greaterThan( 0.0 ), () => {

										const lightDistSq = hitDistance.mul( hitDistance ).toVar();
										// Guard division
										const lightPdf = lightDistSq.div( max( light.area.mul( lightFacing ), EPSILON ) ).toVar();
										lightPdf.divAssign( max( float( totalLights ), 1.0 ) );

										const brdfPdfWeighted = brdfSamplePdf.mul( brdfWeight ).toVar();
										const lightPdfWeighted = lightPdf.mul( lightWeight ).toVar();
										const misW = powerHeuristic( { pdf1: brdfPdfWeighted, pdf2: lightPdfWeighted } ).toVar();

										const lightEmission = light.color.mul( light.intensity ).toVar();
										// Guard division
										const brdfContribution = lightEmission.mul( brdfSampleValue ).mul( NoL ).mul( visibility ).mul( misW ).div( max( brdfSamplePdf, 1e-10 ) );
										totalContribution.addAssign( brdfContribution.mul( totalSamplingWeight ).div( max( brdfWeight, 1e-10 ) ) );

									} );

								} );

							} );

						} );

					} ); // End numAreaLights > 0

				} );

			} );

		} );

		// =====================================================================
		// ENVIRONMENT SAMPLING PATH
		// =====================================================================

		If( sampleEnv, () => {

			If( enableEnvironmentLight.and( useEnvSampling ), () => {

				const env_r1 = RandomValue( rngState ).toVar();
				const env_r2 = RandomValue( rngState ).toVar();
				const envRandom = vec2( env_r1, env_r2 ).toVar();
				const envColor = vec3( 0.0 ).toVar();

				// Sample direction + PDF + color from importance-sampled environment
				const envSampleResult = sampleEquirectProbability(
					envTexture, envMarginalWeights, envConditionalWeights,
					envMatrix, environmentIntensity, envTotalSum, envResolution, envRandom, envColor
				).toVar();

				const envDirection = envSampleResult.xyz.toVar();
				const envPdf = envSampleResult.w.toVar();

				If( envPdf.greaterThan( 0.0 ), () => {

					const NoL = max( float( 0.0 ), dot( hitNormal, envDirection ) ).toVar();

					If( NoL.greaterThan( 0.0 ).and( isDirectionValid( { direction: envDirection, surfaceNormal: hitNormal } ) ), () => {

						const visibility = traceShadowRay(
							rayOrigin, envDirection, float( 1000.0 ), rngState,
							traverseBVHShadow,
							bvhBuffer,
							triangleBuffer,
							materialBuffer,
						);

						If( visibility.greaterThan( 0.0 ), () => {

							const brdfValue = evaluateMaterialResponse( viewDir, envDirection, hitNormal, material );
							const bPdf = calculateMaterialPDF( viewDir, envDirection, hitNormal, material ).toVar();

							const envPdfWeighted = envPdf.mul( envWeight ).toVar();
							const brdfPdfWeighted = bPdf.mul( brdfWeight ).toVar();
							const misW = select(
								bPdf.greaterThan( 0.0 ),
								powerHeuristic( { pdf1: envPdfWeighted, pdf2: brdfPdfWeighted } ),
								float( 1.0 )
							).toVar();

							// Guard division
							const envContribution = envColor.mul( brdfValue ).mul( NoL ).mul( visibility ).mul( misW ).div( max( envPdf, 1e-10 ) );
							totalContribution.addAssign( envContribution.mul( totalSamplingWeight ).div( max( envWeight, 1e-10 ) ) );

						} );

					} );

				} );

			} );

		} );

	} ); // End emissiveIntensity check

	// EMISSIVE TRIANGLE DIRECT LIGHTING
	// NOTE: Emissive triangle sampling is handled separately in pathtracer_core.fs
	// to bypass firefly suppression. Do not add it here to avoid double-counting.

	return totalContribution;

} );
