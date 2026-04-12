/**
 * Tracks render completion state, time limits, and sample limits.
 *
 * Owns: timeElapsed, lastResetTime, renderCompleteDispatched.
 * Called each frame by the render loop and on reset.
 */
export class CompletionTracker {

	constructor() {

		this.timeElapsed = 0;
		this.lastResetTime = performance.now();
		this.renderCompleteDispatched = false;

	}

	/**
	 * Updates elapsed time. Call each frame while rendering is active.
	 */
	updateTime() {

		this.timeElapsed = ( performance.now() - this.lastResetTime ) / 1000;

	}

	/**
	 * Checks whether the time-based render limit has been reached.
	 * @param {string} renderLimitMode - 'time' or 'samples'
	 * @param {number} renderTimeLimit - Time limit in seconds
	 * @returns {boolean}
	 */
	isTimeLimitReached( renderLimitMode, renderTimeLimit ) {

		return renderLimitMode === 'time' && renderTimeLimit > 0 && this.timeElapsed >= renderTimeLimit;

	}

	/**
	 * Checks whether ANY render limit (time or samples) is reached.
	 * @param {Object} pathTracer - The PathTracer stage
	 * @param {string} renderLimitMode
	 * @param {number} renderTimeLimit
	 * @returns {boolean}
	 */
	isLimitReached( pathTracer, renderLimitMode, renderTimeLimit ) {

		if ( ! pathTracer ) return false;

		if ( this.isTimeLimitReached( renderLimitMode, renderTimeLimit ) ) return true;

		return pathTracer.frameCount >= pathTracer.completionThreshold;

	}

	/**
	 * Marks render as complete and returns true if this is the first time.
	 * @returns {boolean} true if freshly completed (should trigger denoise chain)
	 */
	markComplete() {

		if ( this.renderCompleteDispatched ) return false;
		this.renderCompleteDispatched = true;
		return true;

	}

	/**
	 * Resets all tracking state. Call on accumulation reset.
	 */
	reset() {

		this.timeElapsed = 0;
		this.lastResetTime = performance.now();
		this.renderCompleteDispatched = false;

	}

	/**
	 * Adjusts lastResetTime to account for idle time so timeElapsed
	 * continues from where it paused rather than including idle time.
	 */
	resumeFromPause() {

		this.renderCompleteDispatched = false;
		this.lastResetTime = performance.now() - this.timeElapsed * 1000;

	}

}
