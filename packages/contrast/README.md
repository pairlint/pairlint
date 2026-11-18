# @pairlint/contrast

WCAG 2.2 contrast math with modern color parsing. No dependencies.

It computes contrast ratios. It does not decide whether a product is accessible or WCAG conformant. Not affiliated with or endorsed by W3C.

- Parses hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`, `color()` (srgb, srgb-linear, display-p3) and DTCG color objects
- Maps out-of-gamut colors into sRGB with the CSS Color 4 algorithm and tells you it did
- Blends translucent colors the way browsers do
- Exact threshold checks and display formatting that never rounds a failure up to a pass

```js
import { compositeOver, contrastRatio, parseColor, requiredRatio } from "@pairlint/contrast";

const text = parseColor("oklch(0.55 0.02 260)").rgba;
const surface = parseColor("#f8f9fa").rgba;

const ratio = contrastRatio(compositeOver(text, surface), surface);
ratio >= requiredRatio("body", "AA"); // true or false, no rounding
```

Part of [pairlint](https://github.com/pairlint/pairlint). MIT licensed.
