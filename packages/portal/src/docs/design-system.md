---
title: TaskSquad design system
description: A public reference for TaskSquad colors, typography, components, popovers, dialogs, and interaction patterns across web, macOS, and iOS.
order: 2
---

Use this guide when designing a TaskSquad screen or reviewing a change. A teammate opening the inbox should be able to tell what happened, what needs their attention, and what they can do next. Neutral surfaces carry everyday work. Color, labels, and placement identify changes that matter.

[Colors](#color-tokens) · [Components](#components) · [Try the popups](#popups-and-dialogs) · [Interaction patterns](#interaction-patterns)

## Color tokens

Choose a color by its role. Pair each filled surface with its matching foreground. The values below are the light and dark design references. Native apps use system surfaces so materials and increased contrast can follow the device.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | #FFFFFF | #17191E | App canvas and input field |
| `foreground` | #020817 | #E7E9ED | Default text and icons |
| `card` | #FFFFFF | #1C1F25 | Cards, inspectors, and grouped rows |
| `card-foreground` | #020817 | #E7E9ED | Text on a card |
| `popover` | #FFFFFF | #22252C | Menus, popovers, and raised panels |
| `popover-foreground` | #020817 | #E7E9ED | Text on a raised panel |
| `primary` | #0F172A | #FFFFFF | Primary action and selected control |
| `primary-foreground` | #F8FAFC | #17191E | Text and icons on primary buttons |
| `secondary` | #F1F5F9 | #252830 | Secondary button or badge |
| `secondary-foreground` | #0F172A | #FFFFFF | Text on a secondary control |
| `muted` | #F1F5F9 | #252830 | Quiet group, code chip, or track |
| `muted-foreground` | #64748B | #A0A7B4 | Captions, helper text, and timestamps |
| `accent` | #F1F5F9 | #2A2E37 | Hovered row or focused menu item |
| `accent-foreground` | #0F172A | #FFFFFF | Text on that highlighted row |
| `border` | #E2E8F0 | #2E323B | Panel edge or separator |
| `input` | #E2E8F0 | #3A3F4A | Field boundary |
| `ring` | #020817 | #FFFFFF | Keyboard focus indicator |
| `destructive` | #EF4444 | #F87171 | Destructive control surface |
| `destructive-foreground` | #F8FAFC | #17191E | Label on a destructive surface |
| Brand blue | #2563EB | #7AA7FF | Brand and enabled toggles |
| Terminal ink | #0F1117 | #0F1117 | Terminal background |
| Native sidebar | #F8FAFC | #121418 | Navigation behind content |

## Workflow highlights

Use this quieter palette for graph and inbox work. Keep the status word, icon, score, or line pattern visible. On a busy heatmap, give a phase badge an opaque background made from 10% of its foreground mixed into the card color. Its text then stays legible across adjacent cells.

| Role | Light | Dark | Meaning |
| --- | --- | --- | --- |
| Success | #426451 | #9AB3A0 | Execution, verified evidence, or a successful review |
| Information | #405E7D | #9BAFC6 | Planning phase, informational controls, or a goal projection |
| Attention | #78572F | #C4AB88 | A reply, review, or recovery needs attention |
| Violet | #655375 | #B6A4C4 | Grading badge or dashed outline of a proposed state |
| Danger | #884C50 | #C6A0A1 | An error or destructive consequence |

These samples use the live tokens, so they follow the light or dark theme.

```design-example
workflow-highlights
```

Keep a routine inbox card neutral. Use a light attention tint and a specific action label such as **Review result** when someone can act. For a candidate heatmap, mix the attention color into the card from 4% to 24% as weight increases. Print the numeric weight and rank in each cell.

Shared status icons elsewhere in the app use green for success (#16A34A light, #4ADE80 dark), blue for activity (#2563EB, #7AA7FF), amber for waiting (#D97706, #FBBF24), and red for failure (#DC2626, #F87171). Pair an 8 px live dot with a label. Illustration accents are blue `#3B82F6`, purple `#A855F7`, orange `#F97316`, pink `#EC4899`, green `#22C55E`, yellow `#EAB308`, and indigo `#6366F1`.

## Typography and layout

Use the platform system sans serif for UI and a monospace face for commands, IDs, and terminal output. Use tabular numerals where scores or times update in place. Native text uses system text styles and scales with the user's settings.

| Element | Size / line height | Weight |
| --- | --- | --- |
| Caption and helper text | 12 / 16 px | Regular |
| Body, list row, input | 14 / 20 px | Regular |
| Button and field label | 14 / 20 px | Medium |
| Long-form reading | 16 / 24 px | Regular |
| Section or dialog title | 18 / 28 px | Semibold |
| Page title | 24 / 32 px | Semibold |

Build on a 4 px spacing grid. Leave 8 px between an icon and label, 12–16 px between form fields, and 24–40 px between sections. Use 16 px page gutters on a phone and 32 px from 640 px up. At 768 px the portal can show a persistent sidebar. Let a narrow inspector stack below its canvas.

Use a 6 px radius for controls and menus, 8 px for cards and desktop dialogs, and a full radius for badges. Separate neighboring rows with a 1 px border. Reserve shadows for raised elements, with menus below dialogs in visual prominence. In dark appearances, use progressively lighter raised surfaces.

## Components

| Component | Construction | Interaction |
| --- | --- | --- |
| Button | 40 px default height, 16 px horizontal padding, 14 px medium label. Compact is 36 px and large is 44 px. | Give the main action a verb and object. Use outline for alternatives and ghost for toolbar actions. Show progress and prevent duplicate submission while saving. |
| Text field | 40 px high, 1 px input border, 6 px radius. Place a visible label 8 px above. | Associate the label and error with the field. Preserve entered text on failure. A textarea starts at 80 px and supports longer answers. |
| Card and list | 1 px border, 8 px radius, 16 px dense or 24 px regular padding. | Give an interactive row a clear target. Keep independent actions such as its menu separately focusable. |
| Badge | Compact semibold label with a quiet fill or outline. Graph phase labels use 10 px uppercase text. | Use words such as “Running” or “Waiting for input.” Announce important changes without moving keyboard focus. |
| Tabs and navigation | Sidebar items use an icon and label. Tabs share a baseline. | Mark the current destination with a selected state and a visible indicator. Keep navigation separate from record actions. |
| Icons | Lucide outline on web, usually 16 px with a 2 px stroke. | Label icon-only buttons for assistive technology. Give small icons a 44 × 44 px touch target on mobile. |

## Popups and dialogs

Try the shared web components on this sample graph. Changes last for this visit.

```design-example
graph-controls
```

| Surface | Choose it for | Sizing and behavior |
| --- | --- | --- |
| Select | One choice from a fixed list, such as a time range | Show the current value in the trigger and a check on the selected item. Arrow keys move through options. Enter selects and Escape dismisses. |
| Action menu | Commands on one record | Anchor to the invoking button. Group related commands, order frequent actions first, and put destructive actions last. |
| Popover | A short explanation or small contextual control | Start with a 288 px panel, 16 px padding, and a 4 px gap from its trigger. Keep the anchor visible and shift the panel at viewport edges. |
| Dialog | A focused task such as renaming a graph | Center the panel, up to 512 px wide, with 24 px padding. Provide a title, labeled fields, and a clear completion action. Tab stays inside while it is open. |
| Alert dialog | A consequential action such as permanently closing a graph | Name the object and consequence. Put initial focus on the safe action. Require an explicit confirmation and return focus to the invoking control or a logical successor. |
| Drawer or sheet | Navigation or secondary controls on a small screen | Open from the screen edge, keep the title and dismissal reachable, and restore the user's previous place on close. |

Use the modal scrim at 80% black in light appearance and 70% in dark. Use 50% black behind a navigation drawer. A menu or popover gets a border and medium shadow. A modal sits above the scrim and gets the stronger shadow. On phones, stack dialog actions so long labels and enlarged text fit.

## Interaction patterns

**Inbox.** Lead with the task subject and status. Keep the reply or review beside the request. During submission, retain the message and disable repeat submissions. After success, acknowledge the result in the thread. On failure, preserve the draft and describe the next available action.

**Graph.** An arrow between states represents an action plan. A dashed violet card is its proposed outcome. A solid observation card represents a recorded state. Select an edge to read the plan or a node to inspect its chronological history. Blue links to goals show expected → observed impact. Display an em dash for a missing score and `0.00` for a measured zero.

**Loading, empty, and error states.** Keep existing content visible during a refresh. On first load, reserve space for the list or show a labeled progress indicator. For an empty inbox, explain what will appear there and show an available action. When a request fails, say what failed and whether the user can retry.

**Keyboard, motion, and feedback.** Use a visible 2 px focus ring with a 2 px offset. Give controls accessible names and keep keyboard order aligned with reading order. Aim for at least 4.5 to 1 contrast for ordinary text and 3 to 1 for large text and essential control boundaries. Check the actual background, including tints. Use 150 ms for hover or focus and about 200 ms for an opening panel. With reduced motion enabled, remove slides and zooms.

**Native apps.** Use system controls, materials, and scalable text on macOS and iOS. Put creation in the toolbar. Expose record actions in the macOS toolbar and context menu, and in the iOS overflow menu and swipe actions. Keep the action names and consequences consistent across platforms.
