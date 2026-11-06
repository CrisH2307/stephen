/**
 * A same-user-only Unix socket (app.sock, phone.sock): the folder is a real 0700 folder owned by this user, the
 * socket is 0600. A stale socket file (a crashed listener) is replaced only when connecting to it fails; a live one
 * means another `stephen listen` serves it and listen refuses. On close the file is removed only if it is still ours
 * (same inode), so a newer listener's socket is never deleted.
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { type Server, type Socket, createConnection, createServer } from 'node:net';
import { dirname } from 'node:path';

/** Unix socket paths are limited to 104 bytes on macOS (including the NUL). */
export const MAX_SOCKET_PATH_BYTES = 103;

/** How long listenPrivateSocket waits for an existing socket to answer before calling it stale. */
const PROBE_TIMEOUT_MS = 500;

export class PrivateSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateSocketError';
  }
}

/** True when something accepts connections on `path`. */
export function socketAnswers(path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    const done = (v: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function prepareDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new PrivateSocketError(`cannot create ${dir}: ${(e as Error).message}`);
  }
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new PrivateSocketError(`${dir} must be a real folder (not a symlink)`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new PrivateSocketError(`${dir} belongs to another user`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

export interface PrivateSocket {
  /** Stop listening (open connections are the caller's) and remove the socket if it is still ours. */
  close(): Promise<void>;
  /** For a process 'exit' hook: the same, synchronously. */
  closeSync(): void;
}

/** Listen on `path` (see the file comment). `name` labels log lines. Throws PrivateSocketError when it can't. */
export async function listenPrivateSocket(path: string, onConnection: (sock: Socket) => void, log: (line: string) => void, name: string): Promise<PrivateSocket> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) throw new PrivateSocketError(`socket path too long (${Buffer.byteLength(path)} bytes): ${path}`);
  prepareDir(dirname(path));
  let st;
  try {
    st = lstatSync(path);
  } catch {
    st = null;
  }
  if (st) {
    if (!st.isSocket()) throw new PrivateSocketError(`${path} exists and is not a socket; remove it`);
    if (await socketAnswers(path)) throw new PrivateSocketError(`another \`stephen listen\` is already serving ${path}`);
    try {
      unlinkSync(path); // stale: nobody answers
    } catch (e) {
      throw new PrivateSocketError(`cannot remove the stale ${path}: ${(e as Error).message}`);
    }
  }
  const server: Server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e) => reject(new PrivateSocketError(`cannot listen on ${path}: ${e.message}`)));
    server.listen(path, () => resolve());
  });
  server.on('error', (e) => log(`${name}: ${e.message}`));
  let ino: number | null;
  try {
    chmodSync(path, 0o600);
    ino = lstatSync(path).ino;
  } catch (e) {
    server.close();
    throw new PrivateSocketError(`cannot secure ${path}: ${(e as Error).message}`);
  }
  const removeSocket = () => {
    if (ino === null) return;
    try {
      if (lstatSync(path).ino === ino) unlinkSync(path);
    } catch {
      // already gone
    }
    ino = null;
  };
  return {
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      removeSocket();
    },
    closeSync: () => {
      server.close();
      removeSocket();
    },
  };
}
