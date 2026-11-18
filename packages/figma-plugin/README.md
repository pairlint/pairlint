# pairlint for Figma

Check WCAG contrast for your Figma color variables in every mode, then export them so pairlint checks the same pairs in CI.

## What it does

1. Reads the color variables in the open file, with every collection, mode and alias.
2. Guesses which variables are text and which are backgrounds from their names, the same way `pairlint init` does, and shows you the pairs as an editable `pairlint.config.json`.
3. Runs the same checking code as the command line and lists every failure per mode, with color samples, the ratio, what WCAG 2.2 requires and a fix from your own palette.
4. Saves `figma-variables.json` (DTCG) and `pairlint.config.json`. Put both in your repository and `npx pairlint` gives the same results in CI.

Collections with one mode are loaded in every mode. One collection with modes such as Light and Dark gives those modes. Several collections with modes, such as Brand and Theme, become groups, so every brand is checked in every theme.

Aliases stay aliases (`{color.gray.900}`), so fixes point at your palette. Colors from libraries are written in as values and marked with the library variable's name. Files set to Display P3 export Display P3 colors.

## Privacy

- The manifest sets `networkAccess` to `none`, so Figma blocks the plugin from reaching any server.
- The panel's content security policy blocks loading anything from outside it.
- The plugin only reads variables. It never changes your file.
- Files are saved by your browser's own download, straight to your computer.

## Try it from source

```sh
npm ci
npm run build
```

In the Figma desktop app, choose Plugins, Development, Import plugin from manifest, and pick `packages/figma-plugin/manifest.json`.

The manifest's `id` is a placeholder for local use. Figma assigns the real one when the plugin is published to the Community.

## Limits

- Only color variables are read. Styles and colors set directly on layers are not.

pairlint checks color contrast, which is one part of WCAG. Passing does not make a product accessible or WCAG conformant. pairlint is not affiliated with or endorsed by W3C, Figma or GitHub. WCAG is a W3C standard. Figma and GitHub are trademarks of their owners.
