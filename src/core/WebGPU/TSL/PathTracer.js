/**
 * PathTracer.js - Pure TSL Path Tracer Main Entry Point
 *
 * Complete port of pathtracer.fs from GLSL to pure TSL/WGSL
 * NO wgslFn() - uses only Fn(), If(), Loop(), .toVar(), .assign()
 *
 * This file contains:
 * - Main path tracing entry point
 * - Adaptive sampling support
 * - Edge detection for denoising
 * - Temporal accumulation
 * - Debug visualization modes
 *
 * MRT Outputs:
 * - gColor: RGB + edge sharpness (alpha)
 * - gNormalDepth: Normal(RGB) + depth(A)
 * - gAlbedo: Albedo(RGB) for OIDN denoiser
 */

import {
	Fn,
	float,
	vec3,
	vec4,
	vec2,
	int,
	uint,
	bool as tslBool,
	max,
	min,
	clamp,
	mix,
	dot,
	normalize,
	length,
	floor,
	fwidth,
	smoothstep,
	If,
	Loop,
	Break,
	texture,
	select,
	screenCoordinate
} from 'three/tsl';

import {
	RandomValue,
	getDecorrelatedSeed,
	getStratifiedSample,
	pcgHash
} from './Random.js';

import {
	luminance,
	PI,
	TWO_PI,
} from './Common.js';

import {
	traverseBVH,
	generateRayFromCamera
} from './BVHTraversal.js';

import {
	Trace,
	traceSingleBounce
} from './PathTracerCore.js';

import {
	Pixel,
	Ray,
	DirectionSample,
	MaterialClassification,
	BRDFWeights,
	MaterialCache,
	PathState,
	pathTracerOutputStruct
} from './Struct.js';

// ================================================================================
// HELPER FUNCTIONS
// ================================================================================

/**
 * Dithering to prevent banding in 8-bit output
 * Matches GLSL dithering function
 */
export const dithering = Fn( ( [ color, seed ] ) => {

	const gridPosition = RandomValue( seed );
	const ditherShiftRGB = vec3( 0.25 / 255.0, - 0.25 / 255.0, 0.25 / 255.0 ).toVar( 'ditherShiftRGB' );

	// Modify shift according to grid position
	ditherShiftRGB.assign(
		mix( ditherShiftRGB.mul( 2.0 ), ditherShiftRGB.mul( - 2.0 ), gridPosition )
	);

	return color.add( ditherShiftRGB );

} );

/**
 * Compute NDC depth from world position
 * Outputs depth in [0, 1] range suitable for motion vector reprojection
 * Matches GLSL computeNDCDepth function
 */
export const computeNDCDepth = Fn( ( [ worldPos, cameraProjectionMatrix, cameraViewMatrix ] ) => {

	// Transform world position to clip space
	const clipPos = cameraProjectionMatrix.mul( cameraViewMatrix ).mul( vec4( worldPos, 1.0 ) );

	// Convert to NDC depth [0, 1]
	const ndcDepth = clipPos.z.div( clipPos.w ).mul( 0.5 ).add( 0.5 );

	return clamp( ndcDepth, 0.0, 1.0 );

} );

/**
 * Get required samples count from adaptive sampling texture
 * Matches GLSL getRequiredSamples function
 */
export const getRequiredSamples = Fn( ( [
	pixelCoord,
	resolution,
	adaptiveSamplingTexture,
	adaptiveSamplingMax,
	numRaysPerPixel
] ) => {

	const texCoord = pixelCoord.div( resolution );
	const samplingData = texture( adaptiveSamplingTexture, texCoord );

	const result = int( numRaysPerPixel ).toVar( 'requiredSamples' );

	// Early exit for converged pixels (blue channel > 0.5)
	If( samplingData.b.greaterThan( 0.5 ), () => {

		result.assign( 0 );

	} ).Else( () => {

		// Get normalized sample count
		const normalizedSamples = samplingData.r;

		// Stable conversion with minimum guarantee
		const targetSamples = normalizedSamples.mul( float( adaptiveSamplingMax ) );
		const samples = int( floor( targetSamples.add( 0.5 ) ) ); // Stable rounding

		// Ensure minimum samples and valid range
		result.assign( clamp( samples, 1, adaptiveSamplingMax ) );

	} );

	return result;

} );

