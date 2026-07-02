/**
 * ReSTIRTemporalKernel.js — Phase-1 ReSTIR DI temporal reuse (per-pixel 16×16, 2D screen dispatch).
 *
 * After the canonical reservoir is built (restirInitial), reproject the prev-frame reservoir via the
 * motion vector, run an EXPLICIT disocclusion gate (depth+normal compare against prev-frame normalDepth
 * history — §3.3 step 2 / §7-R6; MotionVector's own validity flag is bounds-only), M-cap the history
 * (§3.3 step 4), RE-EVALUATE the temporal sample's target at the CURRENT pixel (Eq. 5, true clamped
 * cosine), and merge via the verified UNBIASED GRIS combine (ReSTIRCore.reservoirCombineUnbiased, §3.4).
 * On disocclusion the temporal reservoir does not participate (canonical written unchanged).
 *
 * Storage buffers (≤10): hitBufferRO, rngBufferRW, materialBuffer, reservoirPoolRW = 4 SB. ONE read-write
 * reservoir node reads the prev slot AND reads/writes the cur slot (disjoint elements) — do NOT also bind
 * the .ro view here: WebGPU forbids rw+ro aliasing of one buffer in a single compute pass. (Primary ray
 * reconstructed from the camera — ShadeKernel overwrote the ray buffer.) The 4 light buffers are UNIFORM
 * buffers (uniformArray) → 0 SB; the motion vector + prev normalDepth are sampled RenderTarget textures → 0 SB.
 *
 * TSL: reservoirs carried as scalar .toVar()s; transient Reservoir({…}) built only to call ReSTIRCore Fns
 * (no whole-struct .assign — StructNode.js:20).
 */

import {
	Fn, float, vec3, vec4, int, uint, ivec2,
	If, normalize, max, dot, abs, select, Return,
	textureLoad,
	localId, workgroupId,
} from 'three/tsl';

import {
	readHitDistance, readHitNormal, readHitMaterialIndex,
	readHitBarycentrics,
} from '../Processor/PackedRayBuffer.js';
import { getMaterial, luminance, computeDotProducts } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { deriveAnalyticLe, restirMISWeight } from './ReSTIRLighting.js';
import { RayTracingMaterial, MaterialSamples, DotProducts } from './Struct.js';
import {
	Reservoir, unpackReservoir, reservoirCapM, reservoirCombineUnbiased,
	reservoirSlotIndex, packReservoirCore, packReservoirAux,
	decodeLightSampleId, RESTIR_LIGHT_TYPE_AREA, RESTIR_LIGHT_TYPE_ENV, RESTIR_TEMPORAL_M_CAP_MULTIPLIER, RESTIR_SNAPSHOT_SLOT,
} from './ReSTIRCore.js';

const WG_SIZE = 16;
const MISS_DIST = 1e19;
// Disocclusion thresholds (tunable). Normal: dot ≥ 0.9 (~25°). Depth: relative |Δ| ≤ 0.1.
const NORMAL_THRESHOLD = 0.9;
const DEPTH_REL_THRESHOLD = 0.1;

