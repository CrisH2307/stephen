# Stephen marketing page proposal (2026-11)

Status: a proposal from the review lane, 2026-11-17. Nothing is published. Hosting, a domain and the date it goes
public are Cris's decisions. The mock is for discussion only: `docs/research/marketing-mock/index.html`.

How to open the mock: in Finder, open the repo folder, then `docs/research/marketing-mock/`, and double-click
`index.html`. It opens in your browser. It makes no outside requests, has no tracking and no cookies. The button at the
top right switches light and dark; it follows the Mac's setting until clicked. Try the Allow and Deny buttons in the
drawing: they wait 0.75 s, like the app.

---

## 1. Who it is for

1. **Now: people who look at Cris's work.** Employers, classmates, reviewers who open the GitHub repo. They want to
   understand in 30 seconds what Stephen is and why it is different. This is the real audience today, because there is
   no download (section 7).
2. **Later: careful Mac users** who want a voice assistant that does real work in their browser and accounts but who do
   not trust an AI model to decide on its own what is allowed. Students first (Canvas, school mail), since that is what
   Stephen is built around.

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
| "Fast", "instant", any latency number | Speed is a goal, not yet a fact (plan section 2.1 and 7.1) |
| An injection pass rate, or "tested against attacks" as a result | No pass rate is published yet. The page may say "we test with trick emails and pages; the rate will be published here when measured" |
| "Private", "nothing leaves your Mac" | The text of each request goes to Claude; replies may use ElevenLabs. Say exactly what stays and what leaves |
| "Secure", "safe", "cannot be hacked" | Absolute claims. Say what the gate does, not that nothing can go wrong |
| "Download", "Get Stephen", prices | No signed or notarized build exists (plan decision U7) |
| Logos of Canvas, Gmail, Notion, Google, Anthropic, Zen, Chrome | Their trademarks; names in plain text are enough. No real company's branding anywhere |
| Testimonials, user counts | There is one user |

## 3. Section order with draft copy

The copy below is in the mock. Plain English, short sentences, no jargon.

**0. Notice bar (mock only).** "Mock for discussion. Not a live site."

**1. Header.** Wordmark "Stephen" plus a small status dot (the app's own mark, UI-PLAN section 2). Links: How it
works, The rules, What it does, Where it is today, Questions. A light and dark switch.

**2. Hero.**
- Headline: "A voice assistant for your Mac that cannot go past your rules."
- Line: "Say "Hey Stephen" or hold F5. Stephen works in your own browser, mail, calendar and school accounts. Every
  action goes through a gate made of fixed rules. The AI model does not decide what is allowed, and a spoken "yes"
  never approves anything."
- Buttons: "See the rules it follows" (primary), "Where it is today" (quiet). No download button.
- Fine print: "Stephen is one person's assistant, built in the open. There is no download yet."
- Visual: the Ask box with a question waiting ("Send this email?"), drawn in HTML and CSS, not a screenshot. Allow and
  Deny wait 0.75 s and work; clicking shows what would happen. This proves the claim with the product, not with
  adjectives.

**3. How it works.** "Four steps from your voice to a finished task." You speak (on the Mac) · Claude plans (only
Stephen's own tools) · The gate checks (allowed, asks you, never) · Stephen answers (out loud and in writing, every
step listed). A numbered row, because it is a real sequence.

**4. The rules** (navy band, the app's Navy theme). "The model can ask. Only the gate can say yes." Four rules: a spoken
"yes" never counts; private data is tracked; web pages and emails are data; everything is on the record (with the
source: typed, F5, "Hey Stephen" or phone).

**5. What Stephen may do.** The same permission table as the app's Personal page (actions by source). Must use the real
cells from the gate's rules before publishing; the mock's cells are examples and say so.

**6. What it does.** Three short lists: School and work (Canvas, mail, Calendar, Notion), Your browser (your own Zen and
Chrome, real pages, passwords always typed by you), Around the Mac (briefing, music, memory only when you say so).

**7. Where it is today.** Two lists. True today: runs daily on its owner's Mac; speech to text on the Mac; gate,
click-only approvals and the record are built and tested. Not yet: no download; speed is a goal; the injection pass
rate will be published when measured.

**8. Questions.** Does my voice leave my Mac? What if a page tells Stephen to do something? Can I say yes to approve? Do
I need another subscription? When can I try it? Native `<details>` elements, no script.

**9. Footer.** One line, no links to social accounts. Later: a link to the GitHub repo and a changelog.

## 4. Visuals each section needs

| Section | Visual | How |
|---|---|---|
| Hero | Ask box with a waiting question | HTML and CSS using the app's tokens; working 0.75 s delay. Later, a short silent screen recording from the real app may replace it (no autoplay, with a poster image and captions) |
| How it works | Four numbered steps | Text only |
| The rules | Navy band | The app's Navy theme colours |
| What Stephen may do | Table | A real HTML table with header cells, scrolls sideways on a phone |
| What it does | Three lists | Text only; no logos |
| Everything else | none | |

No stock photos, no 3D, no illustrations of robots, no gradient blobs, no glow.

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
5. **A licence for the public repo**, if the page says "built in the open". The repo is public today but has no
   licence file, so others may read the code but not reuse it. Cris decides which licence, or the page drops "in the
   open".
6. **No personal data on the page.** The demo uses `school.example` and an invented professor; keep it that way.
7. **The name.** "Stephen" is a common first name; check that the chosen domain and page title do not clash with an
   existing product of the same name.
8. **Hosting and domain chosen by Cris.**

## 8. Questions for Cris

1. Who should the first public version speak to: employers looking at your work, or other Mac users who might use it
   later? The mock speaks to both but leans to the first.
2. Do you want the GitHub repo linked from the page?
