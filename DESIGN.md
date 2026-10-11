# TaskSquad Design System

**Version 1.1 · Source of truth: `packages/portal`**

This is the shared design spec for every TaskSquad surface: the web portal, the macOS app, iOS, mobile, and any future client. The values come from what the portal ships today (Tailwind v4 + shadcn/ui on Radix). The dark theme (§2.7) builds on the macOS palette in `packages/macos/Sources/TaskSquad/Design/Theme.swift`, with **white as the primary color**.

If a platform has to differ (native controls, platform type ramps), keep the **role** and change the **value**, and note the change in that platform's theme file.

---

## 1. Design principles

1. **Quiet chrome, loud content.** The UI is near-monochrome slate. Color is reserved for status, brand moments, and things that need attention.
2. **Dense but breathable.** Work views run on 14px body text and a 4px grid. Marketing pages use 16px or larger with generous vertical rhythm.
3. **One primary action per view.** The solid `primary` button marks it: near-black in light, white in dark. Everything else is `outline`, `ghost`, or `link`.
4. **Status is never color alone.** Every status color comes with a label, an icon, or both.
5. **Same role, same token, on every platform.** Name things by role (`muted-foreground`), never by value (`slate-500`).

---

## 2. Color

### 2.1 Core semantic tokens

The portal defines these in `packages/portal/src/index.css` as `--color-*` (HSL). The hex values below are the canonical form for native apps.

| Token | Role | Light | Dark | Tailwind / CSS |
|---|---|---|---|---|
| `background` | App canvas, inputs, dialogs | `#FFFFFF` | `#17191E` | `bg-background` |
| `foreground` | Primary text | `#020817` | `#E7E9ED` | `text-foreground` |
| `card` | Card surface | `#FFFFFF` | `#1C1F25` | `bg-card` |
| `card-foreground` | Text on card | `#020817` | `#E7E9ED` | `text-card-foreground` |
| `popover` | Menus, popovers, selects | `#FFFFFF` | `#22252C` | `bg-popover` |
| `popover-foreground` | Text on popover | `#020817` | `#E7E9ED` | `text-popover-foreground` |
| `primary` | Primary buttons, selected states, links | `#0F172A` | `#FFFFFF` | `bg-primary` |
| `primary-foreground` | Text/icons on primary | `#F8FAFC` | `#17191E` | `text-primary-foreground` |
| `secondary` | Secondary buttons, secondary badges | `#F1F5F9` | `#252830` | `bg-secondary` |
| `secondary-foreground` | Text on secondary | `#0F172A` | `#FFFFFF` | `text-secondary-foreground` |
| `muted` | Subtle fills, code blocks, hover rows | `#F1F5F9` | `#252830` | `bg-muted` |
| `muted-foreground` | Secondary text, captions, placeholders, inactive icons | `#64748B` | `#A0A7B4` | `text-muted-foreground` |
| `accent` | Hover/focus fill for ghost & outline controls, menu items | `#F1F5F9` | `#2A2E37` | `bg-accent` |
| `accent-foreground` | Text on accent | `#0F172A` | `#FFFFFF` | `text-accent-foreground` |
| `destructive` | Delete/danger buttons, error badges | `#EF4444` | `#F87171` | `bg-destructive` |
| `destructive-foreground` | Text on destructive | `#F8FAFC` | `#17191E` | `text-destructive-foreground` |
| `border` | Every hairline: cards, dividers, sidebar edge | `#E2E8F0` | `#2E323B` | `border-border` (default) |
| `input` | Form control borders | `#E2E8F0` | `#3A3F4A` | `border-input` |
| `ring` | Focus ring | `#020817` | `#FFFFFF` | `ring-ring` |
| `sidebar` *(native only)* | Sidebar surface on desktop apps | `#F8FAFC` | `#121418` | n/a (web sidebar uses `background`) |

> Translucent variants use opacity modifiers on the token, never new hex values: `bg-primary/90` (hover), `bg-muted/30`, `bg-muted/50`, `border-border/50`, `hover:border-primary/50`.

### 2.2 Brand

| Token | Value | Use |
|---|---|---|
| `brand` | `#2563EB` (blue-600) | `theme-color` meta, PWA chrome, active progress spinners, enabled toggles/checkboxes, "info" accents |
| `brand` (dark) | `#7AA7FF` | Same roles, dark appearance |
| `ink` | `#0F1117` | Terminal background, hero shadow tint, dark marketing surfaces |

Brand blue is an **accent**, not the primary-action color. Primary actions stay `primary` (near-black in light mode, near-white in dark).

### 2.3 Status colors

Use these for task, agent, and system state. Each status has a **foreground** (icon or text), a **tint** (background), and a **border** for callouts.

