/**
 * `serve --confirm dialog|deny`: force how confirmations are asked for this server process. Only these two
 * values are accepted, so the flag can make confirmation stricter but never skip it. The voice listener
 * starts the server with `--confirm dialog`: headless `claude -p` has no one watching the chat, so an
 * in-chat (elicitation) prompt would go unanswered — the macOS dialog is the human channel.
 */
export function parseServeArgs(argv: string[]): { confirm?: 'dialog' | 'deny' } | { error: string } {
  const out: { confirm?: 'dialog' | 'deny' } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = a === '--confirm' ? argv[++i] : a.startsWith('--confirm=') ? a.slice('--confirm='.length) : undefined;
    if (a === '--confirm' || a.startsWith('--confirm=')) {
      if (v !== 'dialog' && v !== 'deny') return { error: '--confirm must be "dialog" or "deny"' };
      out.confirm = v;
    } else return { error: `Unknown option "${a}" for serve.` };
  }
  return out;
}
