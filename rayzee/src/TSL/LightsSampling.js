/**
 * LightsSampling.js - Light Sampling and Unified Direct Lighting
 *
 * Pure TSL: Fn(), If(), Loop(), .toVar(), .assign() — NO wgslFn()
 *
 * Direct lighting combines:
 *  - Stochastic discrete light / BRDF selection (area, point, spot, directional)
 *  - Deterministic environment NEE (always runs, two-strategy Veach MIS with implicit miss)
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
	ivec2,
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
	textureLoad,
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
	luminance,
	normalDepthWeight,
} from './Common.js';
import {
	sampleEquirectProbability,
	sampleEquirect,
} from './Environment.js';

// ReSTIR DI primitives for the RIS branch added in calculateReSTIRDeterministicLighting.
import {
	Reservoir,
	emptyReservoir,
	reservoirUpdate,
	reservoirCombine,
	reservoirCombineSpatial,
	reservoirCapM,
	reservoirFinalize,
	packReservoirCore,
	packReservoirAux,
	unpackReservoir,
	reservoirSlotIndex,
	encodeLightSampleId,
	decodeLightSampleId,
	encodeOctahedral,
	decodeOctahedral,
	RESTIR_LIGHT_TYPE_DIRECTIONAL,
	RESTIR_LIGHT_TYPE_AREA,
	RESTIR_LIGHT_TYPE_POINT,
	RESTIR_LIGHT_TYPE_SPOT,
	RESTIR_LIGHT_TYPE_ENV,
	RESTIR_TEMPORAL_M_CAP_MULTIPLIER,
	RESTIR_SPATIAL_M_CAP_MULTIPLIER,
	RESTIR_VISIBILITY_MAX_AGE,
} from './ReSTIRCore.js';
import {
	getReservoirBuffer,
	getReservoirFrameParity,
	getMotionVectorTex,
	getPrevNormalDepthTex,
} from './ReSTIRState.js';

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

		// Sample random position on rectangle (u/v are half-vectors, so map [0,1] → [-1,1])
		const randomPos = light.position
			.add( light.u.mul( ruv.x.mul( 2.0 ).sub( 1.0 ) ) )
			.add( light.v.mul( ruv.y.mul( 2.0 ).sub( 1.0 ) ) )
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

			// Penumbra: inner cone angle = outerAngle * (1 - penumbra)
			// Clamp penumbraCosAngle > coneCosAngle to avoid smoothstep UB when penumbra = 0
			const penumbraCosAngle = cos( light.angle.mul( float( 1.0 ).sub( light.penumbra ) ) ).max( coneCosAngle.add( 1e-5 ) ).toVar();
			const coneAttenuation = getSpotAttenuation( { coneCosine: coneCosAngle, penumbraCosine: penumbraCosAngle, angleCosine: spotCosAngle } );
			const distanceAttenuation = getDistanceAttenuation( { lightDistance: lightDist, cutoffDistance: light.distance, decayExponent: light.decay } );

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

		// Calculate distance attenuation using the light's actual distance and decay properties
		const distanceAttenuation = getDistanceAttenuation( { lightDistance: lightDist, cutoffDistance: light.distance, decayExponent: light.decay } );

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
	const lightPos = light.position.add( light.u.mul( ruv.x.mul( 2.0 ).sub( 1.0 ) ) ).add( light.v.mul( ruv.y.mul( 2.0 ).sub( 1.0 ) ) ).toVar();

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
// ReSTIR DI — helper: resolve an encoded lightSampleId to a LightSample + pHat
// =============================================================================

/**
 * Decode a ReSTIR lightSampleId → concrete (direction, distance, emission)
 * and evaluate the unshadowed target pdf p_hat = luminance(L_e * brdf * cos)
 * at the given shading context.
 *
 * Returns a LightSample struct with:
 *  - direction, distance, emission populated from the referenced light
 *  - pdf = p_hat (we reuse the pdf field to avoid defining a new struct)
 *  - lightType = decoded type (0/2/3)
 *  - valid = false when the encoded index is out of bounds for the current
 *    light counts (e.g., a reservoir from a frame when a light was deleted)
 */