export function buildRestirTemporalKernel( params ) {

	const {
		// Storage buffers
		hitBufferRO, rngBufferRW, materialBuffer,
		reservoirPoolRW, primaryHitBuffer,
		// Textures (0 SB) — bare TextureNodes, .value repointed each frame (ASVGF pattern)
		motionVectorTex, prevNormalDepthTex,
		// Light buffers (uniform buffers — 0 SB) for Le re-eval
		directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
		// Camera (primary-ray reconstruction + view-Z linearization for the depth gate)
		cameraWorldMatrix, cameraProjectionMatrixInverse, cameraViewMatrix,
		// Environment (textures/uniforms — 0 SB): Le re-derivation + strategy-A MIS weight in the pHat re-eval
		environmentTex, envMatrix, environmentIntensity, enableEnvironmentLight,
		envTotalSum, envCompensationDelta, envResolution,
		// Emissive triangles (type 5): packed light buffer + geometry tri buffer (+2 SB) for Le re-derivation.
		lightBuffer, emissiveVec4Offset, triangleBuffer, emissiveBoost, emissiveTotalPower,
		// Uniforms
		frameParityUniform, resolutionUniform,
	} = params;

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resolutionUniform.x ) ).and( gy.lessThan( int( resolutionUniform.y ) ) ), () => {

			const resW = int( resolutionUniform.x ).toVar();
			const resH = int( resolutionUniform.y ).toVar();
			const pixelIndex = gy.mul( resW ).add( gx );
			const rayID = uint( pixelIndex );

			// Current bounce-0 hit — misses carry no reservoir; leave the (empty) canonical as-is.
			const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
			If( hitDist.greaterThan( MISS_DIST ), () => {

				Return();

			} );

			const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
			const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
			const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();

			// EXACT bounce-0 hit point from the actual jittered ray (restirCapture), NOT the pixel-centre
			// reconstruction. V points to the camera: camPos = M·(0,0,0,1) (mat·vec avoids mat4 indexing).
			const P = primaryHitBuffer.element( pixelIndex ).xyz.toVar();
			const camPos = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz.toVar();
			const V = normalize( camPos.sub( P ) ).toVar();

			// Rebuild material at the CURRENT pixel (matIdx → materialBuffer → textures) for p̂ re-eval.
			const material = RayTracingMaterial.wrap( getMaterial( int( hitMatIdx ), materialBuffer ) ).toVar();
			const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
				material, hitUV, normalize( hitNormal ),
			) ).toVar();
			material.color.assign( matSamples.albedo );
			material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
			material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );
			material.sheenRoughness.assign( material.sheenRoughness.clamp( 0.05, 1.0 ) );

			const N = matSamples.normal.toVar();
			If( dot( N, V ).lessThan( 0.0 ), () => {

				N.assign( N.negate() );

			} );

			// ── Read canonical reservoir from the cur slot (rw view). ──
			const curParity = frameParityUniform;
			const baseIdxCur = reservoirSlotIndex( gx, gy, resW, curParity ).toVar();
			const canonical = Reservoir.wrap( unpackReservoir(
				reservoirPoolRW.element( baseIdxCur ),
				reservoirPoolRW.element( baseIdxCur.add( int( 1 ) ) ),
			) ).toVar();

			// ── Reproject to the prev frame via the (1-frame-stale) motion vector. ──
			// motion = currentUV − prevUV ⇒ prevPixel = currentPixel − motion·resolution (ASVGF parity).
			const motion = textureLoad( motionVectorTex, ivec2( gx, gy ) ).toVar();
			const prevXf = float( gx ).add( 0.5 ).sub( motion.x.mul( float( resW ) ) ).toVar();
			const prevYf = float( gy ).add( 0.5 ).sub( motion.y.mul( float( resH ) ) ).toVar();

			// ── Disocclusion gate (explicit; MotionVector validity is bounds-only). ──
			const inBounds = motion.w.greaterThan( 0.5 )
				.and( prevXf.greaterThanEqual( 0.0 ) ).and( prevXf.lessThan( float( resW ) ) )
				.and( prevYf.greaterThanEqual( 0.0 ) ).and( prevYf.lessThan( float( resH ) ) );

			const gxPrev = int( prevXf ).clamp( int( 0 ), resW.sub( int( 1 ) ) ).toVar();
			const gyPrev = int( prevYf ).clamp( int( 0 ), resH.sub( int( 1 ) ) ).toVar();

			const prevND = textureLoad( prevNormalDepthTex, ivec2( gxPrev, gyPrev ) ).toVar();
			const prevN = prevND.xyz.mul( 2.0 ).sub( 1.0 ).toVar();
			const prevDepth = prevND.w.toVar();

			// Depth consistency in LINEAR view-Z. prevNormalDepthTex.w is NDC depth ∈ [0,1] (ShadeKernel
			// writes computeNDCDepth), NOT raw ray-t — comparing it to hitDist mixes units and rejected ALL
			// reuse (M never grew past the per-frame candidate count). Linearize both sides: current from the
			// reconstructed world P via the view matrix; prev by inverse-projecting its NDC z (x/y irrelevant
			// to view-Z for a standard perspective proj). normalOk is unaffected (xyz = normal*0.5+0.5 → *2−1).
			const curViewZ = abs( cameraViewMatrix.mul( vec4( P, 1.0 ) ).z ).toVar();
			const prevView = cameraProjectionMatrixInverse.mul(
				vec4( 0.0, 0.0, prevDepth.mul( 2.0 ).sub( 1.0 ), 1.0 ) ).toVar();
			const prevViewZ = abs( prevView.z.div( prevView.w ) ).toVar();
			const normalOk = dot( N, prevN ).greaterThanEqual( float( NORMAL_THRESHOLD ) );
			const depthDelta = abs( curViewZ.sub( prevViewZ ) ).div( max( curViewZ, float( 0.001 ) ) );
			const depthOk = depthDelta.lessThanEqual( float( DEPTH_REL_THRESHOLD ) );
			// Exclude AREA-light samples from reuse → they stay canonical-only (unbiased). The stored sample is
			// a POINT on a finite area in SOLID-ANGLE measure, so reusing it across frames needs the area-light
			// shift Jacobian (delta point/spot/directional lights have J=1, so they reuse correctly). Until that
			// proper measure handling lands (GRIS path-reuse work), area reuse leaves a small temporal residual
			// (~+3% over-bright on Sponza); gating it keeps area unbiased. Delta lights keep full reuse.
			const notArea = decodeLightSampleId( canonical.lightSampleId ).x.notEqual( float( RESTIR_LIGHT_TYPE_AREA ) );
			const reuse = inBounds.and( normalOk ).and( depthOk ).and( notArea );

			// Default output = canonical unchanged (the disoccluded path).
			const outId = canonical.lightSampleId.toVar();
			const outWSum = canonical.wSum.toVar();
			const outW = canonical.W.toVar();
			const outM = canonical.M.toVar();
			const outPosX = canonical.samplePosX.toVar();
			const outPosY = canonical.samplePosY.toVar();
			const outPosZ = canonical.samplePosZ.toVar();
			const outPHatOwn = canonical.pHatOwn.toVar();

			const rngState = rngBufferRW.element( rayID ).toVar();

			If( reuse, () => {

				// ── Read the prev-parity (temporal) reservoir at the reprojected pixel via the RW node ──
				// (disjoint slot; binding the .ro view too would alias rw+ro in one pass — a WebGPU error).
				const prevParity = curParity.bitXor( int( 1 ) ).toVar();
				const baseIdxPrev = reservoirSlotIndex( gxPrev, gyPrev, resW, prevParity ).toVar();
				const temporal = Reservoir.wrap( unpackReservoir(
					reservoirPoolRW.element( baseIdxPrev ),
					reservoirPoolRW.element( baseIdxPrev.add( int( 1 ) ) ),
				) ).toVar();

				// M-cap the history (bounds correlation; legal in GRIS — any positive c_i is fine).
				const maxM = canonical.M.mul( float( RESTIR_TEMPORAL_M_CAP_MULTIPLIER ) ).toVar();
				const temporalCapped = Reservoir.wrap( reservoirCapM( temporal, maxM ) ).toVar();

				// RE-EVALUATE the temporal sample's p̂ at the CURRENT pixel (Eq. 5, TRUE clamped cosine, §3.1).
				// y is the stored world light POINT; ωᵢ = normalize(samplePos − P), so the DI Jacobian is 1 (§3.6).
				// Le is re-derived analytically from the carried lightSampleId at the current connecting direction.
				const yPos = vec3( temporalCapped.samplePosX, temporalCapped.samplePosY, temporalCapped.samplePosZ ).toVar();
				// ENV: yPos is a unit direction (wi = yPos); analytic: wi = normalize(samplePos − P).
				const tIsEnv = int( decodeLightSampleId( temporalCapped.lightSampleId ).x ).equal( int( RESTIR_LIGHT_TYPE_ENV ) ).toVar();
				const wi = select( tIsEnv, normalize( yPos ), normalize( yPos.sub( P ) ) ).toVar();
				const pHatCosine = max( dot( N, wi ), float( 0.0 ) ).toVar();
				const tDots = DotProducts.wrap( computeDotProducts( N, V, wi ) );
				const tF = evaluateMaterialResponseFromDots( material, tDots ).toVar();
				const tLe = deriveAnalyticLe(
					temporalCapped.lightSampleId, yPos, P,
					directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
					environmentTex, envMatrix, environmentIntensity, enableEnvironmentLight,
					lightBuffer, emissiveVec4Offset, triangleBuffer, emissiveBoost,
				).toVar();
				const tMisW = restirMISWeight(
					temporalCapped.lightSampleId, wi, tDots, material,
					environmentTex, envMatrix, envTotalSum, envCompensationDelta, envResolution,
					yPos, P, lightBuffer, emissiveVec4Offset, triangleBuffer, materialBuffer, emissiveTotalPower,
				).toVar();
				const pHatTemporalCurrent = luminance( { color: tF.mul( pHatCosine ).mul( tLe ) } ).mul( tMisW ).toVar();

				// Unbiased GRIS combine (verified ReSTIRCore). pHatCanonicalCurrent = canonical.pHatOwn (canonical is
				// at its own = current pixel). DO NOT reimplement the combine inline (§3.4).
				const merged = Reservoir.wrap( reservoirCombineUnbiased(
					canonical, temporalCapped,
					canonical.pHatOwn, pHatTemporalCurrent, rngState,
				) ).toVar();

				outId.assign( merged.lightSampleId );
				outWSum.assign( merged.wSum );
				outW.assign( merged.W );
				outM.assign( merged.M );
				outPosX.assign( merged.samplePosX );
				outPosY.assign( merged.samplePosY );
				outPosZ.assign( merged.samplePosZ );
				outPHatOwn.assign( merged.pHatOwn );

			} );

			// Write merged (or unchanged canonical) to the SNAPSHOT slot S (not cur) — restirSpatial reads S as
			// a stable post-temporal source for its neighbor gather, then writes the FINAL to cur. Reads above are
			// unchanged (cur slot[P] = canonical, prev slot[P^1] = last frame's post-spatial final). Disjoint
			// elements through the one rw node ⇒ no rw+ro alias.
			const result = Reservoir( {
				lightSampleId: outId, wSum: outWSum, W: outW, M: outM,
				samplePosX: outPosX, samplePosY: outPosY, samplePosZ: outPosZ, pHatOwn: outPHatOwn,
			} ).toVar();
			const baseIdxSnapshot = reservoirSlotIndex( gx, gy, resW, int( RESTIR_SNAPSHOT_SLOT ) ).toVar();
			reservoirPoolRW.element( baseIdxSnapshot ).assign( packReservoirCore( result ) );
			reservoirPoolRW.element( baseIdxSnapshot.add( int( 1 ) ) ).assign( packReservoirAux( result ) );

			rngBufferRW.element( rayID ).assign( rngState );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as RESTIR_TEMPORAL_WG_SIZE };
