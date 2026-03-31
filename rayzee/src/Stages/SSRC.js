// Screen-Space Radiance Cache (SSRC) Stage
//
// Two compute passes per frame:
//   Pass 1 (Temporal): Reproject previous cache via motion vectors + EMA blend
//   Pass 2 (Spatial):  8-tap neighbor reuse weighted by normal/depth similarity
//
// Execution: PER_CYCLE
//
// Events listened: pipeline:reset, camera:moved
//
// Textures published:  ssrc:output
// Textures read:       pathtracer:color, pathtracer:normalDepth, motionVector:screenSpace

import { uniform } from 'three/tsl';
import { StorageTexture, TextureNode } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, LinearFilter } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { buildTemporalPass, buildSpatialPass } from '../TSL/SSRC.js';

export class SSRC extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'SSRC', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE,
		} );

		this.renderer = renderer;

		// ─── Uniforms ───
		this.resW = uniform( 1 );
		this.resH = uniform( 1 );
		this.temporalAlpha = uniform( options.temporalAlpha ?? 0.1 );
		this.phiNormal = uniform( options.phiNormal ?? 128.0 );
		this.phiDepth = uniform( options.phiDepth ?? 0.5 );
		this.maxHistory = uniform( options.maxHistory ?? 128.0 );
		this.spatialRadius = uniform( options.spatialRadius ?? 4, 'int' );
		this.spatialWeight = uniform( options.spatialWeight ?? 0.4 );
		// 0 on reset → temporal pass skips cache; incremented each render frame
		this._framesSinceReset = uniform( 0, 'int' );

		// ─── Input TextureNodes (set from pipeline context each frame) ───
		this._colorTexNode = new TextureNode();
		this._ndTexNode = new TextureNode();
		this._motionTexNode = new TextureNode();

		// ─── Read-side wrappers for ping-pong StorageTextures ───
		this._readCacheTexNode = new TextureNode(); // prev cache (for temporal pass)
		this._readPrevNDTexNode = new TextureNode(); // prev normalDepth (for edge-stopping)
		this._readPass1CacheTexNode = new TextureNode(); // current cache (for spatial pass)

		// ─── StorageTextures (5 total) ───
		const w = 1, h = 1; // resized on first render

		// Ping-pong temporal cache: .rgb = radiance, .w = history count
		this._cacheTexA = this._createStorageTex( w, h, NearestFilter );
		this._cacheTexB = this._createStorageTex( w, h, NearestFilter );

		// Ping-pong previous-frame normalDepth (for edge-stopping in temporal pass)
		this._prevNDTexA = this._createStorageTex( w, h, NearestFilter );
		this._prevNDTexB = this._createStorageTex( w, h, NearestFilter );

		// Final output (LinearFilter for Display fragment shader sampling)
		this._outputTex = this._createStorageTex( w, h, LinearFilter );

		// ─── State ───
		this._currentPingPong = 0; // 0: read B, write A; 1: read A, write B
		this._dispatchX = 1;
		this._dispatchY = 1;

		// ─── Compute nodes ───
		this._buildComputeNodes();

	}

	// ──────────────────────────────────────────────────
	// Lifecycle
	// ──────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'pipeline:reset', () => this._resetCache() );
		this.on( 'camera:moved', () => this._resetCache() );

	}

	render( context ) {

		if ( ! this.enabled ) {

			context.removeTexture( 'ssrc:output' );
			return;

		}

		// Auto-resize if render resolution changed
		const colorTex = context.getTexture( 'pathtracer:color' );
		if ( colorTex?.image ) {

			const { width, height } = colorTex.image;
			if ( width !== this._cacheTexA.image.width || height !== this._cacheTexA.image.height ) {

				this.setSize( width, height );

			}

		}

		// Bind current-frame inputs from context
		const normalDepthTex = context.getTexture( 'pathtracer:normalDepth' );
		if ( ! normalDepthTex || ! colorTex ) return;

		this._colorTexNode.value = colorTex;
		this._ndTexNode.value = normalDepthTex;

		const motionTex = context.getTexture( 'motionVector:screenSpace' );
		if ( motionTex ) this._motionTexNode.value = motionTex;

		// ─── Ping-pong assignment ───
		// _currentPingPong 0: pass1 reads B, writes A; pass2 reads A
		// _currentPingPong 1: pass1 reads A, writes B; pass2 reads B
		const [ readCache, writeCache, readPrevND ] =
			this._currentPingPong === 0
				? [ this._cacheTexB, this._cacheTexA, this._prevNDTexB ]
				: [ this._cacheTexA, this._cacheTexB, this._prevNDTexA ];

		// ─── Pass 1: Temporal ───
		this._readCacheTexNode.value = readCache;
		this._readPrevNDTexNode.value = readPrevND;

		// patch the write-side storages by recreating nodes is NOT needed — the pass was built
		// with the actual StorageTexture references (not TextureNode wrappers), so we swap them
		// via the ping-pong writeCacheTex / writePrevNDTex references in the closure.
		// Since TSL captures StorageTexture directly for writes, we must rebuild or use a flag.
		// Instead we use the swappable-write pattern: build two pass1 nodes (one per write target).
		this.renderer.compute( this._currentPingPong === 0 ? this._pass1NodeA : this._pass1NodeB );

		// ─── Pass 2: Spatial ───
		// Spatial pass reads the just-written cache from pass 1
		this._readPass1CacheTexNode.value = writeCache;

		this.renderer.compute( this._pass2Node );

		// Advance frames-since-reset counter (capped to avoid overflow)
		this._framesSinceReset.value = Math.min( this._framesSinceReset.value + 1, 9999 );

		// Publish final output
		context.setTexture( 'ssrc:output', this._outputTex );

		// Advance ping-pong
		this._currentPingPong = 1 - this._currentPingPong;

	}

	reset() {

		this._resetCache();

	}

	setSize( width, height ) {

		if ( width < 1 || height < 1 ) return;

		this._cacheTexA.setSize( width, height );
		this._cacheTexB.setSize( width, height );
		this._prevNDTexA.setSize( width, height );
		this._prevNDTexB.setSize( width, height );
		this._outputTex.setSize( width, height );

		this.resW.value = width;
		this.resH.value = height;

		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );

		const count = [ this._dispatchX, this._dispatchY, 1 ];
		if ( this._pass1NodeA ) this._pass1NodeA.setCount( count );
		if ( this._pass1NodeB ) this._pass1NodeB.setCount( count );
		if ( this._pass2Node ) this._pass2Node.setCount( count );

		this._resetCache();

	}

	dispose() {

		this._pass1NodeA?.dispose();
		this._pass1NodeB?.dispose();
		this._pass2Node?.dispose();
		this._cacheTexA.dispose();
		this._cacheTexB.dispose();
		this._prevNDTexA.dispose();
		this._prevNDTexB.dispose();
		this._outputTex.dispose();

	}

	updateParameters( params ) {

		if ( params.temporalAlpha !== undefined ) this.temporalAlpha.value = params.temporalAlpha;
		if ( params.phiNormal !== undefined ) this.phiNormal.value = params.phiNormal;
		if ( params.phiDepth !== undefined ) this.phiDepth.value = params.phiDepth;
		if ( params.maxHistory !== undefined ) this.maxHistory.value = params.maxHistory;
		if ( params.spatialRadius !== undefined ) this.spatialRadius.value = params.spatialRadius;
		if ( params.spatialWeight !== undefined ) this.spatialWeight.value = params.spatialWeight;

	}

	// ──────────────────────────────────────────────────
	// Private
	// ──────────────────────────────────────────────────

	_createStorageTex( w, h, filter ) {

		const tex = new StorageTexture( w, h );
		tex.type = HalfFloatType;
		tex.format = RGBAFormat;
		tex.minFilter = filter;
		tex.magFilter = filter;
		return tex;

	}

	_resetCache() {

		this._currentPingPong = 0;
		this._framesSinceReset.value = 0;

	}

	_buildComputeNodes() {

		const commonArgs = {
			colorTexNode: this._colorTexNode,
			ndTexNode: this._ndTexNode,
			motionTexNode: this._motionTexNode,
			readCacheTexNode: this._readCacheTexNode,
			readPrevNDTexNode: this._readPrevNDTexNode,
			resW: this.resW,
			resH: this.resH,
			temporalAlpha: this.temporalAlpha,
			phiNormal: this.phiNormal,
			phiDepth: this.phiDepth,
			maxHistory: this.maxHistory,
		};

		// Build two temporal nodes — one writing to cacheTexA, one to cacheTexB.
		// This is required because StorageTexture write targets are fixed at compile time.
		const pass1FnA = buildTemporalPass( {
			...commonArgs,
			writeCacheTex: this._cacheTexA,
			writePrevNDTex: this._prevNDTexA,
			framesSinceReset: this._framesSinceReset,
		} );

		const pass1FnB = buildTemporalPass( {
			...commonArgs,
			writeCacheTex: this._cacheTexB,
			writePrevNDTex: this._prevNDTexB,
			framesSinceReset: this._framesSinceReset,
		} );

		const dispatchCount = [ this._dispatchX, this._dispatchY, 1 ];
		const wgSize = [ 8, 8, 1 ];

		this._pass1NodeA = pass1FnA().compute( dispatchCount, wgSize );
		this._pass1NodeB = pass1FnB().compute( dispatchCount, wgSize );

		// Spatial pass: reads from _readPass1CacheTexNode (assigned per-frame to the just-written cache)
		const pass2Fn = buildSpatialPass( {
			colorTexNode: this._colorTexNode,
			ndTexNode: this._ndTexNode,
			readCacheTexNode: this._readPass1CacheTexNode,
			outputTex: this._outputTex,
			resW: this.resW,
			resH: this.resH,
			spatialRadius: this.spatialRadius,
			spatialWeight: this.spatialWeight,
			phiNormal: this.phiNormal,
			phiDepth: this.phiDepth,
		} );

		this._pass2Node = pass2Fn().compute( dispatchCount, wgSize );

	}

}
