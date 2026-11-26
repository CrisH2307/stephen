# Questions people ask

### Is Stephen free?

Stephen itself is free and [open source](GLOSSARY.md#open-source). It runs on your own
[Claude plan](GLOSSARY.md#claude-plan), so what you use counts against your plan, not anyone else's.

### Is Stephen made by Anthropic or Apple?

No. Cris made Stephen. It uses Claude, which Anthropic makes, through your own Claude account. Stephen is not
connected with Anthropic, Apple, Google or any other company it talks to.

### Does Stephen listen to everything I say?

The microphone is on while Stephen is running, so it can hear "Hey Stephen". That check happens on your Mac, and
the audio is not sent anywhere. Only after the wake word (or while you hold F5) does it write down your command.
If you prefer, you can turn the wake word off and use only F5.

### Does Cris see my commands or my data?

No. There is no Stephen server. Nothing is sent to Cris unless you send a crash report yourself, and you see the
report before it is sent.

### What does Anthropic see?

What you ask, the things you asked Stephen to remember, and what Claude reads to answer you (for example a web page
or an email). That is handled under your own Claude account's rules, like when you use Claude yourself. See
[what leaves your Mac](SAFETY-IN-PLAIN-WORDS.md#what-leaves-your-mac).

### Can Stephen send emails or buy things for me?

Stephen only reads your email, calendar, Canvas and Notion. In your browser, it can click buttons like Send or Buy,
but only after you click **Allow** on a card that shows exactly what it is about to do.

### Can a website trick Stephen?

A website can try. That is called [prompt injection](GLOSSARY.md#prompt-injection). Stephen treats page text as
data, never as orders, and any risky step still waits for your click. No AI is fully immune, which is why the
Allow / Deny card exists. Read it before you click Allow.

### Why won't Stephen type my password?

On purpose. Passwords, one-time codes and card numbers are typed by you, always. Stephen asks you to type them,
then goes on.

### Why does Stephen sometimes say "Hold F5 for that"?

Your Mac was playing sound when you said "Hey Stephen". A video could be saying "Hey Stephen" too, so while sound
plays, the wake word only works for media commands like "pause" or "next". Hold F5 for anything else.

### Why is the wake word slower than F5?

We are still working on it. Today F5 is much faster. See the [introduction](INTRODUCTION.md#honest-limits-today).

### Does it work on Windows, Linux or an Intel Mac?

Not for the beta. It needs a Mac with Apple silicon (M1 or newer) and macOS 14 or newer.

### Does it work with Safari or Firefox?

Stephen controls Zen and Chrome. It can still open apps like Safari, but it cannot click or read inside them.

### How do I delete everything Stephen kept?

Follow [deleting everything](../PRIVACY.md#9-deleting-everything) on the privacy page. Your conversation history
is deleted after 7 days on its own (you can choose 0 to 30 days).

### Something broke. What do I do?

1. Run `stephen doctor` in Terminal. It prints a fix for each problem.
2. If Stephen crashed, run `stephen report`. It shows you the report first, and sends nothing until you type "y".
   The report holds no words, pages, names or audio.
3. Open an issue on GitHub, or tell Cris. Issues are public: never paste private text.

### I found a security problem.

Please don't post it in public. Use the private security reporting on the repository's Security tab, or tell Cris
directly.

### What does this word mean?

See the [glossary](GLOSSARY.md).
