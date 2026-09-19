#!/usr/bin/env node
/**
 * dkg-remote-cli.mjs — run the DKG v10 CLI on a remote node over SSH.
 *
 * Drop-in replacement for a local `dkg` binary: forwards argv to
 * DKG_REMOTE_DKG_BIN on DKG_SSH_USER@DKG_SSH_HOST and mirrors stdout/stderr
 * plus the exit code, so callers (e.g. EdgeNodeAdapter via DKG_CLI_BIN)
 * work unchanged against a remote daemon.
 *
 * File arguments (--input-file, --file) are uploaded to /tmp on the server
 * first, since the remote CLI cannot see local temp files. Uploaded files
 * are removed afterwards (best effort).
 *
 * Config (env only, never commit secrets):
 *   DKG_SSH_HOST        default "52.58.167.195"
 *   DKG_SSH_USER        default "harsh"
 *   DKG_SSH_KEY         local path to the SSH private key
 *                       default "~/.ssh/id_ed25519_dkg_ec2"
 *   DKG_SSH_KEY_INLINE  alternative: raw PEM content (for hosted envs like
 *                       Render where the key arrives as a secret env var)
 *   DKG_REMOTE_DKG_BIN  default "/home/harsh/.local/bin/dkg"
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST = process.env.DKG_SSH_HOST ?? "52.58.167.195";
const USER = process.env.DKG_SSH_USER ?? "harsh";
const REMOTE_BIN = process.env.DKG_REMOTE_DKG_BIN ?? "/home/harsh/.local/bin/dkg";
// CLI flags whose *next* argv entry is a local file that must be shipped over.
const FILE_FLAGS = new Set(["--input-file", "--file"]);

function resolveKey() {
  const inline = process.env.DKG_SSH_KEY_INLINE;
  if (inline && inline.includes("PRIVATE KEY")) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pf-ssh-"));
    const file = path.join(dir, "key");
    writeFileSync(file, inline.replace(/\\n/g, "\n").trimEnd() + "\n", { mode: 0o600 });
    try {
      // chmod is a no-op on Windows; local dev should use DKG_SSH_KEY (file path).
      // Hosted Linux (Render) enforces 0600 correctly.
      chmodSync(file, 0o600);
    } catch { /* ignore */ }
    return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const file =
    process.env.DKG_SSH_KEY ?? path.join(os.homedir(), ".ssh", "id_ed25519_dkg_ec2");
  return { file, cleanup: () => {} };
}

function shellEscape(arg) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
}

const { file: keyFile, cleanup: cleanupKey } = resolveKey();
if (!existsSync(keyFile)) {
  console.error(
    `[dkg-remote] SSH key not found: ${keyFile}. Set DKG_SSH_KEY or DKG_SSH_KEY_INLINE.`
  );
  process.exit(2);
}

const sshBase = [
  "-i", keyFile,
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "StrictHostKeyChecking=accept-new",
  `${USER}@${HOST}`
];

const uploaded = [];
const remoteArgs = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (FILE_FLAGS.has(arg) && i + 1 < argv.length && existsSync(argv[i + 1])) {
    const local = argv[i + 1];
    const base = path.basename(local).replace(/[^A-Za-z0-9._-]/g, "-");
    const remote = `/tmp/pf-r-${process.pid}-${uploaded.length}-${base}`;
    const put = run("scp", [...sshBase.slice(0, -1), local, `${USER}@${HOST}:${remote}`]);
    if (put.status !== 0) {
      process.stderr.write(put.stderr ?? Buffer.alloc(0));
      console.error(`[dkg-remote] scp upload failed for ${local}`);
      cleanupKey();
      process.exit(put.status ?? 1);
    }
    uploaded.push(remote);
    remoteArgs.push(arg, remote);
    i++;
  } else {
    remoteArgs.push(arg);
  }
}

const remoteCmd = [REMOTE_BIN, ...remoteArgs].map(shellEscape).join(" ");
const res = run("ssh", [...sshBase, remoteCmd]);
if (res.stdout?.length) process.stdout.write(res.stdout);
if (res.stderr?.length) process.stderr.write(res.stderr);

if (uploaded.length > 0) {
  run("ssh", [...sshBase, `rm -f ${uploaded.map(shellEscape).join(" ")}`]);
}
cleanupKey();
process.exit(res.status ?? 1);
