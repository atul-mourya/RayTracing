/**
 * ReSTIRLighting.js — analytic Le re-derivation for ReSTIR DI reuse passes.
 *
 * Given a reservoir's encoded lightSampleId (lightType·100 + index) and the stored world light POINT,
 * re-derive the light's emission Le at a shading point P WITHOUT re-running the WRS selector. Used by
 * restirTemporal (p̂ re-eval, Eq. 5) and restirResolve (final contribution, Eq. 18). The four light
 * buffers are UNIFORM buffers (uniformArray) → 0 storage-buffer cost, so binding them in the reuse
 * passes does not threaten the 10-SB cap (§1.3).
 *
 * Mirrors the per-type emission of LightsCore.js / LightsSampling.js exactly:
 *   directional : color·intensity·gobo
 *   area        : color·intensity, gated by cosAngle = dot(−ωᵢ, lightNormal) > 0
 *   point       : color·intensity·distanceAttenuation(d, cutoff, decay)
 *   spot        : color·intensity·distAtten·coneAtten·gobo·IES, gated by spotCosAngle ≥ coneCosAngle
 */

import {
	Fn, float, vec3, vec4, int, mat3,
	If, dot, normalize, length, cross, cos, select, texture,
} from 'three/tsl';

import { struct } from './patches.js';
import {
	DirectionalLight, AreaLight, PointLight, SpotLight,
	LIGHT_TYPE_DIRECTIONAL, LIGHT_TYPE_AREA, LIGHT_TYPE_POINT, LIGHT_TYPE_SPOT,
	getDirectionalLight, getAreaLight, getPointLight, getSpotLight,
	getDistanceAttenuation, getSpotAttenuation,
	sampleSpotGoboMask, sampleDirectionalGoboMask, sampleIESProfile,
} from './LightsCore.js';
import { decodeLightSampleId, RESTIR_LIGHT_TYPE_ENV, RESTIR_LIGHT_TYPE_EMISSIVE_TRI } from './ReSTIRCore.js';
import { equirectDirectionToUv, sampleEquirect } from './Environment.js';
import { calculateMaterialPDFFromDots } from './LightsSampling.js';
import { balanceHeuristic, powerHeuristic } from './Common.js';
import { fetchTriangleData, TriangleData, calculateEmissiveLightPdf } from './EmissiveSampling.js';

// Emissive packed-entry stride (2 vec4/entry): vec4[0]=(triIdx,power,cdf,selPdf), vec4[1]=(emission.rgb,area).
const EMISSIVE_VEC4_STRIDE = 2;

// ── Primary-hit reconstruction (camera + pixel + hitDist) ──────────────────────────────────
// ShadeKernel OVERWRITES rayBuffer origin/dir with the bounce-1 continuation ray before the ReSTIR
// passes run, so the primary ray is gone. Reconstruct P + view dir from the camera the same way
// MotionVector does (MotionVector.js:178-200): pinhole ray through the pixel centre, advanced by the
// HIT buffer's linear ray distance. Matrices MUST be Fn params for mat4 bracket-indexing (project
// TSL pitfall). DOF-jittered origins are approximated by the pinhole ray (same as MotionVector — OK
// for the unshadowed target + final shadow ray).

export const PrimaryHit = struct( {
	P: 'vec3', // world shading point
	rayDir: 'vec3', // primary ray direction (V = rayDir.negate())
} );

export const reconstructPrimaryHit = Fn( ( [ camWorldMat, camProjInv, gx, gy, resW, resH, hitDist ] ) => {

	const ndcX = float( gx ).add( 0.5 ).div( resW ).mul( 2.0 ).sub( 1.0 );
	const ndcY = float( gy ).add( 0.5 ).div( resH ).mul( 2.0 ).sub( 1.0 ).negate(); // WebGPU Y-flip
	const rayDirCS = camProjInv.mul( vec4( ndcX, ndcY, 1.0, 1.0 ) ).toVar();
	const rayDir = normalize(
		mat3( camWorldMat[ 0 ].xyz, camWorldMat[ 1 ].xyz, camWorldMat[ 2 ].xyz )
			.mul( rayDirCS.xyz.div( rayDirCS.w ) )
	).toVar();
	const camPos = vec3( camWorldMat[ 3 ] ).toVar();
	return PrimaryHit( { P: camPos.add( rayDir.mul( hitDist ) ), rayDir } );

} );

