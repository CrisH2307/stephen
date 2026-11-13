# Note: keep the Input Monitoring grant across helper rebuilds

**Status:** Proposed. Paper only; no code, no change to `install-helper`, nothing run on the Mac except read-only checks.
**Date:** 2026-11-12
**Origin:** tracker #10 request 4. The grant was lost after a rebuild and the owner's test on 2026-11-11 failed (F5 and Esc did not reach Stephen).

Sources: `src/helper/install.ts`, `docs/HELPER.md` (Install, Rebuild), `helper/main.swift`, `helper/Core.swift`,
`docs/SYSTEM-DESIGN-STEPHEN.md` section 5, `docs/research/PRODUCT-PLAN-2026-11.md` (U7).

## Facts in the code

| Fact | Where |
|---|---|
| App is `~/Applications/Stephen Helper.app`, bundle id `dev.stephen.helper`, built with `swiftc` from the sources in `HELPER_SOURCES` | `install.ts:1-4`, `19-23`; `helper/Info.plist` |
| Signing is ad hoc: `codesign --force --sign - --identifier dev.stephen.helper <app>`. No entitlements, no certificate, no hardened runtime flag | `install.ts:72-74`, run at `243`; `docs/HELPER.md:38-39` |
| Every run rebuilds: compile, write Info.plist, copy binary, sign, replace the old app. There is no "already up to date" check | `install.ts:226-252` |
| The Info.plist embeds the Stephen package version, so even an unchanged binary gets a different bundle after a version bump | `install.ts:76-79`, `236-239` |
| The install text already warns that a rebuild changes the signature and the grant may need to be redone | `install.ts:145-146`; `docs/HELPER.md:60-63` |
| The permission is for a listen-only session event tap on key down, key up and flags changed; granted state is read with `CGPreflightListenEventAccess` | `helper/main.swift:105-127`, `498`, `527` |
| The Settings pane link already exists in the helper | `helper/main.swift:258` |
| The socket checks the peer uid only (`getpeereid`), not the program | `helper/Core.swift:705` |

History of `install.ts` (`git log --oneline -15`): ten commits, the older ones are early fixes (`fd73eca src`, `c196b60 helper src`,
`9280abd push`, `6a4258c error 600`); the rest are UI commits that only add Swift files to `HELPER_SOURCES`. Signing never changed.

## Why the grant is lost

macOS privacy control (TCC) remembers an app by its **code signing requirement**, not by its name or folder. For a build signed
with a real certificate the requirement says "this bundle id, signed by this certificate", which stays true after a rebuild.
An ad-hoc signature has no certificate. Its requirement is only the hash of this exact build.

Checked on the installed app (read-only `codesign`): `Signature=adhoc`, `TeamIdentifier=not set`, no internal requirements, and
the designated requirement is `designated => cdhash H"<hash>"`. So any change to the binary or Info.plist gives a new hash,
which looks like a different app. The old row in Input Monitoring may still show "on", but it belongs to the old hash.
That also explains the "listed as granted but keys do nothing" case in `docs/HELPER.md:60-63`.

## Confidence

Marked in the table below: **Doc** = I am sure from documented macOS behaviour; **Mac** = must be confirmed on the owner's Mac (macOS 26)
before we rely on it. Nothing marked Mac is a fact yet.

## Options

| | A. Skip rebuild when unchanged | B. Self-signed certificate (local) | C. Apple Development or Developer ID | D. Stay ad hoc, ease the re-grant |
|---|---|---|---|---|
| How it works | Hash the Swift sources, build flags and version; if the installed app matches, do nothing | Make one code-signing certificate in the login keychain; `--sign "<name>"` instead of `-`; requirement becomes bundle id plus that certificate | Same, with a certificate Apple issued (free Apple ID in Xcode, or paid Developer ID) | Detect "not granted", open the Input Monitoring pane, show one instruction, optionally `tccutil reset ListenEvent dev.stephen.helper` |
| Owner does once | Nothing | Create the certificate (about 5 steps below), allow `codesign` to use the key once, grant Input Monitoring once | Sign in to Xcode with an Apple ID, or pay 99 USD a year; grant once | Follow the message after each rebuild |
| Cost and risk | Tiny. Risk: a wrong hash skips a needed build (include every source, flag, version, compiler version) | Small code change in `install.ts` plus a doc. Risk: key lives in the keychain, see the threat note | Free tier: certificate expires after one year, needs Xcode. Paid: money, and Developer ID is what distribution needs later (U7: later) | Tiny. Does not fix the cause |
| New Mac | Not relevant | Make a new certificate on each Mac (never copy the key) | Each Mac signs in or installs the certificate | Same message on every rebuild |
| Grant survives a rebuild | Yes when nothing changed (same binary). No after any Swift change or version bump | Expected yes (**Doc**: TCC matches the designated requirement) | Expected yes (**Doc**) | No |
| Needs Mac check | Version in Info.plist: decide if a bump counts as a change | Yes, see list | Yes | `tccutil` effect on macOS 26 |

## Claims and their confidence

