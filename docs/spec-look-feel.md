# Spanish Reader — Look & Feel Specification

## Design Principles

- Clean, minimal, editorial — optimized for reading
- iOS/Safari first (primary use case is phone while reading Spanish)
- No dependencies: no framework, no icon library, no component kit — plain CSS
- Functional over decorative: UI gets out of the way of the content

---

## Color Palette

| Token | Value | Usage |
|---|---|---|
| Background | `#f5f5f7` | Page background |
| Surface | `#ffffff` | Cards, popup, nav |
| Border | `rgba(0,0,0,0.08)` | Card borders, dividers |
| Text primary | `#1d1d1f` | Headings, word in vocab |
| Text secondary | `#6e6e73` | Summary, translation, metadata |
| Accent red | `#c62828` | Selection highlight, buttons, active states |
| Accent red hover | `#b71c1c` | Button hover |
| Danger | `#ff3b30` | Delete/clear buttons |
| Success | — | (not used — confirmations are inline text) |

Selection highlight: `::selection { background: rgba(198,40,40,.2); }` — applied inside the iframe too.

---

## Typography

System font stack throughout:
```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```

| Element | Size | Weight | Color |
|---|---|---|---|
| Nav title | 18px | 600 | primary |
| Card title | 15px | 600 | primary |
| Card summary | 13px | 400 | secondary |
| Card meta (site, date) | 12px | 400 | secondary |
| Vocab word | 15px | 600 | primary |
| Vocab translation | 14px | 400 | secondary |
| Popup word | 20px | 700 | primary |
| Popup translation | 16px | 400 | primary |
| Popup sentence | 14px | 400 | secondary, italic |
| Button | 14–15px | 500–600 | varies |

---

## Layout

### Top Navigation
- Fixed, `height: 52px`, white background, `box-shadow: 0 1px 0 rgba(0,0,0,0.1)`
- Left: app title or back button (in reader)
- Right: action buttons (Import, Clear)
- Content scrolls under nav; page has `padding-top: 52px`

### Cards (Reading List)

```
┌─────────────────────────────────────────┐
│ [img 80×80] Title (bold, 1 line)        │
│             Summary (2 lines, muted)    │
│             Site · Date (small, muted)  │
└─────────────────────────────────────────┘
```

- White background, `border-radius: 12px`, subtle border
- `padding: 12px`, `gap: 12px` between image and text
- Image: `80×80px`, `object-fit: cover`, `border-radius: 8px`, grey fallback background
- Tap highlight: brief opacity reduction (no persistent hover state on mobile)

### Vocabulary Rows

Collapsed:
```
word  ·  translation                          12 Apr  ×
```
- `display: flex; align-items: center; gap: 8px`
- Word bold, translation muted, date right-aligned (`margin-left: auto`), `×` delete icon

Expanded (`.vocab-detail`):
- Spanish sentence in italics, muted
- English sentence translation below
- Subtle top border separating detail from summary row

---

## Translation Popup

Slides up from bottom of screen on mobile; centered/fixed on desktop.

```
┌──────────────────────────────────────┐  ← max-height: 80vh (75vh mobile)
│ ▬ (drag handle)                      │
│ word                            [×]  │  ← popup-header, flex-shrink: 0
├──────────────────────────────────────│
│ English translation                  │  ↑
│                                      │  popup-content
│ Sentence (Spanish, italic)           │  overflow-y: auto
│ Sentence (English)                   │  flex: 1; min-height: 0
│                                      │
│ [Save to vocabulary]                 │  ↓
└──────────────────────────────────────┘
```

**Positioning:**
- Mobile: `position: fixed; bottom: 0; left: 0; right: 0; border-radius: 16px 16px 0 0`
- Desktop: `position: fixed; bottom: 20px; right: 20px; width: 360px; border-radius: 16px`
- `z-index: 1000`, `box-shadow: 0 -4px 24px rgba(0,0,0,0.15)`

**Drag handle:** `4px × 36px` rounded pill, `background: #d1d1d6`, centered in header

**Dismiss gestures:**
- Swipe down ≥ 60px vertically (≤ 80px horizontal drift) on the header area only
- Touches inside `.popup-content` do NOT trigger swipe-dismiss (they scroll the content)

**Save button:**
- Full width, `background: #c62828`, white text, `border-radius: 8px`, `padding: 12px`

---

## Reader View

- Iframe fills the viewport below the nav bar (`width: 100%; height: calc(100vh - 52px); border: none`)
- Loading state: spinner centered in iframe area
- The iframe content is the proxied article — no additional chrome

---

## Buttons

**Primary (Import, Save):**
```css
background: #c62828; color: white; border: none;
border-radius: 8px; padding: 8px 16px; font-weight: 600;
```

**Destructive (Clear, Delete ×):**
```css
color: #ff3b30; background: transparent; border: none;
```

**Nav back button:**
- `←` chevron + "Reading List" text, accent red color

---

## Loading / Empty States

- Loading spinner: simple CSS animation, accent red, centered
- Empty reading list: centered text + instruction to use the bookmarklet
- Empty vocabulary: centered text
- Error (fetch failed): inline red text below the relevant section

---

## Mobile-Specific Rules

```css
@media (max-width: 600px) {
  .translation-popup { max-height: 75vh; }
  /* Cards go full-width with reduced padding */
  .reading-list-card { border-radius: 0; border-left: none; border-right: none; }
}
```

**iOS scroll fix (popup content):**
```css
.popup-content {
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
```

**Tap highlight suppression:**
```css
* { -webkit-tap-highlight-color: transparent; }
```

---

## Context Menu (In-iframe Link Long-press)

Floating card that appears on long-press (600ms) or right-click of links inside the proxied article:

```
┌─────────────────────┐
│ 🌐  Open article    │
├─────────────────────┤
│ 🔖  Save for Later  │
└─────────────────────┘
```

- `min-width: 195px`, `border-radius: 10px`, `box-shadow: 0 8px 28px rgba(0,0,0,.22)`
- Each item: `padding: 13px 16px`, `font-size: 15px`, icon + label with `gap: 10px`
- Positioned to stay within viewport (clamped to edges)
- Dismissed by tapping/clicking outside
