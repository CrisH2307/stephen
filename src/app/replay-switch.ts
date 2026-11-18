/**
 * The replay recorder switch (issue #48 PR 2): writes `voice.replay.enabled` to config.json. Called only for app.sock
 * `replay.set`, which only the Settings switch sends (src/app/protocol.ts). Nothing Claude can reach imports src/app.
 */
import { updateConfigSection } from '../config-write.js';

export function writeReplaySwitch(file: string, enabled: boolean): void {
  updateConfigSection(file, 'voice', (old) => {
    const r = old.replay;
    return { ...old, replay: { ...(r && typeof r === 'object' && !Array.isArray(r) ? r : {}), enabled } };
  });
}
