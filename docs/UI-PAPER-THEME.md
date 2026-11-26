# Paper theme (the website look in the app)

Cris liked the student look of the new website (#323) and asked for it in the app's small Ask box.

## What it is

- A sixth theme, **Paper**, next to Light, Dark, Navy, Rose and Sun. Navy and the others do not change.
  Pick it in Settings > Appearance or with "Theme: Paper" in the ⌘K palette.
- The colours are the website's (`site/style.css`): paper ground `#FBF8F1`, ink `#15151A`, ink-2 `#4A4A57`,
  blue buttons `#1F4FC4`, a lavender Ask box `#E7E1FF`, a pale blue details block `#D9ECFF`, and the one yellow
  (`#FFF1B8`, a softer step of the site's `#FFD84D`) for a selected row.
- Cards and buttons get a 2 pt ink edge and a hard shadow down and to the right (4 pt cards, 3 pt buttons).
  The shadow is a second ink shape behind, not a blur.
- Buttons are pills. Titles in the Ask box use Avenir Next bold (it ships with macOS, like on the site).

## Where it shows

All in `Theme.swift` tokens plus small `if t.paper` branches, so other themes draw exactly as before:

- The Ask box card (`AskBox.swift`): lavender, ink edge, hard shadow, and a "Stephen" title in the strip.
- The question card (`ChatThread.swift`, `ConfirmMessage`): white, the details in a pale blue block.
- Buttons and the ask field (`Components/Controls.swift`): these are shared, so Paper's main window gets the
  pill buttons and outlined field too.

## Safety (the Allow and Deny card)

- No logic changed. `AppConfirm.swift` (Allow, Deny, Esc = Deny) is not touched. The 0.75 s arming delay, the order
  (Deny first for keyboard focus), Esc = Deny and "Return never answers" are unchanged.
- Allow is never the default: no default key, no extra size, no extra shadow. Allow and Deny now share one width
  (76 pt minimum, in every theme) and the same edge and shadow. As in every theme, Allow is the filled button and Deny the outlined one; nothing
  else sets Allow apart.
- The question card keeps its warn outline (#139), at 2 pt in Paper, so it still stands apart from the other
  ink-edged cards. The "Needs your OK" label stays.

## Accessibility

- Text contrast is 4.5:1 or more on every Paper surface, checked by `test/helper/theme-contrast.test.ts` (with a
  new check for the lavender and pale blue fills) and the glass gate `scripts/glass-contrast.mjs`.
- No new motion, so Reduce Motion needs nothing new. Increase Contrast still swaps `line` for `lineStrong`.
- Paper is a light theme. Follow the Mac still means Light by day, Dark at night.

## Not done (on purpose)

- No dot grid: the Ask box floats over other apps, and a grid on lavender is busy. It could go on Home's ground later.
- No press animation on buttons (the site has one). Add it later behind Reduce Motion if Cris wants it.
- Paper is not the default theme. That is Cris's call.
