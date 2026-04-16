// SceneProcessor.js - Processes scene geometry into GPU-ready data (BVH, textures, materials)
import { Color } from "three";
import { BVHBuilder } from './BVHBuilder.js';
import { BVHRefitter } from './BVHRefitter.js';
import { buildBVHParallel, shouldUseParallelBuild } from './ParallelBVHBuilder.js';
import { TLASBuilder } from './TLASBuilder.js';
import { InstanceTable } from './InstanceTable.js';
import { TextureCreator } from './TextureCreator.js';
import { GeometryExtractor } from './GeometryExtractor.js';
import { EmissiveTriangleBuilder } from './EmissiveTriangleBuilder.js';
import { updateLoading } from '../Processor/utils.js';
import { BuildTimer } from './BuildTimer.js';
import { TRIANGLE_DATA_LAYOUT } from '../EngineDefaults.js';
import { fetchAsWorker } from './Workers/fetchAsWorker.js';

/**
 * SceneProcessor - Processes scene geometry into GPU-ready data:
 * BVH acceleration, texture atlas, material buffers.
 */
export class SceneProcessor {

	/**
     * Create a new SceneProcessor
     * @param {Object} options - Configuration options
     * @param {boolean} [options.useWorkers=true] - Use worker threads when available
     * @param {number} [options.bvhDepth=30] - Maximum BVH tree depth
     * @param {number} [options.maxLeafSize=4] - Maximum triangles per BVH leaf
     * @param {boolean} [options.verbose=false] - Enable verbose logging
     * @param {boolean} [options.useFloat32Array=true] - Use Float32Array for triangle data
     * @param {string} [options.textureQuality='adaptive'] - Texture quality mode
     * @param {boolean} [options.enableTextureCache=true] - Enable texture caching
     */
	constructor( options = {} ) {

		// Configuration options with defaults
		this.config = {
			useWorkers: true, // Enable workers by default for peak performance
			bvhDepth: 30,
			maxLeafSize: 4,
			verbose: false,
			useFloat32Array: true,
			textureQuality: 'adaptive', // 'low', 'medium', 'high', 'adaptive'
			enableTextureCache: true,
			maxConcurrentTextureTasks: Math.min( navigator.hardwareConcurrency || 4, 6 ),
			// Treelet optimization configuration
			treeletSize: 7, // 7 nodes gives 315 topologies for optimal enumeration
			treeletOptimizationPasses: 1,
			treeletMinImprovement: 0.01, // Minimum SAH improvement threshold
			...options
		};

		// Initialize geometry data containers
		this.triangleData = null; // Efficient format (Float32Array)
		this.triangleCount = 0; // Number of triangles
		this.materials = [];
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.roughnessMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.displacementMaps = [];
		this.directionalLights = [];
		this.cameras = [];
		this.spheres = [];
		this.bvhRoot = null;

		// Raw data for storage buffers
		this.bvhData = null;
		this.materialData = null;

		// Two-level BVH (TLAS/BLAS) support
		this.instanceTable = null; // Per-mesh BLAS metadata
		this.originalToBvhMap = null; // Uint32Array: original tri index → BVH-order index (global, for legacy compat)
		this._refitWorker = null;
		this._refitSharedBuffers = null; // SharedArrayBuffer refs for zero-copy refit
		this._rebuildGeneration = 0; // Monotonic counter to discard stale background rebuilds
		this._pendingRebuilds = new Map(); // meshIndex → worker

		// Initialize texture references
		this.albedoTextures = null;
		this.normalTextures = null;
		this.bumpTextures = null;
		this.roughnessTextures = null;
		this.metalnessTextures = null;
		this.emissiveTextures = null;
		this.displacementTextures = null;
		this.emissiveTriangleData = null;
		this.emissiveTriangleCount = 0;
		this.lightBVHNodeData = null;
		this.lightBVHNodeCount = 0;

		// Initialize processing components
		this._initProcessors();

		// Processing state
		this.isProcessing = false;
		this.processingStage = null;

		// Performance tracking
		this.performanceMetrics = {
			textureCreationTime: 0,
			geometryExtractionTime: 0,
			bvhBuildTime: 0,
			totalProcessingTime: 0
		};

	}

	/**
     * Initialize processing components with configuration
     * @private
     */
	_initProcessors() {

		// Create and configure geometry extractor
		this.geometryExtractor = new GeometryExtractor();

		// Create and configure BVH builder
		this.bvhBuilder = new BVHBuilder();
		this.bvhBuilder.maxLeafSize = this.config.maxLeafSize;

		// Configure treelet optimization
		this.bvhBuilder.setTreeletConfig( {
			enabled: this.config.enableTreeletOptimization,
			size: this.config.treeletSize,
			passes: this.config.treeletOptimizationPasses,
			minImprovement: this.config.treeletMinImprovement
		} );

		// Create and configure texture creator
		this.textureCreator = new TextureCreator();
		// The optimized TextureCreator will auto-detect capabilities and select optimal methods

		// Create emissive triangle builder for direct lighting
		this.emissiveTriangleBuilder = new EmissiveTriangleBuilder();

		// Create TLAS builder for two-level BVH
		this.tlasBuilder = new TLASBuilder();

	}

	/**
     * Log message if verbose mode is enabled
     * @private
     */
	_log( message, data ) {

		if ( this.config.verbose ) {

			console.log( `[SceneProcessor] ${message}`, data || '' );

		}

	}

	/**
     * Build the BVH from a 3D object/scene
     * @param {Object3D} object - Three.js object to process
     * @returns {Promise<SceneProcessor>} - This instance (for chaining)
     */
	async buildBVH( object ) {

		if ( this.isProcessing ) {

			throw new Error( "Already processing a scene. Call dispose() first." );

		}

		this.isProcessing = true;
		this.processingStage = 'init';

		const timer = new BuildTimer( `SceneProcessor (${object.name || 'scene'})` );

		try {

			// Reset state before beginning
			this._reset();
			this._log( 'Starting scene processing' );

			// Step 1: Extract geometry (0-20%)
			this.processingStage = 'extraction';
			timer.start( 'Geometry extraction' );
			await this._extractGeometry( object );
			timer.end( 'Geometry extraction' );
			this.performanceMetrics.geometryExtractionTime = timer.getDuration( 'Geometry extraction' );

			// Step 2: BVH + textures in parallel (20-95%)
			// Texture creation only needs GeometryExtractor output (materials + texture maps)
			// BVH construction is independent — run both concurrently
			this.processingStage = 'bvh';
			timer.start( 'BVH construction (worker)' );
			timer.start( 'Material textures (parallel)' );

			let texturesDone = false;
			const bvhPromise = this._buildBVH().then( () => timer.end( 'BVH construction (worker)' ) );
			const texturePromise = this._createMaterialTextures().then( () => {

				timer.end( 'Material textures (parallel)' );
				texturesDone = true;

			} );

			// Await BVH first (it drives progress and reorders triangleData).
			// Emissive extraction needs the final reordered triangle indices,
			// so it runs here — overlapping with any remaining texture work.
			await bvhPromise;

			updateLoading( { status: "Building light data...", progress: 77 } );
			timer.start( 'Emissive extraction + Light BVH' );
			this._buildEmissiveData();
			timer.end( 'Emissive extraction + Light BVH' );

			if ( ! texturesDone ) {

				updateLoading( { status: "Processing material textures...", progress: 80 } );

			}

			await texturePromise;

			this.performanceMetrics.bvhBuildTime = timer.getDuration( 'BVH construction (worker)' );
			this.performanceMetrics.textureCreationTime = timer.getDuration( 'Material textures (parallel)' );

			// Step 3: BVH data is already flattened inside the worker (or sync path).
			// Only fall back to main-thread flattening if bvhData wasn't produced.
			this.processingStage = 'finalize';
			timer.start( 'BVH data packing' );
			if ( this.bvhRoot && ! this.bvhData ) {

				this.bvhData = this.textureCreator.createBVHRawData( this.bvhRoot );

			}

			timer.end( 'BVH data packing' );

			// Create additional scene elements (spheres, etc.)
			this.spheres = this._createSpheres();

			// Calculate total performance
			this.performanceMetrics.totalProcessingTime = performance.now() - timer.totalStart;

			timer.print();

			this.processingStage = 'complete';
			updateLoading( { status: "Scene data ready", progress: 85 } );
			return this;

		} catch ( error ) {

			this.processingStage = 'error';
			console.error( '[SceneProcessor] Processing error:', error );
			updateLoading( {
				status: `Error: ${error.message}`,
				progress: 100
			} );
			throw error;

		} finally {

			this.isProcessing = false;

		}

	}

