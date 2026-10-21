/**
 * ZeroRouter owner-credential CLI — the only provisioning surface.
 *
 * There is no /setup endpoint and no public registration: ownership of this
 * dashboard is established by shell access on the machine that hosts the data
 * directory. This tool creates, rotates or inspects the owner credential
 * (username + scrypt-hashed password), revokes every dashboard session on
 * rotation, and provides lockout recovery commands.
 *
 * Usage: npm -w packages/server run owner -- <command> [options]
 * Commands:
 *   set-owner         create the owner credential (or rotate with confirmation)
 *   rotate-password   rotate the credential (requires current password or --recovery)
 *   status            show the effective auth mode (never secrets)
 *   unlock            clear login throttles/recover from repeated failures
 *   revoke-sessions   invalidate every dashboard session (unauthenticated overhead)
 * Options:
 *   --data-dir <dir>              data directory (default ZEROROUTER_DATA_DIR or ./data)
 *   --username <name>             owner username (prompted otherwise; default: existing or "owner")
 *   --password-stdin              read the new password from stdin (automation)
 *   --current-password-stdin      read the current password from stdin (rotation)
 *   --recovery                    rotate without the current password (documented
 *                                 recovery: shell access equals owner authority)
 *   --allow-short-password        accept a password below the 10-character
 *                                 policy floor (explicit opt-in; warns loudly).
 *                                 Rotate upward as soon as convenient.
 *
 * Secrets are never printed. Passwords are stored only as scrypt hashes.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import path from 'node:path';

import { Db } from '../db/database.js';
import { OwnerCredentialRepo, SessionRepo, LoginThrottleRepo } from '../db/repos.js';
import { OwnerAuthService, USERNAME_RE, PASSWORD_MIN_LEN } from '../services/ownerAuth.js';

/* ─── tiny argv helpers ─── */

function flagValue(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  const next: string | undefined = argv[idx + 1];
  if (idx >= 0 && next && !next.startsWith('--')) return next;
  return null;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function chomp(s: string): string {
  return s.replace(/(?:\r?\n)+$/, '');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return chomp(Buffer.concat(chunks).toString('utf8'));
}

/** Prompt without echoing the answer (works on TTYs; falls back to plain). */
function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    return readStdin();
  }
  const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(question);
  return rl.question('').then((answer) => {
    rl.close();
    process.stdout.write('\n');
    return answer;
  });
}

/* ─── commands ─── */

const HELP = `
ZeroRouter owner credential CLI

  npm -w packages/server run owner -- <command> [options]

Commands:
  set-owner          create or replace the owner credential
  rotate-password    rotate with current-password confirmation (or --recovery)
  status             show effective auth mode (never secrets)
  unlock             clear login throttles (lockout recovery)
  revoke-sessions    invalidate every dashboard session

Options:
  --data-dir <dir>          default: ZEROROUTER_DATA_DIR or ./data
  --username <name>         otherwise prompted (default: existing or "owner")
  --password-stdin          read new password from stdin (automation)
  --current-password-stdin  read current password from stdin (rotation)
  --recovery                rotate without current password
  --help                    this help
`.trim();

async function cmdStatus(ownerAuth: OwnerAuthService): Promise<void> {
  console.log(`auth mode:            ${ownerAuth.mode}`);
  console.log(`owner username:       ${ownerAuth.username ?? '—'}`);
  console.log(
    `env fallback set:     ${ownerAuth.mode === 'environment' ? 'yes (ZEROROUTER_DASHBOARD_PASSWORD)' : 'no'}`,
  );
  console.log(
    ownerAuth.username
      ? 'credential stored:    scrypt hash in gateway.db (owner_credential)'
      : 'credential stored:    —',
  );
}

async function currentPasswordForRotation(ownerAuth: OwnerAuthService): Promise<string> {
  const current = hasFlag(process.argv, '--current-password-stdin')
    ? await readStdin()
    : await askHidden('Current password: ');
  const username = ownerAuth.username ?? '';
  const ok = await ownerAuth.verify(username, current);
  if (!ok) {
    throw new Error('Current password verification failed; not rotating. Use --recovery for documented recovery.');
  }
  return current;
}