// ================================================================================
// DEBUG VISUALIZATION MODES
// ================================================================================

/**
 * Debug trace for visualization modes
 * Matches GLSL TraceDebugMode function
 */
export const traceDebugMode = Fn( ( [
	rayOrigin,
	rayDir,
	visMode,
	bvhTex, bvhTexSize,
	triTex, triTexSize,
	matTex, matTexSize,
	envTex, envIntensity, envMatrix, hasEnv
] ) => {

	const result = vec4( 0.0 ).toVar( 'debugResult' );

	// BVH traversal for debug info
	const hitResult = traverseBVH(
		rayOrigin, rayDir, float( 0.0001 ), float( 1e10 ),
		bvhTex, bvhTexSize, triTex, triTexSize
	).toVar( 'debugHitResult' );

	const didHit = hitResult.get( 'hit' );
	const hitT = hitResult.get( 't' );
	const hitTriIndex = hitResult.get( 'triangleIndex' );

	// Mode 1: Triangle intersection count (heat map)
	If( visMode.equal( 1 ), () => {

		If( didHit, () => {

			// Visualize triangle index as color
			const idx = float( hitTriIndex );
			const r = idx.mul( 0.123 ).fract();
			const g = idx.mul( 0.456 ).fract();
			const b = idx.mul( 0.789 ).fract();
			result.assign( vec4( r, g, b, 1.0 ) );

		} ).Else( () => {

			result.assign( vec4( 0.0, 0.0, 0.0, 1.0 ) );

		} );

	} );

	// Mode 2: BVH box test count
	If( visMode.equal( 2 ), () => {

		If( didHit, () => {

			// Visualize depth as heat
			const normalizedDepth = clamp( hitT.div( 50.0 ), 0.0, 1.0 );
			result.assign( vec4( normalizedDepth, float( 1.0 ).sub( normalizedDepth ), 0.0, 1.0 ) );

		} ).Else( () => {

			result.assign( vec4( 0.0, 0.0, 0.2, 1.0 ) );

		} );

	} );

	// Mode 3: Ray distance visualization
	If( visMode.equal( 3 ), () => {

		If( didHit, () => {

			const normalizedDist = clamp( hitT.div( 100.0 ), 0.0, 1.0 );
			result.assign( vec4( vec3( normalizedDist ), 1.0 ) );

		} ).Else( () => {

			result.assign( vec4( 1.0, 0.0, 1.0, 1.0 ) ); // Magenta for miss

		} );

	} );

	// Mode 4: Surface normals (from single bounce)
	If( visMode.equal( 4 ), () => {

		const traceOutput = traceSingleBounce(
			rayOrigin, rayDir,
			bvhTex, bvhTexSize,
			triTex, triTexSize,
			matTex, matTexSize,
			envTex, envIntensity, envMatrix, hasEnv
		);
		result.assign( vec4( traceOutput.xyz.mul( 0.5 ).add( 0.5 ), 1.0 ) );

	} );

	// Mode 6: Environment luminance heat map
	If( visMode.equal( 6 ), () => {

		If( hasEnv, () => {

			// Sample environment
			const rotatedDir = envMatrix.mul( vec4( rayDir, 0.0 ) ).xyz;
			const u = float( 0.5 ).add( rotatedDir.x.atan( rotatedDir.z ).div( TWO_PI ) );
			const v = float( 0.5 ).sub( rotatedDir.y.asin().div( PI ) );
			const envColor = texture( envTex, vec2( u, v ) ).rgb;
			const lum = luminance( envColor );
			// Heat map coloring
			const r = clamp( lum.mul( 2.0 ), 0.0, 1.0 );
			const g = clamp( lum.mul( 2.0 ).sub( 0.5 ), 0.0, 1.0 );
			const b = clamp( lum.sub( 1.0 ), 0.0, 1.0 );
			result.assign( vec4( r, g, b, 1.0 ) );

		} ).Else( () => {

			result.assign( vec4( 0.1, 0.1, 0.1, 1.0 ) );

		} );

	} );

	return result;

} );

// ================================================================================
// MAIN PATH TRACER
// ================================================================================

