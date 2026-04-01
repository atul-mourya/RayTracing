import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu';
import { AdditiveBlending, Color } from 'three';
import { uniform, vec4 } from 'three/tsl';

/**
 * OutlineHelper — Renders selection outlines as a post-pipeline overlay.
 *
 * Uses Three.js OutlineNode internally but renders to a separate fullscreen
 * quad with additive blending, composited on top of the Display output.
 * Renders at **display resolution** (not render resolution), so outlines
 * stay sharp regardless of path tracer resolution scaling.
 *
 * Layer: 'scene' (rendered by OverlayManager's 3D pass, not HUD canvas).
 *
 * @example
 *   const outlineHelper = new OutlineHelper( renderer, meshScene, camera );
 *   overlayManager.register( 'outline', outlineHelper );
 *   outlineHelper.setSelectedObjects( [ mesh ] );
 */
export class OutlineHelper {

	constructor( renderer, scene, camera ) {

		this.layer = 'scene';
		this.visible = true;

		// Outline node (handles its own multi-pass rendering via updateBefore)
		this._outlineNode = outline( scene, camera, {
			selectedObjects: [],
			edgeThickness: uniform( 1.0 ),
			edgeGlow: uniform( 0.0 ),
		} );

		// OutlineNode calls its own setSize() internally during updateBefore()
		// with the renderer's current render target size. Override to force
		// display resolution so outlines stay sharp at any render scale.
		this._displayWidth = 1;
		this._displayHeight = 1;
		const origSetSize = this._outlineNode.setSize.bind( this._outlineNode );
		this._outlineNode.setSize = () => {

			origSetSize( this._displayWidth, this._displayHeight );

		};

		// Build the outline color from visible + hidden edges
		const edgeStrength = uniform( 3.0 );
		const visibleEdgeColor = uniform( new Color( 0xffffff ) );
		const hiddenEdgeColor = uniform( new Color( 0x190a05 ) );
		const { visibleEdge, hiddenEdge } = this._outlineNode;
		const outlineColorNode = visibleEdge.mul( visibleEdgeColor )
			.add( hiddenEdge.mul( hiddenEdgeColor ) )
			.mul( edgeStrength );

		// Fullscreen quad with additive blending — composites outline on top
		this._material = new MeshBasicNodeMaterial();
		this._material.colorNode = vec4( outlineColorNode, 1.0 );
		this._material.blending = AdditiveBlending;
		this._material.toneMapped = false;
		this._material.depthTest = false;
		this._material.depthWrite = false;

		this._quad = new QuadMesh( this._material );

	}

	/**
	 * Sets the objects to outline.
	 * @param {Object3D[]} objects
	 */
	setSelectedObjects( objects ) {

		this._outlineNode.selectedObjects = objects;

	}

	/**
	 * Renders the outline overlay onto the current backbuffer.
	 * Called by OverlayManager after Display has rendered.
	 */
	render( renderer ) {

		if ( this._outlineNode.selectedObjects.length === 0 ) return;

		const prevAutoClear = renderer.autoClear;
		renderer.autoClear = false;
		renderer.setRenderTarget( null );
		this._quad.render( renderer );
		renderer.autoClear = prevAutoClear;

	}

	/**
	 * Updates internal render target sizes.
	 * @param {number} width - Display width in pixels
	 * @param {number} height - Display height in pixels
	 */
	setSize( width, height ) {

		this._displayWidth = width;
		this._displayHeight = height;
		this._outlineNode.setSize( width, height );

	}

	show() {

		this.visible = true;

	}

	hide() {

		this.visible = false;

	}

	dispose() {

		this.visible = false;
		this._outlineNode?.dispose();
		this._material?.dispose();
		this._quad?.dispose();

	}

}
