# Changelog

## 0.1.0 (unreleased)

First release.

- Check WCAG 2.2 contrast (AA and AAA, body text, large text and UI components) for token pairs in every mode.
- Read DTCG and Tokens Studio files, including multi-set Tokens Studio files, aliases and several files per mode.
- Parse hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`, `color()` and DTCG color objects, with CSS Color 4 gamut mapping.
- Blend translucent foregrounds and backgrounds the way browsers do.
- Text and JSON reports with file, line and column for each problem.
- Exempt pairs with a required reason, custom minimum ratios and per-mode pairs.
