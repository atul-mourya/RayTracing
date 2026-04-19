// Lights Direct - Ported from lights_direct.fs
// Direct lighting calculations including shadow ray tracing
// and contribution calculations for all light types.

import {
	Fn,
	vec2,
	vec3,
	vec4,
	float,
	int,
	bool as tslBool,
	If,
	Loop,
	Break,
	dot,
	normalize,
	abs,
	max,
	min,
	length,
	sqrt,
	pow,
	cos,
	clamp,
	smoothstep,
	select,
	texture,
} from 'three/tsl';

import { Ray, ShadowMaterial, HitInfo, DirectionSample, MaterialCache } from './Struct.js';
import { PI, TWO_PI, EPSILON, REC709_LUMINANCE_COEFFICIENTS, powerHeuristic, getShadowMaterial, getDatafromStorageBuffer } from './Common.js';
import { fresnelSchlickFloat } from './Fresnel.js';
import { iorToFresnel0 } from './Fresnel.js';
import {
	DirectionalLight, AreaLight, PointLight, SpotLight,
	sampleCone, intersectAreaLight,
} from './LightsCore.js';
import { calculateBeerLawAbsorption, calculateShadowTransmittance } from './MaterialTransmission.js';
import { RandomValue } from './Random.js';
import { getTransformedUV } from './TextureSampling.js';

// Module-level state for alpha-cutout shadow testing.
// Set by ShaderBuilder before graph construction.
let _shadowAlbedoMaps = null;
let _enableAlphaShadows = null;

/**
 * Set the albedo texture array node for alpha-aware shadow rays.
 * Must be called before the shader graph is constructed.
 * @param {TextureNode} maps - TSL texture node for the albedo array
 */
export function setShadowAlbedoMaps( maps ) {

	_shadowAlbedoMaps = maps;

}

/**
 * Set the runtime uniform node that toggles alpha-cutout shadows.
 * @param {UniformNode} node - TSL int uniform (0 = disabled, 1 = enabled)
 */
export function setAlphaShadowsUniform( node ) {

	_enableAlphaShadows = node;

}

// ================================================================================
// SHADOW RAY MATERIAL TRANSPARENCY
// ================================================================================

export const getMaterialTransparency = Fn( ( [ shadowHit, shadowRayDir, rngState ] ) => {

	const result = float( 1.0 ).toVar();

	// Check if the material has transmission (like glass)
	If( shadowHit.material.transmission.greaterThan( 0.0 ), () => {

		const isEntering = dot( shadowRayDir, shadowHit.normal ).lessThan( 0.0 );
		const transmittance = calculateShadowTransmittance( shadowRayDir, shadowHit.normal, shadowHit.material, isEntering );
		result.assign( float( 1.0 ).sub( transmittance ) );

	} ).ElseIf( shadowHit.material.transparent, () => {

		result.assign( shadowHit.material.opacity );

	} );

	return result;

} );

// ================================================================================
// SHADOW RAY TRACING
// ================================================================================

