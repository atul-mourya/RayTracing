import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

createRoot( document.getElementById( 'root' ) ).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// Log the application version
console.log( `RayTracing v${__APP_VERSION__} (Built: ${new Date( __BUILD_DATE__ ).toLocaleString()})` );
