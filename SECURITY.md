# Security policy

## How to report a vulnerability

Report it privately through GitHub. Open the repository's **Security** tab and click **Report a vulnerability**.
This is GitHub's private vulnerability reporting. The report stays between you and the maintainers.

Please do not open a public issue for a vulnerability. Do not post secrets, tokens, or personal data in any issue
or pull request, even to show a bug. Describe the steps, the version, and what you saw. Leave out anything private.

## What to expect

Stephen is a hobby project with one maintainer. We answer as soon as we can, on a best effort basis. We do not
offer a bounty. We will try to tell you what we found and when a fix ships.

## Supported versions

Only the latest release on `main` is supported. Stephen is at version 0.1.x and is an unsigned beta.

## In scope

- The safety gate: any way Stephen takes an action that the owner did not approve with a click.
- Prompt injection: text from a web page, email, Canvas post, or file that makes Stephen act without a click.
- Private data leaving the Mac in a way the docs do not describe. See `docs/DATA-STORES.md`, and the list of
  outbound traffic in `docs/ARCHITECTURE-PLAN.md`, section 7.2.
- The `app.sock` and `helper.sock` protocols: unauthorized clients that can read data or answer a question.
- Background jobs that get out of their sandbox or run without the owner's approval.
- The CI workflows in `.github/workflows/`, such as a way for a pull request to run untrusted code with secrets.

## Out of scope

- Malware running as the same macOS user. This is documented in `docs/SYSTEM-DESIGN-STEPHEN.md`, section 5.
- Your own accounts with Claude, Google, Canvas, or Notion, and what those services do.
- Bugs in Claude Code itself. Report those to Anthropic.