// Note: traverseBVH is passed as a parameter to avoid circular dependency
export const traceShadowRay = Fn( ( [
	origin, dir, maxDist, rngState,
	// BVH traversal function and textures passed as parameters
	traverseBVHShadowFn,
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
] ) => {

	const transmittance = float( 1.0 ).toVar();
	const rayOrigin = origin.toVar();
	const remainingDist = float( maxDist ).toVar();

	const MAX_SHADOW_TRANSMISSIONS = 8;

	Loop( { start: int( 0 ), end: int( MAX_SHADOW_TRANSMISSIONS ) }, () => {

		const shadowRay = Ray( { origin: rayOrigin, direction: dir } );

		const shadowHit = HitInfo.wrap( traverseBVHShadowFn(
			shadowRay,
			bvhBuffer,
			triangleBuffer,
			materialBuffer,
			remainingDist,
		) );

		// No hit within remaining distance to light
		If( shadowHit.didHit.not(), () => {

			Break();

		} );

		// Opaque fast-path: check the per-triangle blocker flag (NORMAL_A.w, set at
		// extraction time when alphaMode/transparent/transmission/opacity all indicate
		// a fully opaque surface). Short-circuits the 7-slot getShadowMaterial fetch
		// and the entire alpha/transmission/transparent decision tree below.
		const TRI_STRIDE_SR = int( 8 );
		const blocker = getDatafromStorageBuffer( triangleBuffer, shadowHit.triangleIndex, int( 3 ), TRI_STRIDE_SR ).w;
		If( blocker.greaterThan( 0.5 ), () => {

			transmittance.assign( 0.0 );
			Break();

		} );

		// Fetch material for the hit surface (thin reader: 7 slots instead of 27)
		const shadowMaterial = ShadowMaterial.wrap( getShadowMaterial( shadowHit.materialIndex, materialBuffer ) );

		// ---------------------------------------------------------------
		// Alpha-cutout handling (MASK / BLEND with albedo texture alpha)
		// Gated by runtime uniform + alphaMode check — zero overhead for opaque materials.
		// UV computation deferred here from BVH traversal: barycentrics stored in shadowHit.uv,
		// triangle index in shadowHit.triangleIndex. Actual UV interpolation only when needed.
		// ---------------------------------------------------------------
		const alphaCutout = tslBool( false ).toVar();

		if ( _enableAlphaShadows ) If( _enableAlphaShadows.equal( int( 1 ) ), () => {

			// Sample texture alpha once (shared by MASK and BLEND paths).
			// Deferred UV: barycentrics in shadowHit.uv, triangle index in shadowHit.triangleIndex.
			const texAlpha = float( 1.0 ).toVar();

			if ( _shadowAlbedoMaps ) {

				If( shadowMaterial.albedoMapIndex.greaterThanEqual( int( 0 ) ), () => {

					const baryU = shadowHit.uv.x;
					const baryV = shadowHit.uv.y;
					const baryW = float( 1.0 ).sub( baryU ).sub( baryV );
					const TRI_STRIDE = int( 8 );
					const uvData1 = getDatafromStorageBuffer( triangleBuffer, shadowHit.triangleIndex, int( 6 ), TRI_STRIDE );
					const uvData2 = getDatafromStorageBuffer( triangleBuffer, shadowHit.triangleIndex, int( 7 ), TRI_STRIDE );
					const hitUV = uvData1.xy.mul( baryW ).add( uvData1.zw.mul( baryU ) ).add( uvData2.xy.mul( baryV ) );
					const albedoUV = getTransformedUV( { uv: hitUV, transform: shadowMaterial.albedoTransform } );
					texAlpha.assign( texture( _shadowAlbedoMaps, albedoUV ).depth( int( shadowMaterial.albedoMapIndex ) ).a );

				} );

			}

			If( shadowMaterial.alphaMode.equal( int( 1 ) ), () => {

				// MASK mode: binary alpha cutout
				const effectiveAlpha = shadowMaterial.color.a.mul( texAlpha );
				const cutoff = select( shadowMaterial.alphaTest.greaterThan( 0.0 ), shadowMaterial.alphaTest, float( 0.5 ) );
				If( effectiveAlpha.lessThan( cutoff ), () => {

					alphaCutout.assign( true );

				} );

			} ).ElseIf( shadowMaterial.alphaMode.equal( int( 2 ) ), () => {

				// BLEND mode: modulate transmittance by alpha
				const blendAlpha = clamp( shadowMaterial.color.a.mul( shadowMaterial.opacity ).mul( texAlpha ), 0.0, 1.0 );
				transmittance.mulAssign( float( 1.0 ).sub( blendAlpha ) );

				If( transmittance.lessThan( 0.005 ), () => {

					transmittance.assign( 0.0 );
					Break();

				} );

				alphaCutout.assign( true );

			} );

		} );

		// ---------------------------------------------------------------
		// Surface interaction: alpha-skip, transmission, transparent, or opaque
		// ---------------------------------------------------------------
		If( alphaCutout, () => {

			// Alpha-transparent surface — advance ray past it
			const alphaEps = max( float( 1e-5 ), length( shadowHit.hitPoint ).mul( 1e-6 ) );
			rayOrigin.assign( shadowHit.hitPoint.add( dir.mul( alphaEps ) ) );
			remainingDist.subAssign( shadowHit.dst.add( alphaEps ) );

		} ).ElseIf( shadowMaterial.transmission.greaterThan( 0.0 ), () => {

			const entering = dot( dir, shadowHit.normal ).lessThan( 0.0 );
			const N = select( entering, shadowHit.normal, shadowHit.normal.negate() );

			// Apply absorption if exiting medium
			If( entering.not().and( shadowMaterial.attenuationDistance.greaterThan( 0.0 ) ), () => {

				const dist = length( shadowHit.hitPoint.sub( rayOrigin ) );
				const absorption = calculateBeerLawAbsorption(
					shadowMaterial.attenuationColor,
					shadowMaterial.attenuationDistance,
					dist,
				);
				transmittance.mulAssign( absorption.x.add( absorption.y ).add( absorption.z ).div( 3.0 ) );

			} );

			// Compute transmittance based on material properties
			const fresnel = fresnelSchlickFloat(
				abs( dot( dir, N ) ),
				iorToFresnel0( shadowMaterial.ior, float( 1.0 ) ),
			);

			const matTransmittance = float( 1.0 ).sub( fresnel ).mul( shadowMaterial.transmission );
			transmittance.mulAssign( matTransmittance );

			// Early exit if almost no light passes through
			If( transmittance.lessThan( 0.005 ), () => {

				transmittance.assign( 0.0 );
				Break();

			} );

			// Continue ray past transmissive surface
			rayOrigin.assign( shadowHit.hitPoint.add( dir.mul( 0.001 ) ) );
			remainingDist.subAssign( shadowHit.dst.add( 0.001 ) );

		} ).ElseIf( shadowMaterial.transparent, () => {

			// Handle transparent materials
			transmittance.mulAssign( float( 1.0 ).sub( shadowMaterial.opacity ) );

			If( transmittance.lessThan( 0.005 ), () => {

				transmittance.assign( 0.0 );
				Break();

			} );

			// Continue ray past transparent surface
			rayOrigin.assign( shadowHit.hitPoint.add( dir.mul( 0.001 ) ) );
			remainingDist.subAssign( shadowHit.dst.add( 0.001 ) );

		} ).Else( () => {

			// Fully opaque object blocks shadow ray
			transmittance.assign( 0.0 );
			Break();

		} );

	} );

	return transmittance;

} );

