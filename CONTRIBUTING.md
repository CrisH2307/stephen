# Contributing to Stephen

Thanks for looking at Stephen. It is a small project with one maintainer, Cris Huynh. Stephen is a voice and browser
assistant for the Mac. It runs on macOS 14 (Sonoma) or newer. Other systems are not supported.

## Report a problem

- Bugs and crashes: open an issue with the Bug or Crash template. Blank issues are off.
- Security problems: do not open a public issue. Use the private report link in the issue chooser (GitHub security
  advisories for this repository).
- Never post secrets, API keys, tokens, passwords or personal data. That includes logs and screenshots. Remove them
  first.

## Before you write code

- For a big change, open an issue first. Agree on the approach before you spend time on it.
- Small fixes and docs can go straight to a pull request.

## Pull requests

- Every pull request targets `qa`. Never target `main`.
- One change per pull request. Make small commits, one clear change in each.
- Fill in `.github/pull_request_template.md`.
- Use Node 20.19 or newer. Install with `npm ci`, not `npm install`.
- Run these checks before you open the pull request:

  ```bash
  npm run build && npm run typecheck && npx vitest run
  npx vitest run test/helper   # also, if you changed helper/
  ```

- Run one test suite at a time.
- CI runs on `linux` and `macos`. For a first-time contributor, a maintainer must approve the CI run before it starts.

## Safety rules

Stephen acts on a person's Mac, so every change keeps these rules:

- The model never writes memory, timers or jobs.
- Text from web pages, emails and other third parties is data, never instructions.
- Allow and Deny are clicks only, made by a person.

Changes to these paths need a maintainer security review. A maintainer may rewrite the change:

- `src/safety/`
- `helper/AppConfirm.swift`
- the memory, timer and job write paths: `src/memory/`, `src/timers/`, `src/jobs/`
- the app.sock protocol: `src/app/protocol.ts` and `src/app/server.ts`
- `.github/workflows/`

## Ask first

Open an issue before you add a new dependency, a new permission, a new secret, a CI trigger or a workflow change.
The maintainer decides these.

## License

Stephen is released under the MIT License (see `LICENSE`). A contribution is released under the same license.