| Status | Foreground (light) | Foreground (dark) | Tint | Border | Example |
|---|---|---|---|---|---|
| Success / done / live | `#16A34A` green-600 | `#4ADE80` | `#F0FDF4` green-50 or `green-500/10` | `#BBF7D0` green-200 | Completed step, active agent |
| Live pulse dot | `#22C55E` green-500 | `#22C55E` | n/a | n/a | `h-2 w-2 rounded-full bg-green-500 animate-pulse` |
| Warning / waiting / supervisor | `#D97706` amber-600 | `#FBBF24` | `#FFFBEB` amber-50 | `#FDE68A` amber-200 | Waiting for input, stuck, limits |
| Error / failed | `#DC2626` red-600 | `#F87171` | `#FEF2F2` red-50 (dark: `red-500/15`) | `#FECACA` red-200 (dark: `red-500/30`) | Failed task, error callout |
| Info / running | `#2563EB` blue-600 | `#7AA7FF` | `#EFF6FF` blue-50 or `blue-500/10` | `blue-500/20` | Running step, informational note |
| Neutral / offline / pending | `#64748B` muted-foreground | `#A0A7B4` | `muted` | `border` | Offline agent, pending task |

**Callout recipe** (error example):
`rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300`

**Task status → badge variant** (keep the mapping the same on every platform):

| Status | Badge |
|---|---|
| `running`, `done`, `idle`, `live`, `accumulating` | `default` |
| `queued`, `waiting_input`, `scheduled`, `stuck`, `wrapping_up` | `secondary` |
| `failed`, `error` | `destructive` |
| `pending`, `offline`, unknown | `outline` |

### 2.4 Illustration / category accents

These appear only in explanatory diagrams (workflow steps, how-it-works). They never carry status meaning. Recipe: `bg-{hue}-500/10 text-{hue}-500`, with icons inside 32–40px rounded tiles.

| Hue | Hex (500) |
|---|---|
| Blue | `#3B82F6` |
| Purple | `#A855F7` |
| Orange | `#F97316` |
| Pink | `#EC4899` |
| Green | `#22C55E` |
| Yellow | `#EAB308` |
| Indigo | `#6366F1` |

### 2.5 Overlays

| Token | Value | Use |
|---|---|---|
| `scrim-modal` | `#000000` @ 80% | Dialog / alert-dialog backdrop |
| `scrim-drawer` | `#000000` @ 50% | Mobile sidebar backdrop |

### 2.6 Contrast notes

- `foreground` on `background`: 20:1. `muted-foreground` on `background`: 4.8:1, which passes AA. On `muted` it drops to about 4.3:1, so don't put long `muted-foreground` text on `muted` fills.
- `destructive-foreground` on `#EF4444` is 3.8:1. That passes for 14px medium button labels as a UI component, but not for body text. Native apps use `#B91C1C` (6.5:1) instead, and web should move to it in a future revision.
- macOS light uses `#526074` for `muted-foreground` and `#CBD5E1` for `input` to get extra contrast on native vibrancy. That's an allowed platform deviation.

### 2.7 Dark theme

Dark mode isn't an inversion of light mode. It has its own rules:

- **White is primary.** Primary buttons, selected nav items, focus rings, and the single most important action on a screen are pure white `#FFFFFF`, with dark text on top.
- **Body text is off-white.** Use `#E7E9ED`, not pure white, so long text doesn't glare and white actions stay the brightest thing on screen.
- **Lighter surfaces mean higher elevation.** Shadows barely show on dark backgrounds, so depth comes from surfaces getting slightly lighter as they rise.

#### Surfaces (darkest → lightest)

| Token | Hex | Use |
|---|---|---|
| `ink` | `#0F1117` | Terminal, code wells, deepest inset areas |
| `sidebar` | `#121418` | Sidebar / navigation rail (sits behind the canvas) |
| `background` | `#17191E` | App canvas, inputs, dialogs on mobile |
| `card` | `#1C1F25` | Cards, list groups, dense panels |
| `popover` | `#22252C` | Menus, popovers, select lists, dialogs (≥640px), toasts |
| `muted` / `secondary` | `#252830` | Subtle fills, code blocks, secondary buttons, segmented-control track |
| `accent` | `#2A2E37` | Hover / pressed fill for ghost, outline, and menu items |

#### Text & icons

| Token | Hex | Contrast on `background` | Use |
|---|---|---|---|
| `primary` | `#FFFFFF` | 17.6:1 | Headings ≥ 24px, primary actions, active nav label, links |
| `foreground` | `#E7E9ED` | 14.5:1 | Body text, default icons |
| `muted-foreground` | `#A0A7B4` | 7.3:1 (6.1:1 on `muted`) | Secondary text, captions, placeholders, inactive icons |
| `subtle-foreground` | `#7A8291` | 4.5:1 | Disabled-looking meta, timestamps on dense rows. Minimum allowed text color |
| `primary-foreground` | `#17191E` | 17.6:1 on white | Text/icons on white primary buttons and default badges |

