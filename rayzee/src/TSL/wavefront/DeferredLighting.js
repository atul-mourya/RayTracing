/**
 * DeferredLighting.js — Direct Lighting with Deferred Shadow Rays
 *
 * Samples one light source (discrete or environment) per hit and writes
 * a shadow ray to the shadow buffer via atomic append.
 *
 * Runs INSIDE the Shade kernel — uses already-bound storage buffers
 * (shadowBufferRW, counters, envMarginalWeights, envConditionalWeights).
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	If, max, dot, normalize, min,
	atomicAdd, uintBitsToFloat,
} from 'three/tsl';

import { RandomValue } from '../Random.js';
import { evaluateMaterialResponse } from '../MaterialEvaluation.js';
import {
	getDirectionalLight,
	getPointLight,
} from '../LightsCore.js';
import { sampleEquirectProbability } from '../Environment.js';
import { SHADOW_STRIDE, SHADOW } from '../../Processor/PackedRayBuffer.js';
import { COUNTER } from '../../Processor/QueueManager.js';

/**
 * Helper: write a shadow ray to the buffer.
 */
function writeShadowRay( shadowBufferRW, counters, origin, direction, maxDist, parentRayID, pendingRadiance ) {

	const shadowIdx = atomicAdd( counters.element( uint( COUNTER.SHADOW_RAY_COUNT ) ), uint( 1 ) );
	shadowBufferRW.element( shadowIdx.mul( SHADOW_STRIDE ).add( SHADOW.ORIGIN_DIST ) )
		.assign( vec4( origin, min( maxDist, float( 100000.0 ) ) ) );
	shadowBufferRW.element( shadowIdx.mul( SHADOW_STRIDE ).add( SHADOW.DIR_PARENT ) )
		.assign( vec4( direction, uintBitsToFloat( parentRayID ) ) );
	shadowBufferRW.element( shadowIdx.mul( SHADOW_STRIDE ).add( SHADOW.RADIANCE ) )
		.assign( vec4( pendingRadiance, 0.0 ) );

}

/**
 * Sample one light and write a deferred shadow ray.
 */
export const sampleDirectLightDeferred = Fn( ( [
	hitPoint, hitNormal, material, viewDir, rngState,
	directionalLightsBuffer, numDirectionalLights,
	pointLightsBuffer, numPointLights,
	envTexture, environmentIntensity, envMatrix,
	envMarginalWeights, envConditionalWeights,
	envTotalSum, envResolution,
	enableEnvironmentLight,
	shadowBufferRW, counters,
	parentRayID, throughput,
] ) => {

	const rayOrigin = hitPoint.add( hitNormal.mul( 0.001 ) ).toVar();
	const totalLights = numDirectionalLights.add( numPointLights ).toVar();

	// Random strategy selection
	const rand = RandomValue( rngState );

	// Probability of sampling environment vs discrete lights
	// If no discrete lights, always sample environment
	const envProb = float( 0.5 ).toVar();
	If( totalLights.equal( int( 0 ) ), () => {

		envProb.assign( 1.0 );

	} );
	If( enableEnvironmentLight.not(), () => {

		envProb.assign( 0.0 );

	} );

	// ─── ENVIRONMENT IS PATH ────────────────────────────────
	If( rand.lessThan( envProb ).and( enableEnvironmentLight ), () => {

		const r = vec2( RandomValue( rngState ), RandomValue( rngState ) );
		const envColor = vec3( 0.0 ).toVar();
		const envSample = sampleEquirectProbability(
			envTexture,
			envMarginalWeights, envConditionalWeights,
			envMatrix, environmentIntensity,
			envTotalSum, envResolution,
			r, envColor,
		);

		const lightDir = envSample.xyz.toVar();
		const lightPdf = envSample.w.toVar();

		const NoL = max( 0.0, dot( hitNormal, lightDir ) );

		If( NoL.greaterThan( 0.0 ).and( lightPdf.greaterThan( 0.001 ) ), () => {

			const brdfValue = evaluateMaterialResponse( viewDir, lightDir, hitNormal, material );
			// Compensate for selection probability
			const pending = throughput.mul( brdfValue ).mul( envColor ).mul( NoL ).div( lightPdf.mul( envProb ) );

			writeShadowRay( shadowBufferRW, counters, rayOrigin, lightDir, float( 100000.0 ), parentRayID, pending );

		} );

	} );

	// ─── DISCRETE LIGHT PATH ────────────────────────────────
	If( rand.greaterThanEqual( envProb ).and( totalLights.greaterThan( int( 0 ) ) ), () => {

		const lightRand = RandomValue( rngState );
		const lightIdx = int( lightRand.mul( float( totalLights ) ) ).clamp( int( 0 ), totalLights.sub( 1 ) ).toVar();
		const lightSelectionPdf = float( 1.0 ).div( float( totalLights ) ).toVar();

		const lightDir = vec3( 0.0, 1.0, 0.0 ).toVar();
		const lightDist = float( 10000.0 ).toVar();
		const lightEmission = vec3( 0.0 ).toVar();

		If( lightIdx.lessThan( numDirectionalLights ), () => {

			const light = getDirectionalLight( directionalLightsBuffer, lightIdx );
			lightDir.assign( normalize( light.direction.negate() ) );
			lightDist.assign( float( 10000.0 ) );
			lightEmission.assign( light.color.mul( light.intensity ) );

		} ).Else( () => {

			const ptIdx = lightIdx.sub( numDirectionalLights );
			const light = getPointLight( pointLightsBuffer, ptIdx );
			const toLight = light.position.sub( hitPoint ).toVar();
			const dist = toLight.length().toVar();
			lightDir.assign( toLight.div( dist ) );
			lightDist.assign( dist );
			const attenuation = float( 1.0 ).div( max( dist.mul( dist ), 0.001 ) );
			lightEmission.assign( light.color.mul( light.intensity ).mul( attenuation ) );

		} );

		const NoL = max( 0.0, dot( hitNormal, lightDir ) );

		If( NoL.greaterThan( 0.0 ), () => {

			const brdfValue = evaluateMaterialResponse( viewDir, lightDir, hitNormal, material );
			// Compensate for selection probability
			const discreteProb = float( 1.0 ).sub( envProb );
			const pending = throughput.mul( brdfValue ).mul( lightEmission ).mul( NoL ).div( lightSelectionPdf.mul( discreteProb ) );

			writeShadowRay( shadowBufferRW, counters, rayOrigin, lightDir, lightDist.sub( 0.001 ), parentRayID, pending );

		} );

	} );

} );
