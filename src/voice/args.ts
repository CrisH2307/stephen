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
  -h, --help             This help

Say "Hey Stephen, open YouTube". Say "Stephen stop" (or press Ctrl-C) to cancel.
Each command is a fresh conversation. After a command the wake word rests for voice.cooldownSec (20 s);
press Enter to re-arm sooner.
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
  help: boolean;
}

export function parseListenArgs(argv: readonly string[]): ListenArgs | { error: string } {
  const a: ListenArgs = { once: false, text: null, dryRun: false, device: null, listDevices: false, wav: null, setup: false, speak: null, chimes: null, help: false };
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
  return a;
}
