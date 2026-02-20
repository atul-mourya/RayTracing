import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import glsl from 'vite-plugin-glsl';
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
	},
	assetsInclude: [ "**/*.hdr" ],
	plugins: [
		// HTTPS so WebGPU works on remote devices (requires secure context)
		basicSsl(),
		react( {
			babel: {
			  plugins: [
					[ "babel-plugin-react-compiler", ReactCompilerConfig ],
			  ],
			},
		  } ),
		tailwindcss(),
		glsl( {
			include: [ // Glob pattern, or array of glob patterns to import
			  '**/*.glsl', '**/*.wgsl',
			  '**/*.vert', '**/*.frag',
			  '**/*.vs', '**/*.fs'
			],
			exclude: undefined, // Glob pattern, or array of glob patterns to ignore
			warnDuplicatedImports: true, // Warn if the same chunk was imported multiple times
			defaultExtension: 'glsl', // Shader suffix when no extension is specified
			compress: false, // Compress output shader code
			watch: false, // Recompile shader on change
			root: '/' // Directory for root imports
		} ),
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
