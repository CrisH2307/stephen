# Handover: Ask box and Home transitions still look bad

Status: **fixed** (2026-11-09, PR #40, now in `main`; the owner tested it on the Mac). Measured from the owner's
recording at 10 frames a second: causes 1 and 2 below were real, plus one more: during the fade SwiftUI laid out the old
and the new content together, so the box measured as both. The fix was option A (a fixed transparent panel; only the
card's height eases, content clipped to it), the ⋯ menu became a normal pop-up menu over the chat, and Home became one
layout whose composer glides (option C without `matchedGeometryEffect`). Kept below for the record.

## What the owner sees
Opening or closing the Ask box's ⋯ menu, a reply arriving, and Home going between its empty layout and the thread, look
jumpy instead of smooth. They asked for a "collapse" feel: the box grows and shrinks smoothly.

## Where the code is
- `helper/AskBox.swift`: `AskBoxView.body` (content transition and `.stephenAnimation(value: mode)`), `AskBoxController.makePanel`
  (the panel's content is `.fixedSize()` plus a `GeometryReader` that publishes its size through `AskBoxSizeKey`),
  `resize(_:to:)` (the panel frame follows that size, top edge kept, now `setFrame(..., animate: true)`).
- `helper/Components/ChatThread.swift`: the thread's `ScrollView` has its own scroll-to-end animation.
- `helper/HomeView.swift`: `body` switches `start` and `chat` with `.transition(.opacity)`.
- `helper/Theme.swift`: `Motion.state` 0.15 s, `Motion.bar` 0.22 s, `stephenAnimation` (off with Reduce Motion).

## Likely causes (to verify)
1. **Two animations race.** SwiftUI animates the content over 0.15 s while AppKit animates the window frame (system
   resize time, about 0.2 s). The content reaches its final height first, so it is clipped or floats while the window
   catches up.
2. **The window size is derived after layout.** The size is read from a preference change, so every layout pass during
   the animation calls `setFrame` again and restarts the AppKit animation (stutter, or it snaps to the end).
3. **The scale and opacity transition on a view that changes size** moves the top edge of the content while the window
   top edge is also being corrected.
4. **The thread's own scroll animation** (`toEnd` in `ChatThreadView`) runs at the same time as the resize.

## Suggested fix (try in this order)
A. **Make the panel a fixed, transparent, taller canvas** (for example 360 by 560, clicks pass through the empty part:
   `ignoresMouseEvents` toggled by hit-testing, or an `NSHostingView` subclass whose `hitTest` returns nil outside the
   card) and let SwiftUI animate only the card's height, anchored to the top. One animation system, no window resizing, so
   no race. The saved drag position stays the card's top-left. Watch: the shadow (`invalidateShadow`), VoiceOver bounds,
   and clicks outside the card still closing the box (the global monitor).
B. If A is too big a change: keep resizing the window but drive it from one place. Remove the SwiftUI size animation on the
   card, animate only the frame with `NSAnimationContext` (explicit duration 0.2, ease in out), debounce size changes so a
   running animation is not restarted, and drop the scale transition.
C. For Home: keep one container and animate the composer's position and the thread's opacity (a `matchedGeometryEffect`
   on the composer between the centred and the bottom spot) instead of swapping two views.

## Constraints (do not break)
- Reduce Motion: no animation at all.
- The box top edge stays where the owner dragged it; "Reset position" and "Pin open" keep working.
- Approvals: the question is a message in the thread; Allow and Deny stay disabled for 0.75 s; Esc denies.
- All five themes, and text from replies is shown with `Text(verbatim:)`.
- New Swift files go in `HELPER_SOURCES` (`src/helper/install.ts`) and `test/helper/install.test.ts`.

## Done means
- A screen recording from the Mac showing: ⋯ open and close, a reply arriving in a long thread, Home empty to chat and back,
  all smooth.
- `npm run build`, `npm run typecheck`, `npx vitest run`, and the Swift compiled with the exact `swiftc` line from
  `node dist/cli.js install-helper --dry-run` into a temp dir (never over the installed app).
- A PR stacked on the current head of `qa`'s UI chain (`ui/chat-fixes-2`, PR #38) using the PR template, merged into `qa`
  without a force push.

## Related plan
`docs/UI-NEXT-PLAN.md` (recents, resume, action chain, eight sidebar pages, model-written title). Do this transition
fix first, because the new layouts will animate the same way.
