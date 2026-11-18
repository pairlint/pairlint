### pairlint: 4 contrast failures

4 failed, 20 passed, 6 exempt across 2 modes (WCAG AA).

| Mode | Foreground | Background | Contrast | Needs | Suggested fix | Where |
|---|---|---|---|---|---|---|
| dark | `color.border.default` | `color.surface.overlay` | 2.23:1 | 3:1 UI | `{color.gray.500}` (3.66:1) | `tokens/dark.json:16:7` |
| dark | `color.border.default` | `color.surface.raised` | 2.66:1 | 3:1 UI | `{color.gray.500}` (4.37:1) | `tokens/dark.json:16:7` |
| dark | `color.text.secondary` | `color.surface.overlay` | 3.66:1 | 4.5:1 body text | `{color.gray.400}` (5.11:1) | `tokens/dark.json:6:7` |
| dark | `color.text.secondary` | `color.surface.raised` | 4.37:1 | 4.5:1 body text | `{color.gray.400}` (6.09:1) | `tokens/dark.json:6:7` |

<details><summary>1 warning</summary>

- dark: color.text.link is outside the sRGB gamut, so results that use it are approximate (`tokens/dark.json:8:7`)

</details>