const resolveAndEvaluateRestirSample = Fn( ( [
	lightSampleId, storedDirX, storedDirY,
	hitPoint, hitNormal, material, viewDir,
	directionalLightsBuffer, numDirectionalLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
	envTexture, environmentIntensity, envMatrix, envTotalSum, envResolution,
] ) => {

	const direction = vec3( 0.0 ).toVar();
	const distance = float( 0.0 ).toVar();
	const emission = vec3( 0.0 ).toVar();
	const pHatOut = float( 0.0 ).toVar();
	const validOut = tslBool( false ).toVar();
	const lightTypeOut = int( 0 ).toVar();

	const idVec = decodeLightSampleId( lightSampleId );
	const lightType = int( idVec.x ).toVar();
	const lightIndex = int( idVec.y ).toVar();
	lightTypeOut.assign( lightType );

	If( lightType.equal( int( RESTIR_LIGHT_TYPE_DIRECTIONAL ) ).and( lightIndex.lessThan( numDirectionalLights ) ), () => {

		const dl = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, lightIndex ) );
		// dl.direction is stored as "from surface toward light" (see LightSerializer.js:79)
		// — use directly, do NOT negate.
		direction.assign( dl.direction );
		distance.assign( float( 1e10 ) );
		emission.assign( dl.color.mul( dl.intensity ) );
		validOut.assign( tslBool( true ) );

	} ).ElseIf( lightType.equal( int( RESTIR_LIGHT_TYPE_AREA ) ).and( lightIndex.lessThan( numAreaLights ) ), () => {

		// Area-light samples: dirX/dirY carry the (u, v) parametric coordinates
		// on the rectangle's half-axes. Reconstruct the world-space sample point
		// from the light's u/v axes; the per-pixel direction is recomputed here
		// since it depends on the current shading point (different pixels see a
		// different direction to the same light sample).
		const al = AreaLight.wrap( getAreaLight( areaLightsBuffer, lightIndex ) );
		const worldPos = al.position
			.add( al.u.mul( storedDirX.mul( 2.0 ).sub( 1.0 ) ) )
			.add( al.v.mul( storedDirY.mul( 2.0 ).sub( 1.0 ) ) ).toVar();
		const toLight = worldPos.sub( hitPoint ).toVar();
		const d = length( toLight ).toVar();
		If( d.greaterThan( float( 1e-6 ) ), () => {

			const dirNorm = toLight.div( d ).toVar();
			const lightNormal = normalize( cross( al.u, al.v ) );
			const cosAngle = dot( dirNorm.negate(), lightNormal );
			// Back-face cull: if the sample-point's normal points away from us
			// the sample is invalid (emitter is one-sided). Matches sampleRectAreaLight.
			If( cosAngle.greaterThan( float( 0.0 ) ), () => {

				direction.assign( dirNorm );
				distance.assign( d );
				emission.assign( al.color.mul( al.intensity ) );
				validOut.assign( tslBool( true ) );

			} );

		} );

	} ).ElseIf( lightType.equal( int( RESTIR_LIGHT_TYPE_POINT ) ).and( lightIndex.lessThan( numPointLights ) ), () => {

		const pl = PointLight.wrap( getPointLight( pointLightsBuffer, lightIndex ) );
		const toLight = pl.position.sub( hitPoint ).toVar();
		const d = length( toLight ).toVar();
		direction.assign( toLight.div( max( d, float( 1e-6 ) ) ) );
		distance.assign( d );
		const att = getDistanceAttenuation( { lightDistance: d, cutoffDistance: pl.distance, decayExponent: pl.decay } );
		emission.assign( pl.color.mul( pl.intensity ).mul( att ) );
		validOut.assign( tslBool( true ) );

	} ).ElseIf( lightType.equal( int( RESTIR_LIGHT_TYPE_SPOT ) ).and( lightIndex.lessThan( numSpotLights ) ), () => {

		const sl = SpotLight.wrap( getSpotLight( spotLightsBuffer, lightIndex ) );
		const toLight = sl.position.sub( hitPoint ).toVar();
		const d = length( toLight ).toVar();
		const dirNorm = toLight.div( max( d, float( 1e-6 ) ) ).toVar();
		direction.assign( dirNorm );
		distance.assign( d );
		const spotCosAngle = dot( dirNorm.negate(), sl.direction ).toVar();
		const coneCosAngle = cos( sl.angle ).toVar();
		const penumbraCosAngle = cos( sl.angle.mul( float( 1.0 ).sub( sl.penumbra ) ) ).max( coneCosAngle.add( 1e-5 ) ).toVar();
		const distAtt = getDistanceAttenuation( { lightDistance: d, cutoffDistance: sl.distance, decayExponent: sl.decay } );
		const spotAtt = getSpotAttenuation( { coneCosine: coneCosAngle, penumbraCosine: penumbraCosAngle, angleCosine: spotCosAngle } );
		emission.assign( sl.color.mul( sl.intensity ).mul( distAtt ).mul( spotAtt ) );
		validOut.assign( tslBool( true ) );

	} ).ElseIf( lightType.equal( int( RESTIR_LIGHT_TYPE_ENV ) ), () => {

		// Env samples carry the direction octahedral-encoded in the reservoir aux;
		// re-evaluate the env map at that direction to recover emission.
		const encodedDir = vec2( storedDirX, storedDirY );
		const envDir = decodeOctahedral( { e: encodedDir } );
		direction.assign( envDir );
		distance.assign( float( 1e10 ) );
		const envEval = sampleEquirect( envTexture, envDir, envMatrix, envTotalSum, envResolution );
		emission.assign( envEval.xyz.mul( environmentIntensity ) );
		validOut.assign( tslBool( true ) );

	} );

	If( validOut, () => {

		const cosTheta = max( dot( hitNormal, direction ), 0.0 );
		const brdfValue = evaluateMaterialResponse( viewDir, direction, hitNormal, material );
		pHatOut.assign( max( luminance( { color: emission.mul( brdfValue ).mul( cosTheta ) } ), float( 0.0 ) ) );

	} );

	return LightSample( {
		direction,
		emission,
		pdf: pHatOut, // repurposed: carries p_hat for ReSTIR
		distance,
		lightType: lightTypeOut,
		valid: validOut,
	} );

} );

// =============================================================================
// ReSTIR DI — deterministic-light direct lighting via RIS (Phase 3 MVP)
// =============================================================================

/**
 * Direct lighting for deterministic lights (directional / point / spot) via RIS.
 * Replaces the existing NEE path for these light types at bounce 0 when the
 * enableReSTIR uniform is on. Area, env, and emissive-triangle NEE continue
 * through the standard `calculateDirectLightingUnified` path.
 *
 * Algorithm:
 *   1. Sample M=8 candidates uniformly across the deterministic-light pool.
 *      For each: evaluate unshadowed p_hat = luminance(L_e * brdf * cos).
 *   2. Update reservoir via RIS (stochastic replacement weighted by p_hat).
 *   3. Finalize W = sumWeights / (M * p_hat(chosen)).
 *   4. Write reservoir to the ping-pong buffer (Phase 4 will read it for
 *      visibility reuse; for now it's just state for future use).
 *   5. Shadow-trace the chosen sample once, contribute L_e * brdf * cos * W * visibility.
 *
 * Returns vec3 contribution (pre-firefly-suppression). Caller wraps in
 * `regularizePathContribution` like the existing NEE path.
 */
// Tuned from 8 → 4 based on DevTools Sponza measurement: M=8 + K=3 spatial +
// K=1 temporal + K=1 finalize = 13 BRDF evaluations per bounce-0 hit. On
// Sponza (262k tris, complex materials) this cost a 12× fps regression. M=4
// halves the RIS loop cost; K=1 spatial cuts the spatial cost by 2/3 while
// still providing meaningful cross-pixel variance reduction.
const RESTIR_M_CANDIDATES = 4;

// =============================================================================
// ReSTIR DI debug visualization
// =============================================================================

