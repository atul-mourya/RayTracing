/**
 * WavefrontTestHarness.js
 *
 * Phase 0 validation tests for wavefront infrastructure.
 * Tests atomic counters, storage buffer read/write across dispatches,
 * memory allocation, and vec3/vec4 element access codegen.
 *
 * Usage:
 *   import { runWavefrontTests } from './WavefrontTestHarness.js';
 *   await runWavefrontTests( renderer );
 *
 * Results are logged to console. Call from browser DevTools or on app init.
 */

import {
	Fn, uint, float, vec4,
	instanceIndex, atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';
import { attributeArray } from 'three/tsl';
import { RayBufferPool } from './RayBufferPool.js';

/**
 * Helper: read back a StorageBufferNode's underlying GPU data.
 * `attributeArray()` returns a StorageBufferNode whose `.value` is
 * the StorageBufferAttribute. `renderer.getArrayBufferAsync(attr)`
 * copies GPU → CPU via staging buffer + mapAsync.
 *
 * @param {WebGPURenderer} renderer
 * @param {StorageBufferNode} node - Created via attributeArray()
 * @returns {Promise<ArrayBuffer>}
 */
async function readbackBuffer( renderer, node ) {

	const attribute = node.value; // StorageBufferAttribute
	return renderer.getArrayBufferAsync( attribute );

}

/**
 * T0.1: Atomic Counter Smoke Test
 * 1024 threads each do atomicAdd(counter[0], 1). Counter should equal 1024.
 */
async function testAtomicCounter( renderer ) {

	console.group( '[T0.1] Atomic Counter Smoke Test' );
	const THREAD_COUNT = 1024;

	try {

		// Create atomic counter buffer (4 × u32)
		const counterBuffer = attributeArray( 4, 'uint' ).toAtomic();

		// Reset kernel: set counter[0] = 0
		const resetFn = Fn( () => {

			atomicStore( counterBuffer.element( uint( 0 ) ), uint( 0 ) );

		} );

		const resetNode = resetFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] );

		// Increment kernel: each thread adds 1
		const incrementFn = Fn( () => {

			atomicAdd( counterBuffer.element( uint( 0 ) ), uint( 1 ) );

		} );

		// First arg = workgroup count, second = threads per workgroup
		// Total threads = workgroup count × workgroup size
		const WG_SIZE = 256;
		const incrementNode = incrementFn().compute( [ Math.ceil( THREAD_COUNT / WG_SIZE ), 1, 1 ], [ WG_SIZE, 1, 1 ] );

		// Read kernel: copy counter value to a non-atomic output buffer for readback
		const outputBuffer = attributeArray( 1, 'uint' );
		const readFn = Fn( () => {

			outputBuffer.element( uint( 0 ) ).assign( atomicLoad( counterBuffer.element( uint( 0 ) ) ) );

		} );

		const readNode = readFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] );

		// Dispatch sequence
		renderer.compute( resetNode );
		renderer.compute( incrementNode );
		renderer.compute( readNode );

		// Readback via getArrayBufferAsync
		const readbackResult = await readbackBuffer( renderer, outputBuffer );
		const value = new Uint32Array( readbackResult )[ 0 ];
		const passed = value === THREAD_COUNT;
		console.log( `Counter value: ${value} (expected: ${THREAD_COUNT}) — ${passed ? 'PASS ✓' : 'FAIL ✗'}` );

		if ( ! passed ) {

			console.warn( 'Atomic counter mismatch. Check WGSL output in Sources > WebGPU Shaders.' );
			console.warn( 'Possible Three.js codegen issue with atomicAdd on storage buffer elements.' );

		}

		return passed;

	} catch ( error ) {

		console.error( 'T0.1 FAILED with error:', error.message );
		console.error( 'This likely indicates a Three.js TSL codegen issue with atomicAdd.' );
		console.error( 'Check AtomicFunctionNode.generate() WGSL output.' );
		return false;

	} finally {

		console.groupEnd();

	}

}

/**
 * T0.2: Storage Buffer Cross-Dispatch Read/Write Roundtrip
 * Kernel A writes buffer[tid] = tid * 3 + 7
 * Kernel B reads buffer[tid] and writes to output[tid]
 * Verify output[tid] === tid * 3 + 7
 */