	/**
     * Extract geometry data from the object
     * @private
     */
	async _extractGeometry( object ) {

		updateLoading( {
			isLoading: true,
			title: "Processing",
			status: "Extracting geometry...",
			progress: 15
		} );
		await new Promise( r => setTimeout( r, 0 ) );

		// 15-25% range for extraction

		this._log( 'Extracting geometry' );
		const startTime = performance.now();

		try {

			// Extract geometry data
			const extractedData = this.geometryExtractor.extract( object );

			this.triangleData = extractedData.triangleData;
			this.triangleCount = extractedData.triangleCount;

			this._log( `Using Float32Array format: ${this.triangleCount} triangles, ${( this.triangleData.byteLength / ( 1024 * 1024 ) ).toFixed( 2 )}MB` );

			// Store other extracted data
			this.materials = extractedData.materials;
			this.materialCount = this.materials.length; // Store material count for feature scanning
			this.meshes = extractedData.meshes;
			this.meshTriangleRanges = extractedData.meshTriangleRanges; // Per-mesh { start, count } for TLAS/BLAS
			this.maps = extractedData.maps;
			this.normalMaps = extractedData.normalMaps;
			this.bumpMaps = extractedData.bumpMaps;
			this.roughnessMaps = extractedData.roughnessMaps;
			this.metalnessMaps = extractedData.metalnessMaps;
			this.emissiveMaps = extractedData.emissiveMaps;
			this.displacementMaps = extractedData.displacementMaps;
			this.directionalLights = extractedData.directionalLights;
			this.cameras = extractedData.cameras;
			this.sceneFeatures = extractedData.sceneFeatures; // Store material feature flags for shader optimization

			const duration = performance.now() - startTime;
			this._log( `Geometry extraction complete (${duration.toFixed( 2 )}ms)`, {
				triangleCount: this.triangleCount,
				materials: this.materials.length,
			} );

			updateLoading( {
				status: `Extracted ${this.triangleCount.toLocaleString()} triangles`,
				progress: 25
			} );

		} catch ( error ) {

			console.error( '[SceneProcessor] Geometry extraction error:', error );
			updateLoading( {
				status: `Extraction error: ${error.message}`,
				progress: 25
			} );
			throw error;

		}

	}

	/**
	 * Build two-level BVH (TLAS/BLAS): one BLAS per mesh, one TLAS over mesh AABBs.
	 * @private
	 */
	async _buildBVH() {

		updateLoading( {
			status: "Building BVH...",
			progress: 25
		} );

		if ( this.triangleCount === 0 ) {

			throw new Error( "No triangles to build BVH from" );

		}

		this._log( 'Building two-level BVH (TLAS/BLAS)' );
		const startTime = performance.now();

		try {

			const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
			const ranges = this.meshTriangleRanges;

			if ( ! ranges || ranges.length === 0 ) {

				throw new Error( "No mesh triangle ranges available for TLAS/BLAS build" );

			}

			// ── Step 1: Build per-mesh BLASes ──

			this.instanceTable = new InstanceTable();
			this.instanceTable.allocate( ranges.length );
			const meshCount = ranges.length;

			const originalTreeletEnabled = this.config.enableTreeletOptimization;
			const LARGE_MESH_THRESHOLD = 200000;

			// Separate into worker-pool tasks and multi-worker parallel tasks
			const poolTasks = [];
			const parallelTasks = [];

			for ( let m = 0; m < meshCount; m ++ ) {

				const range = ranges[ m ];
				if ( range.count === 0 ) continue;

				if ( range.count >= LARGE_MESH_THRESHOLD && shouldUseParallelBuild( range.count ) ) {

					parallelTasks.push( { m, range } );

				} else {

					poolTasks.push( { m, range } );

				}

			}

			// Worker config shared by all builds
			const workerOpts = {
				depth: this.config.bvhDepth,
				treeletOptimization: {
					enabled: originalTreeletEnabled !== false,
					size: this.config.treeletSize,
					passes: this.config.treeletOptimizationPasses,
					minImprovement: this.config.treeletMinImprovement
				},
				reinsertionOptimization: {
					enabled: this.bvhBuilder.enableReinsertionOptimization,
					batchSizeRatio: this.bvhBuilder.reinsertionBatchSizeRatio,
					maxIterations: this.bvhBuilder.reinsertionMaxIterations
				}
			};

			const totalTasks = poolTasks.length + parallelTasks.length;

			// Build all meshes via bounded worker pool (main thread stays free)
			const poolPromise = this._buildBLASesWithPool( poolTasks, workerOpts, ( done ) => {

				updateLoading( {
					status: `Building BLAS ${done + parallelTasks.length}/${totalTasks}...`,
					progress: 25 + Math.floor( ( done / totalTasks ) * 45 )
				} );

			} );

			// Very large meshes use multi-worker parallel builder concurrently
			const parallelPromises = parallelTasks.map( ( { m, range } ) => {

				const meshTriData = this.triangleData.slice(
					range.start * FPT,
					( range.start + range.count ) * FPT
				);

				return buildBVHParallel( meshTriData, this.config.bvhDepth, null, {
					maxLeafSize: this.bvhBuilder.maxLeafSize,
					numBins: this.bvhBuilder.numBins,
					maxBins: this.bvhBuilder.maxBins,
					minBins: this.bvhBuilder.minBins,
					...workerOpts
				} ).then( result => ( { m, range, result } ) );

			} );

			// Await both paths concurrently
			const [ poolResults, parallelResults ] = await Promise.all( [
				poolPromise,
				Promise.all( parallelPromises )
			] );

			// Store all results
			for ( const { m, range, result } of [ ...poolResults, ...parallelResults ] ) {

				if ( result.reorderedTriangles ) {

					this.triangleData.set( result.reorderedTriangles, range.start * FPT );

				}

				this.instanceTable.setEntry( {
					meshIndex: m,
					blasNodeCount: result.bvhData.length / 16,
					triOffset: range.start,
					triCount: range.count,
					originalToBvhMap: result.originalToBvh || null,
					bvhData: result.bvhData,
				} );

			}

			updateLoading( { status: 'Built all BLASes', progress: 70 } );

			// ── Step 2: Assemble BVH buffer ──

			updateLoading( { status: "Building TLAS...", progress: 72 } );

			const validEntries = this.instanceTable.entries.filter( e => e !== null );

			if ( validEntries.length === 1 ) {

				// Single mesh — use BLAS directly as flat BVH (no TLAS wrapper).
				// Avoids per-ray TLAS overhead and the extra branch in traversal.
				const entry = validEntries[ 0 ];
				this.bvhData = entry.bvhData;
				this.instanceTable.assignOffsets( 0 ); // BLAS at offset 0
				this._buildGlobalOriginalToBvhMap();
				entry.originalToBvhMap = null;
				entry.bvhData = null;

			} else {

				// Multi-mesh — build TLAS over mesh AABBs
				this.instanceTable.computeAABBs( this.triangleData );
				const { root: tlasRoot, nodeCount: tlasNodeCount } = this.tlasBuilder.build( validEntries );

				this.instanceTable.assignOffsets( tlasNodeCount );
				const totalNodes = this.instanceTable.totalNodeCount;

				const tlasData = this.tlasBuilder.flatten( tlasRoot, validEntries );

				// Assemble combined buffer: [TLAS][BLAS_0][BLAS_1]...[BLAS_M]
				this.bvhData = new Float32Array( totalNodes * 16 );
				this.bvhData.set( tlasData );

				for ( const entry of validEntries ) {

					const destOffset = entry.blasOffset * 16;
					this.bvhData.set( entry.bvhData, destOffset );
					this._offsetBLASInPlace( destOffset, entry.bvhData.length / 16, entry.blasOffset, entry.triOffset );

				}

				this._buildGlobalOriginalToBvhMap();

				for ( const entry of validEntries ) {

					entry.originalToBvhMap = null;
					entry.bvhData = null;

				}

			}

			this.bvhRoot = true;
			this._disposeRefitWorker();

			const duration = performance.now() - startTime;
			this._log( `BVH complete: ${validEntries.length} mesh(es), ${this.bvhData.length / 16} nodes (${duration.toFixed( 2 )}ms)` );

			updateLoading( {
				status: "BVH construction complete",
				progress: 75
			} );

		} catch ( error ) {

			console.error( '[SceneProcessor] BVH building error:', error );
			updateLoading( {
				status: `BVH error: ${error.message}`,
				progress: 75
			} );
			throw error;

		}

	}

