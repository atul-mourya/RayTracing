import path from "path";
import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";

const __dirname = path.resolve();

export default defineConfig( {
	plugins: [
		topLevelAwait( {
			promiseExportName: "__tla",
			promiseImportName: i => `__tla_${i}`
		} )
	],
	assetsInclude: [ "**/*.hdr" ],
	define: {
		'process.env.NODE_ENV': JSON.stringify( process.env.NODE_ENV )
	},
	build: {
		lib: {
			entry: path.resolve( __dirname, "src/index.js" ),
			name: "Rayzee",
			fileName: ( format ) => `rayzee.${format}.js`,
		},
		outDir: "dist",
		rollupOptions: {
			external: [
				"three",
				/^three\//,
				/^three\/examples\//,
				"oidn-web",
				"onnxruntime-web",
				"stats-gl",
			],
			output: [
				{
					format: "es",
					entryFileNames: "rayzee.es.js",
					globals: { three: "THREE" },
				},
				{
					format: "umd",
					entryFileNames: "rayzee.umd.js",
					name: "Rayzee",
					globals: ( id ) => {

						if ( id === "three" || id.startsWith( "three/" ) || id.startsWith( "three\\/" ) ) return "THREE";
						if ( id === "oidn-web" ) return "OIDNWeb";
						if ( id === "onnxruntime-web" ) return "ort";
						if ( id === "stats-gl" ) return "Stats";
						return id;

					},
				},
			],
		},
		sourcemap: true,
	},
} );
