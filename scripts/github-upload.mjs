#!/usr/bin/env node
/**
 * ZeroRouter → GitHub uploader (no local git required).
 *
 * Creates a repository on github.com via the REST API and uploads the project
 * as a single commit (blobs → tree → commit → ref). Sensitive state is
 * hard-skipped: the data directory (gateway.db, .master_key), .env files,
 * build output and node_modules never leave this machine.
 *
 * Usage:
 *   node scripts/github-upload.mjs                      # prompts for token
 *   GITHUB_TOKEN=... node scripts/github-upload.mjs     # non-interactive
 *   node scripts/github-upload.mjs --repo my-name --public --message "init"
 *
 * The token needs the "Contents: read/write" + "Administration: read/write"
 * permissions (a fine-grained token limited to repo creation is ideal).
 * Revoke it after uploading if it was typed into a shared terminal.
 */
import { createInterface } from 'node:readline/promises';
import { readdir, readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const API = 'https://api.github.com';
const ROOT = path.resolve(import.meta.dirname, '..');
const REPO_NAME_DEFAULT = 'zerorouter';

/* ─── ignore rules: these NEVER get uploaded ─── */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'data', '.git', '.github', '.vercel', '.idea', '.vscode',
  '.turbo', 'coverage', 'tmp', 'temp', '.cache',
]);
const SKIP_FILE_BASENAMES = new Set(['.env', '.env.local', '.master_key', '.DS_Store', 'Thumbs.db']);
const SKIP_SUFFIXES = ['.db', '.db-shm', '.db-wal', '.sqlite', '.log', '.tmp'];

function isSkipped(relPath, name, isDir) {
  if (isDir) {
    if (SKIP_DIRS.has(name)) return true;
    return false;
  }
  if (SKIP_FILE_BASENAMES.has(name)) return true;
  if (SKIP_SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (relPath.split('/').some((seg) => SKIP_DIRS.has(seg))) return true;
  return false;
}

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (isSkipped(rel, entry.name, entry.isDirectory())) continue;
    if (entry.isDirectory()) out.push(...(await walk(abs, rel)));
    else if (entry.isFile()) out.push({ abs, rel: rel.replaceAll('\\', '/') });
  }
  return out;
}

/* Only execute when invoked directly — importing is for tests/dry-runs. */
const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

/* ─── tiny GitHub REST client ─── */
function client(token) {
  return async function gh(method, url, body) {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'zerorouter-uploader',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  };
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function askToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.output.mute?.();
  const token = (await rl.question('GitHub token (input hidden not supported here — paste and press Enter): ')).trim();
  rl.close();
  return token;
}