	/**
	 * Adjust BLAS node indices in-place within the combined bvhData buffer.
	 * @private
	 */
	_offsetBLASInPlace( destFloat, nodeCount, nodeOffset, triOffset ) {

		for ( let i = 0; i < nodeCount; i ++ ) {

			const o = destFloat + i * 16;

			if ( this.bvhData[ o + 3 ] === - 1 ) {

				this.bvhData[ o ] += triOffset;

			} else {

				this.bvhData[ o + 3 ] += nodeOffset;
				this.bvhData[ o + 7 ] += nodeOffset;

			}

		}

	}

	/**
	 * Build multiple BLASes using a bounded worker pool.
	 * Each mesh is dispatched to an available BVHWorker; at most poolSize workers run concurrently.
	 *
	 * @param {Array<{m: number, range: {start: number, count: number}}>} tasks
	 * @param {Object} opts - Worker build options (depth, treeletOptimization, reinsertionOptimization)
	 * @param {Function} onProgress - Called with (completedCount) as builds finish
	 * @returns {Promise<Array<{m, range, result}>>}
	 * @private
	 */
	_buildBLASesWithPool( tasks, opts, onProgress ) {

		if ( tasks.length === 0 ) return Promise.resolve( [] );

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const poolSize = Math.min( tasks.length, this.config.maxConcurrentTextureTasks || 4 );
		const results = [];
		let nextTask = 0;
		let completed = 0;

		return new Promise( ( resolve, reject ) => {

			const workers = [];

			const dispatchNext = ( worker ) => {

				if ( nextTask >= tasks.length ) {

					// No more tasks — terminate this worker
					worker.terminate();
					workers.splice( workers.indexOf( worker ), 1 );
					if ( workers.length === 0 ) resolve( results );
					return;

				}

				const { m, range } = tasks[ nextTask ++ ];
				const meshTriData = this.triangleData.slice(
					range.start * FPT,
					( range.start + range.count ) * FPT
				);

				// Disable treelet for tiny meshes
				const triCount = range.count;
				const treeletOpts = triCount <= 500
					? { ...opts.treeletOptimization, enabled: false }
					: opts.treeletOptimization;

				worker._currentTask = { m, range };
				worker.postMessage( {
					triangleData: meshTriData.buffer,
					triangleByteOffset: meshTriData.byteOffset,
					triangleByteLength: meshTriData.byteLength,
					triangleCount: triCount,
					depth: opts.depth,
					reportProgress: false,
					sharedReorderBuffer: null,
					treeletOptimization: treeletOpts,
					reinsertionOptimization: opts.reinsertionOptimization,
				}, [ meshTriData.buffer ] );

			};

			const onWorkerMessage = ( worker, e ) => {

				const data = e.data;

				if ( data.error ) {

					workers.forEach( w => w.terminate() );
					reject( new Error( data.error ) );
					return;

				}

				if ( data.progress !== undefined ) return; // Ignore progress messages

				const { m, range } = worker._currentTask;
				results.push( {
					m,
					range,
					result: {
						bvhData: data.bvhData,
						reorderedTriangles: data.triangles || null,
						originalToBvh: data.originalToBvh || null,
					}
				} );

				completed ++;
				onProgress?.( completed );

				dispatchNext( worker );

			};

			// Spin up the pool
			( async () => {

				for ( let i = 0; i < poolSize; i ++ ) {

					let worker;
					try {

						worker = new Worker(
							new URL( './Workers/BVHWorker.js', import.meta.url ),
							{ type: 'module' }
						);

					} catch ( e ) {

						if ( e.name !== 'SecurityError' ) { reject( e ); return; }
						worker = await fetchAsWorker(
							new URL( './Workers/BVHWorker.js', import.meta.url )
						);

					}

					worker.onmessage = ( e ) => onWorkerMessage( worker, e );
					worker.onerror = ( err ) => {

						workers.forEach( w => w.terminate() );
						reject( err );

					};

					workers.push( worker );
					dispatchNext( worker );

				}

			} )().catch( reject );

		} );

	}

	/**
	 * Build global originalToBvhMap and per-mesh bvhToOriginal maps.
	 * The inverse map enables cache-friendly sequential writes during position updates.
	 * @private
	 */
	_buildGlobalOriginalToBvhMap() {

		this.originalToBvhMap = new Uint32Array( this.triangleCount );

		for ( const entry of this.instanceTable.entries ) {

			if ( ! entry ) continue;

			// Build per-mesh bvhToOriginal (inverse map for sequential writes)
			const bvhToOrig = new Uint32Array( entry.triCount );

			if ( entry.originalToBvhMap ) {

				for ( let i = 0; i < entry.triCount; i ++ ) {

					const bvhLocal = entry.originalToBvhMap[ i ];
					this.originalToBvhMap[ entry.triOffset + i ] = entry.triOffset + bvhLocal;
					bvhToOrig[ bvhLocal ] = i;

				}

			} else {

				for ( let i = 0; i < entry.triCount; i ++ ) {

					this.originalToBvhMap[ entry.triOffset + i ] = entry.triOffset + i;
					bvhToOrig[ i ] = i;

				}

			}

			entry.bvhToOriginal = bvhToOrig;

		}

	}

