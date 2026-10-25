/**
 * A resident whisper.cpp, instead of a new one per sentence.
 *
 * Dictation used to spawn `whisper-cli` for every take. Measured on this M1
 * against a five-second clip, that cost:
 *
 *   process start + Metal init   ~440 ms
 *   model load from disk          ~206 ms   (488 MB of ggml-small)
 *   encode                        ~337 ms
 *   sample + decode                ~33 ms
 *   ------------------------------------
 *   wall clock                   ~1300 ms
 *
 * So roughly HALF the wait was the same 488 MB being read off disk and the
 * same Metal context being built, again, for every sentence -- work whose
 * result is identical every time. `whisper-server` ships with the same
 * homebrew formula, holds the model in memory, and answers the identical
 * clip in ~605 ms warm. That is the whole difference between dictation that
 * feels like a text field and dictation that feels like a job you submitted.
 *
 * Three things make this safe to run as a background process:
 *
 *  - It is started lazily, so a user who never dictates never pays 488 MB
 *    of resident memory for it.
 *  - It binds to 127.0.0.1 on an ephemeral port chosen by the OS, so it
 *    cannot collide with the pairing listener (which is why the obvious
 *    8791 is not used here) and is not reachable from the tunnel.
 *  - Every failure falls back to the old `whisper-cli` path rather than
 *    failing the request. A dictation that is merely slow is a far better
 *    outcome than one that does not come back.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

export const DEFAULT_WHISPER_SERVER = '/opt/homebrew/bin/whisper-server';

/**
 * How long to wait for the model to load before giving up and using the CLI.
 *
 * Cold start is dominated by reading the model, which is ~4s here and could
 * be a good deal longer on a spinning disk or a larger model.
 */
const STARTUP_TIMEOUT_MS = 60_000;
/** Poll interval while waiting for the port to accept connections. */
const READY_POLL_MS = 150;

export interface WhisperServerOptions {
  modelPath: string;
  binPath?: string;
  threads?: number;
  language?: string;
}

export class WhisperServer {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<number | null> | null = null;
  private disposed = false;
  /** Set once a start has failed, so we stop paying for retries. */
  private unavailable = false;

  constructor(private readonly opts: WhisperServerOptions) {}

  /**
   * The port if the model is ALREADY loaded, otherwise null -- and never a
   * wait.
   *
   * Used on the request path. Blocking here would mean the first dictation
   * after a restart waits for the whole model load and then decodes, which
   * is strictly worse than just running the CLI once. So this starts the
   * load in the background and lets this one take the old path.
   */
  portIfReady(): number | null {
    if (this.disposed || this.unavailable) return null;
    if (this.child && !this.child.killed && this.port) return this.port;
    this.warm();
    return null;
  }

  /** The port to POST to, or null when the resident path is not usable. */
  async ready(): Promise<number | null> {
    if (this.disposed || this.unavailable) return null;
    if (this.child && !this.child.killed && this.port) return this.port;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Begin loading the model without waiting for it.
   *
   * Called the instant the user presses the mic button. The model then
   * loads WHILE they are speaking, so the first dictation after a restart
   * is as fast as every one after it instead of being the slow one.
   */
  warm(): void {
    void this.ready().catch(() => null);
  }

  private async start(): Promise<number | null> {
    const port = await freePort().catch(() => 0);
    if (!port) {
      this.unavailable = true;
      return null;
    }

    const args = [
      '-m', this.opts.modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-t', String(this.opts.threads ?? 4),
      // Greedy. On dictation-length clips the beam search bought nothing
      // measurable in accuracy here and cost time on every take.
      '-bs', '1',
      '-bo', '1',
      '--no-timestamps',
    ];
    if (this.opts.language && this.opts.language !== 'auto') {
      args.push('-l', this.opts.language);
    }

    let child: ChildProcess;
    try {
      child = spawn(this.opts.binPath || DEFAULT_WHISPER_SERVER, args, {
        stdio: 'ignore',
        // Not detached: it must die with this server, or a restart leaves a
        // half-gigabyte orphan holding a port.
        detached: false,
      });
    } catch {
      this.unavailable = true;
      return null;
    }

    child.once('error', () => {
      this.unavailable = true;
      this.child = null;
      this.port = 0;
    });
    child.once('exit', () => {
      // A crash is not permanent; the next `ready()` starts a fresh one.
      if (this.child === child) {
        this.child = null;
        this.port = 0;
      }
    });
    this.child = child;

    const up = await waitForPort(port, STARTUP_TIMEOUT_MS, () =>
      Boolean(child.killed || child.exitCode !== null),
    );
    if (!up || this.disposed) {
      child.kill('SIGKILL');
      this.child = null;
      this.unavailable = !this.disposed;
      return null;
    }
    this.port = port;
    return port;
  }

  dispose(): void {
    this.disposed = true;
    this.child?.kill('SIGKILL');
    this.child = null;
    this.port = 0;
  }
}

/** Ask the OS for a port nobody is using, then hand it to the child. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

/** Resolve once something accepts a TCP connection on `port`. */
async function waitForPort(
  port: number,
  timeoutMs: number,
  died: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (died()) return false;
    const open = await probe(port);
    if (open) return true;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return false;
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}
