import { vec4, vec3, uv, uniform, select, dot, mix } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, TextureNode } from 'three/webgpu';
import { NoBlending } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { REC709_LUMINANCE_COEFFICIENTS } from '../TSL/Common.js';

/**
 * Display — Terminal pipeline stage for WebGPU.
 *
 * Reads the final colour texture from the pipeline context (using a
 * priority fallback chain), applies exposure, and renders to screen.
 *
 * When new post-processing stages are added between PathTracer and
 * Display, the fallback chain automatically picks up the latest output
 * without any wiring changes.
 */
export class Display extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'Display', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;

		// Exposure uniform — linear multiplier (consistent with auto-exposure)
		this.exposure = uniform( options.exposure ?? 1.0 );

		// Pre-tonemapping saturation — compensates for ACES/AgX desaturation (1.0 = neutral)
		this.saturation = uniform( options.saturation ?? 1.0 );

		// Transparent background toggle
		this._transparentBackground = uniform( 0, 'int' );

		// Updatable texture node — swap .value each frame, no shader recompile
		this._displayTexNode = new TextureNode();

		const texSample = this._displayTexNode.sample( uv() );

		// Build material once (TSL compiles on first render)
		const exposed = texSample.xyz.mul( this.exposure );

		// Saturation adjustment (before tonemapping): mix between luminance and color
		const luma = dot( exposed, REC709_LUMINANCE_COEFFICIENTS );
		let displayShader = mix( vec3( luma ), exposed, this.saturation );

		// Alpha: pass through source alpha when transparent, otherwise 1.0
		const outputAlpha = select( this._transparentBackground, texSample.w, 1.0 );

		this.displayMaterial = new MeshBasicNodeMaterial();
		this.displayMaterial.colorNode = vec4( displayShader, outputAlpha );
		this.displayMaterial.blending = NoBlending;
		this.displayMaterial.toneMapped = true;

		this.displayQuad = new QuadMesh( this.displayMaterial );

	}

	/**
	 * Resolve the best available output texture from the pipeline context.
	 * Later stages in the chain take priority; pathtracer:color is the
	 * baseline fallback that is always present.
	 */
	_resolveDisplayTexture( context ) {

		return context.getTexture( 'bloom:output' )
			|| context.getTexture( 'edgeFiltering:output' )
			|| context.getTexture( 'asvgf:output' )
			|| context.getTexture( 'ssrc:output' )
			|| context.getTexture( 'pathtracer:color' );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const displayTexture = this._resolveDisplayTexture( context );

		if ( ! displayTexture ) return;

		// Swap texture reference (no shader recompilation)
		this._displayTexNode.value = displayTexture;

		// Render to screen
		this.renderer.setRenderTarget( null );
		this.displayQuad.render( this.renderer );

	}

	setExposure( value ) {

		this.exposure.value = value;

	}

	setSaturation( value ) {

		this.saturation.value = value;

	}

	setTransparentBackground( enabled ) {

		this._transparentBackground.value = enabled ? 1 : 0;

	}

	dispose() {

		this.displayMaterial?.dispose();
		this.displayQuad?.dispose();

	}

}
