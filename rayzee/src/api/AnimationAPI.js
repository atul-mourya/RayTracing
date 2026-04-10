/**
 * Animation sub-API — playback controls for GLTF animation clips.
 *
 * Access via `engine.animation`.
 *
 * @example
 * engine.animation.play(0);
 * engine.animation.setSpeed(2);
 * console.log(engine.animation.clips);
 */
export class AnimationAPI {

	/** @param {import('../PathTracerApp.js').PathTracerApp} app */
	constructor( app ) {

		this._app = app;

	}

	/**
	 * Plays an animation clip by index.
	 * @param {number} [clipIndex=0]
	 */
	play( clipIndex = 0 ) {

		this._app.playAnimation( clipIndex );

	}

	/**
	 * Pauses animation, preserving current time position.
	 */
	pause() {

		this._app.pauseAnimation();

	}

	/**
	 * Resumes animation from paused state.
	 */
	resume() {

		this._app.resumeAnimation();

	}

	/**
	 * Stops animation and resets to beginning.
	 */
	stop() {

		this._app.stopAnimationPlayback();

	}

	/**
	 * Sets playback speed multiplier.
	 * @param {number} speed - 1.0 = normal speed
	 */
	setSpeed( speed ) {

		this._app.setAnimationSpeed( speed );

	}

	/**
	 * Sets loop mode for animation playback.
	 * @param {boolean} loop - true for repeat, false for play-once
	 */
	setLoop( loop ) {

		this._app.setAnimationLoop( loop );

	}

	/**
	 * Available animation clips.
	 * @returns {{ index: number, name: string, duration: number }[]}
	 */
	get clips() {

		return this._app.animationClips;

	}

}
