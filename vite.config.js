import path from "path";
import react from "@vitejs/plugin-react";
import glsl from 'vite-plugin-glsl';
import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import process from 'process';
const __dirname = path.resolve();

export default defineConfig( {
	base: './',
	assetsInclude: [ "**/*.hdr" ],
	plugins: [
		react(),
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
	define: {
		'process.env': process.env
	}
} );
