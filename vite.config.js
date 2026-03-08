import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import basicSsl from '@vitejs/plugin-basic-ssl';
import topLevelAwait from "vite-plugin-top-level-await";
import process from 'process';
const __dirname = path.resolve();

const ReactCompilerConfig = {}; // Define ReactCompilerConfig

export default defineConfig( {
	base: './',
	server: {
		// Expose to LAN
		host: true,
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless',
		},
	},
	assetsInclude: [ "**/*.hdr" ],
	plugins: [
		// HTTPS so WebGPU works on remote devices (requires secure context)
		// basicSsl(),
		react( {
			babel: {
			  plugins: [
					[ "babel-plugin-react-compiler", ReactCompilerConfig ],
			  ],
			},
		  } ),
		tailwindcss(),
		topLevelAwait( {
			promiseExportName: "__tla",
			promiseImportName: i => `__tla_${i}`
		} )
	],
	resolve: {
		alias: {
			"@": path.resolve( __dirname, "./src" ),
		},
	},
	// Only define specific environment variables that are needed
	// Avoid exposing all of process.env for security reasons
	define: {
		'process.env.NODE_ENV': JSON.stringify( process.env.NODE_ENV )
	}
} );