async function testBufferRoundtrip( renderer ) {

	console.group( '[T0.2] Storage Buffer Cross-Dispatch Read/Write' );
	const COUNT = 256;

	try {

		const bufferA = attributeArray( COUNT, 'uint' );
		const bufferB = attributeArray( COUNT, 'uint' );

		// Kernel A: write pattern
		const writeKernel = Fn( () => {

			const tid = instanceIndex;
			bufferA.element( tid ).assign( tid.mul( uint( 3 ) ).add( uint( 7 ) ) );

		} );

		// Kernel B: read A, write B
		const readWriteKernel = Fn( () => {

			const tid = instanceIndex;
			const val = bufferA.element( tid );
			bufferB.element( tid ).assign( val );

		} );

		// COUNT threads = 1 workgroup of 256
		const writeNode = writeKernel().compute( [ Math.ceil( COUNT / 256 ), 1, 1 ], [ 256, 1, 1 ] );
		const readWriteNode = readWriteKernel().compute( [ Math.ceil( COUNT / 256 ), 1, 1 ], [ 256, 1, 1 ] );

		// Dispatch A then B
		renderer.compute( writeNode );
		renderer.compute( readWriteNode );

		// Readback
		const result = await readbackBuffer( renderer, bufferB );
		const data = new Uint32Array( result );
		let allCorrect = true;
		let firstError = - 1;

		for ( let i = 0; i < COUNT; i ++ ) {

			const expected = i * 3 + 7;
			if ( data[ i ] !== expected ) {

				allCorrect = false;
				if ( firstError < 0 ) firstError = i;

			}

		}

		if ( allCorrect ) {

			console.log( `All ${COUNT} values correct — PASS ✓` );
			console.log( 'Cross-dispatch StorageBuffer reads work correctly.' );

		} else {

			console.error( `FAIL ✗ at index ${firstError}: got ${data[ firstError ]}, expected ${firstError * 3 + 7}` );
			console.warn( 'StorageBuffer cross-dispatch reads may be broken. Consider ping-pong pattern.' );

		}

		return allCorrect;

	} catch ( error ) {

		console.error( 'T0.2 FAILED:', error.message );
		return false;

	} finally {

		console.groupEnd();

	}

}

/**
 * T0.3: Memory Allocation Verification
 * Instantiate RayBufferPool at 1920×1080 and verify buffer count and estimated size.
 */
function testMemoryAllocation() {

	console.group( '[T0.3] Memory Allocation' );

	try {

		const maxRays = 1920 * 1080; // 2,073,600
		const pool = new RayBufferPool( maxRays );

		const bufferCount = pool.buffers.size;
		const totalMB = pool.totalBytes / ( 1024 * 1024 );
		const capacity = pool.getCapacity();

		console.log( `Requested: ${maxRays} rays` );
		console.log( `Allocated capacity: ${capacity} rays (over-allocated + power-of-2)` );
		console.log( `Buffer fields: ${bufferCount}` );
		console.log( `Estimated total: ${totalMB.toFixed( 1 )} MB` );

		// Verify expected buffer count: 9 ray + 5 hit + 5 shadow + 2 first-hit + 1 visibility = 22
		const expectedBufferCount = 22;
		const passed = bufferCount === expectedBufferCount && capacity >= maxRays;

		console.log( `Buffer count: ${bufferCount} (expected: ${expectedBufferCount}) — ${bufferCount === expectedBufferCount ? 'PASS ✓' : 'FAIL ✗'}` );
		console.log( `Capacity >= requested: ${capacity >= maxRays ? 'PASS ✓' : 'FAIL ✗'}` );

		// Test resize (should not reallocate if within capacity)
		const reallocated = pool.resize( maxRays - 100 );
		console.log( `Resize smaller (no realloc): ${! reallocated ? 'PASS ✓' : 'FAIL ✗'}` );

		// Test resize larger (should reallocate)
		const reallocated2 = pool.resize( capacity + 1 );
		console.log( `Resize larger (realloc): ${reallocated2 ? 'PASS ✓' : 'FAIL ✗'}` );

		pool.dispose();
		return passed;

	} catch ( error ) {

		console.error( 'T0.3 FAILED:', error.message );
		return false;

	} finally {

		console.groupEnd();

	}

}

/**
 * T0.4: vec4 Element Access — verify WGSL codegen
 * Write vec4 values to a buffer, read them back in a second dispatch.
 */
