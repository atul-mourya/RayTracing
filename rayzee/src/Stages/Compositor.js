import { vec4, vec3, uv, uniform, select, dot, mix } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, TextureNode } from 'three/webgpu';
import { NoBlending } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { REC709_LUMINANCE_COEFFICIENTS } from '../TSL/Common.js';

/**
 * Compositor — Terminal pipeline stage.
 *
 * Selects the latest upstream texture via a priority fallback chain, applies
 * a saturation grade, sets alpha, and hands the linear HDR result to the
 * renderer's output pass (tone mapping + sRGB gamma happen there).
 *
 * Exposure is not applied here — `renderer.toneMappingExposure` owns it,
 * and Three.js applies it inside the tone-mapping branch of the output pass
 * (so it has no effect when `renderer.toneMapping === NoToneMapping`).
 */
export class Compositor extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'Compositor', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;

		// 1.0 = neutral; >1 boosts to compensate for ACES/AgX desaturation.
		this.saturation = uniform( options.saturation ?? 1.0 );

		this._transparentBackground = uniform( 0, 'int' );

		// TextureNode reused across frames — only `.value` mutates, shader doesn't recompile.
		this._sourceTexNode = new TextureNode();

		const texSample = this._sourceTexNode.sample( uv() );

		const luma = dot( texSample.xyz, REC709_LUMINANCE_COEFFICIENTS );
		const gradedColor = mix( vec3( luma ), texSample.xyz, this.saturation );

		const outputAlpha = select( this._transparentBackground, texSample.w, 1.0 );

		this.compositorMaterial = new MeshBasicNodeMaterial();
		this.compositorMaterial.colorNode = vec4( gradedColor, outputAlpha );
		this.compositorMaterial.blending = NoBlending;

		this.compositorQuad = new QuadMesh( this.compositorMaterial );

	}

	/**
	 * Later stages in the chain take priority; `pathtracer:color` is the
	 * baseline fallback that is always present.
	 */
	_resolveSourceTexture( context ) {

		return context.getTexture( 'bloom:output' )
			|| context.getTexture( 'edgeFiltering:output' )
			|| context.getTexture( 'asvgf:output' )
			|| context.getTexture( 'pathtracer:color' );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const sourceTexture = this._resolveSourceTexture( context );
		if ( ! sourceTexture ) return;

		this._sourceTexNode.value = sourceTexture;

		this.renderer.setRenderTarget( null );
		this.compositorQuad.render( this.renderer );

	}

	setSaturation( value ) {

		this.saturation.value = value;

	}

	setTransparentBackground( enabled ) {

		this._transparentBackground.value = enabled ? 1 : 0;

	}

	dispose() {

		this._sourceTexNode?.dispose();
		this.compositorMaterial?.dispose();
		// QuadMesh extends Mesh — no dispose method; material already released above.
		this.compositorQuad = null;

	}

}
