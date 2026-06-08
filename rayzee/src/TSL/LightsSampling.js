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
 *  - sampleRectAreaLight              — rectangle area light sampling
 *  - sampleSpotLightWithRadius        — spot light sampling with radius
 *  - samplePointLightWithAttenuation  — point light sampling with attenuation
 *  - sampleLightWithImportance        — importance-weighted light selection (3-pass)
 *  - calculateMaterialPDF             — material PDF for MIS
 *  - calculateDirectLightingUnified   — unified direct lighting (main entry)
 */

import {
	Fn,
	float,
	vec2,
	vec3,
	int,
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
	mix,
	select,
	If,
	Loop,
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
	sampleSpotGoboMask,
	sampleDirectionalGoboMask,
	sampleIESProfile,
} from './LightsCore.js';

import { MISStrategy, DotProducts } from './Struct.js';
import {
	calculateDirectionalLightImportance,
	estimateLightImportance,
	calculatePointLightImportance,
	calculateSpotLightImportance,
	traceShadowRay,
} from './LightsDirect.js';

import { traverseBVHShadow } from './BVHTraversal.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { calculateVNDFPDF } from './MaterialProperties.js';
import { RandomValue } from './Random.js';
import {
	selectOptimalMISStrategy,
	PI,
	PI_INV,
	EPSILON,
	powerHeuristic,
	balanceHeuristic,
	computeDotProducts,
} from './Common.js';
import {
	sampleEquirectProbability,
} from './Environment.js';

const TWO_PI = 2.0 * PI;

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
			.add( light.v.mul( ruv.y.mul( 2.0 ).sub( 1.0 ) ) );

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
		lightIndex: int( - 1 ),
	} );

} );

// Enhanced spot light sampling with radius support
export const sampleSpotLightWithRadius = Fn( ( [ light, rayOrigin, lightSelectionPdf ] ) => {

	const ls_valid = tslBool( false ).toVar();
	const ls_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const ls_emission = vec3( 0.0 ).toVar();
	const ls_distance = float( 0.0 ).toVar();
	const ls_pdf = float( 0.0 ).toVar();
	const ls_lightType = int( LIGHT_TYPE_SPOT ).toVar();

	const toLight = light.position.sub( rayOrigin ).toVar();
	// Guard via lengthSq so the sqrt is skipped on rejected (zero-distance) samples.
	const lightDistSq = dot( toLight, toLight ).toVar();

	// Guard against zero distance
	If( lightDistSq.greaterThanEqual( 1e-20 ), () => {

		const lightDist = sqrt( lightDistSq ).toVar();
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

			// Gobo projection mask + IES photometric profile — both 1.0 when not assigned.
			const goboMask = sampleSpotGoboMask( light, lightDir );
			const iesProfile = sampleIESProfile( light, lightDir );

			ls_emission.assign( light.color.mul( light.intensity ).mul( distanceAttenuation ).mul( coneAttenuation ).mul( goboMask ).mul( iesProfile ) );

		} );

	} );

	return LightSample( {
		valid: ls_valid,
		direction: ls_direction,
		emission: ls_emission,
		distance: ls_distance,
		pdf: ls_pdf,
		lightType: ls_lightType,
		lightIndex: int( - 1 ),
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
	// Guard via lengthSq so the sqrt is skipped on rejected (zero-distance) samples.
	const lightDistSq = dot( toLight, toLight ).toVar();

	// Guard against zero distance
	If( lightDistSq.greaterThanEqual( 1e-20 ), () => {

		const lightDist = sqrt( lightDistSq ).toVar();
		const lightDir = toLight.div( lightDist );

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
		lightIndex: int( - 1 ),
	} );

} );

// =============================================================================
// Importance-Weighted Light Sampling
// =============================================================================

