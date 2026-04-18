/**
 * VideoEncoderPipeline — WebCodecs VP9 encoder + webm-muxer for WebM output.
 *
 * Accepts ImageBitmap frames from VideoRenderManager and produces
 * a downloadable .webm video blob.
 */

import { Muxer, ArrayBufferTarget } from 'webm-muxer';

const VP9_CODEC = 'vp09.00.10.08'; // Profile 0, Level 1.0, 8-bit
const VP8_CODEC = 'vp8';

/**
 * Check if the WebCodecs VideoEncoder API is available and a codec is supported.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<{ supported: boolean, codec: string|null }>}
 */
export async function checkCodecSupport( width, height ) {

	if ( typeof VideoEncoder === 'undefined' ) {

		return { supported: false, codec: null };

	}

	// Try VP9 first, fall back to VP8
	for ( const codec of [ VP9_CODEC, VP8_CODEC ] ) {

		try {

			const result = await VideoEncoder.isConfigSupported( {
				codec,
				width,
				height,
				bitrate: 10_000_000,
			} );

			if ( result.supported ) return { supported: true, codec };

		} catch {

			continue;

		}

	}

	return { supported: false, codec: null };

}

export class VideoEncoderPipeline {

	/**
	 * @param {number} width  - Video width in pixels
	 * @param {number} height - Video height in pixels
	 * @param {Object} [options]
	 * @param {number} [options.fps=30]             - Frame rate
	 * @param {number} [options.bitrate=10_000_000] - Target bitrate in bps
	 * @param {string} [options.codec]              - WebCodecs codec string (auto-detected if omitted)
	 */
	constructor( width, height, options = {} ) {

		const { fps = 30, bitrate = 10_000_000, codec = VP9_CODEC } = options;

		this._fps = fps;
		this._frameDuration = Math.round( 1_000_000 / fps ); // microseconds
		this._frameIndex = 0;
		this._finalized = false;

		// WebM muxer
		const muxerCodec = codec.startsWith( 'vp09' ) ? 'V_VP9' : 'V_VP8';
		this._muxer = new Muxer( {
			target: new ArrayBufferTarget(),
			video: { codec: muxerCodec, width, height },
		} );

		// WebCodecs VideoEncoder
		this._encoder = new VideoEncoder( {
			output: ( chunk, meta ) => this._muxer.addVideoChunk( chunk, meta ),
			error: ( e ) => console.error( 'VideoEncoder error:', e ),
		} );

		this._encoder.configure( {
			codec,
			width,
			height,
			bitrate,
			framerate: fps,
		} );

	}

	/**
	 * Encode a single frame.
	 * @param {ImageBitmap} imageBitmap - Frame content
	 */
	async addFrame( imageBitmap ) {

		if ( this._finalized ) {

			throw new Error( 'VideoEncoderPipeline: Cannot add frames after finalize()' );

		}

		const timestamp = this._frameIndex * this._frameDuration;
		const frame = new VideoFrame( imageBitmap, {
			timestamp,
			duration: this._frameDuration,
		} );

		const keyFrame = this._frameIndex % 30 === 0;
		this._encoder.encode( frame, { keyFrame } );
		frame.close();
		this._frameIndex ++;

		// Back-pressure: wait for the encoder queue to drain
		while ( this._encoder.encodeQueueSize > 5 ) {

			await new Promise( r => setTimeout( r, 10 ) );

		}

	}

	/**
	 * Flush the encoder and finalize the WebM container.
	 * @returns {Promise<Blob>} The finished .webm video
	 */
	async finalize() {

		if ( this._finalized ) {

			throw new Error( 'VideoEncoderPipeline: Already finalized' );

		}

		this._finalized = true;

		await this._encoder.flush();
		this._encoder.close();
		this._muxer.finalize();

		const buffer = this._muxer.target.buffer;
		return new Blob( [ buffer ], { type: 'video/webm' } );

	}

}
