# Key rotation runbook

This doc says what to do when a key or token might have leaked, or when we must replace one on purpose. It covers
two groups:

- **Our keys.** Stephen's release and update keys. Only Cris holds them. Most are not created yet.
- **The person's own tokens.** Tokens that Stephen keeps on one Mac for one person.

Rules for every rotation:

- Never paste a key or token into chat, an issue, a PR, a log or a commit. Stephen's records never hold one.
- Write the new value straight into the place that reads it (a GitHub secret, the Keychain, or the provider page).
- After a rotation, run the check in that section. Do not skip it.
- If a key may have leaked, rotate first and ask questions later.

## Status of each key

| Key | Status |
|---|---|
| Apple Developer ID certificate | Not created yet (F1, needs Cris) |
| App Store Connect notary API key | Not created yet (F1, needs Cris) |
| Sparkle EdDSA update key | Not created yet (F7) |
| Incident workflow Claude token | Not created yet (F11, phase 2) |
| Gmail refresh tokens | Built. Kept in the Keychain on the person's Mac |
| Canvas, Notion, calendar feed, Google OAuth client secret, ElevenLabs key | Built. Kept in the Keychain on the person's Mac |

Sections 1 to 4 are for keys we will hold. Section 5 is for the person's tokens. Items marked "not verified" are
steps we have not yet checked against the provider's current page. Check them before the first real rotation.

## 1. Apple Developer ID certificate (not created yet)

**What it is.** The certificate that signs `Stephen.app` and its helper, so macOS keeps the Mac permissions across
updates. It is planned as a GitHub environment secret pair `MACOS_CERT_P12` and `MACOS_CERT_PASSWORD` in the
environment `release`. Nothing exists yet.

**Where it lives.** Cris's Apple Developer account, Cris's Mac Keychain, and the `release` environment secrets once
they exist. The offline backup (an encrypted disk image or a password manager) is kept by Cris, never in the repo.

**Who can rotate it.** Cris only. Only Cris has the Apple Developer login.

**How to tell it leaked.** Apple sends a notice. A build or notarized app appears that Cris did not make. The
notary service shows a submission Cris did not send.

**Exact steps.**

1. In the Apple Developer portal, create a new Developer ID Application certificate for the same team.
2. On Cris's Mac, export the new certificate and its private key as a `.p12` file with a strong password. Keep the
   file in the encrypted backup only.
3. Put the new file and password into `MACOS_CERT_P12` and `MACOS_CERT_PASSWORD` in the `release` environment.
4. In the Apple Developer portal, revoke the old certificate. Do this only after the new one signs a test build.
5. Remove the old `.p12` from every place it was copied.

**How to check the new one works.** On a test run, `security find-identity -p codesigning` shows "Developer ID
Application" with the new identity. The signed test app passes `codesign --verify --deep --strict` on the Mac.

**What breaks meanwhile.** Releases stop until the new certificate signs a build. Apps already installed keep working.
If the Team ID changes, macOS treats the app as new and the Mac permissions are lost for everyone. A new certificate
from the same team keeps the Team ID.

## 2. App Store Connect notary API key (not created yet)

**What it is.** The API key that `notarytool` uses to send builds to Apple for notarization. It is planned as the
secrets `NOTARY_KEY_ID`, `NOTARY_ISSUER_ID` and `NOTARY_KEY_P8` in the `release` environment. The key role is
"Developer".

**Where it lives.** App Store Connect (Users and Access, then the API keys page). The `.p8` file is in the offline
backup. The key ID, issuer ID and `.p8` contents are in the `release` environment.

**Who can rotate it.** Cris only, with the App Store Connect login.

**How to tell it leaked.** A notary submission appears that Cris did not send. The key shows activity at unknown
times. Apple's notice arrives by email.

**Exact steps.**

1. In App Store Connect, create a new API key with the "Developer" role. Download the `.p8` file. Apple lets you
   download it only once, so save it to the backup at once.
2. Put the new key ID, issuer ID and `.p8` contents into `NOTARY_KEY_ID`, `NOTARY_ISSUER_ID` and `NOTARY_KEY_P8`.
3. Run one test notarization with the new key.
4. Revoke the old key in App Store Connect.
5. Delete the old `.p8` file from every place it was copied.