// Single-pass weighted-reservoir sampling: each light's importance is evaluated
// exactly once. Compared to the previous 3-pass CDF (sum-then-walk-then-sample)
// this halves the importance evaluations and storage-buffer reads per NEE call.
// Selection rule: with seen_weight = sum of weights so far, replace current
// winner with this candidate with probability w_i / seen_weight. Result is
// unbiased; PDF = winnerImportance / totalWeight, identical to the CDF form.
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
	const r_lightIndex = int( - 1 ).toVar(); // within-type index (ReSTIR Le re-derivation)

	const totalLights = numDirectionalLights.add( numAreaLights ).add( numPointLights ).add( numSpotLights ).toVar();

	If( totalLights.greaterThan( int( 0 ) ), () => {

		const totalWeight = float( 0.0 ).toVar();
		const lightIndex = int( 0 ).toVar();

		// Reservoir state: winning light's type/index/importance.
		const selectedType = int( - 1 ).toVar(); // 0=dir, 1=area, 2=point, 3=spot
		const selectedIdx = int( - 1 ).toVar();
		const selectedImportance = float( 0.0 ).toVar();

		// =====================================================================
		// SINGLE PASS: reservoir-sample across all four light type buffers
		// =====================================================================

		If( numDirectionalLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numDirectionalLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( lightIndex.lessThan( int( 16 ) ), () => {

					const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, i ) );
					const importance = calculateDirectionalLightImportance( light, normal, material, bounceIndex ).toVar();
					totalWeight.addAssign( importance );
					If( importance.greaterThan( 0.0 ).and(
						RandomValue( rngState ).mul( totalWeight ).lessThan( importance )
					), () => {

						selectedType.assign( 0 );
						selectedIdx.assign( i );
						selectedImportance.assign( importance );

					} );
					lightIndex.addAssign( 1 );

				} );

			} );

		} );

		If( numAreaLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numAreaLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( lightIndex.lessThan( int( 16 ) ), () => {

					const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, i ) );
					const importance = select( light.intensity.greaterThan( 0.0 ), estimateLightImportance( light, rayOrigin, normal, material ), float( 0.0 ) ).toVar();
					totalWeight.addAssign( importance );
					If( importance.greaterThan( 0.0 ).and(
						RandomValue( rngState ).mul( totalWeight ).lessThan( importance )
					), () => {

						selectedType.assign( 1 );
						selectedIdx.assign( i );
						selectedImportance.assign( importance );

					} );
					lightIndex.addAssign( 1 );

				} );

			} );

		} );

		If( numPointLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numPointLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( lightIndex.lessThan( int( 16 ) ), () => {

					const light = PointLight.wrap( getPointLight( pointLightsBuffer, i ) );
					const importance = calculatePointLightImportance( light, rayOrigin, normal, material ).toVar();
					totalWeight.addAssign( importance );
					If( importance.greaterThan( 0.0 ).and(
						RandomValue( rngState ).mul( totalWeight ).lessThan( importance )
					), () => {

						selectedType.assign( 2 );
						selectedIdx.assign( i );
						selectedImportance.assign( importance );

					} );
					lightIndex.addAssign( 1 );

				} );

			} );

		} );

		If( numSpotLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numSpotLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( lightIndex.lessThan( int( 16 ) ), () => {

					const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, i ) );
					const importance = calculateSpotLightImportance( light, rayOrigin, normal, material ).toVar();
					totalWeight.addAssign( importance );
					If( importance.greaterThan( 0.0 ).and(
						RandomValue( rngState ).mul( totalWeight ).lessThan( importance )
					), () => {

						selectedType.assign( 3 );
						selectedIdx.assign( i );
						selectedImportance.assign( importance );

					} );
					lightIndex.addAssign( 1 );

				} );

			} );

		} );

		// =====================================================================
		// Fallback: Uniform Sampling if no importance
		// =====================================================================

		If( totalWeight.lessThanEqual( 0.0 ), () => {

			const lightSelection = randomSeed.x.mul( float( totalLights ) );
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

						const dirGoboMask = sampleDirectionalGoboMask( light, rayOrigin );
						r_direction.assign( normalize( light.direction ) );
						r_emission.assign( light.color.mul( light.intensity ).mul( dirGoboMask ) );
						r_distance.assign( 1e6 );
						r_lightType.assign( int( LIGHT_TYPE_DIRECTIONAL ) );
						r_lightIndex.assign( selectedLight.sub( currentIdx ) );
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
						r_lightIndex.assign( selectedLight.sub( currentIdx ) );
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
						r_lightIndex.assign( selectedLight.sub( currentIdx ) );
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

						const spotSample = LightSample.wrap( sampleSpotLightWithRadius( light, rayOrigin, lightSelectionPdf ) );
						r_valid.assign( spotSample.valid );
						r_direction.assign( spotSample.direction );
						r_emission.assign( spotSample.emission );
						r_distance.assign( spotSample.distance );
						r_pdf.assign( spotSample.pdf );
						r_lightType.assign( spotSample.lightType );
						r_lightIndex.assign( selectedLight.sub( currentIdx ) );
						sampled.assign( tslBool( true ) );

					} );

				} );

			} );

		} ).Else( () => {

			// =================================================================
			// Sample the reservoir-selected light. selectedType / selectedIdx /
			// selectedImportance were populated during the single-pass walk above.
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
					const solidAngle = float( TWO_PI ).mul( max( float( 1.0 ).sub( cosHalfAngle ), 1e-10 ) );
					dirPdf.assign( float( 1.0 ).div( solidAngle ) );

				} );

				const dirGoboMask = sampleDirectionalGoboMask( light, rayOrigin );
				r_direction.assign( direction );
				r_emission.assign( light.color.mul( light.intensity ).mul( dirGoboMask ) );
				r_distance.assign( 1e6 );
				r_pdf.assign( dirPdf.mul( pdf ) );
				r_lightType.assign( int( LIGHT_TYPE_DIRECTIONAL ) );
				r_lightIndex.assign( selectedIdx );
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
				r_lightIndex.assign( selectedIdx );

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
				r_lightIndex.assign( selectedIdx );

			} );

			// Spot light sampling
			If( selectedType.equal( int( 3 ) ).and( selectedIdx.greaterThanEqual( int( 0 ) ) ), () => {

				const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, selectedIdx ) );
				const spotSample = LightSample.wrap( sampleSpotLightWithRadius( light, rayOrigin, pdf ) );
				r_valid.assign( spotSample.valid );
				r_direction.assign( spotSample.direction );
				r_emission.assign( spotSample.emission );
				r_distance.assign( spotSample.distance );
				r_pdf.assign( spotSample.pdf );
				r_lightType.assign( spotSample.lightType );
				r_lightIndex.assign( selectedIdx );

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
		lightIndex: r_lightIndex,
	} );

} );