/**
 * Main path tracer entry point
 * Complete port of GLSL main() function
 *
 * @param {vec2} resolution - Screen resolution
 * @param {uint} frame - Current frame number
 * @param {int} numRaysPerPixel - Base samples per pixel
 * @param {int} visMode - Visualization mode (0 = normal, >0 = debug)
 *
 * Camera parameters:
 * @param {mat4} cameraWorldMatrix - Camera world transformation
 * @param {mat4} cameraProjectionMatrixInverse - Inverse projection matrix
 * @param {mat4} cameraViewMatrix - Camera view matrix
 * @param {mat4} cameraProjectionMatrix - Camera projection matrix
 *
 * Scene textures:
 * @param {sampler2D} bvhTex, bvhTexSize - BVH acceleration structure
 * @param {sampler2D} triTex, triTexSize - Triangle geometry data
 * @param {sampler2D} matTex, matTexSize - Material data
 * @param {sampler2D} envTex - Environment map
 *
 * Settings:
 * @param {bool} hasEnv - Has environment map
 * @param {float} envIntensity - Environment intensity
 * @param {mat4} environmentMatrix - Environment rotation
 * @param {int} maxBounces - Maximum path bounces
 * @param {int} transmissiveBounces - Additional transmission bounces
 * @param {bool} showBackground - Show background for primary rays
 * @param {float} backgroundIntensity - Background intensity
 * @param {float} fireflyThreshold - Firefly suppression threshold
 *
 * Environment importance sampling:
 * @param {vec2} envSize - Environment map dimensions
 * @param {sampler2D} marginalCDF - Marginal CDF texture
 * @param {sampler2D} conditionalCDF - Conditional CDF texture
 * @param {float} hasImportanceSampling - Has env importance sampling data
 *
 * Accumulation:
 * @param {bool} enableAccumulation - Enable temporal accumulation
 * @param {bool} hasPreviousAccumulated - Has previous frame data
 * @param {sampler2D} prevAccumTexture - Previous accumulated frame
 * @param {float} accumulationAlpha - Accumulation blend factor
 * @param {bool} cameraIsMoving - Camera movement flag
 *
 * Adaptive sampling:
 * @param {bool} useAdaptiveSampling - Enable adaptive sampling
 * @param {sampler2D} adaptiveSamplingTexture - Adaptive sampling data
 * @param {int} adaptiveSamplingMax - Maximum adaptive samples
 *
 * @returns {pathTracerOutputStruct} MRT outputs (gColor, gNormalDepth, gAlbedo)
 */
export const pathTracerMain = ( params ) => {

	return pathTracerImpl(
		params.resolution,
		params.frame,
		params.samplesPerPixel,
		params.visMode,

		params.cameraWorldMatrix,
		params.cameraProjectionMatrixInverse,
		params.cameraViewMatrix,
		params.cameraProjectionMatrix,

		params.bvhTex,
		params.bvhTexSize,
		params.triTex,
		params.triTexSize,
		params.matTex,
		params.matTexSize,
		params.envTex,

		params.hasEnv,
		params.envIntensity,
		params.environmentMatrix,
		params.maxBounces,
		params.transmissiveBounces,
		params.showBackground,
		params.backgroundIntensity,
		params.fireflyThreshold,

		params.envSize,
		params.marginalCDF,
		params.conditionalCDF,
		params.hasImportanceSampling,

		params.enableAccumulation,
		params.hasPreviousAccumulated,
		params.prevAccumTexture,
		params.accumulationAlpha,
		params.cameraIsMoving,

		params.useAdaptiveSampling,
		params.adaptiveSamplingTexture,
		params.adaptiveSamplingMax
	);

	// uncomment simplified version for quick testing
	// return pathTracerSimple(
	// 	params.resolution,
	// 	params.frame,
	// 	params.samplesPerPixel,

	// 	params.cameraWorldMatrix,
	// 	params.cameraProjectionMatrixInverse,

	// 	params.bvhTex,
	// 	params.bvhTexSize,
	// 	params.triTex,
	// 	params.triTexSize,
	// 	params.matTex,
	// 	params.matTexSize,
	// 	params.envTex,
	// 	params.envIntensity,
	// 	params.environmentMatrix,
	// 	params.hasEnv,

	// 	params.maxBounces,
	// 	params.fireflyThreshold
	// );

};

