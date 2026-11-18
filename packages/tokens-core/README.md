# @pairlint/tokens-core

Reads design token files and gives you resolved tokens with their source positions. No dependencies.

- W3C Design Tokens (DTCG), Tokens Studio and Style Dictionary formats, detected automatically
- CSS custom properties from `:root`, a theme selector or a media query, with `var()` aliases and fallbacks
- Group type inheritance, aliases with cycle detection, and Tokens Studio sets
- Several files merged per mode, later files overriding earlier ones
- File, line and column for every token, for precise error messages

```js
import { TokenSet } from "@pairlint/tokens-core";

const tokens = TokenSet.fromFiles([
  { file: { path: "core.json", text: coreJson } },
  { file: { path: "dark.json", text: darkJson } },
]);

tokens.match("color.text.*");
// ["color.text.primary", "color.text.secondary"]

tokens.resolve("color.text.primary");
// { ok: true, value: "#f8f9fa", type: "color", chain: ["color.text.primary", "color.gray.50"], token: {...} }
```

CSS files are recognized by their `.css` extension. Pass `set` to read a theme:

```js
TokenSet.fromFiles([
  { file: { path: "theme.css", text: css } },
  { file: { path: "theme.css", text: css }, set: "[data-theme=dark]" },
]);
```

It also exports `parseJson`, a small JSON and JSONC parser that records where every key starts.

Part of [pairlint](https://github.com/pairlint/pairlint). MIT licensed.
