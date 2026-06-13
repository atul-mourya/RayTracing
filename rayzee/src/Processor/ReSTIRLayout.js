/**
 * ReSTIRLayout.js — single source of truth for the reservoir-pool slot layout (DI + GI).
 *
 * PURE JS, ZERO imports — so the node/vitest stride-parity test can import the EXACT shipping constants
 * (ReSTIRReservoirPool imports three/webgpu and ReSTIRGICore imports three/tsl; neither loads under node).
 * The pool (allocation), ReSTIRCore (DI slot stride), and ReSTIRGICore (GI slot stride) all derive from
 * these, so the documented corruption footgun — slot stride drifting out of lockstep with per-pixel
 * allocation — becomes structurally impossible (and is pinned by tests/unit/core/restirGI.test.js).
 */

// 3 slots/pixel = 2 ping-pong (cur/prev, hold the final post-spatial reservoir) + 1 fixed snapshot
// (slot 2: this frame's post-temporal reservoir — a race-free read-only source for the spatial gather).
export const SLOTS_PER_PIXEL = 3;

// vec4s per reservoir slot, per feature.
export const DI_VEC4S_PER_SLOT = 2; // DI: core (lightSampleId/wSum/W/M) + aux (samplePos.xyz/pHatOwn) = 32 B
// GI/PT (7 vec4 = 112 B/slot): core(wSum/W/M/pHatOwn) + sample(x1.xyz/n1oct) + radiA(A.rgb/validFlip)
// + suffix(B.rgb/ω1oct.x) + recon(matIdx1/uv1.xy/ω1oct.y) + emissive(Le.rgb/triIdx1-or-envPdf)
// + prefix(seedLo/seedHi/kPrefix/prefixPHatCache — PT-3 replay seed as two 16-bit-exact f32 lanes)
export const GI_VEC4S_PER_SLOT = 7;

// Per-pixel slot stride in the storage buffer (must equal the kernel's reservoirSlotIndex multiplier).
export const DI_SLOT_STRIDE = DI_VEC4S_PER_SLOT * SLOTS_PER_PIXEL; // 6  (ReSTIRCore.reservoirSlotIndex)
export const GI_SLOT_STRIDE = GI_VEC4S_PER_SLOT * SLOTS_PER_PIXEL; // 18 (ReSTIRGICore.reservoirSlotIndexGI)

// PT-2b: the GI primaryHit buffer ping-pongs (cur/prev parity) so gi-temporal can evaluate the history
// arm's cross-target at the TRUE previous-frame jittered x0 (the x0-collapse fix). DI stays at 1.
export const GI_PRIMARY_HIT_SLOTS = 2;