// =============================================================================
// Material PDF Calculation for MIS
// =============================================================================

// PDF computation given precomputed dot products. Use this when the caller
// already has dots from a paired evaluateMaterialResponseFromDots invocation
// to avoid recomputing H + dots.
export const calculateMaterialPDFFromDots = Fn( ( [ material, dots ] ) => {

	const NoV = dots.NoV;
	const NoL = dots.NoL.toVar();
	const NoH = dots.NoH;

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

			const roughness = max( material.roughness, 0.02 );
			pdf.addAssign( specularWeight.mul( calculateVNDFPDF( NoH, NoV, roughness ) ) );

		} );

	} );

	return max( pdf, 1e-8 );

} );

// Wrapper that computes dots internally. Use this when the caller doesn't
// already have dots; otherwise prefer calculateMaterialPDFFromDots.
export const calculateMaterialPDF = Fn( ( [ viewDir, lightDir, normal, material ] ) => {

	const dots = DotProducts.wrap( computeDotProducts( normal, viewDir, lightDir ) );
	return calculateMaterialPDFFromDots( material, dots );

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
	bounceIndex, rngState,
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
	envCDFTexture,
	envTotalSum, envCompensationDelta, envResolution,
	enableEnvironmentLight,
	// Phase-1 ReSTIR DI gate: when true (bounce 0 && enableReSTIR), skip ONLY the discrete-analytic
	// light-sampling block — env NEE + BRDF-MIS stay on. ReSTIR resolves the discrete term separately.
	skipDiscreteLighting,
] ) => {

	const totalContribution = vec3( 0.0 ).toVar();
	const rayOrigin = hitPoint.add( hitNormal.mul( 0.001 ) ).toVar();

	// Binds BVH params so shadow-ray sites at varying call depths use a 3-arg call
	const shadow = Fn( ( [ origin, dir, maxDist ] ) =>
		traceShadowRay( origin, dir, maxDist, traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer )
	);

	// Early exit for highly emissive surfaces
	If( material.emissiveIntensity.lessThanEqual( 10.0 ), () => {

		// Adaptive MIS Strategy Selection
		const currentThroughput = vec3( 1.0 ).toVar();
		const misResult = MISStrategy.wrap( selectOptimalMISStrategy(
			material.roughness, material.metalness, bounceIndex, currentThroughput
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
		const effectiveLightWeight = select( hasDiscreteLights, lightWeight, float( 0.0 ) );
		// Guard division
		const invTotalSamplingWeight = float( 1.0 ).div( max( totalSamplingWeight, 1e-10 ) );
		const cumulativeLight = effectiveLightWeight.mul( invTotalSamplingWeight );

		If( rand.lessThan( cumulativeLight ).and( useLightSampling ).and( hasDiscreteLights ), () => {

			sampleLights.assign( tslBool( true ) );

		} ).ElseIf( useBRDFSampling, () => {

			sampleBRDF.assign( tslBool( true ) );

		} ).ElseIf( hasDiscreteLights, () => {

			// Fallback to light sampling only if lights exist
			sampleLights.assign( tslBool( true ) );

		} );

		// =====================================================================
		// LIGHT SAMPLING PATH (discrete analytic lights)
		// Phase-1 ReSTIR DI gates ONLY this block (bounce 0 && enableReSTIR) — env NEE + BRDF-MIS
		// below stay on (separate If blocks, unaffected). ReSTIR's resolve pass replaces this term.
		// Stream divergence from skipping the inner draws is harmless (interactive-only; unbiased
		// accumulator either way).
		// =====================================================================

		If( sampleLights.and( skipDiscreteLighting.not() ), () => {

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
				const lightImportance = lightSample.emission.x.add( lightSample.emission.y ).add( lightSample.emission.z );

				If( NoL.greaterThan( 0.0 ).and( lightImportance.mul( NoL ).greaterThan( importanceThreshold ) ).and( isDirectionValid( { direction: lightSample.direction, surfaceNormal: hitNormal } ) ), () => {

					const shadowDistance = min( lightSample.distance.sub( 0.001 ), float( 1000.0 ) );
					const visibility = shadow( rayOrigin, lightSample.direction, shadowDistance );

					If( visibility.greaterThan( 0.0 ), () => {

						// Share H + dot products between BRDF eval and PDF — otherwise each
						// would recompute normalize(V+L) + 5 dot products independently.
						const sharedDots = DotProducts.wrap( computeDotProducts( hitNormal, viewDir, lightSample.direction ) );
						const brdfValue = evaluateMaterialResponseFromDots( material, sharedDots );
						const bPdf = calculateMaterialPDFFromDots( material, sharedDots ).toVar();

						const misW = float( 1.0 ).toVar();

						If( bPdf.greaterThan( 0.0 ).and( useBRDFSampling ), () => {

							const lightPdfWeighted = lightSample.pdf.mul( lightWeight );
							const brdfPdfWeighted = bPdf.mul( brdfWeight );

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

					// Check intersection with area lights. Gated off when ReSTIR owns bounce-0 direct lighting
					// (skipDiscreteLighting): ReSTIR's resolve already adds the FULL area-light contribution, so
					// this BRDF-sampling-hits-area MIS term would DOUBLE-COUNT area lights (~+34% over-bright).
					// Point/spot/directional are delta → no BRDF-hit term here → unaffected. Env MIS (below) stays.
					If( numAreaLights.greaterThan( int( 0 ) ).and( skipDiscreteLighting.not() ), () => {

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

								const shadowDistance = min( hitDistance.sub( 0.001 ), float( 1000.0 ) );
								const visibility = shadow( rayOrigin, brdfSampleDirection, shadowDistance );

								If( visibility.greaterThan( 0.0 ), () => {

									const lightFacing = max( float( 0.0 ), dot( brdfSampleDirection, light.normal ).negate() ).toVar();

									If( lightFacing.greaterThan( 0.0 ), () => {

										const lightDistSq = hitDistance.mul( hitDistance );
										// Guard division
										const lightPdf = lightDistSq.div( max( light.area.mul( lightFacing ), EPSILON ) ).toVar();
										lightPdf.divAssign( max( float( totalLights ), 1.0 ) );

										const brdfPdfWeighted = brdfSamplePdf.mul( brdfWeight );
										const lightPdfWeighted = lightPdf.mul( lightWeight );
										const misW = powerHeuristic( { pdf1: brdfPdfWeighted, pdf2: lightPdfWeighted } ).toVar();

										const lightEmission = light.color.mul( light.intensity );
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
				envTexture, envCDFTexture,
				envMatrix, environmentIntensity, envTotalSum, envCompensationDelta, envResolution, envRandom, envColor
			).toVar();

			const envDirection = envSampleResult.xyz.toVar();
			const envPdf = envSampleResult.w.toVar();

			If( envPdf.greaterThan( 0.0 ), () => {

				const NoL = max( float( 0.0 ), dot( hitNormal, envDirection ) ).toVar();

				If( NoL.greaterThan( 0.0 ).and( isDirectionValid( { direction: envDirection, surfaceNormal: hitNormal } ) ), () => {

					const visibility = shadow( rayOrigin, envDirection, float( 1000.0 ) );

					If( visibility.greaterThan( 0.0 ), () => {

						// Share H + dots between env BRDF/PDF — same redundancy fix as the
						// discrete-light path above.
						const envDots = DotProducts.wrap( computeDotProducts( hitNormal, viewDir, envDirection ) );
						const brdfValue = evaluateMaterialResponseFromDots( material, envDots );
						const bPdf = calculateMaterialPDFFromDots( material, envDots ).toVar();

						// Balance heuristic for env MIS — optimal for MIS-compensated PDFs (Karlík et al. 2019).
						// The implicit path uses material combinedPdf as prevBouncePdf at the miss check.
						const misW = select(
							bPdf.greaterThan( 0.0 ),
							balanceHeuristic( { pdf1: envPdf, pdf2: bPdf } ),
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
