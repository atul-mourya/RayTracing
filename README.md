# Rayzee - Path Tracer Web Application
Welcome to Rayzee, a realtime path tracing web application! Rayzee brings the power of physically accurate light simulation to the web, allowing users to experience advanced rendering techniques directly in their browsers. Built using **Three.js, GLSL shaders,** and **React**, Rayzee is designed for high-quality visual output and interactive performance.

*Project Demo: <https://atul-mourya.github.io/RayTracing/>*


#### What is Path Tracing?
Path tracing is a global illumination algorithm that simulates how light interacts with objects in a scene. By tracing the paths of light rays as they bounce around, path tracing generates photorealistic images with accurate shadows, reflections, refractions, and indirect lighting. It's a widely used technique in the film and gaming industries for producing realistic renders.

#### Key Features
- **Physically-Based Rendering:** Achieve photorealistic lighting and material effects, including metals, glass, and diffuse surfaces.
- **Tile Rendering:** Progressive rendering for smoother interactions, offering both low and high-resolution rendering.
- **Spatiotemporal Blue Noise:** Reduces sampling artifacts and improves convergence in path tracing.
- **Material Data Textures:** Efficient encoding of material properties for faster shader computations.
- **Dynamic Scene Updates:** Real-time updates for geometry and material changes in the rendered scene.
- **React Integration:** A seamless and responsive user interface for interaction and visualization.


#### Technologies Used
- **Three.js:** For 3D rendering and scene management.
- **GLSL:** To implement the core path tracing logic in the fragment shader.
- **React:** For creating the application’s interactive user interface.
- **Vite:** A fast and modern build tool for development and optimization.

#### Who Is This For?
Rayzee is perfect for developers, researchers, and enthusiasts who want to explore the world of advanced real-time rendering. Whether you're interested in studying path tracing algorithms, experimenting with shaders, or building a photorealistic 3D visualization tool, Rayzee provides the tools to help you learn and innovate.

#### Get Started

1. **Clone the Repository**
   ```bash
   git clone
    ```
2. **Install Dependencies**
    ```bash
    npm install
    ```
3. **Run the Development Server**
    ```bash
    npm run dev
    ```
4. **Open the Application**
    ```bash
    http://localhost:5173
    ```
5. **Start Exploring!**

#### More Results
Take a look at some additional renders demonstrating the path tracer's capabilities:

![Sample Render 1](public/results/result1.png)
![Sample Render 2](public/results/result2.png)