	/**
     * Create material textures and emissive data concurrently with BVH.
     * Only depends on GeometryExtractor output, NOT on BVH.
     * @private
     */
	async _createMaterialTextures() {

		this._log( 'Creating material textures (parallel with BVH)' );

		try {

			// Material raw data for storage buffers (sync, ~1-5ms)
			if ( this.materials?.length ) {

				this.materialData = this.textureCreator.createMaterialRawData( this.materials );

			}

			// Material texture arrays → GPU DataArrayTextures
			// All 7 map types are independent — process in parallel
			const mapTypesList = [
				{ data: this.maps, prop: 'albedoTextures' },
				{ data: this.normalMaps, prop: 'normalTextures' },
				{ data: this.bumpMaps, prop: 'bumpTextures' },
				{ data: this.roughnessMaps, prop: 'roughnessTextures' },
				{ data: this.metalnessMaps, prop: 'metalnessTextures' },
				{ data: this.emissiveMaps, prop: 'emissiveTextures' },
				{ data: this.displacementMaps, prop: 'displacementTextures' },
			];

			await Promise.all(
				mapTypesList
					.filter( ( { data } ) => data?.length > 0 )
					.map( ( { data, prop } ) =>
						this.textureCreator.createTexturesToDataTexture( data )
							.then( result => {

								this[ prop ] = result;

							} )
					)
			);

			this._log( 'Material textures complete', {
				materialData: !! this.materialData,
			} );

		} catch ( error ) {

			console.error( '[SceneProcessor] Texture creation error:', error );
			throw error;

		}

	}

	/**
	 * Extract emissive triangles and build Light BVH.
	 * MUST run after BVH reordering — emissive data stores triangle indices
	 * that reference the main triangle storage buffer.
	 * @private
	 */
	_buildEmissiveData() {

		this.emissiveTriangleCount = this.emissiveTriangleBuilder.extractEmissiveTriangles(
			this.triangleData,
			this.materials,
			this.triangleCount
		);

		this.emissiveTriangleData = this.emissiveTriangleBuilder.createEmissiveRawData();
		this.emissiveTotalPower = this.emissiveTriangleBuilder.totalEmissivePower;
		this._log( 'Emissive triangle extraction complete', this.emissiveTriangleBuilder.getStats() );

		// Build Light BVH for spatially-aware emissive sampling
		this.emissiveTriangleBuilder.buildLightBVH();
		this.lightBVHNodeData = this.emissiveTriangleBuilder.lightBVHNodeData;
		this.lightBVHNodeCount = this.emissiveTriangleBuilder.lightBVHNodeCount;
		// Replace emissiveTriangleData with sorted version (LBVH reorders it)
		this.emissiveTriangleData = this.emissiveTriangleBuilder.emissiveTriangleData || this.emissiveTriangleData;

	}

	/**
     * Create additional sphere objects if needed
     * @private
     */
	_createSpheres() {

		// Factory method for creating any additional scene elements
		// Currently returns an empty array by default
		// const white = new Color( 0xffffff );
		// const black = new Color( 0x000000 );
		return [
			// { position: new Vector3( - 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( - 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },

			// { position: new Vector3( 0, 2, 0 ), radius: 1, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
		];

	}

	/**
     * Reset all data before processing a new scene
     * @private
     */
	_reset() {

		// First dispose any existing resources
		this._disposeTextures();

		// Reset all containers
		this.triangles = [];
		this.triangleData = null;
		this.triangleCount = 0;
		this.materials = [];
		this.meshTriangleRanges = null;
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.roughnessMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.displacementMaps = [];
		this.directionalLights = [];
		this.cameras = [];
		this.spheres = [];
		this.bvhRoot = null;
		this.bvhData = null;
		this.instanceTable = null;
		this.lightBVHNodeData = null;
		this.lightBVHNodeCount = 0;

		// Reset performance metrics
		this.performanceMetrics = {
			textureCreationTime: 0,
			geometryExtractionTime: 0,
			bvhBuildTime: 0,
			totalProcessingTime: 0
		};

	}

	/**
     * Dispose of texture resources
     * @private
     */
	_disposeTextures() {

		const textureProps = [
			'albedoTextures', 'normalTextures', 'bumpTextures', 'roughnessTextures',
			'metalnessTextures', 'emissiveTextures', 'displacementTextures'
		];

		// Dispose each texture if it exists
		textureProps.forEach( prop => {

			if ( this[ prop ] ) {

				if ( typeof this[ prop ].dispose === 'function' ) {

					this[ prop ].dispose();

				}

				this[ prop ] = null;

			}

		} );

	}

	/**
     * Rebuild only materials and textures without touching triangle/BVH data
     * @param {Object3D} object - Three.js object to extract materials from
     * @returns {Promise<SceneProcessor>} - This instance (for chaining)
     */
	async rebuildMaterials( object ) {

		if ( this.isProcessing ) {

			throw new Error( "Already processing. Cannot rebuild materials during processing." );

		}

		this._log( 'Rebuilding materials and textures' );
		const startTime = performance.now();

		try {

			// Set processing flag to prevent concurrent operations
			this.isProcessing = true;

			// Extract only material-related data from the scene (skip geometry extraction)
			const extractedData = this.geometryExtractor.extractMaterialsOnly( object );

			// Dispose old texture resources BEFORE updating arrays
			this._disposeMaterialTextures();

			// Update material arrays (but keep existing triangle data)
			this.materials = extractedData.materials;
			this.materialCount = this.materials.length; // Update material count
			this.meshes = extractedData.meshes; // Update mesh data
			this.maps = extractedData.maps;
			this.normalMaps = extractedData.normalMaps;
			this.bumpMaps = extractedData.bumpMaps;
			this.roughnessMaps = extractedData.roughnessMaps;
			this.metalnessMaps = extractedData.metalnessMaps;
			this.emissiveMaps = extractedData.emissiveMaps;
			this.displacementMaps = extractedData.displacementMaps;
			this.sceneFeatures = extractedData.sceneFeatures; // Update material feature flags

			// Create new material and texture data only
			const params = {
				materials: this.materials,
				triangles: this.triangleData, // Reuse existing triangle data
				maps: this.maps,
				normalMaps: this.normalMaps,
				bumpMaps: this.bumpMaps,
				roughnessMaps: this.roughnessMaps,
				metalnessMaps: this.metalnessMaps,
				emissiveMaps: this.emissiveMaps,
				displacementMaps: this.displacementMaps,
				bvhRoot: this.bvhRoot // Reuse existing BVH
			};

			// Create only material and texture-related textures
			const textures = await this.textureCreator.createMaterialTextures( params );

			// Regenerate raw material data for storage buffers
			this.materialData = this.textureCreator.createMaterialRawData( this.materials );

			// Update texture references (keep triangle and BVH data unchanged)
			this.albedoTextures = textures.albedoTexture;
			this.normalTextures = textures.normalTexture;
			this.bumpTextures = textures.bumpTexture;
			this.roughnessTextures = textures.roughnessTexture;
			this.metalnessTextures = textures.metalnessTexture;
			this.emissiveTextures = textures.emissiveTexture;
			this.displacementTextures = textures.displacementTexture;

			const duration = performance.now() - startTime;
			this._log( `Material rebuild complete (${duration.toFixed( 2 )}ms)`, {
				materials: this.materials.length,
				textures: this.maps.length
			} );

			return this;

		} catch ( error ) {

			console.error( '[SceneProcessor] Material rebuild error:', error );
			throw error;

		} finally {

			// Always clear processing flag
			this.isProcessing = false;

		}

	}

