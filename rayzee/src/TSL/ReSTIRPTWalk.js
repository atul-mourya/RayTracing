/**
 * ReSTIRPTWalk.js — multi-bounce suffix walker for ReSTIR PT (reconnection shift at x_k).
 *
 * Spec: docs/specs/restir-pt-phase03.md (PT-1 walk + PT-2 payload split + PT-3c k-selection). Walks a
 * full path from the bounce-0 scatter, mirroring ShadeKernel's per-vertex shading EXACTLY (the PT-1
 * parity table), and splits the payload for PT-2's domain re-evaluation (ReSTIRGIEval.evalLo):
 *   A   — frozen d=1 terms at x1 (NEE@x1; EVERYTHING when non-factorizable)
 *   Le  — the d=1 emissive-hit UNWEIGHTED radiance (+ triIdx) / pre-x1 env radiance (+ envPdf):
 *         the one frozen MIS weight with a LIVE domain partner — re-derived per domain in evalLo
 *   B   — suffix radiance WITHOUT f_{x1}: x1's fold contributes ind1.throughputNoF (cos·misW/pdf,
 *         branch-exact from LightsIndirect), deeper folds their full throughput
 * Non-factorizable x1 (clearcoat — evaluateMaterialResponse has no clearcoat lobe; the LightsIndirect
 * validInput fallback — throughputNoF=0) ⇒ matIdx1 = GI_MAT_FROZEN: every suffix term folds into A at
 * full frozen weight = exact PT-1 semantics.
 *
 * Per-term firefly clamping in BF-equivalent units (prefixThroughput·gi·FULL-throughput·term) via the
 * scalar suppression factor; the E lane stores Le unclamped (the resolve's relaxed wrap still guards).
 *
 * PT-3c k-selection: rough x0 (anchorAtX1=1) anchors at x1 ALWAYS — bit-compatible with the k=1 path.
 * Glossy x0 routes pre-anchor vertex terms to prefixRad (per-pixel BF — gi-initial adds them straight
 * to RAY radiance) and anchors at the first pair (x_{j−1}, x_j) with roughness(x_{j−1}) ≥ τ,
 * roughness(x_j) ≥ τ₁, |x_j − x_{j−1}| ≥ d_min; no qualifying pair by walk end ⇒ the x1-anchored
 * nonReusable fallback (PT-3b semantics). RR stays off until the anchor exists (scheme B — the replay
 * must not roll RR).
 *
 * v1 terminations (documented): transmissive/SSS lottery CONTINUE arms; pre-x1 alpha skips unless
 * MASK + alphaShadows on; no displacement; no STBN.
 */

import {
	Fn, float, vec2, vec3, int, uint,
	bool as tslBool,
	If, Loop, normalize, max, dot, length, select, sampler,
} from 'three/tsl';

import { struct } from './patches.js';
import { RandomValue, pcgHash } from './Random.js';
import {
	getMaterial, luminance, classifyMaterial, powerHeuristic, balanceHeuristic,
} from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { calculateDirectLightingUnified, calculateMaterialPDF } from './LightsSampling.js';
import { traceShadowRay, calculateRayOffset } from './LightsDirect.js';
import { traverseBVH, traverseBVHShadow } from './BVHTraversal.js';
import { handleMaterialTransparency, MaterialInteractionResult } from './MaterialTransmission.js';
import { calculateIndirectLighting } from './LightsIndirect.js';
import { IndirectLightingResult } from './LightsCore.js';
import { regularizePathContribution, generateSampledDirection, handleRussianRoulette } from './PathTracerCore.js';
import { getImportanceSamplingInfo } from './MaterialProperties.js';
import { sampleClearcoat, ClearcoatResult } from './Clearcoat.js';
import { calculateEmissiveTriangleContribution, calculateEmissiveLightPdf, EmissiveSample } from './EmissiveSampling.js';
import { sampleLightBVHTriangle } from './LightBVHSampling.js';
import { sampleEnvironment, sampleEquirect } from './Environment.js';
import {
	Ray, HitInfo, RayTracingMaterial, MaterialSamples, DirectionSample,
	ImportanceSamplingInfo, MaterialClassification, BRDFWeights, MaterialCache,
	DirectLightingDual,
} from './Struct.js';
import { GI_MAT_ENV, GI_MAT_FROZEN, octEncodeDir2 } from './ReSTIRGICore.js';

