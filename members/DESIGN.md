# CSI Guild Hall: Design Rules

The members app (members.carnivalsociety.org) is a cozy point-and-click carnival game:
**Pokémon GO for freaks, clowns and acrobats.** It sends people *out* to the carnival
and gives them a warm, illustrated home to come back to. Read this before building or
restyling any page. When this file and a generic design rule disagree, this file wins.

## 1. The feeling

- **Inside the tent at night.** Velvet, warm bulbs, painted wood, popcorn gold. Never
  corporate, never "SaaS dashboard," never flat white.
- **Every page is a place.** The Dressing Room is a room, Events is a corkboard,
  the Forum is a bulletin board in a wooden frame, a Blast is the Ringleader popping out of
  a barker's cone. Before adding a list or a card, ask: *what object in the tent is this?*
- **Tactile verbs.** Tap, slide, stamp, pin, ring, squawk. Things bob, wobble, thunk and
  glow when touched. Spiritfarer / Animal Crossing warmth, a carny's voice.
- **Hand-made over generated.** Neeff's painted art and sticker sheet are the source of
  truth. SVG/CSS stand-ins are placeholders until his drawings land (they swap in
  automatically via `artOr()`).

## 2. Color

Tokens live on `:root` in `styles.css`. Use them; don't invent new hexes for UI chrome.

| Token | Hex | Role |
|---|---|---|
| `--night` | `#140c0a` | deepest ground, bottom tabs, top bar |
| `--bg` | `#1c1210` | page ground |
| `--surface` / `--surface-2` | `#2c1c17` / `#3a241d` | panels, sheets, hover |
| `--burgundy-deep` / `--burgundy` / `--burgundy-red` | `#5A1E24` / `#7A2E34` / `#9B3036` | velvet; `--burgundy-red` = active / primary action |
| `--gold` / `--gold-bright` / `--gold-deep` | `#C8A05A` / `#DFBE7D` / `#8F6E34` | trim, labels, links, borders |
| `--glow` | `#FFE2A0` | bulb light, focus rings, "you can touch this" |
| `--cream` / `--cream-soft` | `#F4E8D0` / `#CBB998` | text / secondary text |
| `--wood` / `--wood-edge` | `#4a2f1c` / `#8a5a32` | frames, signs, booths |

- Parchment (`#e8d3a8`-ish with brown ink `#5a3a22`) is allowed **only inside a wooden
  frame** (forum sheet, letters, flyers): paper is an object in the room, not the page.
- `--accent-0…5` are for color-coding categories (chapters, slot types), never for chrome.
- Borders are gold at low alpha (`rgba(200,160,90,0.18–0.4)`). Shadows are warm/dark brown,
  and light comes **from above** (bulbs), so shadows fall downward.
- No AI purple/blue glow gradients. No pure `#000` or pure `#fff`.

## 3. Type

| Font | Use |
|---|---|
| **Libre Franklin** | body, UI, buttons, forms (the workhorse; readable at 16px) |
| **Playfair Display** (700–800, italic 600) | page titles, names, banners |
| **Cormorant Garamond** | large lyrical lines, flavor text, quotes (set big, never small body) |
| **Rye** | tiny carnival-poster labels: section labels, "HEAR YE!", sign plates. Uppercase, tracked `0.08–0.12em`, small sizes only |

- Serif is the brand (carnivalsociety.org's look), not an AI default. Keep it.
- Body ≥ 16px. Long text ≤ ~65ch. `text-wrap: balance` on headings.
- Numbers that count (stamps, reach, members) use `font-variant-numeric: tabular-nums`.

## 4. Voice

- Carny barker, warm and a little ridiculous: "Step right up!", "HEAR YE!", "Holler at
  Everyone", "The cone is waiting." Exclamation marks and emoji are **on brand** here,
  used with intent (one per line, not confetti).
- The **raven** delivers news ("A LETTER!"). The **Ringleader** hollers. Members are
  "the troupe." Rank/passport words: Courtyard, Roustabout, Apprentice, stamps.
- Errors are plain and kind: say what happened and what to do. No "Oops!"
- Never: "Elevate", "Seamless", "Unleash", "Leverage", corporate filler.

## 5. Motion and sound

- Motion has a job: **idle life** (bob, spiral turning 240s, bulb chase), **touch
  feedback** (lift + glow on hover/focus, squash on press), **moments** (prize won,
  cone pop, raven squawk).
- Animate `transform` and `opacity` only. Springy easing for pops
  (`cubic-bezier(.2,1.7,.4,1)`), ease-in-out for idle loops.
- Every animation has a `@media (prefers-reduced-motion: reduce)` fallback that stops it
  and still shows the end state.
- Sound is Web Audio, synthesized, and only after a user tap (iOS). Every sound moment has a
  visible mute toggle. Close AudioContexts once (idempotent, `.catch()` on `close()`).

## 6. Touch and access

- Phone first. It must work one-thumbed at 390px wide with a 16px side gutter, bottom tabs,
  and `env(safe-area-inset-*)` respected.
- Tap targets ≥ 44×44px.
- Every interactive thing is a real `<button>` or `<a>`, keyboard-reachable, with a visible
  `:focus-visible` ring in `--glow` (or a glow `box-shadow` on illustrated objects).
- Room objects and art have `aria-label`/`alt` that names the object *and* the verb
  ("Trunk: open your passport").
- Overlays: trap nothing, close on Escape and on the close button, return focus.
- No `window.alert` for errors; use toasts or inline messages. `confirm()` only for
  irreversible Ringleader actions (sending a blast).

## 7. Layout

- Shell: sticky top bar (max 1240px) + More sheet; under 800px the top nav becomes the
  bottom tabs. No sidebar.
- The blurred room painting sits behind every page (`.shell::before`). Pages are objects
  floating on it: a board, a book, a booth.
- Positions on illustrated scenes are **percentages** of the art so they scale with it.
- Use `min-height: 100dvh`, not `100vh`, for full-screen things.

## 8. Art pipeline

- Art lives in `assets/room/`. Sticker cut-outs are transparent PNGs; the room is
  `room_bg.jpg` (1254²).
- Code always ships a fallback (`artOr(file, fallbackSVG)`) so a missing drawing never breaks
  a page, and a new drawing appears without a code change.
- Wanted art list: vault note "CSI Dressing Room Art List" and the Guild Hall Roadmap.

## 9. Stack rules

- Vanilla JS SPA (`app.js`, hash routes) + one `styles.css` + Cloudflare Worker/D1.
  No frameworks, no Tailwind, no build step. Don't add one.
- New CSS goes in a dated, titled block at the end of `styles.css`
  (`/* ── Name (YYYY-MM-DD) ── */`), using the tokens above.
- External scripts only from cdnjs, pinned versions.
