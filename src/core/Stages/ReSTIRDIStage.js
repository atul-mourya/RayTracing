// ReSTIR DI Stage — Reservoir-based Spatiotemporal Importance Resampling for Direct Illumination
// Compute-based pipeline stage running 3 passes:
//   Pass 1: Candidate generation + temporal reuse → ReservoirA
//   Pass 2: Spatial reuse → ReservoirB
//   Pass 3: Final shading (shadow ray + Lambertian) → output color

import { uniform } from 'three/tsl';
import { StorageTexture, TextureNode } from 'three/webgpu';
import { FloatType, HalfFloatType, RGBAFormat, NearestFilter, LinearFilter } from 'three';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';
import {
	buildCandidateGenAndTemporalCompute,
	buildSpatialReuseCompute,
	buildFinalShadingCompute,
} from '../TSL/ReSTIRDI.js';

export class ReSTIRDIStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'ReSTIRDI', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE,
		} );

		this.renderer = renderer;
		this.pathTracingStage = options.pathTracingStage || null;

		// ─── Uniforms ───
		this.resW = uniform( 1 );
		this.resH = uniform( 1 );
		this.frameCount = uniform( 0, 'int' );
		this.numCandidates = uniform( options.numCandidates ?? 32, 'int' );
		this.spatialRadius = uniform( options.spatialRadius ?? 30.0 );
		this.spatialNeighbors = uniform( options.spatialNeighbors ?? 5, 'int' );
		this.normalThreshold = uniform( 0.906 ); // cos(25°)
		this.depthThreshold = uniform( 0.1 );

		// ─── Input TextureNodes (from pipeline context, assigned at render time) ───
		this._normalDepthTexNode = new TextureNode();
		this._albedoTexNode = new TextureNode();
		this._motionTexNode = new TextureNode();

		// Read-side TextureNode wrappers for StorageTextures (ping-pong reads)
		this._readPrevSampleTexNode = new TextureNode(); // reads ReservoirB sample (prev frame)
		this._readPrevWeightTexNode = new TextureNode(); // reads ReservoirB weight (prev frame)
		this._readASampleTexNode = new TextureNode(); // reads ReservoirA sample (for spatial)
		this._readAWeightTexNode = new TextureNode(); // reads ReservoirA weight (for spatial)
		this._readBSampleTexNode = new TextureNode(); // reads ReservoirB sample (for shading)
		this._readBWeightTexNode = new TextureNode(); // reads ReservoirB weight (for shading)

		// ─── StorageTextures ───
		const w = 1, h = 1; // Resized on first render

		// ReservoirA (intermediate: written by Pass 1, read by Pass 2)
		this._reservoirASampleTex = this._createStorageTex( w, h, FloatType );
		this._reservoirAWeightTex = this._createStorageTex( w, h, HalfFloatType );

		// ReservoirB (final output + temporal prev: written by Pass 2, read by Pass 1 next frame)
		this._reservoirBSampleTex = this._createStorageTex( w, h, FloatType );
		this._reservoirBWeightTex = this._createStorageTex( w, h, HalfFloatType );

		// Output color (written by Pass 3)
		this._outputTex = this._createStorageTex( w, h, HalfFloatType, LinearFilter );

		// ─── State ───
		this._compiled = false;
		this._frameIndex = 0;
		this._dispatchX = 1;
		this._dispatchY = 1;

		// Compute nodes (built lazily after scene data loads)
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

			context.removeTexture( 'restirDI:output' );
			return;

		}

		// Lazy compile: wait for scene data
		if ( ! this._ensureCompiled() ) return;

		// Auto-resize if needed
		const colorTex = context.getTexture( 'pathtracer:color' );
		if ( colorTex?.image ) {

			const img = colorTex.image;
			if ( img.width !== this._reservoirASampleTex.image.width ||
				img.height !== this._reservoirASampleTex.image.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// Update input texture nodes from context
		const normalDepthTex = context.getTexture( 'pathtracer:normalDepth' );
		const albedoTex = context.getTexture( 'pathtracer:albedo' );
		const motionTex = context.getTexture( 'motionVector:screenSpace' );

		if ( ! normalDepthTex ) return;

		this._normalDepthTexNode.value = normalDepthTex;
		if ( albedoTex ) this._albedoTexNode.value = albedoTex;
		if ( motionTex ) this._motionTexNode.value = motionTex;

		// Update frame counter
		this.frameCount.value = this._frameIndex;

		// ─── Pass 1: Candidate Generation + Temporal Reuse ───
		// Read previous frame's ReservoirB
		this._readPrevSampleTexNode.value = this._reservoirBSampleTex;
		this._readPrevWeightTexNode.value = this._reservoirBWeightTex;

		this.renderer.compute( this._pass1Node );

		// ─── Pass 2: Spatial Reuse ───
		// Read current frame's ReservoirA
		this._readASampleTexNode.value = this._reservoirASampleTex;
		this._readAWeightTexNode.value = this._reservoirAWeightTex;

		this.renderer.compute( this._pass2Node );

		// ─── Pass 3: Final Shading ───
		// Read final ReservoirB (spatial output)
		this._readBSampleTexNode.value = this._reservoirBSampleTex;
		this._readBWeightTexNode.value = this._reservoirBWeightTex;

		this.renderer.compute( this._pass3Node );

		// Publish output
		context.setTexture( 'restirDI:output', this._outputTex );

		this._frameIndex ++;

	}

	reset() {

		this._resetReservoirs();

	}

	setSize( width, height ) {

		if ( width < 1 || height < 1 ) return;

		this._reservoirASampleTex.setSize( width, height );
		this._reservoirAWeightTex.setSize( width, height );
		this._reservoirBSampleTex.setSize( width, height );
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
		this._reservoirAWeightTex.dispose();
		this._reservoirBSampleTex.dispose();
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
	 * Returns true if compiled and ready.
	 */
	_ensureCompiled() {

		if ( this._compiled ) return true;

		const pt = this.pathTracingStage;
		if ( ! pt ) return false;

		// Wait for scene data to load (storage nodes are null until then)
		if ( ! pt.bvhStorageNode || ! pt.triangleStorageNode || ! pt.materialStorageNode ) {

			return false;

		}

		this._buildComputeNodes();
		this._compiled = true;

		this.log( 'Compute shaders compiled' );
		return true;

	}

	_buildComputeNodes() {

		const pt = this.pathTracingStage;

		// ─── Pass 1: Candidate Gen + Temporal ───
		const pass1Fn = buildCandidateGenAndTemporalCompute( {
			normalDepthTexNode: this._normalDepthTexNode,
			motionTexNode: this._motionTexNode,
			prevSampleTexNode: this._readPrevSampleTexNode,
			prevWeightTexNode: this._readPrevWeightTexNode,
			reservoirASampleTex: this._reservoirASampleTex,
			reservoirAWeightTex: this._reservoirAWeightTex,
			emissiveTriBuffer: pt.emissiveTriangleStorageNode,
			emissiveTriCount: pt.emissiveTriangleCount,
			emissivePower: pt.emissiveTotalPower,
			triangleBuffer: pt.triangleStorageNode,
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
			numCandidates: this.numCandidates,
		} );

		this._pass1Node = pass1Fn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ 8, 8, 1 ]
		);

		// ─── Pass 2: Spatial Reuse ───
		const pass2Fn = buildSpatialReuseCompute( {
			normalDepthTexNode: this._normalDepthTexNode,
			readSampleTexNode: this._readASampleTexNode,
			readWeightTexNode: this._readAWeightTexNode,
			reservoirBSampleTex: this._reservoirBSampleTex,
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
		const pass3Fn = buildFinalShadingCompute( {
			normalDepthTexNode: this._normalDepthTexNode,
			albedoTexNode: this._albedoTexNode,
			finalSampleTexNode: this._readBSampleTexNode,
			finalWeightTexNode: this._readBWeightTexNode,
			outputTex: this._outputTex,
			bvhBuffer: pt.bvhStorageNode,
			triangleBuffer: pt.triangleStorageNode,
			materialBuffer: pt.materialStorageNode,
			emissiveTriBuffer: pt.emissiveTriangleStorageNode,
			dirLightsBuffer: pt.directionalLightsBufferNode,
			areaLightsBuffer: pt.areaLightsBufferNode,
			pointLightsBuffer: pt.pointLightsBufferNode,
			spotLightsBuffer: pt.spotLightsBufferNode,
			cameraWorldMatrix: pt.cameraWorldMatrix,
			cameraProjInverse: pt.cameraProjectionMatrixInverse,
			resW: this.resW,
			resH: this.resH,
			frameCount: this.frameCount,
		} );

		this._pass3Node = pass3Fn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ 8, 8, 1 ]
		);

	}

}