// far x1 for env candidates (pre-x1 miss) — resolve's visibility ray tests occlusion toward the env
const ENV_FAR = 1e5;

export const PT_WALK_INVALID = 0.0; // no candidate (pre-x1 termination / env-off miss)
export const PT_WALK_SURFACE = 1.0; // x1 is a surface point
export const PT_WALK_ENV = 2.0; // env candidate (x1 = far point along ω)

// PT-3c anchor-pair gates (with the τ uniform): roughness(x_{j−1}) ≥ τ, roughness(x_j) ≥ τ₁,
// |x_j − x_{j−1}| ≥ d_min. Exported — the replay MUST test the SAME values or the stratum
// partition (Eq. 11) leaks.
export const RESTIR_PT_TAU1 = 0.1;
export const RESTIR_PT_DMIN = 0.05;

export const PTWalkResult = struct( {
	x1: 'vec3', // reconnection vertex (surface) or far env point
	n1: 'vec3', // UNFLIPPED interpolated normal at x1 (rebuild basis; Jacobian is flip-blind)
	flip: 'float', // 1 = the path shaded the −n1 side (back-face), 0 = front
	A: 'vec3', // frozen d=1 radiance (payload units, per-term BF-clamped)
	B: 'vec3', // suffix radiance WITHOUT f_{x1} (0 when the walk ended at x1 / non-factorizable)
	om1: 'vec2', // ω1out full-precision oct
	matIdx1: 'float', // x1 material index, or GI_MAT_ENV / GI_MAT_FROZEN
	uv1: 'vec2', // x1 texture uv
	Le: 'vec3', // d=1 emissive-hit UNWEIGHTED Le / env radiance
	triIdx1: 'float', // emissive triangle index / stored envPdf (env)
	flags: 'float', // PT_WALK_*
	prefixRad: 'vec3', // pre-anchor vertex terms (BF-clamped, FULL-throughput units); 0 unless k>1
	kOut: 'float', // anchor depth k (1 = x1 / fallback; ≥2 = deferred anchor, prefix replayed per domain)
	pAnchor: 'float', // scatter pdf INTO the anchor (the k>1 RIS denominator); = pdf0 at k=1
} );

/**
 * Build the suffix-walk Fn (closure over scene buffers/uniforms — kernel-builder pattern).
 * Returned Fn: ( origin0, dir0, pdf0, prefixThroughput, rngSeed, anchorAtX1 ) → PTWalkResult
 * (callers .wrap()). prefixThroughput = ind0.throughput at x0 — used ONLY inside the BF-units firefly
 * clamp. anchorAtX1 = 1 (rough x0) pins the anchor to x1 — the bit-compatible k=1 path. The walk
 * draws from its OWN local stream (hash of rngSeed) — TSL Fn params are not mutable across statements.
 */