	/**
     * Dispose only material-related textures
     * @private
     */
	_disposeMaterialTextures() {

		const materialTextureProps = [
			'albedoTextures', 'normalTextures',
			'bumpTextures', 'roughnessTextures', 'metalnessTextures', 'emissiveTextures',
			'displacementTextures'
		];

		materialTextureProps.forEach( prop => {

			if ( this[ prop ] ) {

				try {

					if ( typeof this[ prop ].dispose === 'function' ) {

						this[ prop ].dispose();

					}

				} catch ( error ) {

					console.warn( `[SceneProcessor] Error disposing ${prop}:`, error );

				} finally {

					this[ prop ] = null;

				}

			}

		} );

		// Clear texture creator cache to prevent stale references
		if ( this.textureCreator && this.textureCreator.textureCache ) {

			this.textureCreator.textureCache.dispose();
			this.textureCreator.textureCache = new ( this.textureCreator.textureCache.constructor )();

		}

	}

	/**
     * Get statistics about the current state
     * @returns {Object} - Statistics object
     */
	getStatistics() {

		const baseStats = {
			triangleCount: this.triangleCount,
			materialCount: this.materials.length,
			textureCount: this.maps.length,
			lightCount: this.directionalLights.length,
			cameraCount: this.cameras.length,
			processingComplete: this.processingStage === 'complete',
			hasBVH: !! this.bvhRoot,
			hasTextures: !! this.materialData && !! this.bvhData,
			useFloat32Array: this.config.useFloat32Array,
			triangleDataSize: this.triangleData ? ( this.triangleData.byteLength / ( 1024 * 1024 ) ).toFixed( 2 ) + 'MB' : '0MB'
		};

		// Add performance metrics
		if ( this.performanceMetrics.totalProcessingTime > 0 ) {

			baseStats.performance = {
				totalTime: this.performanceMetrics.totalProcessingTime,
				textureTime: this.performanceMetrics.textureCreationTime,
				bvhTime: this.performanceMetrics.bvhBuildTime,
				extractionTime: this.performanceMetrics.geometryExtractionTime,
				texturePercentage: ( ( this.performanceMetrics.textureCreationTime / this.performanceMetrics.totalProcessingTime ) * 100 ).toFixed( 1 ) + '%'
			};

		}

		// Add texture creator capabilities if available
		if ( this.textureCreator && this.textureCreator.capabilities ) {

			baseStats.textureCapabilities = this.textureCreator.capabilities;

		}

		return baseStats;

	}

	/**
     * Update configuration
     * @param {Object} newConfig - New configuration options
     */
	updateConfig( newConfig ) {

		Object.assign( this.config, newConfig );

		// Update component configurations
		if ( this.bvhBuilder ) {

			this.bvhBuilder.maxLeafSize = this.config.maxLeafSize;

			// Update treelet optimization configuration
			this.bvhBuilder.setTreeletConfig( {
				enabled: this.config.enableTreeletOptimization,
				size: this.config.treeletSize,
				passes: this.config.treeletOptimizationPasses,
				minImprovement: this.config.treeletMinImprovement
			} );

		}

		// Note: TextureCreator auto-configures based on capabilities
		// but could be enhanced to accept runtime configuration updates

		this._log( 'Configuration updated', this.config );

	}

	// ===== BVH REFIT (Animation Support) =====

	/**
	 * Refit BVH with updated vertex positions (same topology — no triangle add/remove).
	 * O(N) bottom-up AABB update instead of full O(N log N) SAH rebuild.
	 *
	 * @param {Float32Array} newPositions - 9 floats per triangle (ax,ay,az, bx,by,bz, cx,cy,cz) in original mesh order
	 * @returns {Promise<{ refitTimeMs: number }>}
	 */
	async refitBVH( newPositions, newNormals ) {

		if ( ! this.bvhData || ! this.triangleData || ! this.originalToBvhMap ) {

			throw new Error( 'No BVH data available for refit. Run buildBVH() first.' );

		}

		// Lazy-create worker
		if ( ! this._refitWorker ) {

			try {

				this._refitWorker = new Worker(
					new URL( './Workers/BVHRefitWorker.js', import.meta.url ),
					{ type: 'module' }
				);

			} catch ( e ) {

				if ( e.name !== 'SecurityError' ) throw e;
				this._refitWorker = await fetchAsWorker(
					new URL( './Workers/BVHRefitWorker.js', import.meta.url )
				);

			}

		}

		// First call: set up SharedArrayBuffers for zero-copy communication.
		// Worker writes into shared bvh/tri data; main thread reads them for GPU upload.
		// Race-free because _animRefitInFlight guard prevents overlapping calls.
		if ( ! this._refitSharedBuffers ) {

			const sharedBvhBuf = new SharedArrayBuffer( this.bvhData.byteLength );
			const sharedTriBuf = new SharedArrayBuffer( this.triangleData.byteLength );
			const sharedPosBuf = new SharedArrayBuffer( newPositions.byteLength );

			const sharedBvhData = new Float32Array( sharedBvhBuf );
			const sharedTriData = new Float32Array( sharedTriBuf );

			sharedBvhData.set( this.bvhData );
			sharedTriData.set( this.triangleData );

			// Replace local refs with shared views
			this.bvhData = sharedBvhData;
			this.triangleData = sharedTriData;

			// Build bvhToOriginal map (inverse of originalToBvh) for cache-friendly
			// sequential writes in the worker's updateTrianglePositions.
			const triCount = this.originalToBvhMap.length;
			const bvhToOriginal = new Uint32Array( triCount );
			for ( let i = 0; i < triCount; i ++ ) {

				bvhToOriginal[ this.originalToBvhMap[ i ] ] = i;

			}

			this._refitSharedBuffers = {
				bvhBuf: sharedBvhBuf,
				triBuf: sharedTriBuf,
				posBuf: sharedPosBuf,
				posView: new Float32Array( sharedPosBuf ),
			};

			// Send shared buffers + immutable index map to worker (cached there)
			this._refitWorker.postMessage( {
				type: 'init',
				sharedBvhBuf,
				sharedTriBuf,
				sharedPosBuf,
				bvhToOriginal,
			}, [ bvhToOriginal.buffer ] );

		}

		// Write new positions into shared buffer (main thread → worker, zero-copy)
		this._refitSharedBuffers.posView.set( newPositions );

		return new Promise( ( resolve, reject ) => {

			this._refitWorker.onmessage = ( e ) => {

				const msg = e.data;
				if ( msg.type === 'refitComplete' ) {

					// bvhData/triangleData already updated via shared memory.
					// If smooth normals provided, overwrite the face normals the worker computed.
					if ( newNormals ) {

						this._patchSmoothNormals( newNormals );

					}

					resolve( { refitTimeMs: msg.refitTimeMs } );

				} else if ( msg.type === 'error' ) {

					reject( new Error( msg.error ) );

				}

			};

			// Signal worker — no data transfer needed, everything is in shared memory
			this._refitWorker.postMessage( { type: 'refit' } );

		} );

	}

