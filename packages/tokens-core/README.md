# @pairlint/tokens-core

Reads design token files and gives you resolved tokens with their source positions. No dependencies.

- W3C Design Tokens (DTCG) and Tokens Studio formats, detected automatically
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

It also exports `parseJson`, a small JSON and JSONC parser that records where every key starts.

Part of [pairlint](https://github.com/pairlint/pairlint). MIT licensed.