/**
 * Paint a per-pixel color encoding the current reservoir state. Read from the
 * curr ping-pong slot. Called from pathTracerMain when visMode is in the
 * ReSTIR debug range (20-24).
 *
 * Mode 20 — Visibility cache status:
 *   gray    = no sample in reservoir
 *   red     = sample present but never shadow-tested (frameAge == 0)
 *   green   = tested & visible (cache hit → shadow ray elided)
 *   yellow  = tested & occluded (cache hit → no contribution)
 *
 * Mode 21 — Frame age:
 *   black (0), blue (1), green (2), yellow (3), red (4+)
 *
 * Mode 22 — Chosen light type:
 *   gray    = no sample
 *   red     = directional
 *   orange  = area
 *   green   = point
 *   blue    = spot
 *   magenta = env (HDRI)
 *
 * Mode 23 — Reservoir W magnitude (log-normalized grayscale):
 *   darker = smaller W, brighter = larger W
 *
 * Mode 24 — M count (log-normalized grayscale):
 *   darker = fewer samples accumulated, brighter = more
 */
export const getReSTIRDebugColor = Fn( ( [ pixelX, pixelY, renderWidth, visMode ] ) => {

	const color = vec3( 0.0 ).toVar();

	const reservoirBuffer = getReservoirBuffer();
	const frameParity = getReservoirFrameParity();

	// Guard against missing buffer (flag not wired / stub).
	if ( reservoirBuffer !== null && frameParity !== null ) {

		const base = reservoirSlotIndex( pixelX, pixelY, renderWidth, frameParity );
		const core = reservoirBuffer.element( base );
		const aux = reservoirBuffer.element( base.add( int( 1 ) ) );
		const r = Reservoir.wrap( unpackReservoir( core, aux ) ).toVar();

		// Mode 20: visibility cache
		If( visMode.equal( int( 20 ) ), () => {

			If( r.M.lessThanEqual( float( 0.0 ) ), () => {

				color.assign( vec3( 0.2, 0.2, 0.2 ) );

			} ).ElseIf( r.frameAge.lessThanEqual( float( 0.5 ) ), () => {

				color.assign( vec3( 1.0, 0.2, 0.2 ) );

			} ).ElseIf( r.visibility.greaterThan( float( 0.5 ) ), () => {

				color.assign( vec3( 0.2, 1.0, 0.2 ) );

			} ).Else( () => {

				color.assign( vec3( 1.0, 0.8, 0.2 ) );

			} );

		} ).ElseIf( visMode.equal( int( 21 ) ), () => {

			// Frame age
			If( r.frameAge.lessThanEqual( float( 0.5 ) ), () => {

				color.assign( vec3( 0.1, 0.1, 0.1 ) );

			} ).ElseIf( r.frameAge.lessThanEqual( float( 1.5 ) ), () => {

				color.assign( vec3( 0.2, 0.2, 1.0 ) );

			} ).ElseIf( r.frameAge.lessThanEqual( float( 2.5 ) ), () => {

				color.assign( vec3( 0.2, 1.0, 0.2 ) );

			} ).ElseIf( r.frameAge.lessThanEqual( float( 3.5 ) ), () => {

				color.assign( vec3( 1.0, 1.0, 0.2 ) );

			} ).Else( () => {

				color.assign( vec3( 1.0, 0.2, 0.2 ) );

			} );

		} ).ElseIf( visMode.equal( int( 22 ) ), () => {

			// Light type
			const idVec = decodeLightSampleId( r.lightSampleId );
			const type = int( idVec.x ).toVar();
			If( r.M.lessThanEqual( float( 0.0 ) ), () => {

				color.assign( vec3( 0.2, 0.2, 0.2 ) );

			} ).ElseIf( type.equal( int( RESTIR_LIGHT_TYPE_DIRECTIONAL ) ), () => {

				color.assign( vec3( 1.0, 0.2, 0.2 ) ); // red

			} ).ElseIf( type.equal( int( RESTIR_LIGHT_TYPE_AREA ) ), () => {

				color.assign( vec3( 1.0, 0.6, 0.2 ) ); // orange

			} ).ElseIf( type.equal( int( RESTIR_LIGHT_TYPE_POINT ) ), () => {

				color.assign( vec3( 0.2, 1.0, 0.2 ) ); // green

			} ).ElseIf( type.equal( int( RESTIR_LIGHT_TYPE_SPOT ) ), () => {

				color.assign( vec3( 0.2, 0.2, 1.0 ) ); // blue

			} ).ElseIf( type.equal( int( RESTIR_LIGHT_TYPE_ENV ) ), () => {

				color.assign( vec3( 1.0, 0.2, 1.0 ) ); // magenta

			} ).Else( () => {

				color.assign( vec3( 0.4, 0.4, 0.4 ) );

			} );

		} ).ElseIf( visMode.equal( int( 23 ) ), () => {

			// W magnitude — log-normalized to [0,1]
			const logW = max( r.W, float( 1e-6 ) ).log().mul( 0.15 ).add( 0.5 );
			const v = clamp( logW, 0.0, 1.0 );
			color.assign( vec3( v ) );

		} ).ElseIf( visMode.equal( int( 24 ) ), () => {

			// M count — log-normalized
			const logM = max( r.M, float( 1.0 ) ).log().mul( 0.1 );
			const v = clamp( logM, 0.0, 1.0 );
			color.assign( vec3( v ) );

		} );

	}

	return color;

} );