	/**
	 * Overwrite face normals in triangleData with smooth vertex normals (full scene).
	 * @private
	 */
	_patchSmoothNormals( normals ) {

		this._patchNormalsRange( normals, 0, this.originalToBvhMap.length );

	}

	/**
	 * Refit specific BLASes and rebuild TLAS after object transform or per-mesh animation.
	 * Runs on the main thread (fast for per-mesh updates).
	 *
	 * @param {number[]} affectedMeshIndices - Indices into meshTriangleRanges / instanceTable.entries
	 * @param {Float32Array} newPositions - 9 floats per triangle in original mesh order (full scene)
	 * @param {Float32Array} [newNormals] - Optional smooth normals (9 floats per tri)
	 * @returns {{ refitTimeMs: number }}
	 */
	refitBLASes( affectedMeshIndices, newPositions, newNormals ) {

		if ( ! this.instanceTable || ! this.bvhData || ! this.triangleData ) {

			throw new Error( 'No TLAS/BLAS data available. Run buildBVH() first.' );

		}

		const start = performance.now();

		// Lazy-create refitter instance
		if ( ! this._blasRefitter ) {

			this._blasRefitter = new BVHRefitter();

		}

		// Step 1: Update triangle positions and refit each affected BLAS
		for ( const meshIdx of affectedMeshIndices ) {

			const entry = this.instanceTable.entries[ meshIdx ];
			if ( ! entry ) continue;

			// Update triangle positions within this mesh's range
			this._updateMeshTrianglePositions( entry, newPositions );

			// Patch smooth normals for this mesh if provided
			if ( newNormals ) {

				this._patchMeshSmoothNormals( entry, newNormals );

			}

			// Refit this BLAS's nodes
			this._blasRefitter.refitRange(
				this.bvhData,
				this.triangleData,
				entry.blasOffset,
				entry.blasNodeCount
			);

			// Recompute this mesh's AABB for TLAS rebuild
			this.instanceTable.recomputeAABB( meshIdx, this.bvhData, this.triangleData );

		}

		// Step 2: Refit TLAS AABBs in-place (O(tlasNodeCount), no SAH rebuild)
		this._refitTLAS();

		return { refitTimeMs: performance.now() - start };

	}

	/**
	 * Computes the dirty buffer ranges for a set of affected mesh BLASes.
	 * Used for partial GPU upload after per-mesh refit instead of full buffer copy.
	 *
	 * @param {number[]} affectedMeshIndices
	 * @returns {{ triRanges: Array<{offset:number,count:number}>, bvhRanges: Array<{offset:number,count:number}> }}
	 */
	computeBLASDirtyRanges( affectedMeshIndices ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const FPN = 16; // FLOATS_PER_NODE — 4 × vec4 per BVH node
		const triRanges = [];
		const bvhRanges = [];

		for ( const meshIdx of affectedMeshIndices ) {

			const entry = this.instanceTable.entries[ meshIdx ];
			if ( ! entry ) continue;

			triRanges.push( { offset: entry.triOffset * FPT, count: entry.triCount * FPT } );
			bvhRanges.push( { offset: entry.blasOffset * FPN, count: entry.blasNodeCount * FPN } );

		}

		// Always include TLAS range (rebuilt on every refit)
		bvhRanges.push( { offset: 0, count: this.instanceTable.tlasNodeCount * FPN } );

		return { triRanges, bvhRanges };

	}

	/**
	 * Transfers all scene data (geometry, BVH, materials, textures, emissive, lights)
	 * from this SceneProcessor to the PathTracer stage for GPU rendering.
	 *
	 * @param {import('../Stages/PathTracer.js').PathTracer} pathTracer
	 * @param {import('../managers/LightManager.js').LightManager} lightManager
	 * @param {import('three').Scene} meshScene
	 * @param {import('three').Texture|null} environmentTexture
	 * @returns {boolean} false if critical data is missing
	 */
	uploadToPathTracer( pathTracer, lightManager, meshScene, environmentTexture ) {

		if ( ! this.triangleData ) {

			console.error( 'SceneProcessor: Failed to get triangle data' );
			return false;

		}

		pathTracer.setTriangleData( this.triangleData, this.triangleCount );

		if ( ! this.bvhData ) {

			console.error( 'SceneProcessor: Failed to get BVH data' );
			return false;

		}

		pathTracer.setBVHData( this.bvhData );

		if ( this.materialData ) {

			pathTracer.materialData.setMaterialData( this.materialData );

		} else {

			console.warn( 'SceneProcessor: No material data, using defaults' );

		}

		if ( environmentTexture ) {

			pathTracer.environment.setEnvironmentTexture( environmentTexture );

		}

		pathTracer.materialData.setMaterialTextures( {
			albedoMaps: this.albedoTextures,
			normalMaps: this.normalTextures,
			bumpMaps: this.bumpTextures,
			roughnessMaps: this.roughnessTextures,
			metalnessMaps: this.metalnessTextures,
			emissiveMaps: this.emissiveTextures,
			displacementMaps: this.displacementTextures,
		} );

		if ( this.emissiveTriangleData ) {

			pathTracer.setEmissiveTriangleData(
				this.emissiveTriangleData,
				this.emissiveTriangleCount,
				this.emissiveTotalPower,
			);

		}

		if ( this.lightBVHNodeData ) {

			pathTracer.setLightBVHData(
				this.lightBVHNodeData,
				this.lightBVHNodeCount,
			);

		}

		lightManager.transferSceneLights( meshScene );
		return true;

	}

	/**
	 * Updates material emissive data and rebuilds emissive triangle sampling data.
	 * Returns null if no change, or the updated emissive data for GPU upload.
	 *
	 * @param {number} materialIndex
	 * @param {string} property - 'emissive' | 'emissiveIntensity'
	 * @param {*} value
	 * @returns {{ rawData: Float32Array, emissiveCount: number, totalPower: number }|null}
	 */
	updateMaterialEmissive( materialIndex, property, value ) {

		if ( ! this.emissiveTriangleBuilder ) return null;

		const mat = this.materials[ materialIndex ];
		if ( ! mat ) return null;

		if ( property === 'emissive' ) mat.emissive = value;
		else if ( property === 'emissiveIntensity' ) mat.emissiveIntensity = value;

		const changed = this.emissiveTriangleBuilder.updateMaterialEmissive(
			materialIndex, mat,
			this.triangleData, this.materials, this.triangleCount,
		);

		if ( ! changed ) return null;

		return {
			rawData: this.emissiveTriangleBuilder.createEmissiveRawData(),
			emissiveCount: this.emissiveTriangleBuilder.emissiveCount,
			totalPower: this.emissiveTriangleBuilder.totalEmissivePower,
		};

	}

