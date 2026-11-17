# Stephen marketing page proposal (2026-11)

Status: a proposal from the review lane, 2026-11-17. Nothing is published. Hosting, a domain and the date it goes
public are Cris's decisions. The mock is for discussion only: `docs/research/marketing-mock/index.html`.

How to open the mock: in Finder, open the repo folder, then `docs/research/marketing-mock/`, and double-click
`index.html`. It opens in your browser. It makes no outside requests, has no tracking and no cookies. The button at the
top right switches light and dark; it follows the Mac's setting until clicked. Try the Allow and Deny buttons in the
drawing: they wait 0.75 s, like the app.

---

## 1. Who it is for

**Regular Mac users first (Cris's decision, 2026-11-17).** People who want a voice assistant that does real work in
their browser and accounts, but who do not trust an AI model to decide on its own what is allowed. Students first
(Canvas, school mail), since that is what Stephen is built around. The copy speaks to them as future users: plain
words, no developer terms, no "my project" framing.

Because there is no download yet (section 7), the page must say so plainly and must not collect emails or run a
waitlist (that would need a form, storage and a privacy notice). Employers and reviewers can still read it; it does not
speak to them first.

Not for: people who want a faster Siri for timers and weather. The product plan says Stephen does not win there
(`docs/research/PRODUCT-PLAN-2026-11.md` section 6).

## 2. The single message

From the product plan's positioning (section 2.1), cut to what is true today:

> **A voice assistant for your Mac that cannot go past your rules.** It does real work in your own browser and
> accounts, and every action passes a gate made of fixed rules. The model does not decide what is allowed, and a spoken
> "yes" never approves anything.

What the page must NOT claim, and why:

| Do not claim | Why |
|---|---|
| Sending email, or any demo of it | Stephen cannot send email today (checked on 2026-11-17: it answers that it can't send emails yet). The demo uses a web form instead |
| "Fast", "instant", any latency number | Speed is a goal, not yet a fact (plan section 2.1 and 7.1) |
| An injection pass rate, or "tested against attacks" as a result | No pass rate is published yet. The page may say "we test with trick emails and pages; the rate will be published here when measured" |
| "Private", "nothing leaves your Mac" | The text of each request goes to Claude; replies may use ElevenLabs. Say exactly what stays and what leaves |
| "Secure", "safe", "cannot be hacked" | Absolute claims. Say what the gate does, not that nothing can go wrong |
| "Download", "Get Stephen", prices | No signed or notarized build exists (plan decision U7) |
| Logos of Canvas, Gmail, Notion, Google, Anthropic, Zen, Chrome | Their trademarks; names in plain text are enough. No real company's branding anywhere |
| Testimonials, user counts | There is one user |

## 3. Section order with draft copy

Version 2 (2026-11-17, after Cris asked to remove AI-generic filler and repetition). The first version said the same
rules four times (hero, a "How it works" row, a rules grid, an FAQ), carried three disclaimers, header links for a
one-page site, an uppercase label above every heading, and a three-column feature grid. All of that is gone. What
is left, top to bottom:

**0. Notice (mock only).** "Mock for discussion. Not a live site."

**1. Header.** Wordmark "Stephen" with the small status dot, and the light and dark switch. No links: the page is short.

**2. Hero: the product is the hero.** (Pattern from 21st.dev and uiverse.io: a short headline with the real product
right under or beside it.)
- Headline: "A voice assistant for your Mac that cannot go past your rules."
- One line: "Say "Hey Stephen" or hold F5. It works in your own browser and school accounts. Anything that submits or
  sends waits for your click."
- "Not available to download yet." No buttons: there is nothing to download or sign up for.
- Beside it, the Ask box drawn in HTML: "Book a study room at the library for 3 pm today", "Heard by wake word", three
  steps, and the card "Submit this form?" with the page, why it asks, and the form values shown as plain text. Deny and
  Allow wait 0.75 s ("Ready in a moment.") and work.

**3. Before and after: the one proof.** (Pattern from impeccable.style: before and after proves a claim better than
adjectives.) Navy band. "What if a web page tries to give Stephen an order?" Left: an example of text hidden in a page,
shown verbatim in a dashed box. Right, "What Stephen does": page text reaches the model marked as web data, never as
your words; a submit still needs your click, a page cannot say yes for you; every step is on the record. Labelled as an
example, not a real event.

**4. What Stephen may do.** "What Stephen may do depends on how you asked." The same permission table as the app. Must
use the real cells from the gate's rules before publishing; the mock says its values are examples.

**5. Where it is today.** One list of plain facts instead of features, status and FAQ (pattern from uiverse.io and
reactbits.dev: trust stated as facts): Works with; Your voice (text on the Mac, the request text goes to Claude);
Approving (a click, never your voice); Passwords and codes (typed by you); Memory (only what you keep); Speed (measured,
not promised); Trick pages and emails (tested, the pass rate will be published once measured); Download (not yet).

**6. Footer.** One line. Later: a link to the GitHub repo and a changelog, if Cris wants (section 8).

## 4. Visuals each section needs

| Section | Visual | How |
|---|---|---|
| Hero | Ask box with a waiting question | HTML and CSS with the app's tokens; working 0.75 s delay. Later a short silent recording of the real app may replace it (no autoplay, with captions) |
| Before and after | Two panes | Text plus three small line icons; the only strong colour on the page (Navy) |
| What Stephen may do | Table | A real HTML table with header cells, scrolls sideways on a phone |
| Where it is today | Fact list | Text only; no logos |

No stock photos, no 3D, no robot illustrations, no gradient blobs, no glow, no uppercase labels over headings, no
endless motion. (Avoid list from the reference sites: marquees, shader backgrounds, cursor effects, confetti, glow,
testimonial walls.)

## 5. Tech choice

**One static HTML file with inline CSS and a few lines of plain JavaScript** (theme switch and the demo buttons). No
framework, no build step, no web fonts (system fonts match the app's SF Pro on a Mac), no analytics, no cookies, no
third-party requests. Reason: it is one page that changes rarely; a framework would add a build, dependencies and
updates for nothing. It also keeps the "no tracking" promise easy to check: view source.

Where it could be hosted (Cris decides; all have a free tier for a static page):
- **GitHub Pages** from this public repo (a `site/` folder or a `gh-pages` branch). Simplest; the repo is already
  public.
- **Cloudflare Pages** or **Netlify**, if a custom domain with more control is wanted later.

A domain is optional; `<user>.github.io/stephen` works. If a domain is bought, it should not use another company's
trademark.

What the component sites Cris named are good for here: patterns, not parts. 21st.dev (short headline, one sentence, the
real product right under it), magicui.design (two buttons of equal size and different weight), impeccable.style (avoid
generic AI-site tells: uppercase kickers, coloured side stripes, decorative italic serif). Their React components would
need a build and add motion that does not fit (endless marquees, shader backgrounds, shimmer, cursor trails, confetti,
glow), so none is used. Licences noted for the record: uiverse MIT, magicui MIT (free parts), reactbits MIT with
Commons Clause, 21st.dev per component (often not stated).

Mac app sites that do this well, for patterns only: Granola states its one trust difference in the hero as a mechanism;
Superwhisper says what stays local and qualifies it honestly in its FAQ; Wispr Flow shows the before and after instead
of chrome; Linear builds product mockups in HTML. Avoided from those sites: logo walls, autoplay video, announcement
banners, absolute safety promises.

## 6. Accessibility and performance targets

- WCAG 2.2 AA: text 4.5:1 or more in light and dark (the mock uses the app's tokens, measured in
  `docs/UI-PLAN.md` section 9), focus ring visible on every link and button, skip link, one `h1`, no skipped heading
  levels, table header cells with `scope`, the demo's result announced with `aria-live`.
- Works at 320 px wide with no sideways page scroll (checked in the mock at 375 px: page width equals window width).
- Works without JavaScript except the two demo buttons; `<details>` for the FAQ.
- `prefers-reduced-motion`: no smooth scrolling, no transitions.
- `prefers-color-scheme` plus a manual switch.
- Page weight under 50 KB, no external requests (the mock is about 23 KB). Lighthouse performance and accessibility 95
  or more.
- `noindex` while it is a mock.

## 7. What must be true before it goes public

1. **Distribution decision (U7).** The app is not signed, notarized or distributed. Until it is, the page has no
   download button and says so. When it is, add the download with the system requirement under it (macOS version, Apple
   silicon).
2. **The permission table matches the gate.** Copy the cells from the listener's real rules, not from the mock.
3. **Every privacy line checked against the code:** speech to text on the Mac; the request text goes to Claude; replies
   may go to ElevenLabs (or stay on the Mac with Kokoro or the macOS voice). If any of this changes, the page changes.
4. **The injection pass rate is measured** (plan section 7, D3 #63) before any sentence says more than "we test".
5. **A licence for the public repo**, if the page ever links to the code or says it is open. The repo is public today but has no
   licence file, so others may read the code but not reuse it. Cris decides which licence, or the page does not mention
   the code.
6. **No personal data on the page.** The demo uses `library.school.example` and an invented name ("Alex Doe"); keep it
   that way.
7. **The name.** "Stephen" is a common first name; check that the chosen domain and page title do not clash with an
   existing product of the same name.
8. **Hosting and domain chosen by Cris.**

## 8. Questions for Cris

1. Do you want the GitHub repo linked from the page?
2. When the app can be downloaded, should the page offer it for free, or is pricing still open?
