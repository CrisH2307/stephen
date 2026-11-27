# Your first 5 minutes with Stephen

This page starts after Stephen is installed ([Getting started](guide/GETTING-STARTED.md), steps 1 to 3). Setting up is clicks in the Stephen window, except signing in to Claude Code, which needs Terminal. Leaving Stephen also uses Terminal for a few commands.

## 1. Open the Stephen window

1. Click the Stephen icon in the menu bar, then "Open Stephen…".
2. The first time, a sheet called "Set up Stephen" opens. It checks three things and runs nothing on its own.

## 2. Claude Code

1. Step 1 of the sheet checks that Claude Code is installed and signed in.
2. If it says Claude Code is not on this Mac yet: press "Open the Claude Code page", follow the install steps on that page, then press "Check again".
3. If it says Claude Code is not signed in: open Terminal, type claude, press Return and sign in. The sheet shows the word claude with a Copy button. Then press "Check again". This is the only setup step that needs Terminal.

## 3. Voice models

1. Step 2 checks the voice models (the wake word and speech to text). They stay on this Mac.
2. If they are missing, press "Download". A bar shows the progress, for example "Downloading voice model 1 of 3".
3. If the download stops, the sheet says so. Check the internet and press "Retry". What was already downloaded is kept.
4. You can press "Later" and come back; a download that is running keeps going.

## 4. Mac permissions

1. Step 3 shows three permissions and whether each is on: Microphone (to hear you after F5 or "Hey Stephen"), Input Monitoring (to notice F5 and Esc anywhere), Accessibility (to press play, pause and next for you).
2. Microphone: press "Ask now" and click Allow. macOS adds apps to the Microphone list only when they ask. If you said no before, press "Open Settings" and turn on "Stephen Helper" there.
3. Input Monitoring and Accessibility: press "Open Settings", turn on "Stephen Helper". If it is not in the list, click + and choose it from Applications in your home folder.
4. Press "Check again" to see the new state.

## 5. Your first command

1. When all steps are ready, the sheet says "You're set". Press "Continue".
2. Start Stephen from the menu bar icon if it is not running.
3. Hold F5, say "what time is it", and let go. Stephen answers out loud.
4. F5 starts Dictation on some keyboards: hold Fn+F5, or Fn+Option, instead.
5. To see the setup sheet again: Settings, About, "Run setup again".
6. Optional: Settings, About, turn on "Start Stephen at login" so the icon opens when you log in.

## How to leave

1. Turn off "Start Stephen at login": Settings, About (or System Settings, General, Login Items). Do this first, or Stephen starts again at your next login.
2. Quit Stephen: menu bar icon, Quit.
3. Delete what Stephen kept: in Terminal, run `stephen data delete --all`. It lists everything first and asks before it deletes. It also removes Stephen's Keychain items and signs out Gmail. At the end it lists what it did not delete.
4. Remove Stephen from Claude Code (it stops Claude Code from starting Stephen's tools): in Terminal, run `claude mcp remove --scope user stephen`.
5. Delete the apps: move "Stephen Helper" and "Zen for Stephen" (if you use Zen) from Applications in your home folder to the Trash.
6. Delete Stephen itself: in Terminal, run `npm unlink -g stephen`, then delete the stephen folder you downloaded.
7. Claude Code and your Claude account are yours and stay as they are. What you sent to Claude follows your Claude account's own settings.

Stuck? See [If something goes wrong](guide/GETTING-STARTED.md#if-something-goes-wrong).