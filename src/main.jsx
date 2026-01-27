import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { logVersion } from './utils/version';

// Initialize WebGPU utilities on window (for console testing)
import './core/WebGPU/index.js';

logVersion();

createRoot( document.getElementById( 'root' ) ).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