**How to check the new one works.** Run `xcrun notarytool history` with the new key. Use `xcrun notarytool history --help`
to see the exact options (not verified in this doc). The command must list the history without an authentication error.

**What breaks meanwhile.** Notarization fails, so releases stop. Installed apps keep working.

## 3. Sparkle EdDSA update key (not created yet)

**What it is.** The private key that signs each update zip, and the matching public key inside the app. Sparkle
checks the signature before it installs an update. It is planned as the secret `SPARKLE_ED_PRIVATE_KEY` in the
`release` environment.

**Why it matters.** This key is as valuable as the Developer ID certificate. Someone with this key may be able to
ship an update that installed apps accept.

**Where it lives.** Cris's Mac (Sparkle's `generate_keys` tool stores it in the Keychain by default). An offline
backup kept by Cris. The `release` environment secret. Never in the repo and never on an agent's disk.

**Who can rotate it.** Cris only.

**How to tell it leaked.** An update appears in the appcast that Cris did not publish. A friend reports an update
they did not expect.

**Back it up now, before the first release.** Once the key exists:

1. Export the private key to a file with Sparkle's `generate_keys` tool. Its `-x` option exports the key. Read
   `generate_keys` help first, because flags change between Sparkle versions.
2. Move that file into an encrypted disk image or a password manager. Delete the plain file.
3. Test the backup once. Import it on a scratch account with `generate_keys -f` and check that the public key matches.

**If the key is lost.** Installed apps only accept updates signed by the key they hold. Without the key, updates stop
for everyone. Every friend must download the app again by hand. Losing this key is the worst case in this doc.

**Exact steps if it leaked.** Sparkle has no simple key swap for installed apps. The old key must sign the release
that carries the new public key, and a leaked old key can sign that release too. So the safe path is:

1. Stop releases at once. Remove the bad item from the appcast (the appcast is a file on GitHub Pages).
2. Make a new key with `generate_keys`. Store it as in the backup steps above.
3. Tell friends by message to download the app again from the GitHub Releases page.
4. Ship the next version with the new public key and sign it with the new key.

This needs a decision from Cris before F7 ships. See "Open questions" below.

