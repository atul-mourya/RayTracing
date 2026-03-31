/**
 * Web Worker for AI Upscaler inference.
 * Handles ONNX model loading and tile-based inference off the main thread.
 *
 * Messages:
 *   Main → Worker:
 *     { type: 'load', url, sessionOptions }  — load/switch model
 *     { type: 'infer', tileData, width, height, id }  — run inference on a tile
 *     { type: 'dispose' }  — release session
 *
 *   Worker → Main:
 *     { type: 'loaded', backend }
 *     { type: 'inferred', outputData, id }
 *     { type: 'error', message, id? }
 */

import * as ort from 'onnxruntime-web/webgpu';

// WASM paths for CDN delivery — WebGPU EP still uses WASM for lightweight shape ops
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
ort.env.logLevel = 'error';

const IDB_NAME = 'ai-upscaler-models';
const IDB_STORE = 'models';

let session = null;
let currentModelUrl = null;

// ─── IndexedDB Model Cache ───────────────────────────────────────────────────

function openDB() {

	return new Promise( ( resolve, reject ) => {

		const req = indexedDB.open( IDB_NAME, 1 );
		req.onupgradeneeded = () => req.result.createObjectStore( IDB_STORE );
		req.onsuccess = () => resolve( req.result );
		req.onerror = () => reject( req.error );

	} );

}

async function getCachedModel( url ) {

	try {

		const db = await openDB();
		return await new Promise( ( resolve, reject ) => {

			const tx = db.transaction( IDB_STORE, 'readonly' );
			const req = tx.objectStore( IDB_STORE ).get( url );
			req.onsuccess = () => resolve( req.result || null );
			req.onerror = () => reject( req.error );

		} );

	} catch {

		return null;

	}

}

async function cacheModel( url, buffer ) {

	try {

		const db = await openDB();
		await new Promise( ( resolve, reject ) => {

			const tx = db.transaction( IDB_STORE, 'readwrite' );
			tx.objectStore( IDB_STORE ).put( buffer, url );
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject( tx.error );

		} );

	} catch {

		// Cache write failure is non-fatal
	}

}

// ─── Model Loading ───────────────────────────────────────────────────────────

async function fetchModel( url ) {

	// Try IndexedDB cache first
	const cached = await getCachedModel( url );
	if ( cached ) {

		console.log( `AI Upscaler Worker: model loaded from cache (${( cached.byteLength / 1024 / 1024 ).toFixed( 1 )}MB)` );
		return cached;

	}

	// Network fetch + cache
	const response = await fetch( url );
	if ( ! response.ok ) throw new Error( `Failed to fetch model: ${response.status}` );
	const buffer = await response.arrayBuffer();

	// Cache in background (don't block session creation)
	cacheModel( url, buffer.slice( 0 ) );

	return buffer;

}

async function loadModel( url, sessionOptions ) {

	if ( session && currentModelUrl === url ) {

		const backend = 'webgpu';
		self.postMessage( { type: 'loaded', backend } );
		return;

	}

	// Dispose previous session
	if ( session ) {

		await session.release();
		session = null;

	}

	const modelBuffer = await fetchModel( url );

	session = await ort.InferenceSession.create( modelBuffer, sessionOptions );
	currentModelUrl = url;

	// Detect GPU and recommend tile size based on device type
	let tileSize = 512; // default
	try {

		const adapter = await navigator.gpu?.requestAdapter();
		const info = await adapter?.requestAdapterInfo?.() || adapter?.info;
		const isMobile = /apple|swiftshader|llvmpipe/i.test( info?.vendor || '' )
			|| /apple|swiftshader/i.test( info?.architecture || '' );
		const isIntegrated = info?.device?.toLowerCase?.()?.includes( 'integrated' )
			|| /intel.*iris|intel.*uhd|intel.*hd|amd.*vega|radeon.*graphics/i.test( info?.description || '' );

		if ( isMobile ) {

			tileSize = 128;

		} else if ( isIntegrated ) {

			tileSize = 256;

		} else {

			tileSize = 512;

		}

		console.log( `AI Upscaler Worker: GPU="${info?.description || info?.device || 'unknown'}", tileSize=${tileSize}` );

	} catch { /* fallback to default */ }

	const sizeMB = ( modelBuffer.byteLength / 1024 / 1024 ).toFixed( 1 );
	console.log( `AI Upscaler Worker: model loaded (${sizeMB}MB), backend: webgpu` );

	self.postMessage( { type: 'loaded', backend: 'webgpu', tileSize } );

}

async function inferTile( tileData, width, height, id ) {

	const inputName = session.inputNames[ 0 ];
	const outputName = session.outputNames[ 0 ];
	const inputTensor = new ort.Tensor( 'float32', tileData, [ 1, 3, height, width ] );

	const results = await session.run( { [ inputName ]: inputTensor } );
	const outputData = results[ outputName ].data;

	// Transfer the output buffer (zero-copy)
	self.postMessage( { type: 'inferred', outputData, id }, [ outputData.buffer ] );

}

self.onmessage = async ( e ) => {

	const { type } = e.data;

	try {

		if ( type === 'load' ) {

			await loadModel( e.data.url, e.data.sessionOptions );

		} else if ( type === 'infer' ) {

			await inferTile( e.data.tileData, e.data.width, e.data.height, e.data.id );

		} else if ( type === 'dispose' ) {

			if ( session ) {

				await session.release();
				session = null;
				currentModelUrl = null;

			}

		}

	} catch ( error ) {

		self.postMessage( { type: 'error', message: error.message, id: e.data?.id } );

	}

};
