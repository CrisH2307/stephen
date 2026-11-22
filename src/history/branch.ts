/**
 * Edit and resend (ADR-010), the store side: branches and versions read from history lines. Owner-only like the rest
 * of src/history: nothing Claude can reach may import it (test/memory/boundary.test.ts).
 *
 *  - An edit is a NEW conversation C2 whose first line carries `editOf: { conv: C, id: Tk, ts: Tk's time }`. C2 does
 *    not copy T1 ... Tk-1: its branch view is the view of C before Tk's time, then C2's own lines.
 *  - Versions of a message: the message itself (version 1), then every branch first line that is an edit of it, or
 *    an edit of such an edit, oldest first. At most MAX_VERSIONS.
 *  - The context of a resend is built here FROM THE STORE: the app sends only the old command id, the old text's hash
 *    and the new text. A wrong hash refuses.
 *  - Stored text is data: nothing here reads it to decide anything except the hash check on `said`.
 */
import { createHash } from 'node:crypto';
import type { EditOf, HistoryEntry, HistorySource } from './store.js';

/** At most this many versions of one message (ADR-010, "Data model for versions"). */
export const MAX_VERSIONS = 10;
export const TOO_MANY_VERSIONS_MESSAGE = 'Too many versions of this message. Start a new conversation instead.';
export const EARLIER_EXPIRED_MESSAGE = 'The earlier part of this conversation has expired.';
export const CONVERSATION_CHANGED_MESSAGE = 'This conversation changed. Open it again.';
/** Chains longer than this are cut (a guard against a loop of hand-edited lines; MAX_VERSIONS keeps real ones short). */
const MAX_DEPTH = 64;

/** The hash the app sends of the old text: SHA-256 of the stored `said`, lowercase hex. */
export function textHash(said: string): string {
  return createHash('sha256').update(said, 'utf8').digest('hex');
}

const byTs = (a: HistoryEntry, b: HistoryEntry) => Date.parse(a.ts) - Date.parse(b.ts);

/** The lines of one conversation, oldest first. */
function own(entries: readonly HistoryEntry[], conv: string): HistoryEntry[] {
  return entries.filter((e) => e.conv === conv).sort(byTs);
}

export interface BranchView {
  /** What the branch shows and sends: the earlier turns it points to, then its own lines, oldest first. */
  lines: HistoryEntry[];
  /** Some earlier turn of the branch is gone (EARLIER_EXPIRED_MESSAGE). */
  expired: boolean;
}

/**
 * The branch view of `conv`: for an edited branch, the view of the conversation it was edited from, up to the edited
 * message's time (editOf.ts, not included), then its own lines. The cut holds after the edited message itself was
 * deleted ("Delete this version" on version 1). An expired or deleted earlier line is never shown; `expired` says
 * when the start of the record is gone.
 * ponytail: a partly expired start is seen only when the first line left is a follow-up (a conversation starts with a
 * fresh run); a local command left first after the cut hides it.
 */
export function branchView(entries: readonly HistoryEntry[], conv: string, depth = 0): BranchView {
  const mine = own(entries, conv);
  const first = mine[0];
  if (!first) return { lines: [], expired: false };
  if (!first.editOf || depth >= MAX_DEPTH) return { lines: mine, expired: first.followUp };
  const parent = branchView(entries, first.editOf.conv, depth + 1);
  // At the edited message while it is stored (exact, also for lines of the same millisecond); by its time once deleted.
  const at = parent.lines.findIndex((e) => e.id === first.editOf!.id);
  const cut = first.editOf.ts;
  const earlier = at >= 0 ? parent.lines.slice(0, at) : parent.lines.filter((e) => Date.parse(e.ts) < cut);
  return { lines: [...earlier, ...mine], expired: parent.expired };
}

/** An edited branch's first line: it carries editOf and starts its conversation. */
function firstOfBranch(entries: readonly HistoryEntry[], e: HistoryEntry): boolean {
  return !!e.editOf && !!e.conv && own(entries, e.conv)[0]?.id === e.id;
}

const key = (e: Pick<EditOf, 'conv' | 'id'>) => `${e.conv}/${e.id}`;

/** The message a line is a version of: up through edited first lines to the original (`conv/id`). */
function slotOf(entries: readonly HistoryEntry[], line: HistoryEntry): string {
  let cur = line;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (!cur.editOf || !firstOfBranch(entries, cur)) break;
    const target = cur.editOf;
    const parent = entries.find((e) => e.id === target.id && e.conv === target.conv);
    if (!parent) return key(target);
    cur = parent;
  }
  return cur.conv ? key({ conv: cur.conv, id: cur.id }) : cur.id;
}

