# pairlint

Check WCAG contrast for every text and background pair in your design tokens, in every mode.

```
dark
  ✗ color.text.secondary on color.surface.raised
    4.37:1 (#80868b on #202124), needs 4.5:1 for body text (WCAG 1.4.3 AA)
    tokens/dark.json:6:7
  ✓ 11 pairs pass

1 failed, 23 passed across 2 modes (WCAG AA)
```

- Reads W3C Design Tokens (DTCG) and Tokens Studio files, follows aliases, and merges several files per mode.
- Checks every pair you describe in every mode: light, dark, brand, high contrast.
- Handles translucent colors, OKLCH, OKLab and Display P3.
- Compares exactly. 4.499:1 does not pass 4.5:1, and the report never rounds a failure up.
- Points at the file, line and column of the token to fix.
- Zero runtime dependencies. No network access, no install scripts, works offline.

## Quick start

```sh
npm install --save-dev pairlint
```

Add `pairlint.config.json` next to your tokens:

```jsonc
{
  "modes": {
    "light": ["tokens/core.json", "tokens/light.json"],
    "dark": ["tokens/core.json", "tokens/dark.json"]
  },
  "pairs": [
    { "fg": "color.text.*", "bg": "color.surface.*" },
    { "fg": "color.border.*", "bg": "color.surface.*", "use": "ui" }
  ]
}
```

Run it:

```sh
npx pairlint
```

## Configuration

`pairlint.config.json` accepts comments and trailing commas.

| Setting  | What it does                                                                        | Default     |
| -------- | ----------------------------------------------------------------------------------- | ----------- |
| `tokens` | Token files for a single mode.                                                      |             |
| `modes`  | Token files per mode, as `{ "light": [...], "dark": [...] }`. Use this or `tokens`. |             |
| `pairs`  | Which tokens are checked against which. Required.                                   |             |
| `level`  | `"AA"` or `"AAA"`.                                                                  | `"AA"`      |
| `base`   | The color translucent backgrounds sit on. One color, or one per mode.               | `"#ffffff"` |
| `format` | `"auto"`, `"dtcg"` or `"tokens-studio"`.                                            | `"auto"`    |

### Pairs

Each pair has a foreground (`fg`) and a background (`bg`). Both take a token id, a pattern, or a list of them. Every foreground is checked against every background.

| Pattern              | Matches                                                  |
| -------------------- | -------------------------------------------------------- |
| `color.text.primary` | That token only                                          |
| `color.text.*`       | One level below `color.text`                             |
| `color.text.on-*`    | `color.text.on-brand`, `color.text.on-danger`, and so on |
| `color.surface.**`   | Everything below `color.surface`, at any depth           |

A pattern that matches no color tokens is an error, so a typo cannot quietly pass.

`use` sets the threshold:

| `use`              | AA          | AAA         | WCAG         |
| ------------------ | ----------- | ----------- | ------------ |
| `"body"` (default) | 4.5:1       | 7:1         | 1.4.3, 1.4.6 |
| `"large"`          | 3:1         | 4.5:1       | 1.4.3, 1.4.6 |
| `"ui"`             | 3:1         | 3:1         | 1.4.11       |
| `"exempt"`         | not checked | not checked |              |

Other pair settings:

- `min`: a custom minimum ratio, such as `5`. It replaces the WCAG threshold for that pair.
- `modes`: check this pair only in some modes, such as `["dark"]`.
- `reason`: required for `"exempt"` pairs, so the next person knows why. An exempt pair overrides every other rule for the same two tokens.

```jsonc
{
  "fg": "color.text.disabled",
  "bg": "color.surface.*",
  "use": "exempt",
  "reason": "Disabled controls are exempt from WCAG 1.4.3"
}
```

### Modes and token files

Files in a mode are merged in order. When two files define the same token, the later one wins, so a shared `core.json` followed by `dark.json` works the way you expect.

For a Tokens Studio file with several sets, pick sets with `#`:

```jsonc
{
  "modes": {
    "light": ["tokens.json#core", "tokens.json#light"],
    "dark": ["tokens.json#core", "tokens.json#dark"]
  }
}
```

Without `#`, every set in the file is read in `$metadata.tokenSetOrder` order.

pairlint only reads files inside the folder that holds its config.

### Translucent colors

A translucent foreground is blended over its background before measuring, the same way a browser draws it. A translucent background is first blended over the mode's `base` color, which can be a color or a token:

```jsonc
{ "base": { "light": "#ffffff", "dark": "{color.gray.950}" } }
```

### Color formats

Hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`, `color(srgb ...)`, `color(srgb-linear ...)`, `color(display-p3 ...)`, `transparent`, `black`, `white`, and DTCG color objects such as `{ "colorSpace": "oklch", "components": [0.6, 0.15, 250] }`.

WCAG 2 contrast is defined in sRGB. Colors outside sRGB are brought in with the CSS Color 4 gamut mapping algorithm, and pairlint warns that results using them are approximate.

## Command line

```
pairlint [check] [options]

  -c, --config <path>   Config file (default: ./pairlint.config.json)
  -f, --format <name>   text or json (default: text)
  -l, --level <level>   AA or AAA, overrides the config
  -m, --mode <name>     Check only this mode. Repeat for more than one
      --verbose         List passing and exempt pairs too
      --color           Force colored output
      --no-color        Disable colored output
```

Color is on in terminals and off in pipes and CI logs. `NO_COLOR` and `FORCE_COLOR` are respected.

| Exit code | Meaning                                  |
| --------- | ---------------------------------------- |
| 0         | Every pair passes                        |
| 1         | At least one pair fails                  |
| 2         | The config or a token file has a problem |
| 3         | pairlint hit a bug. Please report it.    |

`--format json` prints a versioned report (`"schemaVersion": 1`) with every result, ratio, color and source location.

## GitHub Actions

```yaml
name: Contrast
on: pull_request
permissions:
  contents: read
jobs:
  pairlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - run: npx --yes pairlint@0.1.0
```

Pin actions by commit SHA and pairlint by exact version, as shown, so nothing changes under you.

## What pairlint does not do

- **It is not a conformance claim.** Passing means your token pairs meet the WCAG 2.2 contrast ratios. A site also needs those tokens used in the right places, and much more.
- **It cannot check gradients or images.** Only flat colors and translucent layers.
- **It does not use APCA.** WCAG 3 has not settled on a contrast method. An informational APCA column may come later, but it will never fail a build on its own.
- **Not yet:** Style Dictionary and CSS custom property inputs, SARIF and HTML reports, fix suggestions, and a Figma plugin. See the [roadmap](https://github.com/pairlint/pairlint/issues).

## Security

pairlint reads files and prints a report. It has no runtime dependencies, makes no network requests, runs no install scripts and never evaluates code from your project. CI checks the published code for network, process and `eval` access on every change. Releases are published from GitHub Actions with npm provenance. See [SECURITY.md](SECURITY.md).

## Packages

| Package                                         | What it is                                                 |
| ----------------------------------------------- | ---------------------------------------------------------- |
| [`pairlint`](packages/cli)                      | The command-line tool                                      |
| [`@pairlint/contrast`](packages/contrast)       | WCAG contrast math, color parsing and gamut mapping        |
| [`@pairlint/tokens-core`](packages/tokens-core) | Token file reader with aliases, modes and source positions |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
