/**
 * ReSTIRState.js — module-level state for ReSTIR DI.
 *
 * Follows the same pattern as LightsDirect.js (setShadowAlbedoMaps /
 * setAlphaShadowsUniform): ShaderBuilder calls the setters once before
 * graph construction. TSL reads them at shader-build time.
 *
 * Phase 0: only the enableReSTIR uniform is wired. Future phases will
 * plumb reservoir StorageTextures and Unified Light Proxy Table buffer
 * references through this module.
 *
 * Consumers: LightsSampling.js (`calculateDirectLightingUnified` gate).
 */

// Runtime toggle — bool uniform (int 0/1). When null, callers must fall
// back to the non-ReSTIR code path (safe default for tests / direct Fn use).
let _enableReSTIR = null;

// Placeholder hooks for upcoming phases. Kept here so that the wiring
// surface area is discoverable in one file.
// Single reservoir storage buffer with ping-pong slots packed in-buffer.
// frameParity uniform (0|1) tells the shader which slot to read/write.
let _reservoirBuffer = null;
let _reservoirFrameParity = null;
let _reservoirResolution = null; // vec2 — (width, height) for pixel-to-slot indexing
// Phase 4 temporal-reuse textures.
let _motionVectorTex = null; // TextureNode reading `motionVector:screenSpace`
let _prevNormalDepthTex = null; // TextureNode reading prev-frame pathtracer:normalDepth
let _lightProxyBuffer = null; // Phase 1: unified light proxy storage buffer
let _numLightProxies = null; // Phase 1: int uniform — proxy count

/**
 * Set the runtime uniform node that toggles ReSTIR DI.
 * @param {import('three/tsl').UniformNode} node - int uniform (0 = disabled, 1 = enabled)
 */
export function setReSTIREnabled( node ) {

	_enableReSTIR = node;

}

/** @returns {import('three/tsl').UniformNode|null} */
export function getReSTIREnabled() {

	return _enableReSTIR;

}

// ── Phase 2 hooks: reservoir state ───────────────────────────────────────
// Single storage buffer holding 2 ping-pong slots per pixel. Shader reads
// slot (frameParity ^ 1) for prev state, writes slot (frameParity) for curr.
export function setReservoirBuffer( bufferNode ) {

	_reservoirBuffer = bufferNode;

}

export function getReservoirBuffer() {

	return _reservoirBuffer;

}

export function setReservoirFrameParity( uniformNode ) {

	_reservoirFrameParity = uniformNode;

}

export function getReservoirFrameParity() {

	return _reservoirFrameParity;

}

export function setReservoirResolution( uniformNode ) {

	_reservoirResolution = uniformNode;

}

export function getReservoirResolution() {

	return _reservoirResolution;

}

// ── Phase 4 hooks: temporal reuse ─────────────────────────────────────────
// Motion vector texture node (published as `motionVector:screenSpace`).
// Content is 1-frame lagged because MotionVector stage runs after PathTracer
// in the pipeline — acceptable approximation for slow-camera cases; fast
// motion fails the disocclusion test and falls back to fresh candidates.
export function setMotionVectorTex( texNode ) {

	_motionVectorTex = texNode;

}

export function getMotionVectorTex() {

	return _motionVectorTex;

}

// Previous-frame normal/depth texture node (ShaderBuilder's prevNormalDepthTexNode).
// Used for the disocclusion test via normalDepthWeight().
export function setPrevNormalDepthTex( texNode ) {

	_prevNormalDepthTex = texNode;

}

export function getPrevNormalDepthTex() {

	return _prevNormalDepthTex;

}

// ── Phase 1 hooks (not used yet) ─────────────────────────────────────────
export function setLightProxyBuffer( node ) {

	_lightProxyBuffer = node;

}

export function getLightProxyBuffer() {

	return _lightProxyBuffer;

}

export function setNumLightProxies( node ) {

	_numLightProxies = node;

}

export function getNumLightProxies() {

	return _numLightProxies;

}
