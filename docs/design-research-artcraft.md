# ZeroRouter — Design research: ArtCraft (getartcraft.com)

Purpose: understand ArtCraft's visual/interaction language as a **reference only** for
interaction quality and precision. ZeroRouter is an original product with its own
identity (a developer infrastructure console), and no ArtCraft branding or creative
tooling was copied.

Method: live page inspection (DOM + computed styles) via a real browser session,
plus data extracted from CSS custom properties, stylesheets, and DOM structure.
No authenticated or gated surface was accessed; only the public marketing page.

## Observed system (facts)

| Property           | Observation (measured)                                                        |
| ------------------ | ----------------------------------------------------------------------------- |
| Canvas             | `rgb(18, 19, 22)` body, with near-black inset areas `rgb(6, 6, 7)`            |
| Text               | warm off-white `rgb(242, 241, 238)`, muted at `60%` and `38%` alpha            |
| Accent             | soft blue `rgb(116, 170, 255)` used sparingly                                 |
| Inverted control   | white `rgb(255,255,255)` button with near-black text `rgb(11,11,12)`           |
| Display face       | **Archivo** variable, weight ~620, tight tracking (`36px → -1.08px`, `60px → -2.1px`, `72px → -2.88px` ≈ -3% to -4%) |
| Body face          | **Inter** 16px / 400                                                          |
| Label face         | **Geist Mono** 11px, weight 500/700, **uppercase, +0.15em tracking**, primary nav + buttons |
| Corners            | `border-radius: 0` everywhere — sharp, squared, instrument-panel look          |
| Borders            | hairlines `1px solid rgba(242,241,238,0.15)` and a stronger `0.40` variant     |
| Grids              | sections built as `grid gap-px bg-line` — 1px gaps exhale the border color and read as hairline separators (stat/footer grids confirmed `gap-px` + `md:grid-cols-3` / `-4`) |
| Sections           | full-bleed `border-t` hairlines between major sections                        |
| Buttons            | mono uppercase labels, 48px height, `rounded-none`, transparent→solid hover    |
| Motion             | extremely restrained: `0.12s linear` and `0.15s cubic-bezier(0.4,0,0.2,1)`; only two keyframes on the whole page (`marquee-scroll`, `spin`) |
| Tokens             | Tailwind with semantic names: `bg-line`, `text-ink`, `text-invert-fg`, `bg-invert-bg`, `font-mono`, custom `track-*` |
| Responsive         | grids collapse `md:` and `lg:` (1-col phones); hamburger menu under viewport   |

## Design synthesis — what we adopt for ZeroRouter (and how we differ)

Adopted principles (interaction quality), restated for an API gateway console:

1. **Neutral dark canvas, warm off-white text, three muted tiers** — transcription of
   ArtCraft's tonal system onto ZeroRouter's charcoal (#0B0D10 family).
2. **Archive-grade typography**: display face with tight tracking and mid-bold weight
   for section headings; body face for content; **11px uppercase mono labels with
   0.15em tracking** for navigation, badges, buttons, and eyebrows — the single
   strongest signature of the reference and the clearest fit for a technical console.
3. **Sharp corners + hairline borders** — squared panels and `gap-px bg-line`
   hairline grids for stat tiles and tables. This makes dense technical data
   readable without boxes-in-boxes noise.
4. **Restrained motion budget** — 120–160ms transitions, one signature skeleton
   shimmer, no decorative loops; reduced-motion users get instant state changes.
5. **Inverse-accent CTAs** — solid light/accent mono-uppercase button as the
   "primary action" language; ghost/bordered variants for secondary actions.
6. **Hairline section separators** — full-width `border-t` lines between regions.

Differences (ZeroRouter's own identity):

- Accent color is **amber (`#F0B441`) on charcoal** with a cyan `#66C7F4`
  link/info tone — deliberately not ArtCraft's blue-on-charcoal. Amber reads as
  "signal/attention", which suits a routing control plane; status semantics use
  green (healthy), amber (degraded/attention), red (failing).
- Display face is Archivo (same open family, different identity role: ZeroRouter
  uses 20/24/32px scale for a data-dense console rather than 36–72px marketing).
- No marquee; animation vocabulary is panels, drawers, modals, spinners, skeletons,
  live-response streams — all in service of operation, not spectacle.

## ZeroRouter design tokens (result of this synthesis)

```css
--bg: #0B0D10;      /* canvas */
--panel: #101318;   /* card surface */
--raised: #151A20;  /* inputs, hover fills */
--line: #232A33;    /* hairline border (≈ text alpha 0.14) */
--line-strong: #39424E;
--text: #EDEAE3;    /* warm off-white */
--text-dim: 62%;    /* secondary */
--text-faint: 38%;  /* tertiary */
--accent: #F0B441;  /* amber CTA / focus */
--info: #66C7F4;    /* links/selected */
--ok: #4ADE80; --warn: #F5B84E; --err: #F87171;
font-body: Inter variable; font-display: Archivo variable (tight tracking);
font-mono: JetBrains Mono variable (11px uppercase labels: tracking 0.15em).
radius: 0 everywhere.
```

## Interaction patterns adopted

| ArtCraft pattern                    | ZeroRouter application                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| `grid gap-px bg-line` hairline grid | Stat tiles on Overview; metric tiles inside provider cards        |
| Sharp-corner panels, hairlines      | Cards, tables, drawers, dialogs                                   |
| Mono uppercase nav + eyebrow labels | Sidebar nav, page eyebrows, table column labels, key value chips  |
| Inverse-accent primary button       | "Launch App"-style primary actions: Add provider, Create key, Save |
| `0.12–0.15s` transitions            | All hover/panel/state transitions; drawer slide 160ms             |
| Restrained page motion              | Skeleton shimmer only while loading; spinning status ring on probes |
| Hamburger for narrow viewports      | Responsive dashboard with collapsible sidebar on small screens     |

## Limitations of this research

- Measurement taken at a 789×592 viewport; ArtCraft's fully desktop rendering was
  not visually verified pixel-by-pixel (image capture of the live site was not
  possible in this environment). All layout facts above come from computed styles,
  the CSSOM, and the DOM, and are exact.
- Authenticated in-app screens were not and will not be inspected; access is
  gated by ArtCraft's own sign-in and is out of scope for design research.

