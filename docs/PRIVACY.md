# Stephen privacy policy

**Status:** Draft for review (task P2 in `docs/ARCHITECTURE-PLAN.md`, `docs/PRODUCTION-READINESS.md` row 21). Not
published yet. Last checked against the code: 2026-11-25.

Stephen is a voice and browser assistant that runs on your Mac. This page says what it keeps, what leaves your Mac,
and how to delete it. The short version: Stephen keeps your data on your Mac. It sends your commands to Claude under
**your own** Claude account. It sends nothing to us unless you send us a report yourself.

## 1. Who we are

Stephen is free, open source software made by Cris Huynh. The code is public at
`https://github.com/CrisH2307/stephen`. Stephen is not made by, or connected with, Anthropic, Google, Canvas
(Instructure), Notion, ElevenLabs, YouTube or Open-Meteo.

Questions about privacy: open an issue on the GitHub page above, or use GitHub Discussions once it is on. Security
problems: use "Report a vulnerability" on the repository's Security tab once private reporting is turned on (Cris's
answer on #274, 2026-11-25; to be checked before this page is published), so the report stays private.

## 2. What Stephen keeps on your Mac

Everything lives in the folder `~/.stephen` (only your macOS account can open it), in your Keychain, and in the job
folder you choose (`~/Stephen Jobs` by default). The full list, with how long each thing is kept and how to delete it,
is in `docs/DATA-STORES.md`. The main points:

| What | Kept for | How to delete |
|---|---|---|
| Things you asked it to remember | Until you forget them (at most 30 items) | "Forget ...", the Memory page, or `stephen memory` |
| Your conversations (what you said and the replies) | 7 days by default; you can choose 0 to 30 | `stephen history clear`, or set the days to 0 |
| Claude Code's own record of a conversation | Deleted when the conversation ends | `stephen history clear` |
| Timers and reminders | Until done or cancelled | "Cancel the timer" |
| F5 recordings (only if you turn them on) | 30 days, at most 100 clips | The recordings switch in Settings (Privacy and permissions), or `stephen replay delete --all` |
| Speed numbers and crash records | 30 days. They hold times, versions and code words only: never your words, pages or names | Deleted after 30 days, or delete the folder |
| Safety log of actions | Until it rotates (about 20 MB in all). It holds each action's short purpose and arguments (cut to a few hundred characters); typed text shows only as a length | Delete `~/.stephen/audit.log` and its `.1` to `.3` files |
| Background jobs | Their logs 30 days after they end; the job folders until you delete them | Finder |
| Settings | Until you change them | Edit or delete `~/.stephen/config.json` |
| Tokens for your accounts | In your macOS Keychain until you remove them. Never shown to the model | Gmail: `stephen disconnect gmail <label>`. Others: delete the `stephen-...` items in the Keychain Access app (section 9) |

**Your voice stays on your Mac.** The wake word and speech to text run on your Mac. Audio is never sent anywhere.

## 3. What leaves your Mac

Only what is in this table. Each row was checked against the code on 2026-11-25. The same list, with the code for
each row, goes into `docs/DATA-STORES.md` ("Everything that leaves the Mac", PR #327); the two must stay equal.

| Goes to | What | When |
|---|---|---|
| Anthropic, under your own Claude account | Your command as text, the things you asked Stephen to remember, and what the model reads to answer (page text, email text, Canvas, calendar, Notion) | Every command that needs the model |
| Anthropic, background jobs | The job's task and what the job reads and writes in its folder | Each job you start |
| Anthropic, phone link | The phone conversation, through Claude Code's Remote Control | Only while you have turned the phone link on |
| Google (Gmail), Canvas, Notion | Read requests, with your own sign-in or token. Stephen only reads these accounts | When you ask about that account |
| Your calendar feed (the secret iCal address you set, usually Google Calendar) | One request for the feed. The address itself is the key | When you ask about your calendar or your day |
| ElevenLabs | The reply text to be spoken | Only if you added an ElevenLabs key and chose that voice |
| YouTube and YouTube Music (`www.youtube.com`, `music.youtube.com`) | The words of what you asked to play, as a search | When you ask Stephen to play something |
| Open-Meteo | The latitude and longitude of the place in your settings (Toronto when none is set) | When you ask for the weather or your day |
| GitHub | Your IP address, when Stephen downloads a speech or voice model or you run `stephen update`. A crash report only after you type "y", posted with your own GitHub sign-in, so your GitHub name shows on it | First set-up, each update, each report you send |
| The npm package registry | Your IP address and the package names Stephen needs | Each `stephen update` |
| Websites | Whatever you ask Stephen to open. A background job you start "with web" also searches and reads web pages | When you ask |
| Us (Cris) | Nothing, unless you send a report | |

There is no analytics, no tracking, and no advertising. Stephen does not sell or share your data.

## 4. Anthropic and your Claude account

Stephen uses Claude Code, signed in with your own Claude account. What you send to Claude is handled under
Anthropic's terms and privacy policy for your account, not under this page. Stephen cannot change those rules. Stephen
tells Claude that web pages, emails and other text it reads are data, never instructions, and every risky action asks
you first.

## 5. Your connected accounts

Gmail, Google Calendar, Canvas and Notion are off until you connect them. Stephen's code only reads these accounts.
For Gmail it asks Google for read-only access. A Canvas or Notion token, or a calendar address, is one you create
yourself, and it may allow more than reading: Stephen still only reads with it. Tokens are kept in your macOS
Keychain and are never given to the model. If you put a token in a `.env` file instead (`~/.stephen/.env`, or the older `.env` in the
Stephen folder you installed from git), it is stored there as plain text; the Keychain is safer.

To disconnect Gmail, run `stephen disconnect gmail <label>`: it asks Google to revoke the token and deletes it. For
the others, delete the Keychain items named `stephen-canvas`, `stephen-canvas-url`, `stephen-notion`,
`stephen-calendar-ics` and `stephen-google-oauth` in the Keychain Access app, and revoke the token on that service's own settings page.

## 6. Crash reports

When something breaks, Stephen writes a small crash record on your Mac: the time, the version, which part failed, a
code word for the error, and timings. It never holds your words, web pages, addresses, file names or audio.

Nothing is sent unless you choose to. `stephen report` shows you the exact text first and sends it only if you type
"y", with your own GitHub sign-in. It becomes a **public** GitHub issue under your GitHub name, so it must not hold anything private, and it does not. A future setting,
"Report crashes on its own", will be **off** unless you turn it on.

## 7. Updates

Today you update Stephen with `stephen update`, which downloads the new version from GitHub. A later version may check
for updates once a day. Either way GitHub sees your IP address and which version you download.

## 8. Children

Stephen is not for children. You must be old enough to use Claude under your Claude account's terms.

## 9. Deleting everything

1. Run `stephen disconnect gmail <label>` for each Gmail account, and delete the other `stephen-...` Keychain items
   (section 5). Also delete `stephen-elevenlabs` if you added an ElevenLabs key, and any `.env` file you made (in `~/.stephen` or the Stephen folder).
2. Delete the folder `~/.stephen` and your job folder (`~/Stephen Jobs` by default).
3. Delete the Stephen app.

What you sent to Claude stays under your Claude account's own settings and history rules.

## 10. Changes to this page

Changes are listed in the release notes and in this file's history on GitHub.