const pathTracerImpl = Fn( ( [
	// Frame/Resolution
	resolution, frame, numRaysPerPixel, visMode,
	// Camera
	cameraWorldMatrix, cameraProjectionMatrixInverse, cameraViewMatrix, cameraProjectionMatrix,
	// Textures
	bvhTex, bvhTexSize,
	triTex, triTexSize,
	matTex, matTexSize,
	envTex,
	// Settings
	hasEnv, envIntensity, environmentMatrix,
	maxBounces, transmissiveBounces,
	showBackground, backgroundIntensity, fireflyThreshold,
	// Environment importance sampling
	envSize, marginalCDF, conditionalCDF, hasImportanceSampling,
	// Accumulation
	enableAccumulation, hasPreviousAccumulated, prevAccumTexture, accumulationAlpha, cameraIsMoving,
	// Adaptive Sampling
	useAdaptiveSampling, adaptiveSamplingTexture, adaptiveSamplingMax
] ) => {

	const pixelCoord = screenCoordinate.xy.toVar( 'pixelCoord' );

	// Screen position in NDC [-1, 1]
	// WebGPU screenCoordinate.y is 0 at top (increases downward), opposite of WebGL.
	// Flip Y so that NDC y=+1 is top and y=-1 is bottom, matching the camera projection.
	const uv = pixelCoord.div( resolution ).toVar( 'uv' );
	const screenPosition = vec2( uv.x.mul( 2.0 ).sub( 1.0 ), uv.y.mul( - 2.0 ).add( 1.0 ) ).toVar( 'screenPosition' );

	// Initialize pixel accumulator
	const pixelColor = vec4( 0.0 ).toVar( 'pixelColor' );
	const pixelSamples = int( 0 ).toVar( 'pixelSamples' );

	// Base seed for random number generation
	const baseSeed = getDecorrelatedSeed( pixelCoord, int( 0 ), frame ).toVar( 'baseSeed' );
	const pixelIndex = int( pixelCoord.y ).mul( int( resolution.x ) ).add( int( pixelCoord.x ) ).toVar( 'pixelIndex' );

	// MRT data initialized with defaults
	const worldNormal = vec3( 0.0, 0.0, 1.0 ).toVar( 'worldNormal' );
	const linearDepth = float( 1.0 ).toVar( 'linearDepth' );

	// Determine sample count
	const samplesCount = int( numRaysPerPixel ).toVar( 'samplesCount' );

	// Adaptive sampling support
	If( frame.greaterThan( uint( 2 ) ).and( useAdaptiveSampling ), () => {

		const adaptiveSamples = getRequiredSamples(
			pixelCoord, resolution,
			adaptiveSamplingTexture, adaptiveSamplingMax, numRaysPerPixel
		);
		samplesCount.assign( adaptiveSamples );

		// Handle converged pixels
		If( samplesCount.equal( 0 ), () => {

			If( enableAccumulation.and( hasPreviousAccumulated ), () => {

				// Use accumulated result for converged pixels
				const prevUV = pixelCoord.div( resolution );
				const prevColor = texture( prevAccumTexture, prevUV );
				pixelColor.assign( prevColor );
				pixelSamples.assign( 1 );

			} ).Else( () => {

				// No accumulation available, render at least 1 sample
				samplesCount.assign( 1 );

			} );

		} );

	} );

	// Edge detection variables (from first ray only)
	const objectNormal = vec3( 0.0 ).toVar( 'objectNormal' );
	const objectColor = vec3( 0.0 ).toVar( 'objectColor' );
	const objectID = float( - 1000.0 ).toVar( 'objectID' );
	const pixelSharpness = float( 0.0 ).toVar( 'pixelSharpness' );

	// Main sample loop
	Loop( { start: int( 0 ), end: samplesCount, type: 'int', condition: '<' }, ( { i: rayIndex } ) => {

		// Generate unique seed for this sample
		const seed = pcgHash( baseSeed.add( uint( rayIndex ) ) ).toVar( 'seed' );

		// Stratified jitter for anti-aliasing
		const stratifiedJitter = getStratifiedSample(
			pixelCoord, rayIndex, samplesCount, seed, resolution, frame
		).toVar( 'stratifiedJitter' );

		// Debug mode 5: Visualize stratified samples
		If( visMode.equal( 5 ), () => {

			pixelColor.assign( vec4( stratifiedJitter, 1.0, 1.0 ) );
			pixelSamples.assign( 1 );
			Break();

		} );

		// Apply jitter to screen position
		const jitter = stratifiedJitter.sub( 0.5 ).mul( vec2( 2.0 ).div( resolution ) ).toVar( 'jitter' );
		const jitteredScreenPosition = screenPosition.add( jitter ).toVar( 'jitteredScreenPosition' );

		// Generate ray from camera
		const ray = generateRayFromCamera(
			jitteredScreenPosition, cameraWorldMatrix, cameraProjectionMatrixInverse, seed
		).toVar( 'ray' );
		const rayOrigin = ray.get( 'origin' ).toVar( 'rayOrigin' );
		const rayDir = ray.get( 'direction' ).toVar( 'rayDir' );

		// Sample result
		const sampleColor = vec4( 0.0 ).toVar( 'sampleColor' );

		// Debug visualization modes
		If( visMode.greaterThan( 0 ), () => {

			sampleColor.assign( traceDebugMode(
				rayOrigin, rayDir, visMode,
				bvhTex, bvhTexSize,
				triTex, triTexSize,
				matTex, matTexSize,
				envTex, envIntensity, environmentMatrix, hasEnv
			) );

		} ).Else( () => {

			// Normal path tracing
			const traceResult = Trace(
				rayOrigin, rayDir,
				seed,
				maxBounces, transmissiveBounces,
				bvhTex, bvhTexSize,
				triTex, triTexSize,
				matTex, matTexSize,
				envTex, envIntensity, environmentMatrix, hasEnv,
				showBackground, backgroundIntensity, fireflyThreshold,
				envSize, marginalCDF, conditionalCDF, hasImportanceSampling
			).toVar( 'traceResult' );

			const radiance = traceResult.get( 'gColor' ).xyz;
			const alpha = traceResult.get( 'gColor' ).w;
			const normal = traceResult.get( 'gNormalDepth' ).xyz;
			const depth = traceResult.get( 'gNormalDepth' ).w;
			const albedo = traceResult.get( 'gAlbedo' ).xyz;
			const matIndex = traceResult.get( 'gAlbedo' ).w;

			sampleColor.assign( vec4( radiance, alpha ) );

			// Store first hit data for edge detection and MRT
			If( rayIndex.equal( 0 ), () => {

				objectNormal.assign( normal );
				objectColor.assign( albedo );
				objectID.assign( matIndex );

				// Set MRT data from first hit
				worldNormal.assign( normalize( normal ) );

				// Compute proper NDC depth from depth value
				If( depth.lessThan( 1e9 ), () => {

					// Normalize depth for output (adjust scale as needed)
					linearDepth.assign( clamp( depth.div( 100.0 ), 0.0, 1.0 ) );

				} ).Else( () => {

					// No hit (sky/background) - use far plane depth
					linearDepth.assign( 1.0 );

				} );

			} );

		} );

		// Accumulate sample
		pixelColor.addAssign( sampleColor );
		pixelSamples.addAssign( 1 );

	} );

	// Average samples
	If( pixelSamples.greaterThan( 0 ), () => {

		pixelColor.divAssign( float( pixelSamples ) );

	} );

	// Apply dithering AFTER averaging to prevent banding in 8-bit output
	pixelColor.xyz.assign( dithering( pixelColor.xyz, baseSeed ) );

	// Edge Detection for denoiser guidance
	// Depth-based edges (uses actual ray hit depth)
	const depthDifference = fwidth( linearDepth );
	const depthEdge = smoothstep( float( 0.01 ), float( 0.05 ), depthDifference );

	// Normal-based edges
	const differenceNx = fwidth( objectNormal.x );
	const differenceNy = fwidth( objectNormal.y );
	const differenceNz = fwidth( objectNormal.z );
	const normalDifference = smoothstep( float( 0.3 ), float( 0.8 ), differenceNx )
		.add( smoothstep( float( 0.3 ), float( 0.8 ), differenceNy ) )
		.add( smoothstep( float( 0.3 ), float( 0.8 ), differenceNz ) );

	// Object ID discontinuities (mesh boundaries)
	const objectDifference = min( fwidth( objectID ), 1.0 );

	// Mark pixel as edge if depth OR normal discontinuity detected
	If( depthEdge.greaterThan( 0.5 )
		.or( normalDifference.greaterThanEqual( 1.0 ) )
		.or( objectDifference.greaterThanEqual( 1.0 ) ), () => {

		pixelSharpness.assign( 1.0 );

	} );

	// Store edge sharpness in alpha for denoiser
	pixelColor.w.assign( pixelSharpness );

	// Temporal accumulation
	const finalColor = pixelColor.xyz.toVar( 'finalColor' );

	If( enableAccumulation.and( cameraIsMoving.not() ).and( frame.greaterThan( uint( 1 ) ) ).and( hasPreviousAccumulated ), () => {

		// Get previous accumulated color
		const prevUV = pixelCoord.div( resolution );
		const previousColor = texture( prevAccumTexture, prevUV ).xyz;

		// Blend with previous frame using exponential moving average
		finalColor.assign( previousColor.add( pixelColor.xyz.sub( previousColor ).mul( accumulationAlpha ) ) );

	} );

	// Output MRT
	const finalOutputColor = vec4( finalColor, 1.0 ).toVar( 'finalOutputColor' );
	const finalOutputNormalDepth = vec4( worldNormal.mul( 0.5 ).add( 0.5 ), linearDepth ).toVar( 'finalOutputNormalDepth' );
	const finalOutputAlbedo = vec4( objectColor, 1.0 ).toVar( 'finalOutputAlbedo' );

	return pathTracerOutputStruct( {
		gColor: finalOutputColor,
		gNormalDepth: finalOutputNormalDepth,
		gAlbedo: finalOutputAlbedo
	} );

} );