#### Lines

| Token | Hex | Use |
|---|---|---|
| `border` | `#2E323B` | Hairlines, card edges, dividers, sidebar edge |
| `input` | `#3A3F4A` | Form control borders. A step brighter than `border` so fields read as interactive |
| `ring` | `#FFFFFF` | Focus ring, 2px, offset 2px in `background` |

#### Status (dark)

Foreground colors are lightened (Tailwind 300/400) so they hold contrast. Tints are translucent so they work on any surface.

| Status | Foreground | Contrast | Tint | Border | Callout text |
|---|---|---|---|---|---|
| Success | `#4ADE80` green-400 | 10.1:1 | `green-500/15` | `green-500/30` | `#86EFAC` green-300 |
| Warning | `#FBBF24` amber-400 | 10.5:1 | `amber-500/15` | `amber-500/30` | `#FCD34D` amber-300 |
| Error | `#F87171` red-400 | 6.4:1 | `red-500/15` | `red-500/30` | `#FCA5A5` red-300 |
| Info / brand | `#7AA7FF` | 7.4:1 | `blue-500/15` | `blue-500/30` | `#BFDBFE` blue-200 |
| Neutral | `#A0A7B4` | 7.3:1 | `muted` | `border` | `foreground` |
| Live dot | `#22C55E` green-500 | n/a | n/a | n/a | n/a |

Error callout recipe: `rounded-lg border border-red-500/30 bg-red-500/15 p-3 text-sm text-red-300`

#### Components in dark mode

| Component | Dark treatment |
|---|---|
| Primary button | White fill, `#17191E` label; hover white @ 90%; pressed white @ 80% |
| Destructive button | `#F87171` fill, `#17191E` label (6.4:1); hover @ 90% |
| Secondary button | `#252830` fill, white label; hover `#2A2E37` |
| Outline button | 1px `input` border, transparent fill, `foreground` label; hover `accent` fill, white label |
| Ghost / nav item | Transparent; hover `accent`. **Active nav:** `accent` fill + white label + white icon |
| Input / select / textarea | `background` fill, 1px `input` border, `foreground` text, `muted-foreground` placeholder; focus = white ring |
| Card | `card` fill, 1px `border`, no shadow |
| Popover / menu | `popover` fill, 1px `border`, `0 8px 24px -4px rgb(0 0 0 / .5)` shadow; item hover `accent` |
| Dialog | `popover` fill, 1px `border`, `0 24px 48px -12px rgb(0 0 0 / .6)` shadow; scrim black @ 70% |
| Badge `default` | White fill, `#17191E` text |
| Badge `secondary` / `outline` | `muted` fill / `border` outline, `foreground` text |
| Segmented control | Track `muted`; selected segment `accent` fill + white label; shadow `0 1px 2px rgb(0 0 0 / .4)` |
| Code block / inline code | `ink` fill, 1px `border`; inline code on `muted` |
| Terminal | `ink` fill **with** 1px `border` so it separates from the canvas |
| Scrollbar thumb | `#3A3F4A`, hover `#4A505C` |
| Selection highlight | `#7AA7FF` @ 30% |

#### Dark elevation

| Level | Surface | Shadow |
|---|---|---|
| 0 | `background` | none |
| 1 | `card` | none (border only) |
| 2 | `popover` | `0 8px 24px -4px rgb(0 0 0 / .5)` |
| 3 | `popover` (dialog) | `0 24px 48px -12px rgb(0 0 0 / .6)` |

#### Images & brand assets

- Use `/tasksquad-light.svg` on dark surfaces (`/tasksquad-dark.svg` on light). The dark mark disappears on `#17191E`.
- Screenshots and illustrations get a 1px `border` frame and a `radius-xl` corner; don't put white-background images directly on the canvas.
- Illustration accent tiles (§2.4) switch to `bg-{hue}-500/15 text-{hue}-400`.

#### Implementation

**Web** (`packages/portal/src/index.css`). Follow the OS setting by default, and let a `data-theme` attribute override it:

```css
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* same block as below */ }
}

:root[data-theme="dark"] {
  --color-background: #17191E;
  --color-foreground: #E7E9ED;
  --color-card: #1C1F25;
  --color-card-foreground: #E7E9ED;
  --color-popover: #22252C;
  --color-popover-foreground: #E7E9ED;
  --color-primary: #FFFFFF;
  --color-primary-foreground: #17191E;
  --color-secondary: #252830;
  --color-secondary-foreground: #FFFFFF;
  --color-muted: #252830;
  --color-muted-foreground: #A0A7B4;
  --color-accent: #2A2E37;
  --color-accent-foreground: #FFFFFF;
  --color-destructive: #F87171;
  --color-destructive-foreground: #17191E;
  --color-border: #2E323B;
  --color-input: #3A3F4A;
  --color-ring: #FFFFFF;
  color-scheme: dark;
}
```