/**
 * Analytic Le for a stored ReSTIR light sample.
 * @param lightSampleId  float — encoded lightType·100 + index
 * @param samplePos      vec3  — stored world light point (ENV: a unit DIRECTION wi, not a point)
 * @param P              vec3  — current shading point
 * Returns vec3 Le (0 when the light is back-facing / outside cone / unknown).
 *
 * ENV (type 4): Le is the env-map radiance along the stored direction — shading-point-independent,
 * no distance attenuation. Matches the candidate's color in ReSTIRInitialKernel exactly
 * (texture(env, equirectDirectionToUv(dir,M), 0).rgb · intensity).
 */
export const deriveAnalyticLe = Fn( ( [
	lightSampleId, samplePos, P,
	directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
	environmentTex, envMatrix, environmentIntensity, enableEnvironmentLight,
	lightBuffer, emissiveVec4Offset, triangleBuffer, emissiveBoost,
] ) => {

	const decoded = decodeLightSampleId( lightSampleId ).toVar();
	const lightType = int( decoded.x ).toVar();
	const lightIndex = int( decoded.y ).toVar();

	const toLight = samplePos.sub( P ).toVar();
	const dist = length( toLight ).toVar();
	const wi = normalize( toLight ).toVar();

	const Le = vec3( 0.0 ).toVar();

	If( lightType.equal( int( LIGHT_TYPE_DIRECTIONAL ) ), () => {

		const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, lightIndex ) );
		const goboMask = sampleDirectionalGoboMask( light, P );
		Le.assign( light.color.mul( light.intensity ).mul( goboMask ) );

	} ).ElseIf( lightType.equal( int( LIGHT_TYPE_AREA ) ), () => {

		const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, lightIndex ) );
		const lightNormal = normalize( cross( light.u, light.v ) ).toVar();
		const cosAngle = dot( wi.negate(), lightNormal ).toVar();
		Le.assign( select( cosAngle.greaterThan( 0.0 ), light.color.mul( light.intensity ), vec3( 0.0 ) ) );

	} ).ElseIf( lightType.equal( int( LIGHT_TYPE_POINT ) ), () => {

		const light = PointLight.wrap( getPointLight( pointLightsBuffer, lightIndex ) );
		const distanceAttenuation = getDistanceAttenuation( { lightDistance: dist, cutoffDistance: light.distance, decayExponent: light.decay } );
		Le.assign( light.color.mul( light.intensity ).mul( distanceAttenuation ) );

	} ).ElseIf( lightType.equal( int( LIGHT_TYPE_SPOT ) ), () => {

		const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, lightIndex ) );
		const spotCosAngle = dot( wi.negate(), light.direction ).toVar();
		const coneCosAngle = cos( light.angle ).toVar();
		const penumbraCosAngle = cos( light.angle.mul( float( 1.0 ).sub( light.penumbra ) ) ).max( coneCosAngle.add( 1e-5 ) ).toVar();
		const coneAttenuation = getSpotAttenuation( { coneCosine: coneCosAngle, penumbraCosine: penumbraCosAngle, angleCosine: spotCosAngle } );
		const distanceAttenuation = getDistanceAttenuation( { lightDistance: dist, cutoffDistance: light.distance, decayExponent: light.decay } );
		const goboMask = sampleSpotGoboMask( light, wi );
		const iesProfile = sampleIESProfile( light, wi );
		Le.assign( select(
			spotCosAngle.greaterThanEqual( coneCosAngle ),
			light.color.mul( light.intensity ).mul( distanceAttenuation ).mul( coneAttenuation ).mul( goboMask ).mul( iesProfile ),
			vec3( 0.0 ),
		) );

	} ).ElseIf( lightType.equal( int( RESTIR_LIGHT_TYPE_ENV ) ), () => {

		// samplePos IS the stored unit direction (rotation already baked in at sample time). Env Le is
		// P-independent: direct equirect lookup × intensity, no distance/cone/normal gating. The toLight/
		// dist/wi computed above are unused here (they're only consumed by the analytic branches).
		const uv = equirectDirectionToUv( { direction: samplePos, environmentMatrix: envMatrix } ).toVar();
		const envColor = texture( environmentTex, uv, 0 ).rgb.mul( environmentIntensity ).toVar();
		Le.assign( select( enableEnvironmentLight.greaterThan( 0.5 ), envColor, vec3( 0.0 ) ) );

	} ).ElseIf( lightType.equal( int( RESTIR_LIGHT_TYPE_EMISSIVE_TRI ) ), () => {

		// lightIndex = emissive-LIST index. Read the CACHED emission (·intensity, baked at scene build) from
		// the packed light buffer — IDENTICAL to what the BF emissive NEE uses (cardinal rule). Front-face
		// gate via the triangle's geometric normal (like area lights). ·emissiveBoost (BF applies it at NEE).
		const baseIdx = emissiveVec4Offset.add( lightIndex.mul( int( EMISSIVE_VEC4_STRIDE ) ) ).toVar();
		const emission = lightBuffer.element( baseIdx.add( int( 1 ) ) ).xyz.toVar();
		const triIdx = int( lightBuffer.element( baseIdx ).x ).toVar();
		const tri = TriangleData.wrap( fetchTriangleData( triIdx, triangleBuffer ) );
		const geoNormal = normalize( cross( tri.v1.sub( tri.v0 ), tri.v2.sub( tri.v0 ) ) ).toVar();
		// wi here = normalize(samplePos − P) (computed above); emitter front-faces the shading point when
		// dot(−wi, geoNormal) > 0 (same test as the AREA branch).
		const cosAngle = dot( wi.negate(), geoNormal ).toVar();
		Le.assign( select( cosAngle.greaterThan( 0.0 ), emission.mul( emissiveBoost ), vec3( 0.0 ) ) );

	} );

	return Le;

} );