	/**
	 * Update triangle positions for a single mesh entry.
	 * Iterates in BVH order for sequential writes (cache-friendly), random reads from newPositions.
	 * @private
	 */
	_updateMeshTrianglePositions( entry, newPositions ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const PA = TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET;
		const PB = TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET;
		const PC = TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET;
		const NA = TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET;
		const NB = TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET;
		const NC = TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET;

		const bvhToOrig = entry.bvhToOriginal;

		for ( let bvhLocal = 0; bvhLocal < entry.triCount; bvhLocal ++ ) {

			const origLocal = bvhToOrig[ bvhLocal ];
			const dst = ( entry.triOffset + bvhLocal ) * FPT;
			const src = ( entry.triOffset + origLocal ) * 9;

			const ax = newPositions[ src ];
			const ay = newPositions[ src + 1 ];
			const az = newPositions[ src + 2 ];
			const bx = newPositions[ src + 3 ];
			const by = newPositions[ src + 4 ];
			const bz = newPositions[ src + 5 ];
			const cx = newPositions[ src + 6 ];
			const cy = newPositions[ src + 7 ];
			const cz = newPositions[ src + 8 ];

			this.triangleData[ dst + PA ] = ax;
			this.triangleData[ dst + PA + 1 ] = ay;
			this.triangleData[ dst + PA + 2 ] = az;
			this.triangleData[ dst + PB ] = bx;
			this.triangleData[ dst + PB + 1 ] = by;
			this.triangleData[ dst + PB + 2 ] = bz;
			this.triangleData[ dst + PC ] = cx;
			this.triangleData[ dst + PC + 1 ] = cy;
			this.triangleData[ dst + PC + 2 ] = cz;

			const abx = bx - ax, aby = by - ay, abz = bz - az;
			const acx = cx - ax, acy = cy - ay, acz = cz - az;
			const nx = aby * acz - abz * acy;
			const ny = abz * acx - abx * acz;
			const nz = abx * acy - aby * acx;

			this.triangleData[ dst + NA ] = nx;
			this.triangleData[ dst + NA + 1 ] = ny;
			this.triangleData[ dst + NA + 2 ] = nz;
			this.triangleData[ dst + NB ] = nx;
			this.triangleData[ dst + NB + 1 ] = ny;
			this.triangleData[ dst + NB + 2 ] = nz;
			this.triangleData[ dst + NC ] = nx;
			this.triangleData[ dst + NC + 1 ] = ny;
			this.triangleData[ dst + NC + 2 ] = nz;

		}

	}

	/**
	 * Patch smooth normals for a single mesh's triangles.
	 * @private
	 */
	_patchMeshSmoothNormals( entry, normals ) {

		this._patchNormalsRange( normals, entry.triOffset, entry.triCount );

	}

	/**
	 * Shared normal-patching loop for a range of triangles.
	 * @private
	 */
	_patchNormalsRange( normals, startOrig, count ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const NA = TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET;
		const NB = TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET;
		const NC = TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET;

		for ( let i = 0; i < count; i ++ ) {

			const orig = startOrig + i;
			const bvhIdx = this.originalToBvhMap[ orig ];
			const dst = bvhIdx * FPT;
			const src = orig * 9;

			this.triangleData[ dst + NA ] = normals[ src ];
			this.triangleData[ dst + NA + 1 ] = normals[ src + 1 ];
			this.triangleData[ dst + NA + 2 ] = normals[ src + 2 ];
			this.triangleData[ dst + NB ] = normals[ src + 3 ];
			this.triangleData[ dst + NB + 1 ] = normals[ src + 4 ];
			this.triangleData[ dst + NB + 2 ] = normals[ src + 5 ];
			this.triangleData[ dst + NC ] = normals[ src + 6 ];
			this.triangleData[ dst + NC + 1 ] = normals[ src + 7 ];
			this.triangleData[ dst + NC + 2 ] = normals[ src + 8 ];

		}

	}

	/**
	 * Refit TLAS AABBs in-place without rebuilding the tree structure.
	 * O(tlasNodeCount) bottom-up pass — much faster than full SAH rebuild.
	 * @private
	 */
	_refitTLAS() {

		const tlasNodeCount = this.instanceTable.tlasNodeCount;
		const FPN = 16;

		// Grow-only bounds buffer for TLAS refit
		if ( ! this._tlasBounds || this._tlasBounds.length < tlasNodeCount * 6 ) {

			this._tlasBounds = new Float32Array( tlasNodeCount * 6 );

		}

		// Build blasOffset → entry lookup (avoids O(M) .find() per leaf)
		if ( ! this._blasOffsetMap ) {

			this._blasOffsetMap = new Map();

		}

		this._blasOffsetMap.clear();
		for ( const entry of this.instanceTable.entries ) {

			if ( ! entry ) continue;
			this._blasOffsetMap.set( entry.blasOffset, entry );

		}

		// Bottom-up pass: reverse iteration over TLAS nodes
		for ( let i = tlasNodeCount - 1; i >= 0; i -- ) {

			const o = i * FPN;
			const marker = this.bvhData[ o + 3 ];

			if ( marker === - 2 ) {

				// BLAS-pointer leaf: read AABB from instance table
				const blasRoot = this.bvhData[ o ];
				const entry = this._blasOffsetMap.get( blasRoot );
				if ( entry && entry.worldAABB ) {

					const b = i * 6;
					this._tlasBounds[ b ] = entry.worldAABB.minX;
					this._tlasBounds[ b + 1 ] = entry.worldAABB.minY;
					this._tlasBounds[ b + 2 ] = entry.worldAABB.minZ;
					this._tlasBounds[ b + 3 ] = entry.worldAABB.maxX;
					this._tlasBounds[ b + 4 ] = entry.worldAABB.maxY;
					this._tlasBounds[ b + 5 ] = entry.worldAABB.maxZ;

				}

			} else if ( marker >= 0 ) {

				// Inner node: union of children bounds, update bvhData in-place
				const leftIdx = this.bvhData[ o + 3 ];
				const rightIdx = this.bvhData[ o + 7 ];
				const lb = leftIdx * 6;
				const rb = rightIdx * 6;
				const bounds = this._tlasBounds;

				this.bvhData[ o ] = bounds[ lb ];
				this.bvhData[ o + 1 ] = bounds[ lb + 1 ];
				this.bvhData[ o + 2 ] = bounds[ lb + 2 ];
				this.bvhData[ o + 4 ] = bounds[ lb + 3 ];
				this.bvhData[ o + 5 ] = bounds[ lb + 4 ];
				this.bvhData[ o + 6 ] = bounds[ lb + 5 ];

				this.bvhData[ o + 8 ] = bounds[ rb ];
				this.bvhData[ o + 9 ] = bounds[ rb + 1 ];
				this.bvhData[ o + 10 ] = bounds[ rb + 2 ];
				this.bvhData[ o + 12 ] = bounds[ rb + 3 ];
				this.bvhData[ o + 13 ] = bounds[ rb + 4 ];
				this.bvhData[ o + 14 ] = bounds[ rb + 5 ];

				const b = i * 6;
				bounds[ b ] = Math.min( bounds[ lb ], bounds[ rb ] );
				bounds[ b + 1 ] = Math.min( bounds[ lb + 1 ], bounds[ rb + 1 ] );
				bounds[ b + 2 ] = Math.min( bounds[ lb + 2 ], bounds[ rb + 2 ] );
				bounds[ b + 3 ] = Math.max( bounds[ lb + 3 ], bounds[ rb + 3 ] );
				bounds[ b + 4 ] = Math.max( bounds[ lb + 4 ], bounds[ rb + 4 ] );
				bounds[ b + 5 ] = Math.max( bounds[ lb + 5 ], bounds[ rb + 5 ] );

			}

		}

	}