**Apple** (`Theme.swift`, `dynamic(light:dark:)`): set `primary` to `0xFFFFFF` (from `0xE7E9ED`), add `card = 0x1C1F25`, `popover = 0x22252C`, `accent = 0x2A2E37`, `subtleForeground = 0x7A8291`, `ink = 0x0F1117`. All other dark values already match.

**Appearance setting:** every app offers **System / Light / Dark**, defaulting to System (see the macOS `AppearancePicker`, §9.10).

---

## 3. Typography

### 3.1 Typefaces

| Role | Stack | Notes |
|---|---|---|
| **Sans (UI)** | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | System font: SF Pro on Apple, Segoe UI on Windows, Roboto on Android. No web font is loaded. Native apps use the platform system font. |
| **Mono (code, IDs, tokens)** | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace` | Inline code, agent names in headers, tokens, commands |
| **Terminal** | `"JetBrains Mono", "Fira Code", monospace` | Only for the live terminal (xterm), 13px, on `ink` `#0F1117` |

Weights in use: **400** regular, **500** medium, **600** semibold, **700** bold. Don't use 300 or 800+.

### 3.2 Type scale

Base unit is `1rem = 16px`. Line heights follow Tailwind v4 defaults.

| Token | Size / Line height | Tailwind | Usage share |
|---|---|---|---|
| `micro` | 9px / 12px | `text-[9px]` | Rare. Dense chart labels only |
| `overline` | 10px / 14px | `text-[10px]` | Uppercase labels, chips, counters |
| `meta` | 11px / 16px | `text-[11px]` | Timestamps, secondary metadata |
| `caption` | 12px / 16px | `text-xs` | **Most used.** Helper text, badges, table meta |
| `body` | 14px / 20px | `text-sm` | **Default app body.** Buttons, inputs, list rows, descriptions |
| `body-lg` | 16px / 24px | `text-base` | Marketing body, long-form reading |
| `title-sm` | 18px / 28px | `text-lg` | Dialog titles, section headings, agent name (mono) |
| `title` | 20px / 28px | `text-xl` | Wordmark in top nav, mobile page title |
| `headline` | 24px / 32px | `text-2xl` | Page titles, marketing section headings |
| `display-sm` | 30px / 36px | `text-3xl` | Hero headline (mobile) |
| `display` | 36px / 40px | `text-4xl` | Pricing figures, large stats |
| `display-lg` | 48px / 1.25 | `text-5xl leading-tight` | Hero headline (≥640px) |

### 3.3 Text styles (role → recipe)

| Style | Recipe |
|---|---|
| Hero | 30→48px, bold, `leading-tight`, `mb-6` |
| Hero sub | 16→18px, regular, `muted-foreground`, max-width 576px (`max-w-xl`) |
| Page title | 24px, semibold (app) or bold (marketing), optional `tracking-tight` |
| Section heading | 24px bold (marketing) / 18px semibold (app) |
| Card title | 24px semibold, `leading-none`, `tracking-tight` |
| Dialog title | 18px semibold, `leading-none`, `tracking-tight` |
| Body | 14px regular, `foreground` |
| Body secondary | 14px regular, `muted-foreground` |
| Label | 14px medium, `leading-none` |
| Button | 14px medium |
| Badge | 12px semibold |
| Overline | 10px semibold/bold, UPPERCASE, `tracking-wider` (0.05em), `muted-foreground` |
| Caption | 12px regular, `muted-foreground` |
| Inline code | mono, 0.8125–0.875em, `muted` fill, 3px radius, `0.15em 0.35em` padding |
| Long-form paragraph | `leading-relaxed` (1.625) |

### 3.4 Letter spacing

| Token | Value | Use |
|---|---|---|
| `tighter` | -0.05em | Big display numerals |
| `tight` | -0.025em | Titles ≥ 18px |
| `normal` | 0 | Everything else |
| `wider` | 0.05em | Uppercase overlines (default for caps) |
| `widest` | 0.1em | Uppercase micro-labels ≤ 10px |

### 3.5 Rich text (Markdown / editor)

Applies to `.prose` (comments, rendered markdown) and `.ProseMirror` (notes editor).

