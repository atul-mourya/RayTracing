const config = {
	branches: [ 'main' ],
	plugins: [
		[ '@semantic-release/commit-analyzer', {
			preset: 'angular',
			releaseRules: [
				{ type: 'docs', scope: 'README', release: 'patch' },
				{ type: 'feat', release: 'minor' },
				{ type: 'fix', release: 'patch' },
				{ type: 'perf', release: 'patch' },
			],
			parserOpts: {
				noteKeywords: [ 'BREAKING CHANGE', 'BREAKING CHANGES' ]
			}
		} ],
		'@semantic-release/release-notes-generator',
		[ '@semantic-release/npm', {
			npmPublish: true,
			pkgRoot: 'rayzee',
		} ],
		[ '@semantic-release/git', {
			assets: [ 'rayzee/package.json' ],
			message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}'
		} ],
		'@semantic-release/github'
	],
	debug: true
};

export default config;