export const calculateReSTIRDeterministicLighting = Fn( ( [
	pixelX, pixelY, renderWidth, renderHeight,
	hitPoint, hitNormal, hitDistance, material, viewDir,
	rngState,
	directionalLightsBuffer, numDirectionalLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
	bvhBuffer, triangleBuffer, materialBuffer,
	envTexture, environmentIntensity, envMatrix,
	envCDFBuffer, envTotalSum, envResolution,
	enableEnvironmentLight,
] ) => {

	const contribution = vec3( 0.0 ).toVar();

	const totalDet = numDirectionalLights.add( numAreaLights ).add( numPointLights ).add( numSpotLights ).toVar();
	// ReSTIR runs when we have any deterministic lights OR env is enabled.
	// (Env is the dominant light source in most user scenes; restricting to det
	// lights misses the biggest win.) runtime-gated via enableEnvironmentLight.
	const hasRestirSource = totalDet.greaterThan( int( 0 ) ).or( enableEnvironmentLight );

	If( hasRestirSource, () => {

		// Wrap struct-returning Fn calls to expose .W / .lightSampleId field access
		// (per TSL convention — Fn returns need .wrap() even for .toVar'd locals).
		const reservoir = Reservoir.wrap( emptyReservoir() ).toVar();
		const rayOrigin = hitPoint.add( hitNormal.mul( 0.001 ) ).toVar();

		const invTotalDet = float( 1.0 ).div( max( float( totalDet ), float( 1.0 ) ) ).toVar();

		// RIS candidate loop — split budget across deterministic + env strategies.
		// When both are available, alternate (even iterations → det, odd → env).
		// When only one strategy is available, all candidates come from it.
		//
		// Per-source reweight: with M candidates split across S sources (n_s each
		// so Σ n_s = M), the basic RIS estimator converges to Σ_s (n_s/M)·I_s
		// instead of Σ_s I_s. We correct by multiplying each candidate weight by
		// M/n_source so sumWeights/M recovers the full multi-source sum. For the
		// equal-split alternating pattern with both sources available, the factor
		// is 2; when only one source is active, the factor is 1.
		const hasDet_outer = totalDet.greaterThan( int( 0 ) );
		const hasEnv_outer = enableEnvironmentLight.and( envTotalSum.greaterThan( float( 0.0 ) ) );
		const sourceReweight = hasDet_outer.and( hasEnv_outer ).select( float( 2.0 ), float( 1.0 ) ).toVar();

		Loop( { start: int( 0 ), end: int( RESTIR_M_CANDIDATES ), type: 'int', condition: '<' }, ( { i } ) => {

			// Strategy selection: alternate det/env when both available.
			// If only one source exists, all iterations use it.
			const hasDet = totalDet.greaterThan( int( 0 ) );
			const hasEnv = enableEnvironmentLight.and( envTotalSum.greaterThan( float( 0.0 ) ) );
			// When both: even iterations pick det, odd pick env.
			const useEnvThisIter = hasEnv.and( hasDet.not().or( i.mod( int( 2 ) ).equal( int( 1 ) ) ) );
			const useDetThisIter = hasDet.and( useEnvThisIter.not() );

			If( useDetThisIter, () => {

				// Pick a uniform integer light index in [0, totalDet).
				const rU = RandomValue( rngState ).toVar();
				const k = int( rU.mul( float( totalDet ) ) ).toVar();
				// Guard against k == totalDet on the edge case rU == 1.0.
				If( k.greaterThanEqual( totalDet ), () => {

					k.assign( totalDet.sub( int( 1 ) ) );

				} );

				// Cumulative index → (lightType, lightIndex). Bucket order matches
				// the numeric type codes: DIR(0) | AREA(1) | POINT(2) | SPOT(3).
				const lightType = int( 0 ).toVar();
				const lightIndex = int( 0 ).toVar();

				If( k.lessThan( numDirectionalLights ), () => {

					lightType.assign( int( RESTIR_LIGHT_TYPE_DIRECTIONAL ) );
					lightIndex.assign( k );

				} ).ElseIf( k.lessThan( numDirectionalLights.add( numAreaLights ) ), () => {

					lightType.assign( int( RESTIR_LIGHT_TYPE_AREA ) );
					lightIndex.assign( k.sub( numDirectionalLights ) );

				} ).ElseIf( k.lessThan( numDirectionalLights.add( numAreaLights ).add( numPointLights ) ), () => {

					lightType.assign( int( RESTIR_LIGHT_TYPE_POINT ) );
					lightIndex.assign( k.sub( numDirectionalLights ).sub( numAreaLights ) );

				} ).Else( () => {

					lightType.assign( int( RESTIR_LIGHT_TYPE_SPOT ) );
					lightIndex.assign( k.sub( numDirectionalLights ).sub( numAreaLights ).sub( numPointLights ) );

				} );

				// Sample the light — resolve direction, distance, and emission (pre-shadow).
				const lightDir = vec3( 0.0 ).toVar();
				const lightDist = float( 0.0 ).toVar();
				const lightEmission = vec3( 0.0 ).toVar();
				const sampleValid = tslBool( true ).toVar();

				// For area samples: the reservoir stores the (u, v) position on the
				// light's parametric surface so the sample can be re-resolved next
				// frame at a different shading context. For point/dir/spot the
				// sample is fully determined by lightSampleId → stored dir slots = 0.
				const storeDirX = float( 0.0 ).toVar();
				const storeDirY = float( 0.0 ).toVar();

				// Jacobian applied to the RIS weight. Point/dir/spot use the uniform-
				// over-lights source PDF of 1/totalDet (implicit in invTotalDet below).
				// Area samples additionally include the area→solid-angle Jacobian
				// (area * cosAngle / distSq), so we multiply it into the weight here.
				const areaJacobian = float( 1.0 ).toVar();

				If( lightType.equal( int( RESTIR_LIGHT_TYPE_DIRECTIONAL ) ), () => {

					const dl = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, lightIndex ) );
					// Stored direction already points surface→light; no negation.
					lightDir.assign( dl.direction );
					lightDist.assign( float( 1e10 ) );
					lightEmission.assign( dl.color.mul( dl.intensity ) );

				} ).ElseIf( lightType.equal( int( RESTIR_LIGHT_TYPE_AREA ) ), () => {

					// Draw a parametric (u, v) on the rectangle's half-axes. These
					// are the values we persist into the reservoir so temporal /
					// spatial reuse can reconstruct the exact world-space sample
					// point at next frame's (possibly different) shading context.
					const uR = RandomValue( rngState ).toVar();
					const vR = RandomValue( rngState ).toVar();
					const al = AreaLight.wrap( getAreaLight( areaLightsBuffer, lightIndex ) );
					const worldPos = al.position
						.add( al.u.mul( uR.mul( 2.0 ).sub( 1.0 ) ) )
						.add( al.v.mul( vR.mul( 2.0 ).sub( 1.0 ) ) ).toVar();
					const toLight = worldPos.sub( hitPoint ).toVar();
					const d = length( toLight ).toVar();
					If( d.greaterThan( float( 1e-6 ) ), () => {

						const dirNorm = toLight.div( d ).toVar();
						const lightNormal = normalize( cross( al.u, al.v ) );
						const cosAngle = dot( dirNorm.negate(), lightNormal );
						If( cosAngle.greaterThan( float( 0.0 ) ), () => {

							lightDir.assign( dirNorm );
							lightDist.assign( d );
							lightEmission.assign( al.color.mul( al.intensity ) );
							storeDirX.assign( uR );
							storeDirY.assign( vR );
							// area→solid-angle jacobian = area * cos / dist² (see
							// sampleRectAreaLight for the paired forward math).
							areaJacobian.assign(
								al.area.mul( cosAngle ).div( max( d.mul( d ), float( 1e-6 ) ) )
							);

						} ).Else( () => {

							sampleValid.assign( tslBool( false ) );

						} );

					} ).Else( () => {

						sampleValid.assign( tslBool( false ) );

					} );

				} ).ElseIf( lightType.equal( int( RESTIR_LIGHT_TYPE_POINT ) ), () => {

					const pl = PointLight.wrap( getPointLight( pointLightsBuffer, lightIndex ) );
					const toLight = pl.position.sub( hitPoint ).toVar();
					const d = length( toLight ).toVar();
					lightDir.assign( toLight.div( max( d, float( 1e-6 ) ) ) );
					lightDist.assign( d );
					const att = getDistanceAttenuation( { lightDistance: d, cutoffDistance: pl.distance, decayExponent: pl.decay } );
					lightEmission.assign( pl.color.mul( pl.intensity ).mul( att ) );

				} ).Else( () => {

					const sl = SpotLight.wrap( getSpotLight( spotLightsBuffer, lightIndex ) );
					const toLight = sl.position.sub( hitPoint ).toVar();
					const d = length( toLight ).toVar();
					const dirNorm = toLight.div( max( d, float( 1e-6 ) ) ).toVar();
					lightDir.assign( dirNorm );
					lightDist.assign( d );
					// Spot attenuation: uses cosines, not raw angles. Outside cone → 0.
					const spotCosAngle = dot( dirNorm.negate(), sl.direction ).toVar();
					const coneCosAngle = cos( sl.angle ).toVar();
					const penumbraCosAngle = cos( sl.angle.mul( float( 1.0 ).sub( sl.penumbra ) ) ).max( coneCosAngle.add( 1e-5 ) ).toVar();
					const distAtt = getDistanceAttenuation( { lightDistance: d, cutoffDistance: sl.distance, decayExponent: sl.decay } );
					const spotAtt = getSpotAttenuation( { coneCosine: coneCosAngle, penumbraCosine: penumbraCosAngle, angleCosine: spotCosAngle } );
					lightEmission.assign( sl.color.mul( sl.intensity ).mul( distAtt ).mul( spotAtt ) );

				} );

				If( sampleValid, () => {

					// Unshadowed target pdf: scalar luminance of (emission * brdf * cos).
					const cosTheta = max( dot( hitNormal, lightDir ), 0.0 ).toVar();
					const brdfValue = evaluateMaterialResponse( viewDir, lightDir, hitNormal, material ).toVar();
					const unshadowedLuma = luminance( { color: lightEmission.mul( brdfValue ).mul( cosTheta ) } );
					const pHat = max( unshadowedLuma, float( 0.0 ) ).toVar();

					// Source PDF = (1 / totalDet) [× (distSq / (area * cosAngle)) for area].
					// w = p_hat / source_pdf = p_hat × totalDet × areaJacobian.
					// sourceReweight = 2.0 when env+det split candidates (multi-source fix).
					const w = pHat.div( max( invTotalDet, float( MIN_PDF ) ) )
						.mul( areaJacobian ).mul( sourceReweight );

					const encodedId = encodeLightSampleId( int( lightType ), int( lightIndex ) );
					reservoir.assign( Reservoir.wrap( reservoirUpdate(
						reservoir, encodedId, storeDirX, storeDirY, w, rngState,
					) ) );

				} );

			} );

			If( useEnvThisIter, () => {

				// Sample the env map via the CDF (direction, color, pdf in one pass).
				const envR1 = RandomValue( rngState );
				const envR2 = RandomValue( rngState );
				const envRand = vec2( envR1, envR2 );
				const envColor = vec3( 0.0 ).toVar();
				const envResult = sampleEquirectProbability(
					envTexture, envCDFBuffer,
					envMatrix, environmentIntensity, envTotalSum, envResolution,
					envRand, envColor,
				).toVar();
				const envDir = envResult.xyz.toVar();
				const envPdf = envResult.w.toVar();

				If( envPdf.greaterThan( float( 0.0 ) ), () => {

					const cosTheta = max( dot( hitNormal, envDir ), 0.0 ).toVar();
					If( cosTheta.greaterThan( float( 0.0 ) ), () => {

						// envColor already includes environmentIntensity scaling.
						const brdfValue = evaluateMaterialResponse( viewDir, envDir, hitNormal, material );
						const pHat = max( luminance( { color: envColor.mul( brdfValue ).mul( cosTheta ) } ), float( 0.0 ) );
						// Apply sourceReweight = M/n_env to correct multi-source bias.
						const w = pHat.div( max( envPdf, float( MIN_PDF ) ) ).mul( sourceReweight );

						// Octahedral-encode the sampled direction so we can
						// resolve this sample again across temporal / visibility reuse.
						const encDir = encodeOctahedral( { n: envDir } ).toVar();
						const encodedId = encodeLightSampleId( int( RESTIR_LIGHT_TYPE_ENV ), int( 0 ) );
						reservoir.assign( Reservoir.wrap( reservoirUpdate(
							reservoir, encodedId, encDir.x, encDir.y, w, rngState,
						) ) );

					} );

				} );

			} );

		} );

		// Snapshot the fresh-RIS M before temporal/spatial merges mutate it.
		// Used below as the spatial cap baseline so neighbors are throttled
		// relative to local fresh samples (not relative to already-accumulated
		// prev-frame M, which would scale the cap with the thing it's meant
		// to bound).
		const freshRisM = reservoir.M.toVar();

		// =================================================================
		// Phase 4 temporal reuse: merge last frame's reservoir into current.
		// =================================================================
		// We reproject the current pixel via last frame's motion vector
		// (published by MotionVector stage — 1-frame lagged, acceptable for
		// slow camera motion; the disocclusion test rejects stale samples
		// on fast motion). Then re-evaluate the prev sample's p_hat at the
		// current pixel's shading context (required for unbiased reservoirCombine).
		const motionTex = getMotionVectorTex();
		const prevNDTex = getPrevNormalDepthTex();
		const reservoirBuffer = getReservoirBuffer();
		const frameParity = getReservoirFrameParity();

		// JS-level guard: only compile the temporal-reuse branch when its texture
		// dependencies are wired up. Without this, textureLoad(null, ...) would
		// be evaluated at shader-graph-build time and crash even though the If
		// condition would have selected the fallback path at runtime.
		if ( motionTex !== null && prevNDTex !== null ) {

			const motion = textureLoad( motionTex, ivec2( pixelX, pixelY ) ).toVar();
			const motionValid = motion.w.greaterThan( 0.5 );

			// prevUV = currUV - motion.xy; prevPixel = round(prevUV * resolution - 0.5)
			const prevPxF = float( pixelX ).sub( motion.x.mul( float( renderWidth ) ) );
			const prevPyF = float( pixelY ).sub( motion.y.mul( float( renderHeight ) ) );
			const prevPx = int( prevPxF ).toVar();
			const prevPy = int( prevPyF ).toVar();

			const onScreen = prevPx.greaterThanEqual( int( 0 ) )
				.and( prevPx.lessThan( renderWidth ) )
				.and( prevPy.greaterThanEqual( int( 0 ) ) )
				.and( prevPy.lessThan( renderHeight ) );

			// If the motion vector is marked invalid (e.g., MotionVector stage hasn't
			// run yet on the very first frame, or the reprojection produced an
			// off-screen prev-UV), fall back to identity reprojection — the current
			// pixel's own prev-frame slot. The disocclusion test (normal + depth)
			// below is the authoritative validity gate; motion.w being 0 just means
			// "don't offset", not "skip temporal entirely". Skipping here would
			// suppress all cross-frame M accumulation when motion is flaky.
			If( motionValid.not().or( onScreen.not() ), () => {

				prevPx.assign( int( pixelX ) );
				prevPy.assign( int( pixelY ) );

			} );

			If( tslBool( true ), () => {

				// Disocclusion test against prev normal/depth.
				// pathtracer:normalDepth.xyz stores (worldNormal * 0.5 + 0.5) — decode
				// before the dot. .w stores world-space ray distance (linear depth);
				// we compare it to the current pixel's hitDistance with a RELATIVE
				// tolerance (scale-invariant) so the gate behaves the same close to
				// and far from the camera.
				const prevND = textureLoad( prevNDTex, ivec2( prevPx, prevPy ) ).toVar();
				const prevNormal = prevND.xyz.mul( 2.0 ).sub( 1.0 );
				const prevDepth = prevND.w;
				const normalSim = dot( hitNormal, prevNormal );
				const depthDiff = abs( hitDistance.sub( prevDepth ) );
				const depthScale = max( hitDistance, float( 1e-3 ) );
				const relDepthDiff = depthDiff.div( depthScale );

				// Combined disocclusion test: normal similar AND relative depth within
				// 5% of current hit distance. Rejects reprojections across surfaces
				// and across real depth discontinuities while tolerating sub-pixel
				// reconstruction error.
				If( normalSim.greaterThan( float( 0.95 ) ).and( relDepthDiff.lessThan( float( 0.05 ) ) ), () => {

					// Load prev reservoir from the opposite ping-pong slot.
					// Each slot is 2 consecutive vec4s: core + aux.
					const prevParity = int( 1 ).sub( frameParity ).toVar();
					const prevBase = reservoirSlotIndex( prevPx, prevPy, renderWidth, prevParity );
					const prevCore = reservoirBuffer.element( prevBase ).toVar();
					const prevAux = reservoirBuffer.element( prevBase.add( int( 1 ) ) ).toVar();
					const prevRes = Reservoir.wrap( unpackReservoir( prevCore, prevAux ) ).toVar();

					// Skip empty / invalid reservoirs.
					If( prevRes.M.greaterThan( float( 0.0 ) ).and( prevRes.W.greaterThan( float( 0.0 ) ) ), () => {

						// Re-evaluate p_hat of prev's chosen sample at the CURRENT pixel.
						const prevSample = LightSample.wrap( resolveAndEvaluateRestirSample(
							prevRes.lightSampleId, prevRes.dirX, prevRes.dirY,
							hitPoint, hitNormal, material, viewDir,
							directionalLightsBuffer, numDirectionalLights,
							areaLightsBuffer, numAreaLights,
							pointLightsBuffer, numPointLights,
							spotLightsBuffer, numSpotLights,
							envTexture, environmentIntensity, envMatrix, envTotalSum, envResolution,
						) ).toVar();

						If( prevSample.valid.and( prevSample.pdf.greaterThan( float( 0.0 ) ) ), () => {

							// Cap prev.M to prevent stale reservoirs from dominating forever.
							const cappedM = reservoir.M.mul( float( RESTIR_TEMPORAL_M_CAP_MULTIPLIER ) );
							const cappedPrev = Reservoir.wrap( reservoirCapM( prevRes, cappedM ) ).toVar();

							// Merge — pdf field carries the re-evaluated p_hat_curr(prev.sample).
							reservoir.assign( Reservoir.wrap( reservoirCombine(
								reservoir, cappedPrev, prevSample.pdf, rngState,
							) ) );

						} );

					} );

				} );

			} );

			// =============================================================
			// Phase 5 spatial reuse: merge K neighbors' previous-frame reservoirs.
			// =============================================================
			// Tuned to K=1 based on DevTools Sponza analysis. Spatial reuse
			// is cost-neutral when the scene is primary-BVH-limited, which is
			// the common case on heavy scenes.
			if ( prevNDTex !== null ) {

				const RESTIR_SPATIAL_SAMPLES = 1;
				const RESTIR_SPATIAL_RADIUS = 10.0; // pixels

				Loop( { start: int( 0 ), end: int( RESTIR_SPATIAL_SAMPLES ), type: 'int', condition: '<' }, () => {

					// Random disk offset (sqrt for area-uniform sampling).
					const rrad = RandomValue( rngState ).sqrt().mul( float( RESTIR_SPATIAL_RADIUS ) );
					const rTheta = RandomValue( rngState ).mul( float( 2.0 ).mul( float( PI ) ) );
					const offX = int( rrad.mul( cos( rTheta ) ) ).toVar();
					const offY = int( rrad.mul( sin( rTheta ) ) ).toVar();
					const nX = pixelX.add( offX ).toVar();
					const nY = pixelY.add( offY ).toVar();

					const nInBounds = nX.greaterThanEqual( int( 0 ) )
						.and( nX.lessThan( renderWidth ) )
						.and( nY.greaterThanEqual( int( 0 ) ) )
						.and( nY.lessThan( renderHeight ) );

					If( nInBounds, () => {

						// Disocclusion check against the neighbor's prev normal/depth
						// (same linear-depth convention + relative tolerance as temporal).
						const nND = textureLoad( prevNDTex, ivec2( nX, nY ) ).toVar();
						const nNormal = nND.xyz.mul( 2.0 ).sub( 1.0 );
						const nDepth = nND.w;
						const nSim = dot( hitNormal, nNormal );
						const nDepthDiff = abs( hitDistance.sub( nDepth ) );
						const nDepthScale = max( hitDistance, float( 1e-3 ) );
						const nRelDepthDiff = nDepthDiff.div( nDepthScale );

						// Slightly looser thresholds than temporal — a spatial neighbor is
						// always on a different pixel, so a small depth-ratio mismatch is
						// expected and acceptable.
						If( nSim.greaterThan( float( 0.9 ) ).and( nRelDepthDiff.lessThan( float( 0.08 ) ) ), () => {

							const prevParityS = int( 1 ).sub( frameParity ).toVar();
							const nBase = reservoirSlotIndex( nX, nY, renderWidth, prevParityS );
							const nCore = reservoirBuffer.element( nBase ).toVar();
							const nAux = reservoirBuffer.element( nBase.add( int( 1 ) ) ).toVar();
							const nRes = Reservoir.wrap( unpackReservoir( nCore, nAux ) ).toVar();

							If( nRes.M.greaterThan( float( 0.0 ) ).and( nRes.W.greaterThan( float( 0.0 ) ) ), () => {

								const nSample = LightSample.wrap( resolveAndEvaluateRestirSample(
									nRes.lightSampleId, nRes.dirX, nRes.dirY,
									hitPoint, hitNormal, material, viewDir,
									directionalLightsBuffer, numDirectionalLights,
									areaLightsBuffer, numAreaLights,
									pointLightsBuffer, numPointLights,
									spotLightsBuffer, numSpotLights,
									envTexture, environmentIntensity, envMatrix, envTotalSum, envResolution,
								) ).toVar();

								If( nSample.valid.and( nSample.pdf.greaterThan( float( 0.0 ) ) ), () => {

									// Cap neighbor contribution at SPATIAL_MULT × fresh RIS M
									// (NOT × post-temporal M — that already contains the prev-frame
									// accumulation we're trying to bound). Using freshRisM keeps
									// the spatial merge balanced against the local per-frame
									// candidate pool: neighbor contributes at most like one fresh
									// sample's worth of "trust", preserving the visibility cache
									// across frames (spatial won't dominate biased-combine RIS
									// adoption every single frame).
									const capM = freshRisM.mul( float( RESTIR_SPATIAL_M_CAP_MULTIPLIER ) );
									const cappedN = Reservoir.wrap( reservoirCapM( nRes, capM ) ).toVar();
									// Spatial variant: invalidates visibility cache on sample adoption
									// (neighbor's visibility was tested at their geometry, not ours —
									// reusing it bleeds light across occlusion boundaries).
									reservoir.assign( Reservoir.wrap( reservoirCombineSpatial(
										reservoir, cappedN, nSample.pdf, rngState,
									) ) );

								} );

							} );

						} );

					} );

				} );

			}

		} // end JS-level temporal-reuse guard

		// Re-resolve the (possibly-updated-by-temporal-merge) chosen sample.
		const chosen = LightSample.wrap( resolveAndEvaluateRestirSample(
			reservoir.lightSampleId, reservoir.dirX, reservoir.dirY,
			hitPoint, hitNormal, material, viewDir,
			directionalLightsBuffer, numDirectionalLights,
			areaLightsBuffer, numAreaLights,
			pointLightsBuffer, numPointLights,
			spotLightsBuffer, numSpotLights,
			envTexture, environmentIntensity, envMatrix, envTotalSum, envResolution,
		) ).toVar();

		// Finalize W = sumWeights / (M * p_hat(chosen)).
		reservoir.assign( Reservoir.wrap( reservoirFinalize( reservoir, chosen.pdf ) ) );

		// ==================================================================
		// Phase 4B visibility reuse: skip the shadow ray when the reservoir
		// came from a recent frame's already-tested sample.
		// ==================================================================
		// Cache is valid when:
		//   - Sample was shadow-tested in a prior frame (frameAge > 0)
		//   - Test is fresh enough (frameAge < MAX) — bounds the cost of stale
		//     shadows when occluders move while the disocclusion test still passes.
		//   - Sample still resolves to a valid light this frame (chosen.valid).
		const cacheValid = reservoir.frameAge.greaterThan( float( 0.5 ) )
			.and( reservoir.frameAge.lessThan( float( RESTIR_VISIBILITY_MAX_AGE ) ) )
			.and( chosen.valid );

		const effectiveVis = float( 0.0 ).toVar();
		const didTrace = tslBool( false ).toVar();

		If( cacheValid, () => {

			// Cache hit — use stored visibility without tracing a shadow ray.
			effectiveVis.assign( reservoir.visibility );

		} ).Else( () => {

			// Must trace. Only bother if the reservoir has a usable sample.
			If( chosen.valid.and( reservoir.W.greaterThan( float( 0.0 ) ) ), () => {

				const shadowMaxDist = chosen.distance.sub( float( 0.001 ) );
				effectiveVis.assign( traceShadowRay(
					rayOrigin, chosen.direction, shadowMaxDist, rngState,
					traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
				) );
				didTrace.assign( tslBool( true ) );

			} );

		} );

		// Apply contribution.
		If( chosen.valid.and( reservoir.W.greaterThan( float( 0.0 ) ) ).and( effectiveVis.greaterThan( float( 0.0 ) ) ), () => {

			const chosenCos = max( dot( hitNormal, chosen.direction ), 0.0 );
			const chosenBRDF = evaluateMaterialResponse( viewDir, chosen.direction, hitNormal, material );
			const chosenUnshadowed = chosen.emission.mul( chosenBRDF ).mul( chosenCos );
			contribution.assign( chosenUnshadowed.mul( reservoir.W ).mul( effectiveVis ) );

		} );

		// Update the reservoir's visibility cache for the next frame.
		//   - If we traced: record this frame's result, frameAge = 1 (fresh).
		//   - If we used cache: increment frameAge so it eventually forces a re-test.
		const newVis = didTrace.select( effectiveVis.greaterThan( float( 0.0 ) ).select( float( 1.0 ), float( 0.0 ) ), reservoir.visibility );
		const newAge = didTrace.select( float( 1.0 ), reservoir.frameAge.add( float( 1.0 ) ) );
		const updatedReservoir = Reservoir( {
			lightSampleId: reservoir.lightSampleId,
			W: reservoir.W,
			sumWeights: reservoir.sumWeights,
			M: reservoir.M,
			visibility: newVis,
			frameAge: newAge,
			dirX: reservoir.dirX,
			dirY: reservoir.dirY,
		} ).toVar();

		// Write both vec4s (core + aux) to the current ping-pong slot.
		const currBase = reservoirSlotIndex( pixelX, pixelY, renderWidth, frameParity );
		reservoirBuffer.element( currBase ).assign( packReservoirCore( updatedReservoir ) );
		reservoirBuffer.element( currBase.add( int( 1 ) ) ).assign( packReservoirAux( updatedReservoir ) );

	} );

	return contribution;

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
	envCDFBuffer,
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
		// (env is handled deterministically below, not part of stochastic selection)
		const useBRDFSampling = misResult.useBRDFSampling.toVar();
		const useLightSampling = misResult.useLightSampling.toVar();
		const brdfWeight = misResult.brdfWeight.toVar();
		const lightWeight = misResult.lightWeight.toVar();

		// Adaptive light processing
		const totalLights = numDirectionalLights.add( numAreaLights ).add( numPointLights ).add( numSpotLights ).toVar();

		const importanceThreshold = float( 0.001 ).mul( float( 1.0 ).add( float( bounceIndex ).mul( 0.5 ) ) ).toVar();

		// Check if discrete lights exist
		const hasDiscreteLights = totalLights.greaterThan( int( 0 ) ).toVar();

		// Calculate total sampling weight for stochastic {lights, BRDF} selection
		const totalSamplingWeight = float( 0.0 ).toVar();

		If( useLightSampling.and( hasDiscreteLights ), () => {

			totalSamplingWeight.addAssign( lightWeight );

		} );

		If( useBRDFSampling, () => {

			totalSamplingWeight.addAssign( brdfWeight );

		} );

		If( totalSamplingWeight.lessThanEqual( 0.0 ), () => {

			totalSamplingWeight.assign( 1.0 );
			useBRDFSampling.assign( tslBool( true ) );
			brdfWeight.assign( 1.0 );

		} );

		const stratRand1 = RandomValue( rngState ).toVar();
		const stratRand2 = RandomValue( rngState ).toVar();

		// Determine sampling technique: stochastic {lights, BRDF}
		const rand = stratRand1;
		const sampleLights = tslBool( false ).toVar();
		const sampleBRDF = tslBool( false ).toVar();

		// Calculate effective weights for probability (only include light weight if lights exist)
		const effectiveLightWeight = select( hasDiscreteLights, lightWeight, float( 0.0 ) ).toVar();
		// Guard division
		const invTotalSamplingWeight = float( 1.0 ).div( max( totalSamplingWeight, 1e-10 ) ).toVar();
		const cumulativeLight = effectiveLightWeight.mul( invTotalSamplingWeight ).toVar();

		If( rand.lessThan( cumulativeLight ).and( useLightSampling ).and( hasDiscreteLights ), () => {

			sampleLights.assign( tslBool( true ) );

		} ).ElseIf( useBRDFSampling, () => {

			sampleBRDF.assign( tslBool( true ) );

		} ).ElseIf( hasDiscreteLights, () => {

			// Fallback to light sampling only if lights exist
			sampleLights.assign( tslBool( true ) );

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

							// Apply power heuristic only for area lights — the BRDF path can
							// intersect area lights, so both strategies contribute and MIS is valid.
							// Point/spot/directional lights are delta or non-intersectable by the
							// BRDF path, so MIS would only reduce energy without compensation.
							If( lightSample.lightType.equal( int( LIGHT_TYPE_AREA ) ), () => {

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
		// DETERMINISTIC ENVIRONMENT NEE
		// Always runs (not stochastic) — forms a two-strategy Veach MIS
		// estimator together with the implicit miss check in the main loop.
		// =====================================================================

		If( enableEnvironmentLight, () => {

			const env_r1 = RandomValue( rngState ).toVar();
			const env_r2 = RandomValue( rngState ).toVar();
			const envRandom = vec2( env_r1, env_r2 ).toVar();
			const envColor = vec3( 0.0 ).toVar();

			// Sample direction + PDF + color from importance-sampled environment
			const envSampleResult = sampleEquirectProbability(
				envTexture, envCDFBuffer,
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

						// Standard two-strategy MIS: NEE (envPdf) vs implicit miss (materialPdf).
						// The implicit path uses material combinedPdf as prevBouncePdf at the miss check.
						const misW = select(
							bPdf.greaterThan( 0.0 ),
							powerHeuristic( { pdf1: envPdf, pdf2: bPdf } ),
							float( 1.0 )
						).toVar();

						// Guard division — no stochastic scaling needed (deterministic estimator)
						const envContribution = envColor.mul( brdfValue ).mul( NoL ).mul( visibility ).mul( misW ).div( max( envPdf, 1e-10 ) );
						totalContribution.addAssign( envContribution );

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