// ================================================================================
// RAY OFFSET CALCULATION
// ================================================================================

export const calculateRayOffset = Fn( ( [ hitPoint, normal, material ] ) => {

	// Base epsilon scaled by scene size
	const scaleEpsilon = max( float( 1e-4 ), length( hitPoint ).mul( 1e-6 ) ).toVar();

	// Adjust for material properties
	const materialEpsilon = scaleEpsilon.toVar();

	If( material.transmission.greaterThan( 0.0 ), () => {

		// Transmissive materials need larger offsets
		materialEpsilon.mulAssign( 2.0 );

	} );

	If( material.roughness.lessThan( 0.1 ), () => {

		// Smooth materials are more sensitive to precision issues
		materialEpsilon.mulAssign( 1.5 );

	} );

	return normal.mul( materialEpsilon );

} );

// ================================================================================
// LIGHT IMPORTANCE ESTIMATION
// ================================================================================

export const calculateDirectionalLightImportance = Fn( ( [ light, hitPoint, normal, material, bounceIndex ] ) => {

	const NoL = max( float( 0.0 ), dot( normal, light.direction ) );
	const result = float( 0.0 ).toVar();

	If( NoL.greaterThan( 0.0 ), () => {

		const intensity = light.intensity.mul( dot( light.color, REC709_LUMINANCE_COEFFICIENTS ) );

		// Material-specific weighting
		const materialWeight = float( 1.0 ).toVar();
		If( material.metalness.greaterThan( 0.7 ), () => {

			materialWeight.assign( 1.5 );

		} ).ElseIf( material.roughness.greaterThan( 0.8 ), () => {

			materialWeight.assign( 0.7 );

		} );

		// Reduce importance on secondary bounces
		const bounceWeight = float( 1.0 ).div( float( 1.0 ).add( float( bounceIndex ).mul( 0.5 ) ) );

		result.assign( intensity.mul( NoL ).mul( materialWeight ).mul( bounceWeight ) );

	} );

	return result;

} );