| Claim | Confidence |
|---|---|
| TCC keys an app by its code requirement; ad hoc means requirement = cdhash | **Doc**; the cdhash form is **confirmed** by `codesign -d -r-` on the installed app |
| With a certificate-based requirement the Input Monitoring grant survives rebuilds | **Doc** for the principle; **Mac** for Input Monitoring on macOS 26 specifically |
| A self-signed (not Apple-trusted) certificate is accepted by TCC for this | **Mac**. Some privacy services are known to be picky; test first |
| `codesign` shows a keychain prompt the first time it uses the key | **Doc**; "Always Allow" removes it, **Mac** to confirm wording |
| The key can be created with Certificate Assistant (Code Signing type, Self Signed Root) | **Doc** for the tool; **Mac** for the exact menu text on macOS 26 |
| `security find-identity -v -p codesigning` lists it as valid | **Mac**. On this Mac it currently reports 0 valid identities, so nothing exists yet. A self-signed root may show only without `-v` until trusted |
| The Settings link opens the Input Monitoring pane | In use in `main.swift:258`; **Mac** that it still works on macOS 26 |
| `tccutil reset ListenEvent <bundle id>` clears the stale row | **Doc** for the command; **Mac** that it works without a reboot |

## Recommendation (ordered)

1. **A now.** Add a "no change, no rebuild" check to `install-helper`: store a hash of source files, `swiftcArgs`, version and compiler path next to the app; when it matches and the app is signed, print "Stephen Helper is up to date" and exit. Acceptance: run `install-helper` twice with no edits; the second run builds nothing and the grant stays.
2. **B as the real fix.** Add a `--sign-identity` setting (config or env var) used by `codesignArgs`; default stays ad hoc so nothing breaks. Acceptance: with the certificate set up, change one Swift file, run `install-helper` twice; F5 and Esc still work each time with **no visit to System Settings**. `codesign -d -r-` shows an identifier plus certificate requirement, not a cdhash.
3. **D as the fallback.** When the helper reports not granted (it already knows), `stephen doctor` and the menu say: "Open System Settings, Privacy and Security, Input Monitoring, turn Stephen Helper on", with the pane link. Acceptance: after a deliberate ad-hoc rebuild, the message appears and one click reaches the right pane.
4. **C when distribution starts** (U7). Developer ID plus notarization is a separate decision with its own note.

If B fails the TCC check on the owner's Mac, go to C (free Apple Development) before giving up, and keep D.

## Threat note

- **What changes.** Today every rebuild needs a fresh owner grant, because the identity is a throwaway hash. That is an accidental safety property: a swapped binary never inherits the grant. With B, the identity is a key. Any process of the same user that can use that key can sign a program that inherits the helper's Input Monitoring grant, which is a key logger for the whole session.
- **Scope.** Same-user malware is out of scope (`docs/SYSTEM-DESIGN-STEPHEN.md` section 5, last row). It could already add itself to Input Monitoring only with the owner's click, so B lowers that bar. Said plainly: we trade a painful property for convenience.
- **Controls.** The key is created in the login keychain, never exported, never committed, never placed in the repo or `~/.stephen`; it is not an Apple-trusted certificate, so it opens no other door (no Gatekeeper pass, no notarization). Do not mark the key as "allow all apps"; keep the first-use prompt on, then "Always Allow" for `codesign` only.
- **Socket.** The helper checks only the peer user id (`helper/Core.swift:705`), so the signature is not what protects the socket. Pinning the client program is a separate hardening item ("helper.sock nonce" in section 5).
- **Still true.** The helper is listen-only (`main.swift:111-117`); it cannot inject keys.

## What the owner does once (option B)

1. Open **Keychain Access**. In the menu bar choose **Keychain Access > Certificate Assistant > Create a Certificate**.
2. Name it with any plain word you will remember, for example "Stephen Local". Leave Identity Type as **Self Signed Root**. Set Certificate Type to **Code Signing**. Click **Create**.
3. In the list, check the certificate appears under **login**. Do not export it.
4. Tell the dev team only the name you chose (it is a setting, not a secret).
5. Run `stephen install-helper`. If a box asks whether `codesign` may use the key, click **Always Allow**.
6. When "Stephen Helper" asks for keystrokes, click **Open System Settings** and turn it on. If it was already listed, remove it with the minus button first and add it again.
7. You should see **Input Monitoring: granted** in the Stephen menu. This is the last time you do this.
8. Check: ask the dev team for a rebuild, then press F5. It should work without opening System Settings.

## Open questions

- Owner: is it acceptable that anything running as you could, in principle, sign a program that inherits the grant (threat note)?
- Owner: free Apple Development certificate (expires yearly, needs Xcode sign-in) or the local self-signed one first?
- Dev team: does a package version bump alone count as a change for A? A cheap answer is to read the version from outside the bundle signature, which needs a change to the plist handling.
- Dev team: should the signing identity live in `~/.stephen/config` or an env var, and should `stephen doctor` print `codesign -d -r-` (requirement kind only, never names) so we can see "cdhash" versus "certificate" at a glance?
- Dev team: after B, should `install-helper` refuse to fall back to ad hoc silently when the named identity is missing, and say why?
