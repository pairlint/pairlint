# pairlint

Check WCAG contrast for every text and background pair in your design tokens, in every mode.

```
dark
  ✗ color.text.secondary on color.surface.raised
    4.37:1 (#80868b on #202124), needs 4.5:1 for body text (WCAG 1.4.3 AA)
    Try: point color.text.secondary at {color.gray.400} (6.09:1)
    tokens/dark.json:6:7
  ✓ 11 pairs pass

1 failed, 23 passed across 2 modes (WCAG AA)
```

- Reads W3C Design Tokens (DTCG), Tokens Studio, Style Dictionary and CSS custom properties, follows aliases, and merges several files per mode.
- Checks every pair you describe in every mode: light, dark, high contrast, and every brand × theme combination.
- Handles translucent colors, OKLCH, OKLab and Display P3.
- Compares exactly. 4.499:1 does not pass 4.5:1, and the report never rounds a failure up.
- Points at the file, line and column of the token to fix, and suggests the nearest shade that passes.
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

| Setting    | What it does                                                                                                               | Default                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `tokens`   | Token files for a single mode. Next to `modes`, files every mode loads first.                                              |                            |
| `modes`    | Token files per mode, as `{ "light": [...], "dark": [...] }`, or groups that combine. See [Modes](#modes-and-token-files). |                            |
| `pairs`    | Which tokens are checked against which. Required.                                                                          |                            |
| `level`    | `"AA"` or `"AAA"`.                                                                                                         | `"AA"`                     |
| `base`     | The color translucent backgrounds sit on. One color, or one per mode.                                                      | `"#ffffff"`                |
| `format`   | For JSON files: `"auto"`, `"dtcg"`, `"tokens-studio"` or `"style-dictionary"`. `.css` files are always read as CSS.        | `"auto"`                   |
| `baseline` | The baseline file, relative to the config. See [Adopting pairlint](#adopting-pairlint-on-an-existing-design-system).       | `"pairlint.baseline.json"` |

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
- `modes`: check this pair only in some modes, such as `["dark"]`. With [groups](#brand--theme-combinations), `"dark"` means every brand in its dark theme.
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

Files every mode shares can go in `tokens`. They load before each mode's own files:

```jsonc
{
  "tokens": ["tokens/core.json"],
  "modes": { "light": ["tokens/light.json"], "dark": ["tokens/dark.json"] }
}
```

pairlint only reads files inside the folder that holds its config.

### Brand × theme combinations

When a mode is an object instead of a list, it is a group. Groups combine, so two brands and two themes become four modes, each checked on its own:

```jsonc
{
  "tokens": ["tokens/core.json"],
  "modes": {
    "brand": { "acme": ["brands/acme.json"], "zen": ["brands/zen.json"] },
    "theme": { "light": ["themes/light.json"], "dark": ["themes/dark.json"] }
  },
  "base": { "dark": "{color.gray.950}" }
}
```

The modes are named `acme/light`, `acme/dark`, `zen/light` and `zen/dark`. Files load in order: `tokens`, then the first group, then the next, so a theme can override a brand.

Wherever a mode name goes (pair `modes`, `base`, `--mode`), you can use a full name like `"zen/dark"` or one value like `"dark"` for every mode that has it. In `base`, a full name wins over a single value. Groups can add up to 256 modes.

### Style Dictionary

Style Dictionary 3 files (tokens with `value` and an optional `comment`) are detected automatically. References like `{color.base.blue.value}` resolve to the token. Style Dictionary 4 projects that use the DTCG format are read as DTCG. pairlint reads JSON token files only and never runs JavaScript configs.

### CSS custom properties

Point pairlint at a `.css` file and each custom property becomes a token named without its `--`: `--text-muted` is `text-muted`. `var(--gray-500)` is an alias, and `var(--brand, #0057ff)` uses its fallback when `--brand` is not defined.

By default pairlint reads `:root` and `html` rules. Add `#` and a selector or media query to read a theme instead, and list the default first so the theme only has to override what changes:

```jsonc
{
  "modes": {
    "light": ["theme.css"],
    "dark": ["theme.css", "theme.css#[data-theme=dark]"],
    "system-dark": ["theme.css", "theme.css#@media (prefers-color-scheme: dark)"]
  }
}
```

Selectors are matched exactly, with spacing and quotes ignored. `@layer` and `@supports` blocks are read as if they were not there, and nested rules and `&` work. When nothing matches, the error lists the selectors in the file that do have custom properties. pairlint reads the CSS without running anything and skips every declaration that is not a custom property.

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
pairlint explain <fg> <bg> [options]
pairlint baseline --reason <text> --owner <name> [--expires <date>]

  -c, --config <path>   Config file (default: ./pairlint.config.json)
  -f, --format <name>   text, json, sarif, markdown or html (default: text)
  -o, --output <path>   Write the report to a file instead of the terminal
  -l, --level <level>   AA or AAA, overrides the config
  -m, --mode <name>     Check only this mode. Repeat for more than one
      --verbose         List passing, exempt and baselined pairs too
      --ignore-baseline Report baselined failures as failures
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

### Reports

| Format     | For                                     | What you get                                                                                  |
| ---------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `text`     | You, in a terminal                      | Failures grouped by mode, with fixes and file locations                                       |
| `json`     | Scripts                                 | Every result, ratio, color, suggestion and location. Versioned with `"schemaVersion": 1`      |
| `sarif`    | GitHub code scanning                    | SARIF 2.1.0. Failures show up as annotations on the token's line in pull requests             |
| `markdown` | Pull request comments and job summaries | A short summary and a table of failures with suggested fixes                                  |
| `html`     | Designers and stakeholders              | One self-contained page with color samples, ratios and fix previews, in light and dark themes |

The HTML report has no scripts and loads nothing from the network, so you can attach it to a ticket or open it offline. It meets WCAG AA itself, and a test checks that.

### Fix suggestions

For each failing pair, pairlint suggests the smallest change that passes:

1. If the token is an alias into a scale, like `{color.gray.500}`, it suggests the nearest shade in that scale that passes, for example `{color.gray.400}`. Your design system stays intact.
2. If no foreground shade works, it tries the background's scale.
3. Otherwise it suggests a new value with only the OKLCH lightness changed, keeping hue, chroma and alpha. The value is checked after rounding to hex, so it really passes.

### Explaining one pair

```sh
npx pairlint explain color.text.secondary color.surface.raised
```

```
color.text.secondary on color.surface.raised (dark)
  ✗ 4.37:1 (#80868b on #202124), needs 4.5:1 for body text (WCAG 1.4.3 AA)
  foreground  color.text.secondary → color.gray.500
              #80868b  tokens/dark.json:6:7
  background  color.surface.raised → color.gray.900
              #202124  tokens/dark.json:12:7
  base        #121212
  blended     #80868b on #202124
  Try: point color.text.secondary at {color.gray.400} (6.09:1)
```

It shows every alias step, each token's own color, the base color, and the colors after blending. It works for any two tokens, even ones not in your pairs, which are then checked as body text. Add `--mode` to limit it to one mode, or `--format json` for scripts.

## Adopting pairlint on an existing design system

A large token set will probably have failures on day one. A baseline lets you turn pairlint on now and fail only on new problems.

```sh
npx pairlint baseline --reason "Gray ramp redesign, planned for Q1" --owner @design-systems --expires 2027-03-31
```

This writes `pairlint.baseline.json` with one entry per current failure:

```json
{
  "version": 1,
  "entries": [
    {
      "mode": "dark",
      "fg": "color.text.secondary",
      "bg": "color.surface.raised",
      "use": "body",
      "reason": "Gray ramp redesign, planned for Q1",
      "owner": "@design-systems",
      "expires": "2027-03-31"
    }
  ]
}
```

Commit it. From then on:

- A failure listed in the baseline is reported as **baselined** and does not fail the build.
- Every entry needs a `reason` and an `owner`. pairlint refuses entries without them, so nothing is accepted silently.
- After its `expires` date, an entry stops counting and the pair fails again, with its owner and reason shown. Leave `expires` out to accept a failure until it is fixed.
- Entries are matched by mode, tokens and use, not by color. Changing the color re-checks the pair.
- When a baselined pair passes, or is no longer checked, pairlint warns you to remove its entry.
- Running `pairlint baseline` again keeps existing entries with their reasons, adds new failures with the reason and owner you give, and removes entries that are no longer needed. Edit the file by hand to give single entries better reasons.
- `--ignore-baseline` shows every failure, baselined or not.

Pairs that cannot be checked at all, like a broken alias, can never be baselined. Fix those first.

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
      - run: npx --yes pairlint@0.1.0 --format markdown --output "$GITHUB_STEP_SUMMARY"
```

The Markdown summary shows on the workflow run page. To see failures as annotations on the token files in pull requests, also upload SARIF to code scanning:

```yaml
permissions:
  contents: read
  security-events: write
steps:
  # checkout and setup-node as above
  - run: npx --yes pairlint@0.1.0 --format sarif --output pairlint.sarif
  - if: always()
    uses: github/codeql-action/upload-sarif@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3
    with:
      sarif_file: pairlint.sarif
```

Pin actions by commit SHA and pairlint by exact version, as shown, so nothing changes under you.

## What pairlint does not do

- **It is not a conformance claim.** Passing means your token pairs meet the WCAG 2.2 contrast ratios. A site also needs those tokens used in the right places, and much more.
- **It cannot check gradients or images.** Only flat colors and translucent layers.
- **It does not use APCA.** WCAG 3 has not settled on a contrast method. An informational APCA column may come later, but it will never fail a build on its own.
- **It does not read computed values in CSS.** `calc()`, `color-mix()`, `light-dark()` and relative colors are reported as values pairlint cannot parse, with the file and line.
- **Not yet:** a Figma plugin. See the [roadmap](https://github.com/pairlint/pairlint/issues).

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
