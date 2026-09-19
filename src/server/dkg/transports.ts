import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * How the app reaches a DKG v10 edge node CLI.
 *
 * Two implementations share this contract so the rest of the app never
 * cares where the daemon lives:
 *  - LocalCliTransport: a daemon on the same machine (`dkg` on PATH).
 *  - SshCliTransport:   a daemon on a remote host (EC2), reached by
 *    running its CLI over SSH. File arguments are uploaded first because
 *    the remote CLI cannot see local temp files.
 *
 * Selection is env-driven (see createTransportFromEnv): setting
 * DKG_SSH_HOST switches the app to the remote node. No code changes,
 * no secrets in the repo — hosts, users and key *paths* live in env,
 * key *content* arrives via DKG_SSH_KEY_INLINE on hosted platforms.
 */
export interface CliTransport {
  /** Run the CLI; resolves stdout, rejects on non-zero exit / timeout. */
  run(args: string[], timeoutMs?: number): Promise<string>;
}

/** Local daemon transport — the historical default. */
export class LocalCliTransport implements CliTransport {
  constructor(private readonly bin: string = process.env.DKG_CLI_BIN ?? "dkg") {}

  async run(args: string[], timeoutMs = 120_000): Promise<string> {
    const { stdout } = await execFileAsync(this.bin, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === "win32" // dkg is a .cmd shim on Windows
    });
    return stdout;
  }
}

export interface SshTransportConfig {
  host: string;
  user: string;
  /** Local path to the SSH private key (dev machines). */
  keyFile: string;
  /** Raw PEM content (hosted platforms where the key arrives as env). */
  keyInline?: string;
  remoteBin: string;
  connectTimeoutSecs: number;
}

/** Null when DKG_SSH_HOST is unset — the caller then uses LocalCliTransport. */
export function loadSshConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): SshTransportConfig | null {
  const host = env.DKG_SSH_HOST?.trim();
  if (!host) return null;
  return {
    host,
    user: env.DKG_SSH_USER?.trim() || "harsh",
    keyFile:
      env.DKG_SSH_KEY?.trim() || path.join(os.homedir(), ".ssh", "id_ed25519_dkg_ec2"),
    keyInline: env.DKG_SSH_KEY_INLINE?.trim() || undefined,
    remoteBin: env.DKG_REMOTE_DKG_BIN?.trim() || "/home/harsh/.local/bin/dkg",
    connectTimeoutSecs: Number(env.DKG_SSH_CONNECT_TIMEOUT_SECS ?? 15) || 15
  };
}

/** Quote one argv entry for `sh -c` on the remote side. */
export function shellEscape(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

const FILE_FLAGS = new Set(["--input-file", "--file"]);

export interface FileUpload {
  local: string;
  remote: string;
}

/**
 * Rewrite argv so file arguments point at server-side temp paths.
 * Pure (no I/O besides an existence check) so it stays unit-testable;
 * the transport performs the actual upload for each entry.
 */
export function extractFileUploads(
  args: readonly string[],
  remoteName: (localBase: string, index: number) => string = (base, i) =>
    `/tmp/pf-r-${process.pid}-${i}-${base}`
): { remoteArgs: string[]; uploads: FileUpload[] } {
  const remoteArgs: string[] = [];
  const uploads: FileUpload[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (FILE_FLAGS.has(arg) && next !== undefined && existsSync(next)) {
      const base = path.basename(next).replace(/[^A-Za-z0-9._-]/g, "-");
      const remote = remoteName(base, uploads.length);
      uploads.push({ local: next, remote });
      remoteArgs.push(arg, remote);
      i++;
    } else {
      remoteArgs.push(arg);
    }
  }
  return { remoteArgs, uploads };
}

/** Remote daemon transport over SSH. */
export class SshCliTransport implements CliTransport {
  private readonly keyFile: string;
  private readonly keyCleanup: () => void;

  constructor(private readonly config: SshTransportConfig) {
    if (config.keyInline?.includes("PRIVATE KEY")) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "pf-ssh-"));
      this.keyFile = path.join(dir, "key");
      writeFileSync(this.keyFile, `${config.keyInline.trim()}\n`, { mode: 0o600 });
      try {
        chmodSync(this.keyFile, 0o600); // no-op on Windows; enforced on Linux
      } catch {
        /* ignore */
      }
      this.keyCleanup = () => rmSync(dir, { recursive: true, force: true });
    } else {
      this.keyFile = config.keyFile;
      this.keyCleanup = () => {};
    }
    if (!existsSync(this.keyFile)) {
      throw new Error(
        `[dkg-ssh] key not found: ${this.keyFile}. Set DKG_SSH_KEY or DKG_SSH_KEY_INLINE.`
      );
    }
  }

  /** Release the temp key dir when the key came from inline content. */
  dispose(): void {
    this.keyCleanup();
  }

  private sshBaseArgs(): string[] {
    const { host, user, connectTimeoutSecs } = this.config;
    return [
      "-i",
      this.keyFile,
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${connectTimeoutSecs}`,
      "-o",
      "StrictHostKeyChecking=accept-new",
      `${user}@${host}`
    ];
  }

  async run(args: string[], timeoutMs = 120_000): Promise<string> {
    const { host, user, remoteBin } = this.config;
    const { remoteArgs, uploads } = extractFileUploads(args);
    try {
      for (const { local, remote } of uploads) {
        await execFileAsync("scp", [...this.sshBaseArgs().slice(0, -1), local, `${user}@${host}:${remote}`], {
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024
        });
      }
      const remoteCmd = [remoteBin, ...remoteArgs].map(shellEscape).join(" ");
      const { stdout } = await execFileAsync("ssh", [...this.sshBaseArgs(), remoteCmd], {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024
      });
      return stdout;
    } finally {
      if (uploads.length > 0) {
        await execFileAsync(
          "ssh",
          [...this.sshBaseArgs(), `rm -f ${uploads.map((u) => shellEscape(u.remote)).join(" ")}`],
          { timeout: 30_000 }
        ).catch(() => undefined);
      }
    }
  }
}

/** Factory used by the adapter: SSH when a host is configured, local otherwise. */
export function createTransportFromEnv(env: Record<string, string | undefined> = process.env): CliTransport {
  const ssh = loadSshConfigFromEnv(env);
  return ssh ? new SshCliTransport(ssh) : new LocalCliTransport(env.DKG_CLI_BIN ?? "dkg");
}