export const estimateLightImportance = Fn( ( [ light, hitPoint, normal, material ] ) => {

	const toLight = light.position.sub( hitPoint );
	const dist = length( toLight );
	const distSq = dist.mul( dist );

	const lightDir = toLight.div( dist );
	const NoL = max( dot( normal, lightDir ), 0.0 );
	const result = float( 0.0 ).toVar();

	If( NoL.greaterThan( 0.0 ), () => {

		const lightFacing = max( dot( lightDir, light.normal ).negate(), 0.0 );

		If( lightFacing.greaterThan( 0.0 ), () => {

			const solidAngle = light.area.div( max( distSq, 0.1 ) );
			const power = light.intensity.mul( dot( light.color, REC709_LUMINANCE_COEFFICIENTS ) ).mul( light.area );

			// Material-aware weighting
			const materialFactor = float( 1.0 ).toVar();

			If( material.metalness.greaterThan( 0.7 ), () => {

				materialFactor.mulAssign( 1.5 );
				If( material.roughness.lessThan( 0.3 ), () => {

					materialFactor.mulAssign( float( 1.0 ).add( float( 1.0 ).sub( material.roughness ).mul( 0.5 ) ) );

				} );

			} );

			If( material.roughness.greaterThan( 0.6 ).and( material.metalness.lessThan( 0.3 ) ), () => {

				const sizeBoost = min( light.area.mul( 2.0 ), float( 2.0 ) );
				materialFactor.mulAssign( sizeBoost );

			} );

			If( material.transmission.greaterThan( 0.5 ), () => {

				materialFactor.mulAssign( float( 1.0 ).add( material.transmission.mul( 0.3 ) ) );

			} );

			result.assign( power.mul( solidAngle ).mul( NoL ).mul( lightFacing ).mul( materialFactor ) );

		} );

	} );

	return result;

} );

export const calculatePointLightImportance = Fn( ( [ light, hitPoint, normal, material ] ) => {

	const toLight = light.position.sub( hitPoint );
	const distSq = dot( toLight, toLight );
	const result = float( 0.0 ).toVar();

	If( distSq.greaterThanEqual( 0.001 ), () => {

		const dist = sqrt( distSq );
		const lightDir = toLight.div( dist );
		const NoL = max( float( 0.0 ), dot( normal, lightDir ) );

		If( NoL.greaterThan( 0.0 ), () => {

			const distanceFactor = float( 1.0 ).div( max( distSq, 0.1 ) );
			const power = light.intensity.mul( dot( light.color, REC709_LUMINANCE_COEFFICIENTS ) );

			const materialFactor = float( 1.0 ).toVar();

			If( material.metalness.greaterThan( 0.7 ), () => {

				materialFactor.mulAssign( 1.5 );
				If( material.roughness.lessThan( 0.3 ), () => {

					materialFactor.mulAssign( float( 1.0 ).add( float( 1.0 ).sub( material.roughness ).mul( 0.4 ) ) );

				} );

			} );

			If( material.roughness.greaterThan( 0.6 ), () => {

				materialFactor.mulAssign( 0.9 );

			} );

			If( material.transmission.greaterThan( 0.5 ), () => {

				materialFactor.mulAssign( float( 1.0 ).add( material.transmission.mul( 0.2 ) ) );

			} );

			result.assign( power.mul( distanceFactor ).mul( NoL ).mul( materialFactor ) );

		} );

	} );

	return result;

} );

export const calculateSpotLightImportance = Fn( ( [ light, hitPoint, normal, material ] ) => {

	const toLight = light.position.sub( hitPoint );
	const distSq = dot( toLight, toLight );
	const result = float( 0.0 ).toVar();

	If( distSq.greaterThanEqual( 0.001 ), () => {

		const lightDir = toLight.div( sqrt( distSq ) );
		const NoL = max( float( 0.0 ), dot( normal, lightDir ) );

		If( NoL.greaterThan( 0.0 ), () => {

			const spotCosAngle = dot( lightDir.negate(), light.direction );
			const coneCosAngle = cos( light.angle );

			If( spotCosAngle.greaterThanEqual( coneCosAngle ), () => {

				const distanceFactor = float( 1.0 ).div( max( distSq, 0.01 ) );
				const coneAttenuation = smoothstep( coneCosAngle, coneCosAngle.add( 0.1 ), spotCosAngle );
				const intensity = light.intensity.mul( dot( light.color, REC709_LUMINANCE_COEFFICIENTS ) );

				const materialWeight = select(
					material.metalness.greaterThan( 0.7 ), float( 1.5 ),
					select( material.roughness.greaterThan( 0.8 ), float( 0.8 ), float( 1.0 ) )
				);

				result.assign( intensity.mul( distanceFactor ).mul( coneAttenuation ).mul( NoL ).mul( materialWeight ) );

			} );

		} );

	} );

	return result;

} );

