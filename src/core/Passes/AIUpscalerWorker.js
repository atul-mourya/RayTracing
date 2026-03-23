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

// Configure WASM paths for CDN delivery
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
ort.env.logLevel = 'error';

let session = null;
let currentModelUrl = null;

async function loadModel( url, sessionOptions ) {

	if ( session && currentModelUrl === url ) {

		const backend = ort.env.webgpu?.device ? 'webgpu' : 'wasm';
		self.postMessage( { type: 'loaded', backend } );
		return;

	}

	// Dispose previous session
	if ( session ) {

		await session.release();
		session = null;

	}

	const response = await fetch( url );
	if ( ! response.ok ) throw new Error( `Failed to fetch model: ${response.status}` );
	const modelBuffer = await response.arrayBuffer();

	session = await ort.InferenceSession.create( modelBuffer, sessionOptions );
	currentModelUrl = url;

	const backend = ort.env.webgpu?.device ? 'webgpu' : 'wasm';
	const sizeMB = ( modelBuffer.byteLength / 1024 / 1024 ).toFixed( 1 );
	console.log( `AI Upscaler Worker: model loaded (${sizeMB}MB), backend: ${backend}` );

	self.postMessage( { type: 'loaded', backend } );

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