| Element | Spec |
|---|---|
| Base | 14px / 1.5 |
| H1 | 1.5em (prose) / 1.875em (editor), 700, lh 1.2 |
| H2 | 1.25em / 1.375em, 600, lh 1.3 |
| H3 | 1.125em, 600, lh 1.4 |
| Paragraph gap | 0.5em (prose) / 0.6em (editor) |
| Lists | 1.25–1.5em indent, 0.2–0.25em item gap |
| Code block | `muted` fill, 1px `border`, 6px radius, `0.75em 1em` padding, horizontal scroll |
| Blockquote | 3px left rule in `muted-foreground`, 0.75–1em indent, `muted-foreground` text |
| HR | 2px top border in `border` |
| Link | `primary`, underlined, 80% opacity on hover |

---

## 4. Spacing

### 4.1 Grid

**4px base grid.** Every padding, margin, gap, and fixed size is a multiple of 4, with 2px and 6px allowed for optical tweaks inside dense components.

| Token | px | Tailwind | Typical use |
|---|---|---|---|
| `space-0.5` | 2 | `0.5` | Badge vertical padding, icon nudge |
| `space-1` | 4 | `1` | Icon-to-text in tight chips, popover viewport padding |
| `space-1.5` | 6 | `1.5` | Icon gap in compact rows, card header stack |
| `space-2` | 8 | `2` | **Default gap.** Icon + label, button groups, list stacks |
| `space-2.5` | 10 | `2.5` | Badge horizontal padding, compact cards |
| `space-3` | 12 | `3` | Input/small-button horizontal padding, dense card padding |
| `space-4` | 16 | `4` | Button horizontal padding, card padding (dense), mobile page gutter, dialog gap |
| `space-5` | 20 | `5` | Sidebar brand row vertical padding |
| `space-6` | 24 | `6` | Card/dialog padding, desktop gutter (marketing), section bottom margin |
| `space-8` | 32 | `8` | Desktop page padding (app), wide button padding |
| `space-10` | 40 | `10` | Large section stacks, top nav bottom margin (mobile) |
| `space-16` | 64 | `16` | Marketing section spacing (mobile) |
| `space-20` | 80 | `20` | Top nav bottom margin (desktop) |
| `space-24` | 96 | `24` | Marketing section spacing (desktop) |

### 4.2 Usage rules

- **Inline gaps:** icon ↔ label = 8px (6px in compact controls, 4px in micro chips).
- **Stacks:** related items 4–8px apart; form field label ↔ control 8px; form fields 12–16px apart; groups or sections 24–40px apart.
- **Containers:** card padding 24px (16px dense, 10–12px list cards); dialog padding 24px with 16px internal gap; popover padding 16px.
- **Page padding:** app main area 16px mobile, 32px from 640px up. Marketing gutter 16px mobile, 24px from 640px up.
- **Heading margins:** page title → content 16–24px; marketing section heading → content 24px.
- Use `gap-*` on flex/grid instead of margins between siblings.

---

## 5. Radius

| Token | px | Tailwind | Use |
|---|---|---|---|
| `radius-none` | 0 | `rounded-none` | Full-bleed panels, joined edges |
| `radius-xs` | 3 | n/a (CSS) | Inline code |
| `radius-sm` | 4 | `rounded-sm` / `rounded` | Select items, dialog close button, small chips, tiny tags |
| `radius-md` | **6** | `rounded-md` | **Controls:** buttons, inputs, selects, textareas, popovers, menus, code blocks |
| `radius-lg` | **8** | `rounded-lg` | **Containers:** cards, dialogs (≥640px), callouts, list groups |
| `radius-xl` | 12 | `rounded-xl` | Feature/hero panels, screenshot frames, large marketing cards |
| `radius-2xl` | 16 | `rounded-2xl` | Rare. Oversized promotional tiles |
| `radius-full` | 9999 | `rounded-full` | Badges, avatars, status dots, step numbers, pill toggles |

**Nesting rule:** inner radius = outer radius − padding (minimum 4). A 3px-padded segmented control in an 8px track gets 5px segments, as in the macOS `AppearancePicker`.

Native mapping: `Theme.controlRadius = 6`, `Theme.radius = 8`. Use continuous corner curves (`.continuous`) on Apple platforms.

> `--radius: 0.5rem` in `index.css` is legacy shadcn and no utility reads it. Treat the table above as authoritative.

---

## 6. Elevation

The look is flat. Prefer a 1px `border` over a shadow, and save shadows for things that float.

| Token | Value | Tailwind | Use |
|---|---|---|---|
| `elevation-0` | none + 1px border | `border` | Default for cards, list groups, sidebar |
| `elevation-1` | `0 1px 3px 0 rgb(0 0 0 / .10), 0 1px 2px -1px rgb(0 0 0 / .10)` | `shadow-sm` | Card (shadcn default), selected segment |
| `elevation-2` | `0 4px 6px -1px rgb(0 0 0 / .10), 0 2px 4px -2px rgb(0 0 0 / .10)` | `shadow-md` | Popovers, select menus, dropdowns |
| `elevation-3` | `0 10px 15px -3px rgb(0 0 0 / .10), 0 4px 6px -4px rgb(0 0 0 / .10)` | `shadow-lg` | Dialogs, alert dialogs |
| `elevation-hero` | `0 24px 60px -20px rgba(15, 17, 23, .25)` | `shadow-[…]` | Product screenshot frame on marketing pages |