// ================================================================================
// DIRECTIONAL LIGHT CONTRIBUTION
// ================================================================================

export const shouldSkipDirectionalLight = Fn( ( [ light, normal, material, bounceIndex ] ) => {

	const NoL = max( float( 0.0 ), dot( normal, light.direction ) );
	const shouldSkip = tslBool( false ).toVar();

	If( light.intensity.lessThanEqual( 0.001 ).or( NoL.lessThanEqual( 0.001 ) ), () => {

		shouldSkip.assign( true );

	} );

	If( shouldSkip.not().and( bounceIndex.greaterThan( int( 0 ) ) ), () => {

		If( light.intensity.lessThan( 0.01 ), () => {

			shouldSkip.assign( true );

		} );

		If( shouldSkip.not().and( material.metalness.greaterThan( 0.9 ) ).and( NoL.lessThan( 0.1 ) ), () => {

			shouldSkip.assign( true );

		} );

		If( shouldSkip.not().and( material.metalness.lessThan( 0.1 ) ).and( material.roughness.greaterThan( 0.9 ) ).and( light.intensity.lessThan( 0.1 ) ), () => {

			shouldSkip.assign( true );

		} );

	} );

	return shouldSkip;

} );

export const calculateDirectionalLightContribution = Fn( ( [
	light, hitPoint, normal, viewDir, material, matCache, brdfSample, bounceIndex,
	rngState,
	// Shadow tracing callback + textures
	traceShadowRayFn,
	evaluateMaterialResponseCachedFn,
] ) => {

	const result = vec3( 0.0 ).toVar();

	If( shouldSkipDirectionalLight( light, normal, material, bounceIndex ).not(), () => {

		const rayOffset = calculateRayOffset( hitPoint, normal, material );
		const rayOrigin = hitPoint.add( rayOffset );

		// Determine shadow sampling strategy based on light angle
		const shadowDirection = vec3( 0.0 ).toVar();
		const lightPdf = float( 1e6 ).toVar();

		If( light.angle.greaterThan( 0.001 ), () => {

			// Soft shadows: sample direction within cone
			const xi_r1 = RandomValue( rngState ).toVar();
			const xi_r2 = RandomValue( rngState ).toVar();
			const xi = vec2( xi_r1, xi_r2 );
			const halfAngle = light.angle.mul( 0.5 );
			shadowDirection.assign( sampleCone( { direction: light.direction, halfAngle, xi } ) );

			// Calculate PDF for cone sampling
			const cosHalfAngle = cos( halfAngle );
			lightPdf.assign( float( 1.0 ).div( TWO_PI.mul( float( 1.0 ).sub( cosHalfAngle ) ) ) );

		} ).Else( () => {

			shadowDirection.assign( light.direction );

		} );

		const NoL = max( float( 0.0 ), dot( normal, shadowDirection ) );

		If( NoL.greaterThan( 0.0 ), () => {

			const maxShadowDistance = float( 1e6 );
			const visibility = traceShadowRayFn( rayOrigin, shadowDirection, maxShadowDistance, rngState );

			If( visibility.greaterThan( 0.0 ), () => {

				const brdfValue = evaluateMaterialResponseCachedFn( viewDir, shadowDirection, normal, material, matCache );
				const lightRadiance = light.color.mul( light.intensity );
				const contribution = lightRadiance.mul( brdfValue ).mul( NoL ).mul( visibility );

				// MIS for directional lights (only on primary rays)
				If( bounceIndex.equal( int( 0 ) ).and( brdfSample.pdf.greaterThan( 0.0 ) ), () => {

					const alignment = max( float( 0.0 ), dot( normalize( brdfSample.direction ), shadowDirection ) );

					If( alignment.greaterThan( 0.996 ), () => {

						const misWeight = powerHeuristic( { pdf1: lightPdf, pdf2: brdfSample.pdf } );
						result.assign( contribution.mul( misWeight ) );

					} ).Else( () => {

						result.assign( contribution );

					} );

				} ).Else( () => {

					result.assign( contribution );

				} );

			} );

		} );

	} );

	return result;

} );

