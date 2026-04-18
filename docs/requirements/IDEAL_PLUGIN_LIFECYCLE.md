Ideal plugin lifecycle for Rayzee-in-a-host-app                                    
                                                                                    
Core principle: one engine instance, many scene swaps, explicit power states        
                            
Creating/destroying PathTracerApp on every open is too slow (WebGPU adapter request 
+ pipeline compilation + BVH/texture workers = hundreds of ms). The host should keep
the engine alive across open/close cycles but move it through explicit power       
states. Only call dispose() when the user opts out permanently.                     
                                                                                    
State machine (what the plugin must be able to be in)                               

State: UNMOUNTED                                                                    
What's loaded: nothing                                                            
rAF: off                                                                            
GPU resources: none                                                               
Resume cost: cold (~500ms+)                                                     
When: before first open, after permanent close                                      
────────────────────────────────────────                                        
State: INITIALIZING                                                                 
What's loaded: adapter + pipeline                                                 
rAF: off                                                                            
GPU resources: allocating                                                       
Resume cost: —                                                                      
When: transitional                                                                  
────────────────────────────────────────                                        
State: READY                                                                        
What's loaded: engine, no scene                                                   
rAF: off                                                                        
GPU resources: shader pipelines compiled                                        
Resume cost: warm (1 frame)                                                     
When: post-init, post-unload                                                    
────────────────────────────────────────                                            
State: LOADING                                                                  
What's loaded: scene in flight                                                      
rAF: off                                                                            
GPU resources: BVH/texture workers running                                      
Resume cost: —                                                                      
When: transitional                                                                
────────────────────────────────────────
State: RUNNING                                                                      
What's loaded: scene, visible
rAF: on                                                                             
GPU resources: full working set                                                   
Resume cost: instant
When: user looking at it
────────────────────────────────────────
State: PAUSED
What's loaded: scene, hidden tab/minimized
rAF: off
GPU resources: full working set
Resume cost: instant (1 frame)
When: tab hidden, window minimized
────────────────────────────────────────
State: SUSPENDED
What's loaded: scene, UI hidden
rAF: off
GPU resources: accumulation textures freed, BVH/textures pinned
Resume cost: ~10ms (realloc RTs)
When: host says "I won't show this for a while"
────────────────────────────────────────
State: HIBERNATED                                                                   
What's loaded: scene metadata only
rAF: off                                                                            
GPU resources: all GPU freed, CPU-side buffers kept                               
Resume cost: ~50–100ms (reupload)
When: low-memory signal from host
────────────────────────────────────────
State: DISPOSING / DISPOSED                                                         
What's loaded: nothing
rAF: off                                                                            
GPU resources: none                                                               
Resume cost: —
When: user permanently quits plugin

Not all states need to exist day-one — RUNNING ↔ PAUSED ↔ SUSPENDED is the minimum. 
HIBERNATED matters for the "complex host modeling app" memory pressure scenario.
                                                                                    
Lifecycle methods the plugin must expose                                            

Engine-level (once per session)                                                     
- create(opts) → Promise<Rayzee> — async, adapter + pipeline compile. Idempotent. 
- dispose() — permanent. Already exists; good.                                      

Canvas/DOM (may happen many times per session)                                      
- attachCanvas(canvas) — mount to a host-provided surface                         
- detachCanvas() — release the canvas ref, keep engine alive (for host to re-mount  
later)                                                                            
                                                                                    
Scene (the hot path)                                                              
- loadScene(sceneDescriptor) — full load/replace                                    
- unloadScene() — drop scene, stay in READY. Already exists; good.                  
- updateScene(patch) — delta update for common edits:             
- { transforms: [{meshId, matrix}] } → BVH refit (fast)                           
- { materials: [{matId, props}] } → material buffer write (very fast)             
- { camera: {...} } → uniform update (trivial)                                    
- { topology: [...] } → fall back to full rebuild                                 
- isLoading / isReady getters. isLoading already exists.                            
                                                                                    
Power states (the new surface)                                                      
- start() / resume() — enter RUNNING                                                
- pause() — enter PAUSED (already exists as pause())                                
- suspend() — drop accumulation targets, keep BVH/textures                          
- hibernate() — drop GPU buffers, keep CPU-side scene data                          
- wake() — transition from any paused/suspended/hibernated state back to RUNNING.   
Auto-reallocates what was freed.                                                    
                                                                                    
Query                                                                             
- getState() — current state enum                                                   
- getMemoryStats() — CPU bytes, GPU bytes, texture atlas count                    
- Events: stateChanged, memoryPressure, contextLost, loadProgress, renderComplete,  
error                                                                               
                                                                                    
Host-side ownership contract (prevents leaks)                                       
                                                                                    
Rayzee must treat host-owned data as borrowed, not owned:                           
- sceneDescriptor passed to loadScene() is copied into Rayzee's buffers; Rayzee
never retains a ref to host geometry/materials after load completes. unloadScene()  
must release the copies.                                                          
- Host textures passed by GPUTexture handle or ImageBitmap — Rayzee uploads to its  
own atlas, does not store the handle.                                             
- Rayzee's destroy() is mandatory for permanent close. Host WeakRef-wraps the Rayzee
instance so if it ever forgets to destroy, at least no cycles prevent GC.          
                                                                                    
