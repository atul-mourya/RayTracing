// ReSTIR GI Stage — Reservoir-based Spatiotemporal Importance Resampling for Global Illumination
// Compute-based pipeline stage running 3 passes:
//   Pass 1: Initial BRDF ray + secondary shading + temporal reuse → ReservoirA
//   Pass 2: Spatial reuse → ReservoirB
//   Pass 3: Final shading (visibility + Lambertian) → output color

import { uniform } from 'three/tsl';
import { StorageTexture, TextureNode } from 'three/webgpu';
import { FloatType, HalfFloatType, RGBAFormat, NearestFilter, LinearFilter } from 'three';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';
import {
	buildGIInitialAndTemporalCompute,
	buildGISpatialReuseCompute,
	buildGIFinalShadingCompute,
} from '../TSL/ReSTIRGI.js';

export class ReSTIRGIStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'ReSTIRGI', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE,
		} );

		this.renderer = renderer;
		this.pathTracingStage = options.pathTracingStage || null;

		// ─── Uniforms ───
		this.resW = uniform( 1 );
		this.resH = uniform( 1 );
		this.frameCount = uniform( 0, 'int' );
		this.spatialRadius = uniform( options.spatialRadius ?? 30.0 );
		this.spatialNeighbors = uniform( options.spatialNeighbors ?? 3, 'int' );
		this.normalThreshold = uniform( 0.906 ); // cos(25°)
		this.depthThreshold = uniform( 0.1 );
		this.debugMode = uniform( 0, 'int' ); // 0=combined, 1=GI only, 2=radiance, 3=weight

		// ─── Input TextureNodes (from pipeline context) ───
		this._normalDepthTexNode = new TextureNode();
		this._albedoTexNode = new TextureNode();
		this._motionTexNode = new TextureNode();
		this._pathTracerTexNode = new TextureNode();

		// Read-side TextureNode wrappers for StorageTextures
		this._readPrevSampleTexNode = new TextureNode();
		this._readPrevRadianceTexNode = new TextureNode();
		this._readPrevWeightTexNode = new TextureNode();
		this._readASampleTexNode = new TextureNode();
		this._readARadianceTexNode = new TextureNode();
		this._readAWeightTexNode = new TextureNode();
		this._readBSampleTexNode = new TextureNode();
		this._readBRadianceTexNode = new TextureNode();
		this._readBWeightTexNode = new TextureNode();

		// ─── StorageTextures ───
		const w = 1, h = 1;

		// ReservoirA (intermediate: written by Pass 1, read by Pass 2)
		this._reservoirASampleTex = this._createStorageTex( w, h, FloatType );
		this._reservoirARadianceTex = this._createStorageTex( w, h, HalfFloatType );
		this._reservoirAWeightTex = this._createStorageTex( w, h, HalfFloatType );

		// ReservoirB (final + temporal prev: written by Pass 2, read by Pass 1 next frame)
		this._reservoirBSampleTex = this._createStorageTex( w, h, FloatType );
		this._reservoirBRadianceTex = this._createStorageTex( w, h, HalfFloatType );
		this._reservoirBWeightTex = this._createStorageTex( w, h, HalfFloatType );

		// Output color
		this._outputTex = this._createStorageTex( w, h, HalfFloatType, LinearFilter );

		// ─── State ───
		this._compiled = false;
		this._frameIndex = 0;
		this._dispatchX = 1;
		this._dispatchY = 1;

		this._pass1Node = null;
		this._pass2Node = null;
		this._pass3Node = null;

	}

	// ──────────────────────────────────────────────────
	// Lifecycle
	// ──────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'pipeline:reset', () => this._resetReservoirs() );
		this.on( 'camera:moved', () => this._resetReservoirs() );

	}

	render( context ) {

		if ( ! this.enabled ) {

			context.removeTexture( 'restirGI:output' );
			return;

		}

		if ( ! this._ensureCompiled() ) return;

		// Auto-resize
		const colorTex = context.getTexture( 'pathtracer:color' );
		if ( colorTex?.image ) {

			const img = colorTex.image;
			if ( img.width !== this._reservoirASampleTex.image.width ||
				img.height !== this._reservoirASampleTex.image.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// Update input textures from context
		const normalDepthTex = context.getTexture( 'pathtracer:normalDepth' );
		const albedoTex = context.getTexture( 'pathtracer:albedo' );
		const motionTex = context.getTexture( 'motionVector:screenSpace' );

		if ( ! normalDepthTex ) return;

		this._normalDepthTexNode.value = normalDepthTex;
		if ( albedoTex ) this._albedoTexNode.value = albedoTex;
		if ( motionTex ) this._motionTexNode.value = motionTex;
		if ( colorTex ) this._pathTracerTexNode.value = colorTex;

		this.frameCount.value = this._frameIndex;

		// Force-compile on first render AFTER TextureNode values are set.
		// Matches ASVGFStage pattern: compile with real texture bindings
		// so the WebGPU backend generates distinct bind group entries.
		if ( ! this._compiled ) {

			this.renderer.compute( this._pass1Node );
			this.renderer.compute( this._pass2Node );
			this.renderer.compute( this._pass3Node );
			this._compiled = true;
			this.log( 'Compute shaders compiled' );

		}

		// ─── Pass 1: Initial Sample + Temporal Reuse ───
		this._readPrevSampleTexNode.value = this._reservoirBSampleTex;
		this._readPrevRadianceTexNode.value = this._reservoirBRadianceTex;
		this._readPrevWeightTexNode.value = this._reservoirBWeightTex;

		this.renderer.compute( this._pass1Node );

		// ─── Pass 2: Spatial Reuse ───
		this._readASampleTexNode.value = this._reservoirASampleTex;
		this._readARadianceTexNode.value = this._reservoirARadianceTex;
		this._readAWeightTexNode.value = this._reservoirAWeightTex;

		this.renderer.compute( this._pass2Node );

		// ─── Pass 3: Final Shading ───
		this._readBSampleTexNode.value = this._reservoirBSampleTex;
		this._readBRadianceTexNode.value = this._reservoirBRadianceTex;
		this._readBWeightTexNode.value = this._reservoirBWeightTex;

		this.renderer.compute( this._pass3Node );

		if ( this.debugMode.value === 0 ) {

			// Combined mode: overwrite pathtracer:color so ASVGF denoises the combined result
			context.setTexture( 'pathtracer:color', this._outputTex );
			context.removeTexture( 'restirGI:output' );

		} else {

			// Debug mode: bypass denoiser, show raw debug output
			context.setTexture( 'restirGI:output', this._outputTex );

		}

		this._frameIndex ++;

	}

	reset() {

		this._resetReservoirs();

	}

	setSize( width, height ) {

		if ( width < 1 || height < 1 ) return;

		this._reservoirASampleTex.setSize( width, height );
		this._reservoirARadianceTex.setSize( width, height );
		this._reservoirAWeightTex.setSize( width, height );
		this._reservoirBSampleTex.setSize( width, height );
		this._reservoirBRadianceTex.setSize( width, height );
		this._reservoirBWeightTex.setSize( width, height );
		this._outputTex.setSize( width, height );

		this.resW.value = width;
		this.resH.value = height;

		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );

		if ( this._pass1Node ) this._pass1Node.setCount( [ this._dispatchX, this._dispatchY, 1 ] );
		if ( this._pass2Node ) this._pass2Node.setCount( [ this._dispatchX, this._dispatchY, 1 ] );
		if ( this._pass3Node ) this._pass3Node.setCount( [ this._dispatchX, this._dispatchY, 1 ] );

		this._resetReservoirs();

	}

	dispose() {

		this._reservoirASampleTex.dispose();
		this._reservoirARadianceTex.dispose();
		this._reservoirAWeightTex.dispose();
		this._reservoirBSampleTex.dispose();
		this._reservoirBRadianceTex.dispose();
		this._reservoirBWeightTex.dispose();
		this._outputTex.dispose();

	}

	// ──────────────────────────────────────────────────
	// Private
	// ──────────────────────────────────────────────────

	_createStorageTex( w, h, type, filter = NearestFilter ) {

		const tex = new StorageTexture( w, h );
		tex.type = type;
		tex.format = RGBAFormat;
		tex.minFilter = filter;
		tex.magFilter = filter;
		return tex;

	}

	_resetReservoirs() {

		this._frameIndex = 0;

	}

	/**
	 * Lazy compilation: build compute nodes once PathTracingStage has valid buffer data.
	 * Returns true if ready (compute nodes built, and either compiled or ready to compile).
	 */
	_ensureCompiled() {

		if ( this._compiled ) return true;

		const pt = this.pathTracingStage;
		if ( ! pt ) return false;

		if ( ! pt.bvhStorageNode || ! pt.triangleStorageNode || ! pt.materialStorageNode ) {

			return false;

		}

		if ( ! this._pass1Node ) {

			// Pre-assign read-side TextureNodes to actual StorageTextures BEFORE
			// building compute nodes — gives each node a unique texture reference
			// so the WebGPU backend generates distinct bindings (not deduplicated).
			this._readPrevSampleTexNode.value = this._reservoirBSampleTex;
			this._readPrevRadianceTexNode.value = this._reservoirBRadianceTex;
			this._readPrevWeightTexNode.value = this._reservoirBWeightTex;
			this._readASampleTexNode.value = this._reservoirASampleTex;
			this._readARadianceTexNode.value = this._reservoirARadianceTex;
			this._readAWeightTexNode.value = this._reservoirAWeightTex;
			this._readBSampleTexNode.value = this._reservoirBSampleTex;
			this._readBRadianceTexNode.value = this._reservoirBRadianceTex;
			this._readBWeightTexNode.value = this._reservoirBWeightTex;

			this._buildComputeNodes();

		}

		// Warm-up compile is deferred to render() — needs input TextureNode
		// values (normalDepth, albedo, etc.) from the pipeline context first.
		// See the ASVGF pattern: compile AFTER setting TextureNode values.
		return true;

	}

	_buildComputeNodes() {

		const pt = this.pathTracingStage;

		// ─── Pass 1: Initial Sample + Temporal ───
		const pass1Fn = buildGIInitialAndTemporalCompute( {
			normalDepthTexNode: this._normalDepthTexNode,
			motionTexNode: this._motionTexNode,
			prevSampleTexNode: this._readPrevSampleTexNode,
			prevRadianceTexNode: this._readPrevRadianceTexNode,
			prevWeightTexNode: this._readPrevWeightTexNode,
			reservoirASampleTex: this._reservoirASampleTex,
			reservoirARadianceTex: this._reservoirARadianceTex,
			reservoirAWeightTex: this._reservoirAWeightTex,
			bvhBuffer: pt.bvhStorageNode,
			triangleBuffer: pt.triangleStorageNode,
			materialBuffer: pt.materialStorageNode,
			emissiveTriBuffer: pt.emissiveTriangleStorageNode,
			emissiveTriCount: pt.emissiveTriangleCount,
			emissivePower: pt.emissiveTotalPower,
			dirLightsBuffer: pt.directionalLightsBufferNode,
			numDirLights: pt.numDirectionalLights,
			areaLightsBuffer: pt.areaLightsBufferNode,
			numAreaLights: pt.numAreaLights,
			pointLightsBuffer: pt.pointLightsBufferNode,
			numPointLights: pt.numPointLights,
			spotLightsBuffer: pt.spotLightsBufferNode,
			numSpotLights: pt.numSpotLights,
			cameraWorldMatrix: pt.cameraWorldMatrix,
			cameraProjInverse: pt.cameraProjectionMatrixInverse,
			resW: this.resW,
			resH: this.resH,
			frameCount: this.frameCount,
		} );

		this._pass1Node = pass1Fn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ 8, 8, 1 ]
		);

		// ─── Pass 2: Spatial Reuse ───
		const pass2Fn = buildGISpatialReuseCompute( {
			normalDepthTexNode: this._normalDepthTexNode,
			readSampleTexNode: this._readASampleTexNode,
			readRadianceTexNode: this._readARadianceTexNode,
			readWeightTexNode: this._readAWeightTexNode,
			reservoirBSampleTex: this._reservoirBSampleTex,
			reservoirBRadianceTex: this._reservoirBRadianceTex,
			reservoirBWeightTex: this._reservoirBWeightTex,
			cameraWorldMatrix: pt.cameraWorldMatrix,
			cameraProjInverse: pt.cameraProjectionMatrixInverse,
			resW: this.resW,
			resH: this.resH,
			frameCount: this.frameCount,
			spatialRadius: this.spatialRadius,
			spatialNeighbors: this.spatialNeighbors,
			normalThreshold: this.normalThreshold,
			depthThreshold: this.depthThreshold,
		} );

		this._pass2Node = pass2Fn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ 8, 8, 1 ]
		);

		// ─── Pass 3: Final Shading ───
		const pass3Fn = buildGIFinalShadingCompute( {
			normalDepthTexNode: this._normalDepthTexNode,
			albedoTexNode: this._albedoTexNode,
			pathTracerTexNode: this._pathTracerTexNode,
			finalSampleTexNode: this._readBSampleTexNode,
			finalRadianceTexNode: this._readBRadianceTexNode,
			finalWeightTexNode: this._readBWeightTexNode,
			outputTex: this._outputTex,
			bvhBuffer: pt.bvhStorageNode,
			triangleBuffer: pt.triangleStorageNode,
			materialBuffer: pt.materialStorageNode,
			cameraWorldMatrix: pt.cameraWorldMatrix,
			cameraProjInverse: pt.cameraProjectionMatrixInverse,
			resW: this.resW,
			resH: this.resH,
			frameCount: this.frameCount,
			debugMode: this.debugMode,
		} );

		this._pass3Node = pass3Fn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ 8, 8, 1 ]
		);

	}

}