Dark mode uses lighter surfaces plus stronger, softer shadows instead. See §2.7 → Dark elevation.

---

## 7. Layout

### 7.1 Breakpoints

| Name | Min width | What changes |
|---|---|---|
| base | 0 | Single column, 16px gutter, sidebar becomes an off-canvas drawer |
| `sm` | 640px | Page padding 32px, dialogs get rounded corners, dialog footers go horizontal, marketing type steps up |
| `md` | 768px | Persistent sidebar, mobile top bar hidden |
| `lg` | 1024px | Multi-column grids |
| `xl` | 1280px | Wide dashboards |

### 7.2 App shell (authenticated)

```
┌──────────┬───────────────────────────────────────────┐
│ Sidebar  │ Main  (overflow-auto, p-4 → sm:p-8)        │
│ 208px    │                                           │
│ border-r │                                           │
│          │                                           │
│ ──────── │                                           │
│ footer   │                                           │
└──────────┴───────────────────────────────────────────┘
```

| Element | Spec |
|---|---|
| Sidebar width | **208px** desktop (`md:w-52`), **256px** mobile drawer (`w-64`) |
| Sidebar brand row | 20px logo + wordmark 18px bold, padding 16px × 20px |
| Sidebar nav | 8px horizontal inset; items are full-width `ghost` buttons, left-aligned, 16px icon + 8px gap, 4px between items |
| Sidebar footer | `border-t`, 8px padding, 12px muted links |
| Mobile top bar | 12px vertical / 16px horizontal padding, `border-b`, menu button + logo + wordmark |
| Main | `p-4 sm:p-8`, safe-area aware |
| Full-height | `h-screen overflow-hidden` shell; only the main column scrolls |

### 7.3 Marketing / public pages

| Element | Spec |
|---|---|
| Content width | **800px** max (`max-w-[800px] mx-auto`) |
| Gutter | 16px → 24px at `sm` |
| Top padding | 40px → 64px at `sm` (plus safe-area) |
| Top nav | Wordmark 20px bold left; links + primary "Sign in" button right; 16→24px gap |
| Section rhythm | 64px → 96px between sections |

### 7.4 Common content widths

| Width | Use |
|---|---|
| 320–400px | Small dialogs, auth cards, confirm prompts |
| 448px (`max-w-md`) | Forms, login |
| 512px (`max-w-lg`) | Default dialog |
| 576px (`max-w-xl`) | Hero subtitle |
| 672px (`max-w-2xl`) | Reading column, code panels |
| 800px | Marketing column |

### 7.5 Safe areas

Every edge-anchored surface pads for device insets: `env(safe-area-inset-top|bottom)`. Use the `pt-safe` / `pb-safe` / `mt-safe` / `mb-safe` utilities, or `calc(<spacing> + env(...))` when combining with spacing.

---

## 8. Iconography

