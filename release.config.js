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
		'semantic-release-export-data',
		[ '@semantic-release/npm', {
			npmPublish: true,
			pkgRoot: 'rayzee',
		} ],
		[ '@semantic-release/git', {
			assets: [ 'rayzee/package.json', 'rayzee/README.md', 'README.md' ],
			message: 'chore(release): ${nextRelease.version}\n\n${nextRelease.notes}'
		} ],
		// successComment/failComment disabled: commit bodies reference internal
		// parity-gap numbers (#4, #11, ...) that aren't real issues/PRs, which
		// 404s the post-publish comment step.
		[ '@semantic-release/github', {
			successComment: false,
			failComment: false,
		} ]
	],
	debug: true
};

export default config;