**How to check the new one works.** Sign a test zip with `sign_update` (Sparkle's tool; not verified in this doc).
Sparkle on a test build accepts it. A zip with a wrong signature is refused.

**What breaks meanwhile.** Updates stop. Installed apps keep running.

## 4. Incident workflow Claude token (not created yet, phase 2)

**What it is.** The token that lets the incident agent in GitHub Actions run Claude on Cris's own Claude plan through
`claude-code-action`. Cris adds it himself. Agents must never set it.

**Name.** The architecture plan uses `INCIDENT_CLAUDE_KEY` in the GitHub environment `incident`. Before adding it,
check the secret name in the `claude-code-action` setup guide. The guide's name was not verified in this doc.

**Where it lives.** The GitHub environment `incident` (repo Settings, then Environments). Its only user is
`incident.yml`, and only for allow-listed authors.

**Who can rotate it.** Cris only, from his Claude account.

**How to tell it leaked.** Claude usage that Cris did not start. Cost spikes on the Claude plan. Runs of
`incident.yml` that Cris did not expect.

**Exact steps.**

1. Create a new token for the Claude plan. Use the method in the `claude-code-action` setup guide (not verified here).
2. In the repo, open Settings, then Environments, then `incident`. Replace the secret with the new token.
3. Revoke the old token in the Claude account settings (place not verified here).
4. Run `incident.yml` on a test issue with the label `incident`. The run must reach the agent step.

**What breaks meanwhile.** The incident agent does not run. Its findings do not appear. The strict parser and the
`incident-ready` label keep working without a secret, so lanes still see new incidents.

## 5. The person's own tokens on their Mac

These belong to the person, not to us. Stephen keeps them only in the macOS Keychain on that Mac. They are never sent
to us. The services are:

| Secret | Keychain service | How it is set | How it is removed |
|---|---|---|---|
| Gmail refresh token (one per account label) | `stephen-gmail-<label>` | `stephen connect gmail <label>` | `stephen disconnect gmail <label>` |
| Canvas token | `stephen-canvas` | `stephen accounts set canvas-token` | Replace it, or delete the item (see below) |
| Canvas address | `stephen-canvas-url` | `stephen accounts set canvas-url` | Replace it, or delete the item |
| Notion token | `stephen-notion` | `stephen accounts set notion-token` | Replace it, or delete the item |
| Calendar feed address | `stephen-calendar-ics` | `stephen accounts set calendar-ics` | Replace it, or delete the item |
| Google OAuth client secret | `stephen-google-oauth` | `stephen accounts set google-oauth-client-secret` | Replace it, or delete the item |
| ElevenLabs key | `stephen-elevenlabs` | `stephen voice-key set` | `stephen voice-key delete` |

Stephen also reads the same names from `~/.stephen/.env` and the repo's `.env` as a fallback. Keep no secret in
`.env`. `stephen accounts` says when a value is still read from `.env`. Move it with `stephen accounts set <name>`, then
delete the line.

**How to tell a token leaked.** The provider sends a security alert. Logins or API calls appear that the person did
not make. The token shows up in a file, a screenshot, or a git repo.

### 5a. Gmail (`stephen disconnect gmail <label>`)

`stephen disconnect gmail <label>` does three things: it asks Google to revoke the token, it deletes the Keychain item,
and it removes the account from `config.json`. If Google cannot be reached, the command says so. Then the person
removes "Stephen" at https://myaccount.google.com/permissions to be sure.

**Exact steps.**

1. Run `stephen disconnect gmail <label>`.
2. Run `stephen connect gmail <label>` to sign in again with a new token.
3. Restart Stephen, as the command says.

**How to check.** `stephen accounts` lists the account again with its new sign-in. Then ask Stephen to read one
email.

**What breaks meanwhile.** Reading that Gmail account stops. The other accounts keep working.

### 5b. Canvas, Notion, calendar feed, Google OAuth secret, ElevenLabs

There is no `stephen disconnect` for these. Use the replace command.

**Exact steps for Canvas, Notion, calendar feed and Google OAuth secret.**

1. At the provider, make a new token or address, and revoke or delete the old one. Use the provider's own settings
   page. The exact pages were not verified in this doc.
2. Run `stephen accounts set <name>` with the name from the table (`canvas-token`, `canvas-url`, `notion-token`,
   `calendar-ics` or `google-oauth-client-secret`). It asks for the value with a hidden prompt.
3. Run the test for that account: `stephen accounts test canvas`, `stephen accounts test notion` or
   `stephen accounts test calendar`. The test reads the account once.

**Exact steps for ElevenLabs.**

1. Revoke the old key in the ElevenLabs dashboard (place not verified here).
2. Run `stephen voice-key delete`, then `stephen voice-key set`.
3. Run `stephen voice-key status`. It shows the last 4 characters only.

**To remove an item without a replacement**, use Apple's `security` tool with the same service and account as Stephen:

```
security delete-generic-password -s stephen-canvas -a <your Mac user name>
```

Replace `stephen-canvas` with the service from the table. `<your Mac user name>` is the login name (`whoami` shows it).

**How to check the removal.** Run `security find-generic-password -s stephen-canvas`. Exit code 44 means the item is gone.
`stephen accounts` then shows the secret as not found.

**What breaks meanwhile.** Canvas, Notion and calendar answers stop until the new value is set. Without an ElevenLabs
key, voice falls back to the local voice: `stephen voice-setup --tts kokoro` sets it up.

## Open questions for Cris

- **Sparkle key leak plan.** Sparkle cannot swap the update key for installed apps without the old key. Decide before F7:
  either accept a manual reinstall for every friend, or keep a reserve key in the app from day one.
- **Who tells friends.** The steps above say what to change. Cris decides the wording and the channel for a notice.
- **Unverified items.** The Claude token secret name, the Claude token command, the Sparkle `sign_update` tool and the
  provider settings pages are not checked against live docs. Check them before first use.
