# Friends beta invite (draft)

For Cris to copy and send. Nothing is sent from the repo. Check the "Before you send" list first.

## Before you send

- [ ] The checklist in `docs/RELEASE-PLAN.md`, section 5, is green. The beta date is Cris's decision there.
- [ ] `stephen setup` and `stephen update` are merged. If not, keep the manual steps below. If yes, replace them
      with `stephen setup`.
- [ ] You know each friend has a Mac on macOS 14 or newer, and a Claude account with Claude Code.
- [ ] Cris will sit with the first friend and time the setup (`docs/NFR-STEPHEN.md`, section 7).

## The message

> Hey! I built a voice assistant for my Mac. It is called Stephen. You say "Hey Stephen, open YouTube", or hold
> F5 and talk, and it does it in your browser (Zen or Chrome).
>
> It asks you before anything risky, in a normal Mac pop-up. Web pages cannot give it orders. Your voice is
> turned into text on your own Mac, and I never get your data. There is no server.
>
> I want 3 to 5 friends to try it for 2 weeks and tell me what breaks. It is early. Some things are slow.
>
> You need: a Mac with macOS 14 or newer, Node, Claude Code signed in, and about 30 minutes the first time.
> I will help you set it up. Want to try?

Short version for a chat app:

> I made a voice assistant for Mac. Want to beta test it for 2 weeks? You say "Hey Stephen, open YouTube" and it
> does it. It asks before risky things and your voice stays on your Mac. Needs macOS 14+ and Claude Code.

## What testers do

1. Set it up with Cris (about 15 to 30 minutes). Say where you got stuck.
2. Use it for real things for 2 weeks: open sites, play music, ask what is due, set timers.
3. Try both ways: hold F5, and say "Hey Stephen".
4. Click Allow or Deny on the Mac pop-ups. Say if one surprised you.
5. Report anything wrong (below). A small thing is fine.

Please do not test attacks on other people's accounts or sites. Only your own.

## How to report a problem

- **It crashed or quit:** run `stephen report`. It shows you the file first. It sends nothing until you read it and
  type y. The file holds no words, web addresses, page text, names or audio, only times, versions and code words
  (`docs/NFR-STEPHEN.md`, section 9). It opens a GitHub issue with your own `gh` sign-in.
- **Something does not work:** open a **Bug** issue at github.com/CrisH2307/stephen/issues/new/choose.
- **You want it to do more:** open a **User story** issue on the same page.
- **A security problem:** use the private "Security problem" link on that page. Do not post it in public.
- **Not sure:** message Cris.

Run `stephen doctor` first. It tells you what is wrong with your setup.

Issues on this repo are public. Do not paste private text, emails or screenshots of your accounts.

## What stays on your Mac

The full list, with how long each thing is kept and how to delete it, is `docs/DATA-STORES.md`. In short:

| What | Kept | Delete it |
|---|---|---|
| Things you asked it to remember | Until you forget them (at most 30) | Say "forget ...", or `stephen memory` |
| Conversation history | 7 days by default (0 to 30) | `stephen history clear` |
| Timers | Until done (at most 20) | "Cancel the timer" |
| Speed numbers | 30 days, no words in them | Delete the folder |
| Crash records | 30 days, no words in them | Delete the folder |
| F5 recordings | Off unless you turn them on. 30 days | Settings, Privacy, or `stephen replay delete --all` |
| Passwords and tokens for connected accounts | macOS Keychain, never shown to the model | `stephen disconnect <account>` |

Everything is under `~/.stephen`, in folders only you can read.

What does leave your Mac:
- The text of your command, and what Stephen reads to answer it (a page, an email), go to Claude, through your own Claude account.
- Calls to accounts you connect (for example Gmail, Canvas), made from your Mac.

Nothing is sent to Cris or to us. Your audio is never uploaded.

## Known rough edges (tell friends up front)

- Setup is a few Terminal steps today. macOS asks for Microphone, Input Monitoring and Accessibility.
- The app is not signed yet. After an update, macOS may ask for permission again.
- "Hey Stephen" is slower than F5 right now.
- Zen needs to be opened with the "Zen for Stephen" app. While it runs, other programs on your Mac can reach its
  control port (see `README.md`). Quit Zen when you are not using Stephen.
- A daily cost limit is built in `qa`. Check it is on before the beta (`docs/NFR-STEPHEN.md`, section 6).