// ================================================================================
// AREA LIGHT CONTRIBUTION
// ================================================================================

export const calculateAreaLightContribution = Fn( ( [
	light, hitPoint, normal, viewDir, material, matCache, brdfSample,
	sampleIndex, bounceIndex, rngState,
	traceShadowRayFn,
	evaluateMaterialResponseCachedFn,
	getRandomSampleFn,
] ) => {

	const contribution = vec3( 0.0 ).toVar();

	const lightImportance = estimateLightImportance( light, hitPoint, normal, material );

	If( lightImportance.greaterThanEqual( 0.001 ), () => {

		const rayOffset = calculateRayOffset( hitPoint, normal, material );
		const rayOrigin = hitPoint.add( rayOffset );

		const isDiffuse = material.roughness.greaterThan( 0.7 ).and( material.metalness.lessThan( 0.3 ) );
		const isSpecular = material.roughness.lessThan( 0.3 ).or( material.metalness.greaterThan( 0.7 ) );
		const isFirstBounce = bounceIndex.equal( int( 0 ) );

		// LIGHT SAMPLING STRATEGY
		If( isFirstBounce.or( isDiffuse ).or( lightImportance.greaterThan( 0.1 ).and( isSpecular.not() ) ), () => {

			const ruv = getRandomSampleFn( sampleIndex, bounceIndex, rngState );

			// Generate position on light surface
			const lightPos = light.position
				.add( light.u.mul( ruv.x.sub( 0.5 ) ) )
				.add( light.v.mul( ruv.y.sub( 0.5 ) ) );

			const toLight = lightPos.sub( hitPoint );
			const lightDistSq = dot( toLight, toLight );
			const lightDist = sqrt( lightDistSq );
			const lightDir = toLight.div( lightDist );

			const NoL = max( float( 0.0 ), dot( normal, lightDir ) );
			const lightFacing = max( float( 0.0 ), dot( lightDir, light.normal ).negate() );

			If( NoL.greaterThan( 0.0 ).and( lightFacing.greaterThan( 0.0 ) ), () => {

				const visibility = traceShadowRayFn( rayOrigin, lightDir, lightDist, rngState );

				If( visibility.greaterThan( 0.0 ), () => {

					const brdfValue = evaluateMaterialResponseCachedFn( viewDir, lightDir, normal, material, matCache );

					// Calculate PDFs for MIS
					const lightPdf = lightDistSq.div( max( light.area.mul( lightFacing ), EPSILON ) );
					const brdfPdf = brdfSample.pdf;

					// Light contribution with inverse-square falloff
					const falloff = light.area.div( float( 4.0 ).mul( PI ).mul( lightDistSq ) );
					const lightContribution = light.color.mul( light.intensity ).mul( falloff ).mul( lightFacing );

					// MIS weight
					const misWeight = select(
						brdfPdf.greaterThan( 0.0 ).and( isFirstBounce ),
						powerHeuristic( { pdf1: lightPdf, pdf2: brdfPdf } ),
						float( 1.0 ),
					);

					contribution.addAssign( lightContribution.mul( brdfValue ).mul( NoL ).mul( visibility ).mul( misWeight ) );

				} );

			} );

		} );

		// BRDF SAMPLING STRATEGY
		If( isFirstBounce.or( isSpecular ).and( brdfSample.pdf.greaterThan( 0.0 ) ), () => {

			const toLight = light.position.sub( rayOrigin );
			const rayToLightDot = dot( toLight, brdfSample.direction );

			If( rayToLightDot.greaterThan( 0.0 ), () => {

				const hitDistance = intersectAreaLight( light, rayOrigin, brdfSample.direction );

				If( hitDistance.greaterThan( 0.0 ), () => {

					const visibility = traceShadowRayFn( rayOrigin, brdfSample.direction, hitDistance, rngState );

					If( visibility.greaterThan( 0.0 ), () => {

						const lightFacing = max( float( 0.0 ), dot( brdfSample.direction, light.normal ).negate() );

						If( lightFacing.greaterThan( 0.0 ), () => {

							const lightPdf = hitDistance.mul( hitDistance ).div( max( light.area.mul( lightFacing ), EPSILON ) );
							const misWeight = powerHeuristic( { pdf1: brdfSample.pdf, pdf2: lightPdf } );

							const lightEmission = light.color.mul( light.intensity );
							const NoL = max( float( 0.0 ), dot( normal, brdfSample.direction ) );

							contribution.addAssign( lightEmission.mul( brdfSample.value ).mul( NoL ).mul( visibility ).mul( misWeight ) );

						} );

					} );

				} );

			} );

		} );

	} );

	return contribution;

} );