async function testVec4ElementAccess( renderer ) {

	console.group( '[T0.4] vec4 Element Access' );
	const COUNT = 16;

	try {

		const buffer = attributeArray( COUNT, 'vec4' );
		const output = attributeArray( COUNT, 'vec4' );

		// Write kernel: buffer[tid] = vec4(tid, tid*2, tid*3, tid*4)
		const writeKernel = Fn( () => {

			const tid = instanceIndex;
			const f = float( tid );
			buffer.element( tid ).assign( vec4( f, f.mul( 2.0 ), f.mul( 3.0 ), f.mul( 4.0 ) ) );

		} );

		// Read kernel: output[tid] = buffer[tid]
		const readKernel = Fn( () => {

			const tid = instanceIndex;
			output.element( tid ).assign( buffer.element( tid ) );

		} );

		// COUNT threads = 1 workgroup of 16
		const writeNode = writeKernel().compute( [ Math.ceil( COUNT / 16 ), 1, 1 ], [ 16, 1, 1 ] );
		const readNode = readKernel().compute( [ Math.ceil( COUNT / 16 ), 1, 1 ], [ 16, 1, 1 ] );

		renderer.compute( writeNode );
		renderer.compute( readNode );

		const result = await readbackBuffer( renderer, output );
		const data = new Float32Array( result );
		let allCorrect = true;

		for ( let i = 0; i < COUNT; i ++ ) {

			const base = i * 4;
			const expected = [ i, i * 2, i * 3, i * 4 ];

			for ( let c = 0; c < 4; c ++ ) {

				if ( Math.abs( data[ base + c ] - expected[ c ] ) > 0.001 ) {

					allCorrect = false;
					console.error( `FAIL at [${i}][${c}]: got ${data[ base + c ]}, expected ${expected[ c ]}` );

				}

			}

		}

		console.log( `vec4 element access: ${allCorrect ? 'PASS ✓' : 'FAIL ✗'}` );

		if ( ! allCorrect ) {

			console.warn( 'vec4 storage buffer element access codegen may be incorrect.' );
			console.warn( 'Check WGSL output in Sources panel for struct alignment issues.' );

		}

		return allCorrect;

	} catch ( error ) {

		console.error( 'T0.4 FAILED:', error.message );
		return false;

	} finally {

		console.groupEnd();

	}

}

/**
 * Run all Phase 0 tests.
 * @param {WebGPURenderer} renderer
 * @returns {Promise<{passed: number, failed: number, results: Object}>}
 */
export async function runWavefrontTests( renderer ) {

	console.log( '%c=== Wavefront Phase 0 Tests ===', 'font-weight:bold; font-size:14px; color:#4CAF50' );
	console.log( 'Testing: atomics, buffer cross-dispatch R/W, memory allocation, vec4 access' );
	console.log( '' );

	const results = {};

	// T0.3 runs synchronously (no GPU)
	results[ 'T0.3_memory' ] = testMemoryAllocation();

	// GPU tests
	results[ 'T0.1_atomics' ] = await testAtomicCounter( renderer );
	results[ 'T0.2_buffer_roundtrip' ] = await testBufferRoundtrip( renderer );
	results[ 'T0.4_vec4_access' ] = await testVec4ElementAccess( renderer );

	// Summary
	const passed = Object.values( results ).filter( v => v ).length;
	const failed = Object.values( results ).filter( v => ! v ).length;

	console.log( '' );
	console.log( `%c=== Results: ${passed} passed, ${failed} failed ===`,
		`font-weight:bold; font-size:14px; color:${failed > 0 ? '#F44336' : '#4CAF50'}` );

	if ( failed > 0 ) {

		console.log( '%cFailed tests require investigation before proceeding to Phase 1.',
			'color:#F44336' );
		console.log( 'Check Chrome DevTools > Sources > WebGPU Shaders for WGSL codegen issues.' );

	} else {

		console.log( '%cAll Phase 0 tests passed. Foundation is solid for wavefront implementation.',
			'color:#4CAF50' );

	}

	return { passed, failed, results };

}

/**
 * Expose tests globally for Chrome DevTools console access.
 * Usage in console:
 *   const app = getApp();  // or however you access the app
 *   await window.__wavefrontTests( app.renderer );
 */
if ( typeof window !== 'undefined' ) {

	window.__wavefrontTests = runWavefrontTests;

}