// ================================================================================
// SIMPLIFIED PATH TRACER (for quick testing)
// ================================================================================

/**
 * Simplified path tracer without adaptive sampling or accumulation
 * Useful for testing and debugging
 */
// export const pathTracerSimple = Fn( ( [
// 	resolution, frame, numRaysPerPixel,
// 	cameraWorldMatrix, cameraProjectionMatrixInverse,
// 	bvhTex, bvhTexSize,
// 	triTex, triTexSize,
// 	matTex, matTexSize,
// 	envTex, envIntensity, environmentMatrix, hasEnv,
// 	maxBounces, fireflyThreshold
// ] ) => {

// 	const pixelCoord = screenCoordinate.xy.toVar( 'pixelCoord' );

// 	const screenPosition = pixelCoord.div( resolution ).mul( 2.0 ).sub( 1.0 ).toVar( 'screenPosition' );
// 	const baseSeed = getDecorrelatedSeed( pixelCoord, int( 0 ), frame ).toVar( 'baseSeed' );

// 	// Generate ray
// 	const ray = generateRayFromCamera(
// 		screenPosition, cameraWorldMatrix, cameraProjectionMatrixInverse, baseSeed
// 	).toVar( 'ray' );

// 	// Single bounce trace for simplicity
// 	const traceOutput = traceSingleBounce(
// 		ray.get( 'origin' ), ray.get( 'direction' ),
// 		bvhTex, bvhTexSize,
// 		triTex, triTexSize,
// 		matTex, matTexSize,
// 		envTex, envIntensity, environmentMatrix, hasEnv
// 	).toVar( 'traceOutput' );

// 	const outColor = vec4( traceOutput.xyz, 1.0 );
// 	const outNormalDepth = vec4( 0.5, 0.5, 1.0, traceOutput.w.div( 100.0 ) );
// 	const outAlbedo = vec4( traceOutput.xyz, 1.0 );

// 	return pathTracerOutputStruct( {
// 		gColor: outColor,
// 		gNormalDepth: outNormalDepth,
// 		gAlbedo: outAlbedo
// 	} );

// } );

// ================================================================================
// EXPORTS
// ================================================================================

export {
	Pixel,
	Ray,
	DirectionSample,
	MaterialClassification,
	BRDFWeights,
	MaterialCache,
	PathState,
	pathTracerOutputStruct
};
