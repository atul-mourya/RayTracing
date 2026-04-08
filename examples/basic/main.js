import { PathTracerApp } from 'rayzee';

const canvas = document.getElementById('viewport');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const engine = new PathTracerApp(canvas);
await engine.init();
await engine.loadModel('./models/CornellBox1.glb');
await engine.loadEnvironment('./hdri/adams_place_bridge_1k.hdr');
engine.animate();

engine.set('maxBounces', 8);
engine.set('exposure', 1.0);

window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  engine.onResize();
});
