import path from "path";
import { defineConfig } from "vitest/config";

const __dirname = path.resolve();

export default defineConfig( {
	test: {
		globals: true,
		environment: 'node',
		include: [ 'tests/**/*.test.js' ],
		coverage: {
			provider: 'v8',
			reporter: [
				[ 'text' ],
				[ 'text-summary' ]
			],
			include: [ 'rayzee/src/**/*.js', 'app/src/lib/**/*.js' ],
			exclude: [ '**/.DS_Store', '**/*.md', '**/Workers/**' ],
		},
	},
	resolve: {
		alias: {
			"@/core": path.resolve( __dirname, "rayzee/src" ),
			"@": path.resolve( __dirname, "app/src" ),
			"oidn-web": path.resolve( __dirname, "tests/__mocks__/oidn-web.js" ),
		},
	},
} );
