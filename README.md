# Rayzee - Real-Time Path Tracer

A sophisticated real-time path tracing web application that brings physically accurate global illumination to the browser. Built with **Three.js**, **WebGPU**, and **React**, Rayzee delivers production-quality rendering with interactive performance.

The project is organized as a monorepo with two packages:
- **`rayzee/`** — The standalone rendering engine, publishable to npm
- **`app/`** — The React UI application that wraps the engine

External clients can use the engine independently:
```js
import { PathTracerApp } from 'rayzee';
```

🌐 **[Live Demo](https://atul-mourya.github.io/RayTracing/)**


## What is Path Tracing?

Path tracing is a rendering technique that simulates the physical behavior of light by tracing rays as they bounce through a scene. This approach produces photorealistic images with accurate:
- Global illumination and indirect lighting
- Realistic shadows and reflections
- Complex material interactions
- Caustics and light scattering effects

## Tech Stack

| Category | Technologies |
|----------|-------------|
| **Frontend** | React 19, Vite 7, TailwindCSS 4 |
| **3D Rendering** | Three.js 0.183+, WebGPU, TSL Shaders (WGSL) |
| **UI Components** | Radix UI, Lucide Icons |
| **State Management** | Zustand |
| **Denoising** | Intel OIDN Web, Custom ASVGF |
| **Build Tools** | Vite, ESLint, Semantic Release |
| **Performance** | Stats.gl |

## Key Features

### Advanced Rendering Engine
- **Real-time Path Tracing**: GPU-accelerated Monte Carlo path tracing with WebGPU and TSL shaders
- **Adaptive Sampling**: Intelligent sample distribution with variance-guided quality control
- **Progressive Rendering**: Continuous quality improvement with accumulation buffer
- **Multi-bounce Transport**: Configurable bounce limits for complex light interactions
- **Tiled Rendering**: Efficient progressive refinement with tile-based processing
- **Auto Exposure**: Automatic exposure adjustment for optimal brightness

### Visual Quality Features
- **AI-Powered Denoising**: Intel OIDN integration for clean, artifact-free renders
- **ASVGF Temporal Filtering**: Advanced spatiotemporal noise reduction with motion vectors
- **Bilateral Filtering**: Edge-preserving denoising for real-time quality
- **HDR Environment Mapping**: Image-based lighting with importance sampling
- **Advanced Tone Mapping**: Multiple tone mapping operators (ACES, AgX, Reinhard, etc.)
- **Post-Processing Pipeline**: Bloom, exposure control, and color grading
- **Depth of Field**: Realistic camera simulation with focus controls

### Interactive Controls
- **Real-time Parameter Adjustment**: Live editing of all rendering parameters
- **Camera Management**: Multiple camera angles with instant switching
- **Material Editing**: Real-time PBR material property adjustments
- **Environment Controls**: Dynamic HDRI rotation and intensity
- **Debug Visualizations**: Heat maps, sampling patterns, and diagnostic modes

### Performance Optimization
- **BVH Acceleration**: Optimized ray-scene intersection with bounding volume hierarchies and treelet optimization
- **Web Worker Processing**: Off-main-thread BVH construction and texture processing
- **Interaction Mode**: Reduced quality during camera movement for responsive navigation
- **Firefly Suppression**: Advanced noise reduction for bright pixels

### Asset Management
- **3D Model Support**: GLB, GLTF, FBX, OBJ, STL, PLY, DAE (Collada), 3MF, USDZ formats
- **Environment Maps**: HDR and EXR format support for realistic lighting
- **Image Formats**: PNG, JPEG, WebP for textures and environments
- **Archive Support**: ZIP files with automatic model detection and extraction
- **Drag & Drop Loading**: Intuitive model and environment loading
- **Built-in Asset Library**: Curated selection of models and HDRI environments
- **Camera Extraction**: Automatic detection of embedded camera positions
- **Material Preservation**: Full PBR material pipeline support

## Quick Start

### Prerequisites
- Node.js >= 20.19.0
- Modern browser with WebGPU support (Chrome 113+, Edge 113+, or Firefox Nightly)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/atul-mourya/RayTracing.git
   cd RayTracing
   ```

2. **Install dependencies** (installs both `rayzee/` and `app/` workspaces)
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

4. **Open in browser**
   ```
   http://localhost:5174
   ```

### Build for Production
```bash
npm run build          # Builds both engine and app
npm run build:engine   # Build only the rayzee engine
npm run build:app      # Build only the React app
npm run preview        # Preview the production build locally
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Toggle rendering pause/play |
| `R` | Reset camera to default position |
| `Esc` | Deselect current object |

## Usage Guide

1. **Loading Models**: Drag and drop 3D files (GLB, GLTF, FBX, OBJ, STL, PLY, etc.) or select from the built-in library
2. **Environment Setup**: Choose from 50+ HDRI environments or load custom HDR/EXR files
3. **Quality Control**: Adjust samples per pixel, bounces, and denoising settings in the Path Tracer panel
4. **Camera Control**: Use mouse to navigate, or switch between embedded cameras from loaded models
5. **Material Editing**: Select objects in the outliner to modify PBR material properties
6. **Progressive Rendering**: Watch the path tracer continuously improve image quality over time
7. **Results Management**: Save, organize, and post-process your rendered images

### Working with Results

**Rendering & Saving:**
- Configure final render settings in the "Final Render" panel (resolution, samples, denoising)
- Choose between Regular or Tiled rendering modes for different quality/performance trade-offs
- Save completed renders automatically to the local database with timestamp and metadata
- Access saved renders anytime from the Results panel in the left sidebar

**Results Gallery:**
- Browse all saved renders in a grid layout with thumbnail previews
- View detailed render information including date/time and technical settings
- Delete unwanted renders with one-click removal
- Select any render to view in full resolution in the Results viewport

**Post-Processing Tools:**
- **Color Correction**: Adjust brightness, contrast, saturation, hue, exposure, and gamma
- **Real-time Preview**: See changes instantly as you adjust parameters
- **Original Comparison**: Press and hold on any image to compare with the unprocessed original
- **Non-destructive Editing**: Original renders are preserved; edits are saved as new versions
- **Reset Functionality**: Restore original settings anytime with the reset button

**Export Options:**
- **Screenshot Download**: Export any render (original or edited) as PNG with one click
- **High-Quality Export**: Maintain full resolution and color depth in exported images
- **Organized Gallery**: Browse and manage all saved renders in an intuitive interface

## Architecture

The application follows an event-driven stage-based architecture:

```
├── rayzee/                  # Standalone rendering engine (npm package)
│   └── src/
│       ├── index.js             # Public API
│       ├── PathTracerApp.js     # Main application class
│       ├── managers/            # Focused manager classes
│       │   ├── CameraManager.js     # Camera switching, auto-focus, DOF
│       │   ├── LightManager.js      # Light CRUD, helpers, GPU transfer
│       │   ├── DenoisingManager.js  # Denoiser strategy, OIDN, upscaler
│       │   └── InteractionManager.js# Click-to-select, focus picking
│       ├── Pipeline/            # Stage pipeline infrastructure
│       │   ├── RenderPipeline.js    # Stage execution orchestrator
│       │   ├── RenderStage.js       # Base class for stages
│       │   ├── PipelineContext.js   # Shared state & textures
│       │   └── EventDispatcher.js   # Event bus for stage communication
│       ├── Stages/              # Rendering pipeline stages
│       │   ├── PathTracer.js            # Core Monte Carlo path tracing
│       │   ├── ASVGF.js                # Spatiotemporal denoising
│       │   ├── AdaptiveSampling.js      # Variance-guided sampling
│       │   ├── EdgeFilter.js
│       │   ├── BilateralFilter.js
│       │   ├── NormalDepth.js           # G-buffer generation
│       │   ├── MotionVector.js          # Motion vector computation
│       │   ├── Variance.js
│       │   ├── AutoExposure.js
│       │   └── Compositor.js           # Source select + saturation grade (terminal stage)
│       ├── TSL/                 # TSL shader modules (23 files)
│       │   ├── PathTracer.js        # Main path tracer logic
│       │   ├── BVHTraversal.js      # BVH acceleration traversal
│       │   ├── MaterialSampling.js  # BRDF sampling
│       │   ├── Environment.js       # Environment mapping
│       │   ├── LightsDirect.js      # Direct lighting
│       │   ├── LightsIndirect.js    # Indirect lighting
│       │   └── ...                  # Disney BRDF, transmission, fog, etc.
│       └── Processor/           # Asset loading & processing
│           ├── AssetLoader.js       # GLB/GLTF model loading
│           ├── GeometryExtractor.js # Mesh → triangle data
│           ├── BVHBuilder.js        # BVH acceleration structure
│           ├── TextureCreator.js    # GPU texture generation
│           └── Workers/             # Web Workers for heavy computation
│               ├── BVHWorker.js
│               └── TexturesWorker.js
├── app/                     # React UI application
│   ├── index.html
│   ├── public/              # Static assets
│   └── src/
│       ├── components/          # React UI components
│       │   ├── layout/              # App layout (sidebars, topbar, viewports)
│       │   └── ui/                  # 45+ Radix-based UI components
│       ├── hooks/               # Custom React hooks (9 hooks)
│       ├── services/            # External services & APIs
│       ├── store.js             # Zustand state management
│       └── utils/               # Utility functions
├── tests/                   # Vitest test suites
├── package.json             # Workspace orchestration
├── vitest.config.js
└── eslint.config.js
```

### Rendering Pipeline

Stages execute sequentially, communicating via an event bus:

1. **PathTracer** — Core Monte Carlo path tracing with MRT outputs
2. **NormalDepth** — G-buffer generation (normals + linear depth)
3. **MotionVector** — Per-pixel motion vectors for temporal filtering
4. **Variance** — Per-pixel variance for adaptive sampling
5. **AdaptiveSampling** — Variance-guided sample distribution
6. **ASVGF** — Real-time spatiotemporal denoising
7. **BilateralFilter** — Edge-preserving bilateral filter
8. **EdgeFilter** — Temporal filtering with edge preservation
9. **AutoExposure** — Automatic exposure adjustment
10. **Compositor** — Selects the latest upstream texture, applies saturation, hands off to the renderer's output pass (tone mapping + sRGB)

Tile visualization is handled by the **OverlayManager** (2D canvas overlay), not a pipeline stage.

### Debug Visualizations

Access via Path Tracer tab → Debug Mode:
- `1-2`: BVH traversal statistics (triangle/box tests)
- `3`: Ray distance visualization
- `4`: Surface normals
- `6`: Environment map luminance heat map
- `7`: Environment importance sampling PDF

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details on:
- Getting started with development
- Code style and conventions
- Pull request process
- Issue reporting guidelines

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Gallery

Experience photorealistic rendering directly in your browser:

![Sample Render 1](app/public/results/result1.png)
![Sample Render 2](app/public/results/result2.png)

---

**Built with ❤️ by [Atul Mourya](https://github.com/atul-mourya)**
