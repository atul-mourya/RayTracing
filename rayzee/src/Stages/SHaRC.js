// Spatially Hashed Radiance Cache (SHaRC) — Pipeline Stage
//
// Owns 3 atomic u32 storage buffers — keyLo, keyHi, and a packed cellData. The
// path tracer reads/writes these via shared TSL storage-node references built
// in ShaderBuilder. accum+resolved share a single cellData buffer to stay
// under WebGPU's 8-bindings-per-stage limit.
//
// Per-cell `_cellData` layout (8× u32 per cell):
//   [0..2]  accum R,G,B (fixed-point, atomicAdd by path tracer Update)
//   [3]     accum sampleNum (atomicAdd by path tracer Update)
//   [4..6]  resolved R,G,B (running mean, written by Resolve pass)
//   [7]     resolved packed metadata (accumFrameNum:16 | staleFrameNum:16)
//
// Resolve pass: one thread per cell. Reads accumulator from the previous
// path-tracer frame, blends with resolved history, decays staleFrameNum, evicts
// cells that have gone unsampled too long. Throttled by `resolveStride`.
//
// Execution: ALWAYS (cheap; ~0.5 ms at 1M cells).
//
// Events listened:
//   pipeline:reset    — clear all buffers next render
//   camera:moved      — clear all buffers next render (cache is camera-relative
//                       in level computation; LOD discontinuities at camera cuts
//                       would otherwise leave stale entries in mismatched levels)

import {
	Fn,
	uint,
	uniform,
	atomicStore,
	workgroupId,
	localId,
	attributeArray,
} from 'three/tsl';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import {
	SHARC_STALE_FRAME_NUM_MAX,
	buildResolveCellBody,
} from '../TSL/SHaRC.js';

const RESOLVE_WG_SIZE = 256;

export class SHaRC extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'SHaRC', {
			...options,
			executionMode: StageExecutionMode.ALWAYS,
		} );

		this.renderer = renderer;

		// Capacity must be a multiple of RESOLVE_WG_SIZE for clean dispatch.
		this._capacity = ( options.capacity ?? ( 1 << 20 ) ) >>> 0;
		if ( ( this._capacity % RESOLVE_WG_SIZE ) !== 0 ) {

			this._capacity = Math.ceil( this._capacity / RESOLVE_WG_SIZE ) * RESOLVE_WG_SIZE;

		}

		this.staleFrameNumMax = uniform( options.staleFrameNumMax ?? SHARC_STALE_FRAME_NUM_MAX, 'uint' );

		// Resolve dispatch frequency. 1 = every frame; 4 = every 4th frame.
		// Atomic accumulation handles multi-frame batching naturally — the
		// running mean math stays correct because accumN reflects however many
		// samples landed since the last resolve. Skipped frames just leave the
		// resolved buffer one frame stale (cells appear to lag slightly behind
		// the actual cache state). Saves the per-frame resolve dispatch cost.
		this.resolveStride = Math.max( 1, options.resolveStride ?? 1 );
		this._resolveFrameCounter = 0;

		// ─── Atomic storage buffers ─────────────────────────────────────────
		// keyLo / keyHi: one u32 per cell. Empty sentinel = (0, 0).
		// cellData: 8 u32 per cell, interleaved [accumR, accumG, accumB, accumN,
		//   resolvedR, resolvedG, resolvedB, resolvedMeta].
		this._hashKeyLo = attributeArray( this._capacity, 'uint' ).toAtomic();
		this._hashKeyHi = attributeArray( this._capacity, 'uint' ).toAtomic();
		this._cellData = attributeArray( this._capacity * 8, 'uint' ).toAtomic();

		// First render zeros buffers (allocator may not).
		this._needsClear = true;

		// ─── Compute nodes ────────────────────────────────────────────────────
		this._buildClearCompute();
		this._buildResolveCompute();

	}

	setupEventListeners() {

		this.on( 'pipeline:reset', () => {

			this._needsClear = true;

		} );
		this.on( 'camera:moved', () => {

			this._needsClear = true;

		} );

	}

	render() {

		if ( ! this.enabled ) return;

		if ( this._needsClear ) {

			this.renderer.compute( this._clearComputeNode );
			this._needsClear = false;
			this._resolveFrameCounter = 0;
			return; // Skip resolve on the same frame as a clear — nothing to resolve yet.

		}

		// Resolve every Nth frame. Stride=1 dispatches every frame (default).
		this._resolveFrameCounter ++;
		if ( ( this._resolveFrameCounter % this.resolveStride ) !== 0 ) return;

		this.renderer.compute( this._resolveComputeNode );

	}

	setResolveStride( n ) {

		this.resolveStride = Math.max( 1, n | 0 );
		this._resolveFrameCounter = 0;

	}

	reset() {

		this._needsClear = true;

	}

	dispose() {

		this._clearComputeNode?.dispose?.();
		this._resolveComputeNode?.dispose?.();

	}

	getCapacity() {

		return this._capacity;

	}

	// ──────────────────────────────────────────────────────────────────────────
	// Compute graphs
	// ──────────────────────────────────────────────────────────────────────────

	_buildClearCompute() {

		const keyLo = this._hashKeyLo;
		const keyHi = this._hashKeyHi;
		const cell = this._cellData;

		const fn = Fn( () => {

			// One thread per cell. Capacity is multiple of WG_SIZE.
			const cellIdx = uint( workgroupId.x ).mul( uint( RESOLVE_WG_SIZE ) ).add( uint( localId.x ) ).toVar();
			const base = cellIdx.mul( uint( 8 ) ).toVar();

			atomicStore( keyLo.element( cellIdx ), uint( 0 ) );
			atomicStore( keyHi.element( cellIdx ), uint( 0 ) );
			// Zero all 8 cell slots (accum + resolved)
			for ( let i = 0; i < 8; i ++ ) {

				atomicStore( cell.element( base.add( uint( i ) ) ), uint( 0 ) );

			}

		} );

		const numWorkgroups = this._capacity / RESOLVE_WG_SIZE;
		this._clearComputeNode = fn().compute( [ numWorkgroups, 1, 1 ], [ RESOLVE_WG_SIZE, 1, 1 ] );

	}

	_buildResolveCompute() {

		const keyLo = this._hashKeyLo;
		const keyHi = this._hashKeyHi;
		const cell = this._cellData;
		const staleMax = this.staleFrameNumMax;

		const fn = Fn( () => {

			const cellIdx = uint( workgroupId.x ).mul( uint( RESOLVE_WG_SIZE ) ).add( uint( localId.x ) );

			buildResolveCellBody( {
				cellIdx,
				keyLoBuf: keyLo,
				keyHiBuf: keyHi,
				cellBuf: cell,
				staleFrameNumMax: staleMax,
			} );

		} );

		const numWorkgroups = this._capacity / RESOLVE_WG_SIZE;
		this._resolveComputeNode = fn().compute( [ numWorkgroups, 1, 1 ], [ RESOLVE_WG_SIZE, 1, 1 ] );

	}

}