- **Library:** [Lucide](https://lucide.dev) on every platform (`lucide-react` on web, the `LucideIcon` enum on macOS).
- **Stroke:** 2px (Lucide default). Don't mix filled and outline icons.
- **Color:** inherits `currentColor`. Inactive icons use `muted-foreground`.

| Size | px | Tailwind | Use |
|---|---|---|---|
| `icon-xs` | 12 | `h-3 w-3` | Inside badges, micro buttons, footer links |
| `icon-sm` | 14 | `h-3.5 w-3.5` | Dense rows, compact buttons, meta lines |
| `icon-md` | **16** | `h-4 w-4` | **Default.** Buttons, nav items, inputs, dialog close |
| `icon-lg` | 20 | `h-5 w-5` | Logo, mobile menu, empty-state accents |
| `icon-tile` | 28–32 | `h-7 w-7` / `h-8 w-8` | Circular step numbers, avatar, icon tiles |

Icon ↔ text spacing: `mr-2` (8px) in buttons and nav, `mr-1.5` (6px) in small buttons, `mr-1` (4px) in badges.

---

## 9. Components

All interactive components share:

- **Focus:** 2px `ring` + 2px offset in `background` color (`focus-visible:ring-2 ring-ring ring-offset-2`). Never remove focus without replacing it.
- **Disabled:** 50% opacity and no pointer events (labels: 70%).
- **Transition:** `transition-colors`, 150ms, `cubic-bezier(0.4, 0, 0.2, 1)`.

### 9.1 Button

| Size | Height | Padding X | Radius | Text |
|---|---|---|---|---|
| `sm` | 36px | 12px | 6px | 14px medium |
| `default` | **40px** | 16px | 6px | 14px medium |
| `lg` | 44px | 32px | 6px | 14px medium |
| `icon` | 40 × 40px | n/a | 6px | 16px icon |

| Variant | Rest | Hover |
|---|---|---|
| `default` (primary) | `primary` bg, `primary-foreground` text | `primary` @ 90% |
| `destructive` | `destructive` bg, `destructive-foreground` text | `destructive` @ 90% |
| `outline` | 1px `input` border, `background` fill | `accent` fill |
| `secondary` | `secondary` fill | `secondary` @ 80% |
| `ghost` | transparent | `accent` fill |
| `link` | `primary` text, no fill | underline, 4px offset |

Mobile minimum hit target: 44 × 44px. Pad compact icon buttons with an invisible hit area when needed.

### 9.2 Inputs (text field, select trigger, textarea)

| Property | Value |
|---|---|
| Height | 40px (textarea min 80px) |
| Padding | 12px × 8px |
| Radius | 6px |
| Border | 1px `input` |
| Fill | `background` |
| Text | 14px `foreground`; placeholder `muted-foreground` |
| Focus | 2px `ring`, 2px offset |
| Trailing icon | 16px chevron at 50% opacity (select) |

**Label:** 14px medium, `leading-none`, 8px above the control.
**Helper/error text:** 12px, `muted-foreground` / red-600, 6px below.

### 9.3 Select menu / dropdown / popover

| Property | Menu / Select | Popover |
|---|---|---|
| Radius | 6px | 6px |
| Border | 1px `border` | 1px `border` |
| Fill | `popover` | `popover` |
| Shadow | `elevation-2` | `elevation-2` |
| Padding | 4px viewport | 16px |
| Width | ≥128px, matches trigger | 288px default |
| Offset from trigger | 4px | 4px |
| Item | 14px, 6px vertical, 32px left (check slot) / 8px right, radius 4px, `accent` on focus |
| Group label | 14px semibold |
| Separator | 1px `muted`, 4px vertical margin, bleeds −4px |
| Max height | 384px, then scroll |

### 9.4 Card

| Part | Spec |
|---|---|
| Container | radius 8px, 1px `border`, `card` fill, `elevation-1` (optional) |
| Header | 24px padding, 6px vertical stack |
| Title | 24px semibold, `tracking-tight`, `leading-none` |
| Description | 14px `muted-foreground` |
| Content / footer | 24px padding, no top padding |
| Dense variant | 16px padding, no shadow (`rounded-lg border bg-background p-4`) |
| Interactive list card | 10px padding; on hover the border goes to `primary` @ 50% and the fill to `muted` @ 30% |
| List group | `rounded-lg border divide-y` (rows separated by 1px `border`) |

### 9.5 Dialog / Alert dialog

| Property | Value |
|---|---|
| Width | `100%`, max 512px (small: 400px) |
| Position | Centered |
| Padding | 24px |
| Internal gap | 16px |
| Radius | 0 on mobile, 8px from 640px |
| Border | 1px `border` |
| Shadow | `elevation-3` |
| Backdrop | black @ 80% |
| Title | 18px semibold |
| Description | 14px `muted-foreground` |
| Footer | Stacked reversed on mobile (primary on top); right-aligned row with 8px gap from 640px |
| Close | 16px X, top-right 16px inset, 70% → 100% opacity on hover |
| Motion | Fade + zoom 95→100%, 200ms |

Alert dialogs have no close X: **Cancel** (`outline`) + **Action** (`default` or `destructive`).

### 9.6 Badge

| Property | Value |
|---|---|
| Shape | Pill (`rounded-full`), 1px border |
| Padding | 10px × 2px |
| Text | 12px semibold |
| Variants | `default` (primary fill), `secondary` (secondary fill), `destructive`, `outline` (border only, `foreground` text) |

**Status chip** (overline style): `text-[10px] uppercase tracking-wider font-semibold px-3 py-1 rounded-full bg-muted/50 border border-border/50 text-muted-foreground`.

### 9.7 Status indicators

| Element | Spec |
|---|---|
| Live dot | 8 × 8px circle, green-500, `animate-pulse` |
| Offline dot | 8 × 8px circle, `muted-foreground` |
| Spinner | Lucide `Loader2`, `animate-spin`, 14–16px, `brand` or `currentColor` |
| Step progress | 15px icon: `CheckCircle2` green-600 (done), `Loader2` blue-600 spinning (active), gray-400 (upcoming) |

### 9.8 Code & terminal

| Element | Spec |
|---|---|
| Inline command chip | `bg-muted rounded-md px-3 py-2`, mono 12→14px, horizontal scroll |
| Code block | See §3.5 |
| Terminal | `ink` `#0F1117` background, JetBrains Mono 13px, radius 8–12px frame |

### 9.9 Navigation item

Full-width `ghost` button, left-aligned, 40px tall, 16px icon + 8px gap, 4px bottom margin. **Active:** `secondary` or `accent` fill with `foreground` text. **Inactive:** `foreground` text (footer: `muted-foreground`).

### 9.10 Segmented control (appearance picker)

Track: `muted`, 8px radius, 3px padding, 4px gap. Segment: 28px tall, 10px horizontal padding, 5px radius, 14px icon + 12px medium label, 6px gap. **Selected:** `background` fill, `foreground` text, `0 1px 1px rgb(0 0 0 / .08)` shadow. **Unselected:** `muted-foreground`.

---

## 10. Motion

| Token | Duration | Easing | Use |
|---|---|---|---|
| `motion-fast` | 150ms | `cubic-bezier(0.4, 0, 0.2, 1)` | Color, opacity, border on hover/focus (default) |
| `motion-base` | 200ms | `ease-in-out` / `ease-out` | Sidebar drawer slide, dialog/popover enter/exit, `fade-in` |
| `motion-slow` | 300ms | `ease-out` | Larger panels, chart transitions |

- **`fade-in`:** opacity 0 → 1 with translateY 8px → 0, 200ms ease-out. Use it for content arriving after a load.
- **Popover/menu enter:** fade + zoom 95% + 8px slide from the trigger side.
- **Looping:** `animate-spin` for loading only; `animate-pulse` for live/active indicators only.
- Respect `prefers-reduced-motion`: drop translate/zoom and keep the opacity change.

---

## 11. Z-index

| Layer | Value | Use |
|---|---|---|
| `z-base` | 0 | Content |
| `z-raised` | 10 | Sticky headers inside scroll areas |
| `z-scrim` | 40 | Mobile drawer backdrop |
| `z-overlay` | 50 | Sidebar drawer, dialogs, popovers, menus, toasts |

---

## 12. Voice in UI

- Sentence case everywhere ("Create agent", not "Create Agent"). The exception is UPPERCASE overlines.
- Buttons are verbs: *Create*, *Send*, *Delete project*. Destructive buttons name the object.
- Status labels are the raw lowercase enum in badges (`running`, `waiting_input`, rendered as-is today). New UI should humanize them ("Waiting for input").
- The wordmark is **TaskSquad**, one word with a capital S.

---

## 13. Platform mapping

| Spec token | Web (Tailwind v4) | macOS / iOS (SwiftUI) |
|---|---|---|
| `background` | `bg-background` | `Theme.background` |
| `foreground` | `text-foreground` | `Theme.foreground` |
| `muted` | `bg-muted` | `Theme.muted` |
| `muted-foreground` | `text-muted-foreground` | `Theme.mutedForeground` |
| `border` | `border-border` | `Theme.border` |
| `input` | `border-input` | `Theme.input` |
| `primary` | `bg-primary` | `Theme.primary` |
| `destructive` | `bg-destructive` | `Theme.destructive` |
| `brand` | `#2563EB` | `Theme.brand` |
| success / warning / error | `green-600` / `amber-600` / `red-600` | `Theme.green` / `Theme.amber` / `Theme.red` |
| live dot | `bg-green-500` | `Theme.live` |
| `radius-md` | `rounded-md` | `Theme.controlRadius` (6) |
| `radius-lg` | `rounded-lg` | `Theme.radius` (8) |
| Sans | system stack | `.system` font |
| Mono | `font-mono` | `.system(design: .monospaced)` |

**Native type mapping** (points = px): caption 12, body 14 (macOS) / 15–17 (iOS, follow Dynamic Type `.subheadline`/`.body`), title-sm 18, headline 24. On iOS, scale the ramp with Dynamic Type and keep the weights from §3.3.

---

## 14. Known gaps (to fix forward)

1. **Web dark mode.** The portal uses scattered `dark:` utilities but defines no dark tokens. Paste the §2.7 implementation block into `index.css`, and swap the sidebar logo to `tasksquad-light.svg` in dark mode.
2. **Hard-coded hex values** in `Dashboard.tsx` and `CloseStepsProgress.tsx` (`#2563EB`, `#16a34a`, `#E2E4EA`, `#9ca3af`) should become tokens (`brand`, success, `border`, `muted-foreground`).
3. **Status colors** are raw Tailwind hues. Promote them to `--color-success|warning|info` (+ `-foreground`, `-tint`) tokens.
4. **Destructive contrast.** Align web `destructive` to `#DC2626`/`#B91C1C` for AA text contrast.
5. **Ad-hoc 9/10/11px sizes.** Consolidate onto `overline` (10px) and `meta` (11px). Drop 9px.