// ================================================================================
// POINT LIGHT CONTRIBUTION
// ================================================================================

export const calculatePointLightContribution = Fn( ( [
	light, hitPoint, normal, viewDir, material, matCache, brdfSample, bounceIndex,
	rngState,
	traceShadowRayFn,
	evaluateMaterialResponseFn,
] ) => {

	const result = vec3( 0.0 ).toVar();

	const toLight = light.position.sub( hitPoint );
	const distance = length( toLight );

	If( distance.lessThanEqual( 1000.0 ), () => {

		const lightDir = toLight.div( distance );
		const NdotL = dot( normal, lightDir );

		If( NdotL.greaterThan( 0.0 ), () => {

			const attenuation = float( 1.0 ).div( distance.mul( distance ) );
			const lightRadiance = light.color.mul( light.intensity ).mul( attenuation );

			const rayOffset = calculateRayOffset( hitPoint, normal, material );
			const rayOrigin = hitPoint.add( rayOffset );

			const visibility = traceShadowRayFn( rayOrigin, lightDir, distance.sub( 0.001 ), rngState );

			If( visibility.greaterThan( 0.0 ), () => {

				const brdfValue = evaluateMaterialResponseFn( viewDir, lightDir, normal, material );
				result.assign( brdfValue.mul( lightRadiance ).mul( NdotL ).mul( visibility ) );

			} );

		} );

	} );

	return result;

} );

// ================================================================================
// SPOT LIGHT CONTRIBUTION
// ================================================================================

export const calculateSpotLightContribution = Fn( ( [
	light, hitPoint, normal, viewDir, material, matCache, brdfSample, bounceIndex,
	rngState,
	traceShadowRayFn,
	evaluateMaterialResponseFn,
] ) => {

	const result = vec3( 0.0 ).toVar();

	const toLight = light.position.sub( hitPoint );
	const distance = length( toLight );

	If( distance.lessThanEqual( 1000.0 ), () => {

		const lightDir = toLight.div( distance );
		const NdotL = dot( normal, lightDir );

		If( NdotL.greaterThan( 0.0 ), () => {

			const spotCosAngle = dot( lightDir.negate(), light.direction );
			const coneCosAngle = cos( light.angle );

			If( spotCosAngle.greaterThanEqual( coneCosAngle ), () => {

				const coneAttenuation = smoothstep( coneCosAngle, coneCosAngle.add( 0.1 ), spotCosAngle );
				const distanceAttenuation = float( 1.0 ).div( distance.mul( distance ) );
				const lightRadiance = light.color.mul( light.intensity ).mul( distanceAttenuation ).mul( coneAttenuation );

				const rayOffset = calculateRayOffset( hitPoint, normal, material );
				const rayOrigin = hitPoint.add( rayOffset );

				const visibility = traceShadowRayFn( rayOrigin, lightDir, distance.sub( 0.001 ), rngState );

				If( visibility.greaterThan( 0.0 ), () => {

					const brdfValue = evaluateMaterialResponseFn( viewDir, lightDir, normal, material );
					result.assign( brdfValue.mul( lightRadiance ).mul( NdotL ).mul( visibility ) );

				} );

			} );

		} );

	} );

	return result;

} );
