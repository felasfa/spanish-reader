# Favicon Typography

## Text

| Property | Value |
|---|---|
| Content | `Sr` (capital S, lowercase r) |
| Color | `white` (`#ffffff`) |

## Font

| Property | Value |
|---|---|
| `font-family` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif` |
| `font-size` | `18` (SVG user units, in a 32×32 viewport) |
| `font-weight` | `700` (bold) |

The font stack is a system UI stack — no web font is loaded. Each OS renders in its native UI typeface:

| Platform | Typeface |
|---|---|
| macOS / iOS | SF Pro |
| Windows | Segoe UI |
| Android / Linux | Roboto / Arial |

## Layout

| Property | Value |
|---|---|
| Canvas | 32×32 SVG viewBox |
| `text-anchor` | `middle` (horizontal center at x=16) |
| `dominant-baseline` | `auto` (baseline at y=23) |
| `x` | `16` (horizontal midpoint) |
| `y` | `23` (baseline; positions text in lower two-thirds of canvas) |

## Shape

| Property | Value |
|---|---|
| Background fill | `#c62828` (same as `--primary` navbar color) |
| Corner radius (`rx` / `ry`) | `6` |
| Inset from edge | `2px` on all sides (rect starts at x=2, y=2) |