/**
 * The versions of the message with command id `id`, oldest first: the original (when still stored) and every edit of
 * it or of one of its edits. A line nobody edited is its only version. [] when `id` is not stored.
 */
export function versionsOf(entries: readonly HistoryEntry[], id: string): HistoryEntry[] {
  const line = entries.find((e) => e.id === id);
  if (!line) return [];
  const slot = slotOf(entries, line);
  return entries
    .filter((e) => (e.conv && key({ conv: e.conv, id: e.id }) === slot) || (firstOfBranch(entries, e) && slotOf(entries, e) === slot))
    .sort(byTs);
}

/** What a resend needs, built from the store (never from the app's request). */
export interface EditContext {
  /** The new branch's editOf: the edited message. */
  editOf: EditOf;
  /** The edited message's source (the audit line names it). */
  source: HistorySource;
  /** T1 ... Tk-1 of the branch the owner is looking at, oldest first. */
  earlier: HistoryEntry[];
  /** Tk ... Tn: the edited message and what followed it in that branch. Only their step lines may be sent. */
  replaced: HistoryEntry[];
}

/**
 * The context of an edit of message `oldId` seen in branch `viewConv` (the version on the owner's screen), or why it
 * is refused (CONVERSATION_CHANGED_MESSAGE): the message is gone, it has no conversation id, the old text's hash does
 * not match (a stale page, or a forged request), or the message is not in that branch's view (its own lines or the
 * T1 ... Tk-1 it points to). The MAX_VERSIONS-th version already exists: TOO_MANY_VERSIONS_MESSAGE. The earlier turns
 * and the replaced step lines follow `viewConv`'s branch.
 */
export function editContext(entries: readonly HistoryEntry[], oldId: string, oldHash: string, viewConv: string): EditContext | { refused: string } {
  const old = entries.find((e) => e.id === oldId);
  if (!old || !old.conv || textHash(old.said) !== oldHash) return { refused: CONVERSATION_CHANGED_MESSAGE };
  const view = branchView(entries, viewConv).lines;
  const at = view.findIndex((e) => e.id === oldId);
  if (at < 0) return { refused: CONVERSATION_CHANGED_MESSAGE };
  if (versionsOf(entries, oldId).length >= MAX_VERSIONS) return { refused: TOO_MANY_VERSIONS_MESSAGE };
  return { editOf: { conv: old.conv, id: old.id, ts: Date.parse(old.ts) }, source: old.source, earlier: view.slice(0, at), replaced: view.slice(at) };
}

export const VERSION_GONE_MESSAGE = 'That message is no longer saved.';
export const NOT_A_VERSION_MESSAGE = 'Only a message with more than one version can be deleted here.';
export const VERSION_IN_USE_MESSAGE = 'Another version still uses these messages.';

/**
 * Why "Delete this version" of message `entryId` is refused, or null when it may go (ADR-010 Decision 4: nothing is
 * deleted silently). Refused when the message is gone, has fewer than two versions, is not a version's own line (the
 * original or a branch's first line), or when another branch still shows one of the lines it would delete (that
 * message and the later lines of its conversation) as its earlier part. Refusing loses nothing; the owner can
 * delete the branch that uses them first.
 */
export function deleteVersionRefusal(entries: readonly HistoryEntry[], entryId: string): string | null {
  const line = entries.find((e) => e.id === entryId);
  if (!line?.conv) return VERSION_GONE_MESSAGE;
  const versions = versionsOf(entries, entryId);
  if (versions.length < 2 || !versions.some((v) => v.id === entryId)) return NOT_A_VERSION_MESSAGE;
  const fromMs = Date.parse(line.ts);
  const gone = new Set(entries.filter((e) => e.conv === line.conv && (e.id === entryId || Date.parse(e.ts) > fromMs)).map((e) => e.id));
  const others = new Set(entries.filter((e) => e.conv && e.conv !== line.conv && firstOfBranch(entries, e)).map((e) => e.conv!));
  for (const conv of others) {
    if (branchView(entries, conv).lines.some((e) => e.conv !== conv && gone.has(e.id))) return VERSION_IN_USE_MESSAGE;
  }
  return null;
}
