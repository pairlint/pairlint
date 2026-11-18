# Changelog

## Unreleased

- `init` pairs text and borders only with backgrounds they could sit on: their own component's (`button.color` with `button.background-color`), or else the shared surfaces. Different intents (success text on a danger background) and states (hover text on a pressed background) are kept apart, and strong fills (`emphasis`, `solid`, `inverse`) only get their on- colors, preferring fills with the same intent. The config notes how many pairs that makes and lists colors it could not pair. On Primer this cut the pairs per mode from about 78,000 to 1,200.
- Aliases to names with spaces, like `{Light.Moss Green.7}` from a Figma variables export, now resolve instead of failing as "not a color".
- `init` keeps light and dark high contrast apart (`light-high-contrast`, `dark-high-contrast`) and loads each after its base theme. It names CSS themes from attribute values, so `[data-light-theme="dark"]` is a dark theme.
- `init` reads camelCase names (`fgColor-default`, `bgColor-muted`) and CSS property names (`button.color` next to `button.background-color`), leaves disabled backgrounds out of the foregrounds, follows aliases before counting a token as a color, and never writes a pattern that also matches untyped tokens that are not colors.
- `pairlint init` finds token files and CSS custom properties, names modes after the themes it finds, guesses pairs from token names, and writes a commented `pairlint.config.json`. It never overwrites a config without `--force`.
- Official GitHub Action: `uses: pairlint/pairlint@v0.1.0` annotates failing tokens in the pull request diff, writes a job summary, and can write SARIF. Inputs reach the shell only through environment variables.
- New `github` report format: workflow command annotations for each failure and warning.
- `schema.json` ships with the package for editor completion and validation. Point `$schema` at `./node_modules/pairlint/schema.json`.
- SARIF and annotation paths are relative to `GITHUB_WORKSPACE` when it is set, so they work when pairlint runs in a subfolder.
- Releases attach a CycloneDX SBOM for each package. OpenSSF Scorecard runs every week.

- Style Dictionary 3 token files, detected automatically or set with `"format": "style-dictionary"`. References that end in `.value` resolve to the token.
- CSS custom properties as tokens. Files ending in `.css` read `:root` by default, or a theme with `theme.css#[data-theme=dark]` or `theme.css#@media (prefers-color-scheme: dark)`. `var()` becomes an alias and its fallback is used when the target is missing.
- Brand × theme modes: groups inside `modes` combine into every pairing, named like `acme/dark`. Pair `modes`, `base` and `--mode` accept a full name or one value such as `dark`.
- `tokens` can now sit next to `modes` to hold files every mode loads first.
- Fix suggestions only offer shades from a real scale (steps like `500` or `dark`), so a red token is no longer pointed at its green sibling. CSS suggestions are written as `var(--name)`. A background is only nudged to a nearby shade unless nothing else works.
- `--mode` suggests the closest name when it does not match.

- Baselines: `pairlint baseline --reason <text> --owner <name> [--expires <date>]` records today's failures in `pairlint.baseline.json` so only new failures break the build. Entries need a reason and an owner, can expire, and pairlint warns when one is no longer needed. `--ignore-baseline` shows everything. New `baseline` config setting and `baselined` result status.
- New report formats: `sarif` for GitHub code scanning, `markdown` for pull request comments and job summaries, and `html`, a self-contained page for designers with color samples and fix previews.
- New `--output <path>` option writes the report to a file.
- Token suggestions in the JSON report include the suggested shade's `color`.
- Failing pairs now come with a fix suggestion: the nearest passing shade in the same scale, or a new value with only the OKLCH lightness changed.
- New `pairlint explain <fg> <bg>` command shows alias chains, raw and blended colors, the base color and the suggestion for one pair in each mode.
- `@pairlint/contrast` exports `adjustLightness` and `oklabLightness`.

## 0.1.0 (unreleased)

First release.

- Check WCAG 2.2 contrast (AA and AAA, body text, large text and UI components) for token pairs in every mode.
- Read DTCG and Tokens Studio files, including multi-set Tokens Studio files, aliases and several files per mode.
- Parse hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`, `color()` and DTCG color objects, with CSS Color 4 gamut mapping.
- Blend translucent foregrounds and backgrounds the way browsers do.
- Text and JSON reports with file, line and column for each problem.
- Exempt pairs with a required reason, custom minimum ratios and per-mode pairs.