Listener discipline (already implemented via _addTrackedListener):                
- Every subscription the plugin creates on host objects must be tracked and removed 
on detachCanvas() or dispose().                                                     
- Host subscriptions into Rayzee must use the returned unsubscribe function — no raw
addEventListener without a matching removeEventListener.                           
                                                                                    
Fast-reopen strategy
                                                                                    
The host should choose based on expected reopen latency:                            

┌────────────────────────────────────┬───────────────────────────────────────┐      
│     Expected gap before reopen     │        State to enter on close        │    
├────────────────────────────────────┼───────────────────────────────────────┤      
│ < 1 min (tab switch, panel toggle) │ PAUSED (cheap)                        │    
├────────────────────────────────────┼───────────────────────────────────────┤      
│ < 10 min (workflow break)          │ SUSPENDED (frees ~40% of working set) │      
├────────────────────────────────────┼───────────────────────────────────────┤      
│ > 10 min, low memory pressure      │ HIBERNATED (frees ~90%)               │      
├────────────────────────────────────┼───────────────────────────────────────┤      
│ Never again this session           │ DISPOSE (full teardown)               │    
└────────────────────────────────────┴───────────────────────────────────────┘      
                                                                                
Host can start a timer on pause() and auto-escalate: pause → 5 min → suspend → 30   
min → hibernate.                                                                  
                                                                                    
What's missing in Rayzee today (vs this ideal)                                      

┌──────────────────────────┬────────────────────────────────────────────────────┐   
│         Concept          │                       Status                       │ 
├──────────────────────────┼────────────────────────────────────────────────────┤   
│ create() / init() /      │ ✅ exists, idempotent                              │
│ dispose()                │                                                    │   
├──────────────────────────┼────────────────────────────────────────────────────┤   
│ unloadScene()            │ ✅ just added                                      │
├──────────────────────────┼────────────────────────────────────────────────────┤   
│ loadScene() (full)       │ ✅ exists                                          │   
├──────────────────────────┼────────────────────────────────────────────────────┤
│ updateScene() partial —  │ ✅ refitBLASes / refitBVH already                  │   
│ transforms               │                                                    │ 
├──────────────────────────┼────────────────────────────────────────────────────┤   
│ updateScene() partial —  │ ✅ setMaterialProperty                             │ 
│ materials                │                                                    │   
├──────────────────────────┼────────────────────────────────────────────────────┤
│ pause() / resume()       │ ✅ exists but only RAF-level                       │   
├──────────────────────────┼────────────────────────────────────────────────────┤ 
│ suspend() / hibernate()  │ ❌ missing                                         │   
├──────────────────────────┼────────────────────────────────────────────────────┤ 
│ attachCanvas() /         │ ❌ canvas is baked in at construction              │   
│ detachCanvas()           │                                                    │ 
├──────────────────────────┼────────────────────────────────────────────────────┤   
│ getState() state machine │ ❌ scattered across isInitialized, _paused,        │ 
│                          │ _disposed, _loadingInProgress, pauseRendering      │
├──────────────────────────┼────────────────────────────────────────────────────┤
│ getMemoryStats()         │ ❌ missing                                         │
├──────────────────────────┼────────────────────────────────────────────────────┤   
│ memoryPressure /         │ ❌ missing                                         │
│ contextLost events       │                                                    │   
├──────────────────────────┼────────────────────────────────────────────────────┤ 
│ WebGPU context-lost      │ ❌ missing                                         │
│ recovery                 │                                                    │   
├──────────────────────────┼────────────────────────────────────────────────────┤
│ Host-owned data borrow   │ ⚠️  partial — AssetLoader disposes prior model, but │   
│ contract                 │  no docs/enforcement                               │   
└──────────────────────────┴────────────────────────────────────────────────────┘
                                                                                    
Recommended order if you want to build this                                       

1. Formal state machine — collapse the 5 scattered flags into one state property + a
transition table. This is cheap and immediately reveals illegal transitions (e.g.
unloadScene during LOADING).                                                        
1. detachCanvas() / attachCanvas() — needed before you can open/close a plugin    
window without full dispose.                                                        
1. suspend() / wake() — free only the ping-pong accumulation targets + storage
textures; keep shaders, BVH, material atlas. Biggest bang per unit work.            
1. updateScene() as a single entry point — currently the delta-update surface is  
scattered (setMaterialProperty, setMeshVisibility, refitBLASes, etc). Unify so the  
host has one call.                                                                
1. hibernate() + memoryPressure event — required for the "complex host modeling app"
constraint. Lets host evict Rayzee under pressure without losing scene data.       
1. contextLost recovery — WebGPU devices can be lost. Currently crashes.
                                                                                    
Want me to draft the state-machine refactor first (item 1), or go straight for      
attach/detachCanvas (item 2) since that's the load-bearing piece for                
reopen-without-redispose?                            
