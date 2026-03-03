# Rayzee - Real-Time Path Tracer

A sophisticated rea## 🛠️ Tech Stack

| Category | Technologies |
|----------|-------------|
| **Frontend** | React 19, Vite, TailwindCSS |
| **3D Rendering** | Three.js, WebGPU, TSL Shaders (WGSL) |
| **UI Components** | Radix UI, Lucide Icons |
| **State Management** | Zustand |
| **Denoising** | Intel OIDN Web, Custom ASVGF |
| **Build Tools** | Vite, ESLint, Semantic Release |
| **Performance** | Stats.gl, MeshOptimizer |e path tracing web application that brings physically accurate global illumination to the browser. Built with **Three.js**, **WebGPU**, and **React**, Rayzee delivers production-quality rendering with interactive performance.

🌐 **[Live Demo](https://atul-mourya.github.io/RayTracing/)**


## What is Path Tracing?

Path tracing is a rendering technique that simulates the physical behavior of light by tracing rays as they bounce through a scene. This approach produces photorealistic images with accurate:
- Global illumination and indirect lighting
- Realistic shadows and reflections  
- Complex material interactions
- Caustics and light scattering effects

## ✨ Key Features

### 🚀 Advanced Rendering Engine
- **Real-time Path Tracing**: GPU-accelerated Monte Carlo path tracing with WebGPU and TSL shaders
- **Adaptive Sampling**: Intelligent sample distribution with variance-guided quality control
- **Progressive Rendering**: Continuous quality improvement with accumulation buffer
- **Multi-bounce Transport**: Configurable bounce limits for complex light interactions
- **Tiled Rendering**: Efficient progressive refinement with tile-based processing

### 🎨 Visual Quality Features
- **AI-Powered Denoising**: Intel OIDN integration for clean, artifact-free renders
- **ASVGF Temporal Filtering**: Advanced spatiotemporal noise reduction
- **HDR Environment Mapping**: Image-based lighting with importance sampling
- **Advanced Tone Mapping**: Multiple tone mapping operators (ACES, AgX, Reinhard, etc.)
- **Post-Processing Pipeline**: Bloom, exposure control, and color grading
- **Depth of Field**: Realistic camera simulation with focus controls

### 🎯 Interactive Controls
- **Real-time Parameter Adjustment**: Live editing of all rendering parameters
- **Camera Management**: Multiple camera angles with instant switching
- **Material Editing**: Real-time PBR material property adjustments
- **Environment Controls**: Dynamic HDRI rotation and intensity
- **Debug Visualizations**: Heat maps, sampling patterns, and diagnostic modes

### 🔧 Performance Optimization
- **BVH Acceleration**: Optimized ray-scene intersection with bounding volume hierarchies
- **Mesh Optimization**: Automatic geometry simplification options
- **Interaction Mode**: Reduced quality during camera movement for responsive navigation
- **Firefly Suppression**: Advanced noise reduction for bright pixels

### 💾 Asset Management
- **3D Model Support**: GLB, GLTF, FBX, OBJ, STL, PLY, DAE (Collada), 3MF, USDZ formats
- **Environment Maps**: HDR and EXR format support for realistic lighting
- **Image Formats**: PNG, JPEG, WebP for textures and environments
- **Archive Support**: ZIP files with automatic model detection and extraction
- **Drag & Drop Loading**: Intuitive model and environment loading
- **Built-in Asset Library**: Curated selection of models and HDRI environments
- **Camera Extraction**: Automatic detection of embedded camera positions
- **Material Preservation**: Full PBR material pipeline support

#### Technologies Used
- **Three.js:** For 3D rendering, scene management, and the WebGPU renderer.
- **TSL (Three Shading Language):** To implement the core path tracing logic, compiled to WGSL at runtime.
- **React:** For creating the application’s interactive user interface.
- **Vite:** A fast and modern build tool for development and optimization.

## 🚀 Quick Start

### Prerequisites
- Node.js >= 20.11.1
- Modern browser with WebGPU support (Chrome 113+, Edge 113+, or Firefox Nightly)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/atul-mourya/RayTracing.git
   cd RayTracing
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

4. **Open in browser**
   ```
   http://localhost:5173
   ```

### Build for Production
```bash
npm run build
npm run preview
```

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Toggle rendering pause/play |
| `R` | Reset camera to default position |
| `Esc` | Deselect current object |

## 🎯 Usage Guide

1. **Loading Models**: Drag and drop 3D files (GLB, GLTF, FBX, OBJ, STL, PLY, etc.) or select from the built-in library
2. **Environment Setup**: Choose from 50+ HDRI environments or load custom HDR/EXR files
3. **Quality Control**: Adjust samples per pixel, bounces, and denoising settings in the Path Tracer panel
4. **Camera Control**: Use mouse to navigate, or switch between embedded cameras from loaded models
5. **Material Editing**: Select objects in the outliner to modify PBR material properties
6. **Progressive Rendering**: Watch the path tracer continuously improve image quality over time
7. **Results Management**: Save, organize, and post-process your rendered images

### 📸 Working with Results

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

## 🎨 Features in Detail

### Adaptive Sampling
- **Material Intelligence**: Higher sampling for complex materials
- **Edge Detection**: Increased samples at geometric discontinuities  
- **Convergence Analysis**: Real-time variance tracking and sample redistribution
- **Quality Presets**: Performance, Balanced, and Quality modes

### Denoising Pipeline
- **Intel OIDN**: Production-grade AI denoiser for final output
- **ASVGF**: Real-time spatiotemporal filtering during progressive rendering
- **G-Buffer Integration**: Enhanced denoising with geometric information

### Debug Visualizations
- **Heat Maps**: Visualize sampling density and convergence
- **Triangle Intersection Counts**: Performance debugging
- **Material Properties**: Real-time material parameter visualization
- **Tile Highlighting**: Progressive rendering tile visualization

## 🏗️ Architecture

The application follows a modular architecture:

```
src/
├── core/              # Core path tracing engine
│   ├── PathTracerApp.js  # Main application class
│   ├── Stages/           # Rendering pipeline stages
│   ├── TSL/              # TSL shader modules
│   └── Processor/        # Asset loading and processing
├── components/       # React UI components
├── hooks/           # Custom React hooks
├── store/           # Zustand state management
└── utils/           # Utility functions
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details on:
- Getting started with development
- Code style and conventions
- Testing requirements
- Pull request process
- Issue reporting guidelines

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🎨 Gallery

Experience photorealistic rendering directly in your browser:

![Sample Render 1](public/results/result1.png)
![Sample Render 2](public/results/result2.png)

---

**Built with ❤️ by [Atul Mourya](https://github.com/atul-mourya)**