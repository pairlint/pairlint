# Contributing

Thanks for helping. Bug reports with a small token file that shows the problem are the most useful thing you can send.

## Setup

You need Node 22.14 or newer.

```sh
npm ci
npm run ci
```

`npm run ci` runs everything CI runs: lint, build, type checks, tests, the security check on published code and the install size budget.

## Repository layout

```
packages/
  tokens-core/   reads token files: DTCG, Tokens Studio, aliases, modes, source positions
  contrast/      color parsing, conversion, gamut mapping and WCAG math
  cli/           the pairlint command: config, checks, reports
scripts/         CI checks and release helpers
```

`tokens-core` knows nothing about contrast, and `contrast` knows nothing about tokens. Keep it that way: other tools will build on `tokens-core`.

## Rules for changes

- **Every change comes with tests.** Bug fixes include a test that failed before the fix.
- **No runtime dependencies.** If you think one is needed, open an issue first.
- **Golden files change only on purpose.** Output snapshots live in `packages/cli/test/fixtures`. If your change alters them, run `npx vitest run -u`, read the diff and explain it in the pull request.
- **No breaking changes in minor or patch releases.** Anything that can make a passing project fail is a major change.
- **Clear messages.** An error should say what is wrong, where, and what to do about it.

## Commits and pull requests

Keep pull requests focused on one change. Describe what changed, why, and how you tested it. All changes to `main` go through a reviewed pull request.

Sign off your commits to certify the [Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "Explain what changed"
```

## Releasing

Maintainers release by bumping every package to the same version, updating `CHANGELOG.md`, merging that pull request, and pushing a `vX.Y.Z` tag. The release workflow checks the tag against the package versions, runs the tests and publishes with provenance.