async function main() {
  const token = await askToken();
  if (!token) throw new Error('No token provided.');
  const gh = client(token);

  const me = await gh('GET', '/user');
  const login = me.login;
  const repoName = opt('--repo') ?? REPO_NAME_DEFAULT;
  const isPublic = flag('--public');
  const message = opt('--message') ?? `ZeroRouter — initial upload (${new Date().toISOString().slice(0, 10)})`;
  console.log(`\nUploading as @${login} → ${isPublic ? 'PUBLIC' : 'private'} repo "${login}/${repoName}"`);

  /* collect files */
  const files = await walk(ROOT);
  const totalBytes = (await Promise.all(files.map((f) => stat(f.abs)))).reduce((a, s) => a + s.size, 0);
  console.log(`Collected ${files.length} files (${(totalBytes / 1024 / 1024).toFixed(2)} MB), secrets/build output skipped.\n`);
  const dataDirLeak = files.find((f) => /(^|\/)(data|\.master_key)($|\/)/.test(f.rel) || f.rel.endsWith('.db'));
  if (dataDirLeak) throw new Error(`Safety stop: sensitive path matched the skip filter: ${dataDirLeak.rel}`);

  /* create repo (or reuse) */
  let repo;
  try {
    repo = await gh('POST', '/user/repos', { name: repoName, private: !isPublic, description: 'Private, self-hosted AI gateway — one OpenAI-compatible API in front of every provider. ZeroRouter.' });
    console.log(`Created repository: ${repo.html_url}`);
  } catch (err) {
    if (!String(err).includes('422')) throw err;
    repo = await gh('GET', `/repos/${login}/${repoName}`);
    console.log(`Repository already exists, updating: ${repo.html_url}`);
  }
  const full = repo.full_name;
  const branch = repo.default_branch || 'main';

  /* base commit (or fresh branch) */
  let baseCommit = null;
  let baseTree = null;
  try {
    const ref = await gh('GET', `/repos/${full}/git/ref/heads/${branch}`);
    baseCommit = ref.object.sha;
    baseTree = (await gh('GET', `/repos/${full}/git/commits/${baseCommit}`)).tree.sha;
    console.log(`Existing branch ${branch} @ ${baseCommit.slice(0, 8)} — committing on top.`);
  } catch {
    console.log(`Empty repository — creating first commit on ${branch}.`);
    // The git data API 409s on a truly empty repository: seed it through the
    // Contents API (one placeholder file), then continue with the real tree.
    try {
      await gh('PUT', `/repos/${full}/contents/README.md`, {
        message: 'initialize repository',
        content: Buffer.from('# ZeroRouter\n\nPrivate, self-hosted AI gateway — one OpenAI-compatible API in front of every provider.\n').toString('base64'),
      });
    } catch (initErr) {
      if (!String(initErr).includes('422')) throw initErr; // 422 = someone already pushed something
    }
    const seeded = await gh('GET', `/repos/${full}/git/ref/heads/${branch}`);
    baseCommit = seeded.object.sha;
    baseTree = (await gh('GET', `/repos/${full}/git/commits/${baseCommit}`)).tree.sha;
  }

  /* upload blobs (skip files whose blob already exists upstream) */
  const existing = new Map();
  if (baseTree) {
    const tree = await gh('GET', `/repos/${full}/git/trees/${baseTree}?recursive=1`);
    for (const e of tree.tree ?? []) if (e.type === 'blob') existing.set(e.path, e.sha);
  }
  const entries = [];
  const shaToPath = new Map();
  let uploaded = 0; let reused = 0;
  for (const f of files) {
    const content = await readFile(f.abs);
    // Git blob sha = sha1 over header + full content bytes.
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    if (existing.get(f.rel) === sha) {
      reused += 1;
    } else {
      const blob = await gh('POST', `/repos/${full}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' });
      uploaded += 1;
      shaToPath.set(blob.sha, f.rel);
      process.stdout.write(`\ruploading… ${uploaded + reused}/${files.length}`);
    }
    entries.push({ path: f.rel, mode: '100644', type: 'blob', sha });
  }
  console.log(`\nblobs uploaded: ${uploaded}, unchanged (reused): ${reused}`);

  /* tree → commit → ref — full standalone tree (entries cover every file);
   * no base_tree: merging against the seeded placeholder tree makes GitHub's
   * validator trip over the placeholder blob ("not a valid blob" 422). */
  let tree;
  try {
    tree = await gh('POST', `/repos/${full}/git/trees`, { tree: entries });
  } catch (err) {
    const bad = String(err).match(/tree\.sha (\S+) is not a valid/);
    if (bad) {
      console.error(`\nOffending blob sha ${bad[1]} belongs to: ${shaToPath.get(bad[1]) ?? 'UNKNOWN (not from this run — stale upstream reference?)'}`);
    }
    throw err;
  }
  const commit = await gh('POST', `/repos/${full}/git/commits`, {
    message,
    tree: tree.sha,
    parents: baseCommit ? [baseCommit] : [],
    author: { name: login, email: `${login}@users.noreply.github.com` },
  });
  if (baseCommit) {
    await gh('PATCH', `/repos/${full}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
  } else {
    await gh('POST', `/repos/${full}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }

  console.log(`\n✔ Done: ${files.length} files committed to ${repo.html_url} (${branch} @ ${commit.sha.slice(0, 8)})`);
  console.log('\nDeploy note: connect this repo at a host that supports persistent disks + long-running');
  console.log('Node (Railway / Fly.io / your own VPS). Do NOT use serverless hosts (Vercel/Netlify) for');
  console.log('the backend — their ephemeral filesystem would wipe gateway.db + .master_key on every deploy.');
}

export { walk, isSkipped };

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\n✖ ${err.message ?? err}`);
    process.exit(1);
  });
}