/**
 * Strategy-A MIS weight for a stored ReSTIR light sample. Analytic lights → 1 (delta lights have no
 * BSDF-sampling partner; area lights' BSDF-hit term is gated in Shade). ENV and EMISSIVE_TRI → the SAME
 * weight BF's NEE applies (env: balanceHeuristic; emissive: powerHeuristic — matching ShadeKernel) — folded
 * into the resampling TARGET pHat (Initial/Temporal/Spatial) AND the resolve, so the reservoir composes
 * UNBIASED with the surviving strategy-B (next-bounce miss/hit) term that cannot be gated at bounce-0.
 * @param wi        vec3 — connecting direction (env: the stored unit direction; emissive: normalize(samplePos−P))
 * @param dots      DotProducts at the current pixel (for the BSDF pdf)
 * @param samplePos vec3 — stored sample (emissive: world point on the triangle; unused by env)
 * @param P         vec3 — current shading point (emissive distance; unused by env)
 */
export const restirMISWeight = Fn( ( [
	lightSampleId, wi, dots, material,
	environmentTex, envMatrix, envTotalSum, envCompensationDelta, envResolution,
	samplePos, P, lightBuffer, emissiveVec4Offset, triangleBuffer, materialBuffer, emissiveTotalPower,
] ) => {

	const w = float( 1.0 ).toVar();
	const lightType = int( decodeLightSampleId( lightSampleId ).x ).toVar();

	If( lightType.equal( int( RESTIR_LIGHT_TYPE_ENV ) ), () => {

		const envPdf = sampleEquirect( environmentTex, wi, envMatrix, envTotalSum, envCompensationDelta, envResolution ).w.toVar();
		const bsdfPdf = calculateMaterialPDFFromDots( material, dots ).toVar();
		w.assign( select( bsdfPdf.greaterThan( 0.0 ), balanceHeuristic( { pdf1: envPdf, pdf2: bsdfPdf } ), float( 1.0 ) ) );

	} ).ElseIf( lightType.equal( int( RESTIR_LIGHT_TYPE_EMISSIVE_TRI ) ), () => {

		// powerHeuristic(emissivePdf, bsdfPdf) — re-derive the emissive solid-angle pdf at THIS pixel from
		// the stored point (cardinal rule: identical to BF's emissive NEE, ShadeKernel.js:771-773).
		const lightIndex = int( decodeLightSampleId( lightSampleId ).y ).toVar();
		const triIdx = int( lightBuffer.element( emissiveVec4Offset.add( lightIndex.mul( int( EMISSIVE_VEC4_STRIDE ) ) ) ).x ).toVar();
		const dist = length( samplePos.sub( P ) ).toVar();
		const emissivePdf = calculateEmissiveLightPdf( triIdx, dist, wi, P, triangleBuffer, materialBuffer, emissiveTotalPower ).toVar();
		const bsdfPdf = calculateMaterialPDFFromDots( material, dots ).toVar();
		w.assign( select( bsdfPdf.greaterThan( 0.0 ), powerHeuristic( { pdf1: emissivePdf, pdf2: bsdfPdf } ), float( 1.0 ) ) );

	} );

	return w;

} );