	/**
	 * Schedule background BLAS rebuilds for affected meshes.
	 * Rebuilds optimal SAH BVH in a worker, then swaps into the combined buffer.
	 * Stale rebuilds (object moved again) are discarded via generation counter.
	 *
	 * @param {number[]} meshIndices - Mesh indices to rebuild
	 * @param {Function} onSwap - Called after a successful swap (for GPU upload)
	 */
	scheduleBackgroundRebuild( meshIndices, onSwap ) {

		if ( ! this.instanceTable || ! this.triangleData ) return;

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		this._rebuildGeneration ++;
		const generation = this._rebuildGeneration;

		const dispatchRebuild = ( meshIdx, entry, worker ) => {

			const meshTriData = this.triangleData.slice(
				entry.triOffset * FPT,
				( entry.triOffset + entry.triCount ) * FPT
			);

			this._pendingRebuilds.set( meshIdx, worker );

			worker.onmessage = ( e ) => {

				const data = e.data;
				worker.terminate();
				this._pendingRebuilds.delete( meshIdx );

				if ( data.error ) {

					console.error( `Background BLAS rebuild error (mesh ${meshIdx}):`, data.error );
					return;

				}

				// Discard if object was transformed again since this rebuild started
				if ( generation !== this._rebuildGeneration ) return;

				this._swapBLAS( meshIdx, entry, data, onSwap );

			};

			worker.onerror = ( err ) => {

				console.error( `Background BLAS rebuild worker error (mesh ${meshIdx}):`, err );
				worker.terminate();
				this._pendingRebuilds.delete( meshIdx );

			};

			// Disable treelet for tiny meshes
			const treeletEnabled = entry.triCount > 500;

			worker.postMessage( {
				triangleData: meshTriData.buffer,
				triangleByteOffset: meshTriData.byteOffset,
				triangleByteLength: meshTriData.byteLength,
				triangleCount: entry.triCount,
				depth: this.config.bvhDepth,
				reportProgress: false,
				sharedReorderBuffer: null,
				treeletOptimization: {
					enabled: treeletEnabled,
					size: this.config.treeletSize,
					passes: this.config.treeletOptimizationPasses,
					minImprovement: this.config.treeletMinImprovement
				},
				reinsertionOptimization: {
					enabled: this.bvhBuilder.enableReinsertionOptimization,
					batchSizeRatio: this.bvhBuilder.reinsertionBatchSizeRatio,
					maxIterations: this.bvhBuilder.reinsertionMaxIterations
				},
			}, [ meshTriData.buffer ] );

		};

		for ( const meshIdx of meshIndices ) {

			const entry = this.instanceTable.entries[ meshIdx ];
			if ( ! entry ) continue;

			// Cancel any in-flight rebuild for this mesh
			const existing = this._pendingRebuilds.get( meshIdx );
			if ( existing ) existing.terminate();

			let worker;
			try {

				worker = new Worker(
					new URL( './Workers/BVHWorker.js', import.meta.url ),
					{ type: 'module' }
				);
				dispatchRebuild( meshIdx, entry, worker );

			} catch ( e ) {

				if ( e.name !== 'SecurityError' ) throw e;
				fetchAsWorker(
					new URL( './Workers/BVHWorker.js', import.meta.url )
				).then( w => dispatchRebuild( meshIdx, entry, w ) );

			}

		}

	}

	/**
	 * Swap a rebuilt BLAS into the combined buffer.
	 * @private
	 */
	_swapBLAS( meshIdx, entry, workerData, onSwap ) {

		const FPN = 16;
		const newBvhData = workerData.bvhData;
		const newNodeCount = newBvhData.length / FPN;

		// Node count must match — refit doesn't change topology, rebuild shouldn't either
		// for the same triangle set. If it differs, the buffer layout is invalid.
		if ( newNodeCount !== entry.blasNodeCount ) {

			console.warn( `Background rebuild: node count mismatch for mesh ${meshIdx} (${newNodeCount} vs ${entry.blasNodeCount}), skipping swap` );
			return;

		}

		// Write rebuilt BLAS nodes into the combined buffer at the entry's offset
		const destOffset = entry.blasOffset * FPN;
		this.bvhData.set( newBvhData, destOffset );
		this._offsetBLASInPlace( destOffset, newNodeCount, entry.blasOffset, entry.triOffset );

		// Write reordered triangles back into global array
		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const reorderedTris = workerData.triangles;
		if ( reorderedTris ) {

			this.triangleData.set( reorderedTris, entry.triOffset * FPT );

		}

		// Update per-mesh maps
		const newOrigToBvh = workerData.originalToBvh;
		if ( newOrigToBvh ) {

			// Update global originalToBvhMap for this mesh's range
			for ( let i = 0; i < entry.triCount; i ++ ) {

				this.originalToBvhMap[ entry.triOffset + i ] = entry.triOffset + newOrigToBvh[ i ];

			}

			// Update per-mesh bvhToOriginal
			const bvhToOrig = new Uint32Array( entry.triCount );
			for ( let i = 0; i < entry.triCount; i ++ ) {

				bvhToOrig[ newOrigToBvh[ i ] ] = i;

			}

			entry.bvhToOriginal = bvhToOrig;

		}

		// Recompute AABB and refit TLAS
		this.instanceTable.recomputeAABB( meshIdx, this.bvhData, this.triangleData );
		this._refitTLAS();

		this._log( `Background BLAS rebuild complete for mesh ${meshIdx}` );

		onSwap?.();

	}

	/**
	 * Cancel all pending background rebuilds.
	 */
	cancelBackgroundRebuilds() {

		for ( const worker of this._pendingRebuilds.values() ) {

			worker.terminate();

		}

		this._pendingRebuilds.clear();

	}

	/**
	 * Terminate the refit worker if active.
	 * @private
	 */
	_disposeRefitWorker() {

		if ( this._refitWorker ) {

			this._refitWorker.terminate();
			this._refitWorker = null;

		}

		this._refitSharedBuffers = null;
		this.cancelBackgroundRebuilds();

	}

	/**
     * Completely dispose of all resources
     * Call this when the instance is no longer needed
     */
	dispose() {

		this._log( 'Disposing resources' );

		// Dispose refit worker
		this._disposeRefitWorker();

		// Dispose textures
		this._disposeTextures();

		// Clear all data
		this._reset();

		// Dispose texture creator
		if ( this.textureCreator ) {

			this.textureCreator.dispose();
			this.textureCreator = null;

		}

		// Clear reference to other processing components
		this.geometryExtractor = null;
		this.bvhBuilder = null;
		this.tlasBuilder = null;
		this._blasRefitter = null;

	}

}
