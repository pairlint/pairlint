# Changelog

## Unreleased

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