export function makeSuffixWalker( params ) {

	const {
		bvhBuffer, triangleBuffer, materialBuffer,
		lightBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
		emissiveBoost, enableEmissiveTriangleSampling, lightBVHNodeCount,
		envTexture, environmentIntensity, envMatrix, envCDFTexture,
		envTotalSum, envCompensationDelta, envResolution, enableEnvironmentLight, useEnvMapIS,
		directionalLightsBuffer, numDirectionalLights,
		areaLightsBuffer, numAreaLights,
		pointLightsBuffer, numPointLights,
		spotLightsBuffer, numSpotLights,
		maxBounceCount, transmissiveBounces, maxSubsurfaceSteps,
		enableAlphaShadows,
		globalIlluminationIntensity, fireflyThreshold, frame,
		restirGIRoughnessTau,
	} = params;

	const useEmissiveNEE = lightBuffer !== undefined;

	return Fn( ( [ origin0, dir0, pdf0, prefixThroughput, rngSeed, anchorAtX1 ] ) => {

		// LOCAL mutable rng stream (TSL Fn-param mutation does not persist across statements — a param
		// stream freezes every draw; measured 15×). Hash-decorrelated from the caller's continued stream.
		const rngState = pcgHash( { state: rngSeed.bitXor( uint( 0x517cc1b7 ) ) } ).toVar();

		const resX1 = vec3( 0.0 ).toVar();
		const resN1 = vec3( 0.0, 0.0, 1.0 ).toVar();
		const resFlip = float( 0.0 ).toVar();
		const Abuck = vec3( 0.0 ).toVar();
		const Bbuck = vec3( 0.0 ).toVar();
		const resOm1 = vec2( 0.0 ).toVar();
		const resMatIdx1 = float( GI_MAT_FROZEN ).toVar();
		const resUv1 = vec2( 0.0 ).toVar();
		const resLe = vec3( 0.0 ).toVar();
		const resTriIdx1 = float( 0.0 ).toVar();
		const flagsV = float( PT_WALK_INVALID ).toVar();
		const prefixRad = vec3( 0.0 ).toVar();
		const resKOut = float( 1.0 ).toVar();
		const resPAnchor = pdf0.toVar();

		const rayOrigin = origin0.toVar();
		const rayDir = dir0.toVar();
		// FULL suffix-local throughput (excludes the x0 scatter) — drives RR + the BF-units clamp.
		const throughput = vec3( 1.0 ).toVar();
		// NoF mirror: like throughput but x1's fold contributes throughputNoF (no f_{x1}) — feeds B.
		// EVERY post-x1 throughput mutation must mirror here (indirect folds, RR, alpha skips).
		const suffixTNoF = vec3( 0.0 ).toVar();
		const factorizable = tslBool( false ).toVar();
		const prevPdf = pdf0.toVar();
		const cameraDepth = int( 1 ).toVar();
		const iter = int( 1 ).toVar();
		const haveX1 = tslBool( false ).toVar();
		const active = tslBool( true ).toVar();
		// PT-3c anchor state. prevRough starts 0 — glossy x0 < τ means the (x0, x1) pair can never fire.
		// preT = pre-anchor transport, dropped from the payload at the anchor (the replay re-realizes it
		// per domain) but kept in the BF-units clamp; ≡1 at k=1.
		const haveAnchor = tslBool( false ).toVar();
		const prevRough = float( 0.0 ).toVar();
		const prevPos = origin0.toVar();
		const preT = vec3( 1.0 ).toVar();

		// BF free-bounce headroom (PathTracer.js loopBound)
		const maxIter = int( maxBounceCount ).add( int( transmissiveBounces ) ).add( int( maxSubsurfaceSteps ) ).toVar();

		// Scalar BF-units suppression factor for a term at the current depth (identity when clamp off).
		const clampFactor = ( payload ) => {

			const bf = prefixThroughput.mul( preT ).mul( globalIlluminationIntensity ).mul( payload ).toVar();
			const bfLum = luminance( { color: bf } ).toVar();
			const wrapped = regularizePathContribution( bf, float( iter ), fireflyThreshold, int( frame ) );
			return select( bfLum.greaterThan( 1e-10 ), luminance( { color: wrapped } ).div( bfLum ), float( 1.0 ) );

		};

		// Route a term to its bucket. atX1 terms (other than the Le capture) → A. Suffix terms → B in
		// NoF units when factorizable, else → A in full frozen units (PT-1 semantics). The clamp factor
		// is ALWAYS computed from the FULL-throughput BF units.
		const addTermAtX1 = ( term ) => {

			const payload = term.toVar(); // throughput at x1 ≡ 1 (pre-fold)
			Abuck.addAssign( payload.mul( clampFactor( payload ) ) );

		};

		const addTermSuffix = ( term ) => {

			const payloadFull = throughput.mul( term ).toVar();
			const factor = clampFactor( payloadFull ).toVar();
			If( factorizable, () => {

				Bbuck.addAssign( suffixTNoF.mul( term ).mul( factor ) );

			} ).Else( () => {

				Abuck.addAssign( payloadFull.mul( factor ) );

			} );

		};

		// PT-3c: pre-anchor vertex terms (glossy x0) — per-pixel BF, added straight to RAY radiance by
		// gi-initial. Zeroed at walk end when no anchor fires (the x1-anchored fallback keeps them in A/B).
		const addTermPrefix = ( term ) => {

			const payloadFull = throughput.mul( term ).toVar();
			prefixRad.addAssign( payloadFull.mul( clampFactor( payloadFull ) ) );

		};

		const emptyWeights = BRDFWeights( {
			specular: float( 0.0 ), diffuse: float( 0.0 ), sheen: float( 0.0 ),
			clearcoat: float( 0.0 ), transmission: float( 0.0 ), iridescence: float( 0.0 ),
		} );
		const emptyCache = MaterialCache( {
			F0: vec3( 0.04 ), NoV: float( 1.0 ), diffuseColor: vec3( 0.0 ), isPurelyDiffuse: false,
			alpha: float( 0.0 ), k: float( 0.0 ), alpha2: float( 0.0 ),
			invRoughness: float( 0.5 ), metalFactor: float( 0.5 ), iorFactor: float( 0.67 ), maxSheenColor: float( 0.0 ),
		} );

		Loop( active.and( iter.lessThanEqual( maxIter ) ), () => {

			const ray = Ray( { origin: rayOrigin, direction: rayDir } );
			const hit = HitInfo.wrap( traverseBVH( ray, bvhBuffer, triangleBuffer ).toVar() );

			If( hit.didHit.not(), () => {

				If( enableEnvironmentLight, () => {

					const envColor = sampleEnvironment( {
						tex: envTexture, samp: sampler( envTexture ), direction: rayDir,
						environmentMatrix: envMatrix, environmentIntensity, enableEnvironmentLight,
					} ).xyz.toVar();

					If( haveX1.not(), () => {

						// pre-x1 miss ⇒ ENV CANDIDATE: store UNWEIGHTED env radiance + the env pdf — the
						// MIS weight vs the live env-NEE@x0 partner is re-derived PER DOMAIN in evalLo.
						resX1.assign( rayOrigin.add( rayDir.mul( ENV_FAR ) ) );
						resN1.assign( rayDir.negate() );
						resMatIdx1.assign( float( GI_MAT_ENV ) );
						resLe.assign( envColor );
						If( useEnvMapIS, () => {

							const envPdf = sampleEquirect(
								envTexture, rayDir, envMatrix, envTotalSum, envCompensationDelta, envResolution,
							).w;
							resTriIdx1.assign( max( envPdf, 0.0 ) );

						} );
						flagsV.assign( float( PT_WALK_ENV ) );

					} ).Else( () => {

						// post-x1 env escape — MIS vs prevPdf, frozen (suffix-internal pair, exact)
						const envMisW = float( 1.0 ).toVar();
						If( useEnvMapIS, () => {

							If( prevPdf.greaterThan( 0.0 ), () => {

								const envPdf = sampleEquirect(
									envTexture, rayDir, envMatrix, envTotalSum, envCompensationDelta, envResolution,
								).w;
								If( envPdf.greaterThan( 0.0 ), () => {

									envMisW.assign( balanceHeuristic( { pdf1: prevPdf, pdf2: envPdf } ) );

								} );

							} );

						} );
						addTermSuffix( envColor.mul( envMisW ) );

					} );

				} );
				active.assign( false );

			} ).Else( () => {

				const hitPoint = hit.hitPoint.toVar();
				const nGeo = normalize( hit.normal ).toVar();
				const atX1 = haveX1.not().toVar();

				// Shade's exact normal pipeline: textures with the UNFLIPPED interpolated normal → N :=
				// matSamples.normal (perturbed, unflipped) → transparency with that N → flip toward V.
				const material = RayTracingMaterial.wrap( getMaterial( hit.materialIndex, materialBuffer ) ).toVar();
				const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
					material, hit.uv, nGeo,
				) ).toVar();
				material.color.assign( matSamples.albedo );
				material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
				material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );
				material.sheenRoughness.assign( material.sheenRoughness.clamp( 0.05, 1.0 ) );
				const N = matSamples.normal.toVar();

				// transparency lottery (no medium stack: IORs 1/1, wavelength 0; transTraversals MUST be
				// >0 or glass silently shades as phantom opaque)
				const interaction = MaterialInteractionResult.wrap( handleMaterialTransparency(
					ray, N, material, rngState,
					int( transmissiveBounces ),
					float( 1.0 ), float( 1.0 ),
					float( 0.0 ),
				) ).toVar();

				If( interaction.continueRay, () => {

					If( interaction.isTransmissive.or( interaction.isSubsurface ), () => {

						// v1: terminate the CONTINUE arm of the glass/SSS lottery (the opaque-rolled arm
						// falls through and shades = BF's lottery weighting). Documented energy gap.
						active.assign( false );

					} ).Else( () => {

						// alpha skip — free bounce. Pre-x1: continue ONLY when MASK + alphaShadows on
						// (transport ≡ the resolve shadow-ray semantics at the same texel); BLEND would
						// double-attenuate (1−a)², MASK+shadows-off would V=0 the pixel. Pre-x1 throughput
						// stays UNTOUCHED (edge transmittance is the resolve V's per-domain job).
						const preX1ExactOk = material.alphaMode.equal( int( 1 ) )
							.and( enableAlphaShadows.equal( int( 1 ) ) );
						If( haveX1.not().and( preX1ExactOk.not() ), () => {

							active.assign( false );

						} ).Else( () => {

							If( haveX1, () => {

								throughput.mulAssign( interaction.throughput );
								suffixTNoF.mulAssign( interaction.throughput );

							} );
							// offset along the RAY direction (Shade :524-526), not the normal
							rayOrigin.assign( hitPoint.add( rayDir.mul( 0.001 ) ) );

						} );

					} );

				} ).Else( () => {

					// ── opaque vertex: mirror Shade :547-905 ──

					const V = rayDir.negate().toVar();

					// PT-3c anchor policy (decided at visit time): rough x0 (anchorAtX1) anchors at x1
					// ALWAYS — bit-compatible k=1; glossy x0 defers to the first qualifying pair.
					const pairOk = prevRough.greaterThanEqual( restirGIRoughnessTau )
						.and( material.roughness.greaterThanEqual( RESTIR_PT_TAU1 ) )
						.and( length( hitPoint.sub( prevPos ) ).greaterThanEqual( RESTIR_PT_DMIN ) );
					const atAnchor = haveAnchor.not().and(
						anchorAtX1.greaterThan( 0.5 ).and( atX1 )
							.or( anchorAtX1.lessThanEqual( 0.5 ).and( pairOk ) )
					).toVar();
					prevRough.assign( material.roughness );
					prevPos.assign( hitPoint );

					// reconnection-vertex capture: x1 (the k=1 anchor / the no-anchor fallback) or the
					// deferred anchor x_k — the same code path, relocated. n stored UNFLIPPED (the
					// rebuild's perturbation basis); the shaded side goes into the flip bit.
					If( atX1.or( atAnchor ), () => {

						resX1.assign( hitPoint );
						resN1.assign( nGeo );
						resFlip.assign( select( dot( nGeo, V ).lessThan( 0.0 ), float( 1.0 ), float( 0.0 ) ) );
						resUv1.assign( hit.uv );
						flagsV.assign( float( PT_WALK_SURFACE ) );

					} );
					If( atX1, () => {

						haveX1.assign( true );

					} );
					If( atAnchor, () => {

						haveAnchor.assign( true );
						resKOut.assign( float( cameraDepth ) );
						resPAnchor.assign( prevPdf );
						// deferred anchor (k>1): drop the x1-anchored fallback routing and re-anchor the
						// payload at x_k — pre-anchor transport moves to preT (BF-units clamp only); the
						// replay re-realizes it per domain.
						If( atX1.not(), () => {

							Abuck.assign( vec3( 0.0 ) );
							Bbuck.assign( vec3( 0.0 ) );
							resLe.assign( vec3( 0.0 ) );
							resTriIdx1.assign( 0.0 );
							suffixTNoF.assign( vec3( 0.0 ) );
							factorizable.assign( tslBool( false ) );
							preT.assign( throughput );
							throughput.assign( vec3( 1.0 ) );

						} );

					} );

					// PT-3c routing: anchor vertex → A (payload units); beyond → B/A (suffix); pre-anchor
					// (glossy, unanchored) → prefixRad + the x1-anchored FALLBACK buckets.
					const routeTerm = ( term ) => {

						If( atAnchor, () => {

							addTermAtX1( term );

						} ).ElseIf( haveAnchor, () => {

							addTermSuffix( term );

						} ).Else( () => {

							addTermPrefix( term );
							If( atX1, () => {

								addTermAtX1( term );

							} ).Else( () => {

								addTermSuffix( term );

							} );

						} );

					};

					// emissive hit (Shade :549-590). AT the anchor with emissive sampling ON: capture
					// UNWEIGHTED Le + triIdx into the E lane — the MIS weight's partner (emissive-NEE@x0)
					// runs LIVE at the reuse domain, so evalLo re-derives the weight per domain (the PT-2
					// fix for the broken partition). Toggle OFF ⇒ weight 1 is correct and final → frozen
					// into A. Other vertices: frozen MIS pair vs prevPdf (exact — suffix-internal, and the
					// per-pixel prefix is BF's own weighting).
					const emissiveV = matSamples.emissive.toVar();
					If( length( emissiveV ).greaterThan( 0.0 ), () => {

						const emissiveOn = useEmissiveNEE
							? enableEmissiveTriangleSampling.equal( int( 1 ) ).and( emissiveTriangleCount.greaterThan( int( 0 ) ) )
							: tslBool( false );

						// hoisted (the anchor Le capture ignores it — pure math, no draws)
						const emisW = float( 1.0 ).toVar();
						if ( useEmissiveNEE ) {

							If( enableEmissiveTriangleSampling.equal( int( 1 ) )
								.and( emissiveTriangleCount.greaterThan( int( 0 ) ) ), () => {

								If( prevPdf.greaterThan( 0.0 ), () => {

									const lightPdf = calculateEmissiveLightPdf(
										hit.triangleIndex, hit.dst, rayDir, rayOrigin,
										triangleBuffer, materialBuffer, emissiveTotalPower,
									);
									emisW.assign( powerHeuristic( { pdf1: prevPdf, pdf2: lightPdf } ) );

								} );

							} );

						}

						If( atAnchor.and( emissiveOn ), () => {

							resLe.assign( emissiveV ); // unclamped (resolve's relaxed wrap guards)
							resTriIdx1.assign( float( hit.triangleIndex ) );

						} ).ElseIf( atAnchor, () => {

							addTermAtX1( emissiveV.mul( emisW ) );

						} ).ElseIf( haveAnchor, () => {

							addTermSuffix( emissiveV.mul( emisW ) );

						} ).Else( () => {

							addTermPrefix( emissiveV.mul( emisW ) );
							If( atX1.and( emissiveOn ), () => {

								resLe.assign( emissiveV );
								resTriIdx1.assign( float( hit.triangleIndex ) );

							} ).ElseIf( atX1, () => {

								addTermAtX1( emissiveV.mul( emisW ) );

							} ).Else( () => {

								addTermSuffix( emissiveV.mul( emisW ) );

							} );

						} );

					} );

					If( dot( N, V ).lessThan( 0.0 ), () => {

						N.assign( N.negate() );

					} );

					const mc = MaterialClassification.wrap( classifyMaterial(
						material.metalness, material.roughness, material.transmission,
						material.clearcoat, material.emissive, material.subsurface,
					) ).toVar();

					// BRDF sample — clearcoat branch mirrored (Shade :653-680). Per-component capture:
					// vec2(RandomValue(s), RandomValue(s)) reads BOTH lanes after BOTH advances (xi.x==xi.y).
					const xiX = RandomValue( rngState ).toVar();
					const xiY = RandomValue( rngState ).toVar();
					const xi = vec2( xiX, xiY ).toVar();
					const brdfDir = vec3( 0.0 ).toVar();
					const brdfValue = vec3( 0.0 ).toVar();
					const brdfPdf = float( 0.0 ).toVar();
					If( material.clearcoat.greaterThan( 0.0 ), () => {

						const ccHit = HitInfo( {
							didHit: true, dst: hit.dst, hitPoint, normal: N, uv: hit.uv,
							materialIndex: hit.materialIndex, meshIndex: int( 0 ),
							triangleIndex: int( 0 ), boxTests: int( 0 ), triTests: int( 0 ),
						} );
						const ccResult = ClearcoatResult.wrap( sampleClearcoat(
							ray, ccHit, material, xi, rngState,
						) );
						brdfDir.assign( ccResult.L );
						brdfValue.assign( ccResult.brdf );
						brdfPdf.assign( ccResult.pdf );

					} ).Else( () => {

						const bs = DirectionSample.wrap( generateSampledDirection(
							V, N, material, xi, rngState, mc, false, emptyWeights, false, emptyCache,
						) );
						brdfDir.assign( bs.direction );
						brdfValue.assign( bs.value );
						brdfPdf.assign( bs.pdf );

					} );

					// unified NEE (analytic + env + BRDF-MIS-to-area); bounce≥1 ⇒ never DI-gated
					const direct = DirectLightingDual.wrap( calculateDirectLightingUnified(
						hitPoint, N, material, V,
						brdfDir, brdfPdf, brdfValue,
						iter, rngState,
						directionalLightsBuffer, numDirectionalLights,
						areaLightsBuffer, numAreaLights,
						pointLightsBuffer, numPointLights,
						spotLightsBuffer, numSpotLights,
						bvhBuffer, triangleBuffer, materialBuffer,
						envTexture, environmentIntensity, envMatrix, envCDFTexture,
						envTotalSum, envCompensationDelta, envResolution, enableEnvironmentLight,
						false, // skipDiscreteLighting: bounce>=1 is never DI-gated
						false, // wantUnoccluded: no shadow-catcher reference needed here
					) ).shadowed.toVar();
					routeTerm( direct );

					// emissive-triangle NEE (Shade :724-824) — INCLUDING the rough-diffuse skip on the BVH
					// path (the flat-CDF fallback inherits it). Frozen pairs at d≥2 are exact; at x1 it is
					// the live-partnered side's NEE arm at x1's OWN lighting — frozen in A (documented).
					if ( useEmissiveNEE ) {

						If( enableEmissiveTriangleSampling.equal( int( 1 ) )
							.and( emissiveTriangleCount.greaterThan( int( 0 ) ) ), () => {

							const traceShadowRayWrapped = Fn( ( [ sOrigin, sDir, sMaxDist ] ) => {

								return traceShadowRay(
									sOrigin, sDir, sMaxDist,
									traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
								);

							} );

							const emissiveNEETerm = vec3( 0.0 ).toVar();

							If( lightBVHNodeCount.greaterThan( int( 0 ) ), () => {

								const emissiveSample = EmissiveSample.wrap( sampleLightBVHTriangle(
									hitPoint, N,
									rngState,
									lightBuffer,
									lightBuffer,
									emissiveVec4Offset,
									triangleBuffer,
								) );

								const skip = iter.greaterThan( int( 1 ) )
									.and( material.roughness.greaterThan( 0.9 ) )
									.and( material.metalness.lessThan( 0.1 ) );

								If( skip.not().and( emissiveSample.valid ).and( emissiveSample.pdf.greaterThan( 0.0 ) ), () => {

									const NoL = max( float( 0.0 ), dot( N, emissiveSample.direction ) );

									If( NoL.greaterThan( 0.0 ), () => {

										const rayOffset = calculateRayOffset( hitPoint, N, material );
										const sOrigin = hitPoint.add( rayOffset );
										const shadowDist = emissiveSample.distance.sub( 0.001 );
										const visibility = traceShadowRayWrapped(
											sOrigin, emissiveSample.direction, shadowDist,
										);

										If( visibility.greaterThan( 0.0 ), () => {

											const brdfVal = evaluateMaterialResponse( V, emissiveSample.direction, N, material );
											const bPdf = calculateMaterialPDF( V, emissiveSample.direction, N, material );
											const misW = select(
												bPdf.greaterThan( 0.0 ),
												powerHeuristic( { pdf1: emissiveSample.pdf, pdf2: bPdf } ),
												float( 1.0 ),
											);

											emissiveNEETerm.assign( emissiveSample.emission
												.mul( brdfVal ).mul( NoL )
												.div( emissiveSample.pdf )
												.mul( visibility ).mul( emissiveBoost ).mul( misW ) );

										} );

									} );

								} );

							} ).Else( () => {

								emissiveNEETerm.assign( calculateEmissiveTriangleContribution(
									hitPoint, N, V, material,
									iter, rngState,
									emissiveBoost,
									lightBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
									triangleBuffer,
									traceShadowRayWrapped,
									calculateRayOffset,
								) );

							} );

							If( luminance( { color: emissiveNEETerm } ).greaterThan( 0.0 ), () => {

								routeTerm( emissiveNEETerm );

							} );

						} );

					}

					// indirect continuation (Shade :835-848) → RR → shade-then-terminate on camera depth
					const samplingInfo = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo(
						material, iter, mc,
					) ).toVar();
					const ind = IndirectLightingResult.wrap( calculateIndirectLighting(
						V, N, material, brdfDir, brdfPdf, brdfValue, rngState, samplingInfo,
					) ).toVar();
					throughput.mulAssign( ind.throughput );

					If( atX1.or( atAnchor ), () => {

						// PT-2 reconnection data at the anchor's fold. Factorizable ⇔ the fold's BSDF is
						// evaluateMaterialResponse (clearcoat folds evaluateLayeredBRDF / sampleClearcoat's
						// brdf; the LightsIndirect fallback isn't f·cos·misW/pdf at all → throughputNoF=0).
						resOm1.assign( vec2( 0.0 ) );
						If( material.clearcoat.lessThanEqual( 0.0 ).and( ind.throughputNoF.greaterThan( 0.0 ) ), () => {

							factorizable.assign( true );
							resMatIdx1.assign( float( hit.materialIndex ) );
							suffixTNoF.assign( vec3( ind.throughputNoF ) );
							// full-precision 2-lane oct (12-bit oct error ≈ GGX lobe width at roughness 0.05)
							resOm1.assign( octEncodeDir2( ind.direction ) );

						} ).Else( () => {

							factorizable.assign( false );
							resMatIdx1.assign( float( GI_MAT_FROZEN ) );

						} );

					} );

					// PT-3 RR scheme (B): RR runs only once the reconnection anchor exists — a prefix RR's
					// 1/p_surv has no domain counterpart under replay (the replay must not roll RR). NO-OP
					// at k≡1 (the anchor is found at vertex 1, before RR's iter≥3 onset); energy-neutral,
					// variance-only deviation from Shade-parity row 9.
					const rrSurvival = float( 1.0 ).toVar();
					If( haveAnchor, () => {

						rrSurvival.assign( handleRussianRoulette(
							iter, throughput, mc, ind.direction, rngState,
							enableEnvironmentLight, useEnvMapIS,
						) );

					} );
					If( rrSurvival.lessThanEqual( 0.0 ), () => {

						active.assign( false );

					} ).Else( () => {

						throughput.divAssign( rrSurvival );
						suffixTNoF.divAssign( rrSurvival );

						If( cameraDepth.greaterThanEqual( maxBounceCount ), () => {

							active.assign( false );

						} ).Else( () => {

							rayOrigin.assign( hitPoint.add( N.mul( 0.001 ) ) );
							rayDir.assign( ind.direction );
							prevPdf.assign( max( ind.combinedPdf, 0.001 ) );
							cameraDepth.addAssign( int( 1 ) );
							// deeper folds carry their FULL throughput into the NoF mirror (only the
							// anchor's f is excluded)
							If( atX1.or( atAnchor ).not(), () => {

								suffixTNoF.mulAssign( ind.throughput );

							} );

						} );

					} );

				} );

			} );

			iter.addAssign( int( 1 ) );

		} );

		// no anchor by walk end (glossy): the x1-anchored fallback candidate stands — the prefix
		// accumulator belongs to the discarded deferred-anchor accounting.
		If( haveAnchor.not(), () => {

			prefixRad.assign( vec3( 0.0 ) );

		} );

		return PTWalkResult( {
			x1: resX1, n1: resN1, flip: resFlip,
			A: Abuck, B: Bbuck, om1: resOm1,
			matIdx1: resMatIdx1, uv1: resUv1,
			Le: resLe, triIdx1: resTriIdx1,
			flags: flagsV,
			prefixRad, kOut: resKOut, pAnchor: resPAnchor,
		} );

	} );

}