async function newPassword(argv: string[]): Promise<string> {
  let password: string;
  if (hasFlag(argv, '--password-stdin')) {
    password = await readStdin();
  } else if (process.stdin.isTTY) {
    password = await askHidden('New password: ');
    const confirm = await askHidden('Confirm password: ');
    if (password !== confirm) throw new Error('Password confirmation does not match.');
  } else {
    throw new Error('stdin is not a TTY; pass the password via --password-stdin (e.g. `Get-Content pw.txt | ...`).');
  }
  if (password.length < PASSWORD_MIN_LEN && !hasFlag(argv, '--allow-short-password')) {
    throw new Error(
      `Password must be at least ${PASSWORD_MIN_LEN} characters. ` +
        'Login throttling only limits guessing — it does not compensate for short passwords. ' +
        'If a password below this length is genuinely required (an explicitly requested private deployment), pass --allow-short-password.',
    );
  }
  if (password.length < PASSWORD_MIN_LEN) {
    console.log(`warning: short password provisioned via --allow-short-password (below the ${PASSWORD_MIN_LEN}-character policy floor).`);
    console.log('   Rotate to 12+ characters or a stronger passphrase when convenient: owner rotate-password.');
  }
  if (password.length < 12) {
    console.log('note: acceptable but short — 12+ characters or a passphrase is recommended.');
  }
  if (password.length > 1024) throw new Error('Password too long (max 1024 chars).');
  return password;
}

async function cmdSetOwner(ownerAuth: OwnerAuthService, argv: string[], forceRecovery: boolean): Promise<void> {
  const existing = ownerAuth.username;
  if (existing && !forceRecovery) {
    await currentPasswordForRotation(ownerAuth);
  }
  let username: string | undefined = flagValue(argv, '--username') ?? undefined;
  if (!username && process.stdin.isTTY) {
    username = (await askHidden(`Owner username [${existing ?? 'owner'}]: `)) || undefined;
  }
  const finalUsername = (username ?? existing ?? 'owner').trim().toLowerCase();
  if (!USERNAME_RE.test(finalUsername)) {
    throw new Error('Username must be 3–32 chars of [a-z0-9._@-], starting with a letter or digit.');
  }
  const password = await newPassword(argv);
  const res = await ownerAuth.provision(finalUsername, password, {
    allowShortPassword: hasFlag(argv, '--allow-short-password'),
  });
  console.log(`owner credential ${res.created ? 'created' : 'updated'} (username: ${res.username}).`);
  console.log(`revoked sessions: ${res.revokedSessions}. Login throttles cleared.`);
  console.log('Keep passwords out of shell history; prefer --password-stdin over typed prompts in scripts.');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || argv.length === 0) {
    console.log(HELP);
    return 0;
  }
  const command = argv.find((a) => !a.startsWith('--')) ?? '';
  const dataDir = path.resolve(flagValue(argv, '--data-dir') ?? process.env['ZEROROUTER_DATA_DIR'] ?? './data');
  const forceRecovery = hasFlag(argv, '--recovery');

  const db = new Db(path.join(dataDir, 'gateway.db'));
  try {
    db.migrate();
    const ownerRepo = new OwnerCredentialRepo(db);
    const sessions = new SessionRepo(db);
    const throttleRepo = new LoginThrottleRepo(db);
    const ownerAuth = new OwnerAuthService({
      db,
      ownerRepo,
      sessions,
      loginThrottleRepo: throttleRepo,
      envPassword: process.env['ZEROROUTER_DASHBOARD_PASSWORD'] || null,
    });

    switch (command) {
      case 'status': {
        await cmdStatus(ownerAuth);
        return 0;
      }
      case 'set-owner': {
        await cmdSetOwner(ownerAuth, argv, forceRecovery);
        return 0;
      }
      case 'rotate-password': {
        await cmdSetOwner(ownerAuth, argv, forceRecovery);
        return 0;
      }
      case 'unlock': {
        throttleRepo.clearAll();
        console.log('login throttles cleared (lockout was temporary; cooldowns never lasted beyond 5 minutes).');
        return 0;
      }
      case 'revoke-sessions': {
        const removed = sessions.deleteAll();
        console.log(`revoked ${removed} dashboard session(s).`);
        return 0;
      }
      default:
        console.error(`unknown command: ${command}\n\n${HELP}`);
        return 2;
    }
  } finally {
    db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
