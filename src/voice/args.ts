/** `stephen listen` options. */

export const LISTEN_USAGE = `stephen listen [options]   "Hey Stephen" voice listener (macOS; audio stays on this Mac)

  --once                 Handle one command, then exit
  --text "<command>"     Skip the microphone: send this command to Claude (and speak the reply)
  --dry-run              Print the claude command line instead of running Claude
  --device <index|name>  Microphone to use (see --list-devices; default: the system input)
  --list-devices         List microphones and exit
  --wav <file.wav>       Listen to a WAV file instead of the microphone
  --setup                Download the speech models and exit (same as \`stephen voice-setup\`)
  --no-speak             Print replies instead of speaking them
  --no-chimes            No Tink/Pop sounds
  --ptt-only             Push-to-talk only: no wake word (needs Stephen Helper; same as voice.wakeWord false)
  --no-helper            Don't use Stephen Helper (no push-to-talk; the wake-word cooldown applies)
  -h, --help             This help

Say "Hey Stephen, open YouTube", or hold Fn+Option while you speak (push-to-talk, with Stephen Helper:
\`stephen install-helper\`). Say "Stephen stop", press Esc (helper) or Ctrl-C to cancel.
Each command is a fresh conversation. With the helper, "Hey Stephen" is ignored only while the Mac plays
sound, and replies stay quiet while it does. Without it, the wake word rests for voice.cooldownSec (20 s)
after a command; press Enter to re-arm sooner.
Config: the "voice" section of config.json — see docs/VOICE.md.`;

export interface ListenArgs {
  once: boolean;
  text: string | null;
  dryRun: boolean;
  device: string | null;
  listDevices: boolean;
  wav: string | null;
  setup: boolean;
  speak: boolean | null;
  chimes: boolean | null;
  pttOnly: boolean;
  noHelper: boolean;
  help: boolean;
}

export function parseListenArgs(argv: readonly string[]): ListenArgs | { error: string } {
  const a: ListenArgs = { once: false, text: null, dryRun: false, device: null, listDevices: false, wav: null, setup: false, speak: null, chimes: null, pttOnly: false, noHelper: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string | { error: string } => {
      if (inline !== undefined) return inline;
      const v = argv[i + 1];
      if (v === undefined) return { error: `${name} needs a value` };
      i++;
      return v;
    };
    const flag = (): { error: string } | null => (inline !== undefined ? { error: `${name} takes no value` } : null);
    switch (name) {
      case '--once':
      case '--dry-run':
      case '--list-devices':
      case '--setup':
      case '--no-speak':
      case '--no-chimes':
      case '--ptt-only':
      case '--no-helper':
      case '--help':
      case '-h': {
        const bad = flag();
        if (bad) return bad;
        if (name === '--once') a.once = true;
        else if (name === '--dry-run') a.dryRun = true;
        else if (name === '--list-devices') a.listDevices = true;
        else if (name === '--setup') a.setup = true;
        else if (name === '--no-speak') a.speak = false;
        else if (name === '--no-chimes') a.chimes = false;
        else if (name === '--ptt-only') a.pttOnly = true;
        else if (name === '--no-helper') a.noHelper = true;
        else a.help = true;
        break;
      }
      case '--text':
      case '--device':
      case '--wav': {
        const v = value();
        if (typeof v !== 'string') return v;
        if (!v.trim()) return { error: `${name} needs a non-empty value` };
        if (name === '--text') a.text = v;
        else if (name === '--device') a.device = v;
        else a.wav = v;
        break;
      }
      default:
        return { error: `Unknown option "${arg}"` };
    }
  }
  if (a.text !== null && a.wav !== null) return { error: '--text and --wav cannot be combined' };
  if (a.pttOnly && a.noHelper) return { error: '--ptt-only needs Stephen Helper, so it cannot be combined with --no-helper' };
  if (a.pttOnly && a.wav !== null) return { error: '--ptt-only cannot be combined with --wav (push-to-talk needs the keyboard)' };
  return a;
}
