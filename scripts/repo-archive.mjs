#!/usr/bin/env node
/**
 * repo-archive.mjs — the scratchpad archive's rules, applied to every git repository on this machine.
 *
 * Owner instruction 2026-09-14, after the scratchpad archive: "do the same in all repos on my device" —
 * copy every HTML, PDF, spreadsheet, Word file, SVG and screenshot into per-extension folders, never
 * delete them, recover the ones already deleted, and keep them safe in future.
 *
 *   node repo-archive.mjs             # find the repos, copy protected files out of every working tree
 *   node repo-archive.mjs --history   # also recover protected files that git history shows were deleted
 *   node repo-archive.mjs --status    # list the repos found and how many files each has archived
 *   --quiet                           # for hooks and the scheduled task
 *
 * Layout:  <ARCHIVE>/_by-source/<ext>/_repos/<repo>/<path inside the working tree>
 *          <ARCHIVE>/_by-source/<ext>/_repos-deleted-in-git/<repo>/<path>   (content just before the deleting commit)
 *
 * 🔴 UNDER _by-source, NOT under <ARCHIVE>/<ext>/. The day folders <ARCHIVE>/<ext>/<YYYY-MM-DD>/ are the
 * scratchpad sweep's; nothing here writes them. This header said <ARCHIVE>/<ext>/_repos until 2026-10-09,
 * and so did the standing rule, so a session checking "is this document archived before I delete the
 * worktree?" listed a path that has never existed, read back nothing, and reported the sweep had archived
 * nothing in its life. `--status` now prints these roots and counts what is on disk under them, so the
 * question is answered by the script rather than by guessing at a path.
 * A worktree files under its MAIN repository's name, and identical bytes are archived once per repository,
 * so a dozen worktrees of one repo do not make a dozen copies.
 *
 * Never deletes or overwrites anything; changed content becomes a new .v<stamp> version. Git is only
 * read (log, cat-file), with optional locks off, so a session working in the repo is not disturbed.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { ARCHIVE, EXTENSIONS, copyNoClobber } from './scratchpad-archive.mjs';

const DRIVES = ['C:/', 'D:/', 'E:/', 'F:/'];
const REPOS_FILE = `${ARCHIVE}/_repos.json`;
const INDEX = `${ARCHIVE}/_repo-index.json`;
const LOG = `${ARCHIVE}/_archive.log`;
const LOCK = `${ARCHIVE}/_repo-sweep.lock`;
const LOCK_STALE_MS = 15 * 60 * 1000;

// Never searched for repositories.
const FIND_SKIP = new Set(['node_modules', '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'programdata', 'appdata', '.pnpm-store', '.next', '.cache', 'claude scratchpad archive', 'recovery', 'msocache']);
// Never walked inside a repository: installed packages, build caches, git's own store.
const WALK_SKIP = new Set(['node_modules', '.git', '.next', '.turbo', '.vercel', '.venv', 'venv', '__pycache__', '.pnpm-store']);
// Other people's code that happens to be a git checkout: the package manager and plugin marketplaces.
const NOT_OWNER = /[\\/](scoop|plugins[\\/]marketplaces|vendor_imports|\.codex[\\/]\.tmp)([\\/]|$)/i;

const QUIET = process.argv.includes('--quiet');
const say = (s) => { if (!QUIET) console.log(s); };
const logLine = (s) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()}  repos: ${s}\n`); } catch {} };
const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const extOf = (f) => path.extname(f).slice(1).toLowerCase();

function versioned(dest, mtimeMs) {
  const d = new Date(mtimeMs);
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = path.extname(dest);
  let candidate = `${dest.slice(0, -ext.length)}.v${stamp}${ext}`;
  for (let i = 2; fs.existsSync(candidate); i++) candidate = `${dest.slice(0, -ext.length)}.v${stamp}-${i}${ext}`;
  return candidate;
}

/** "F - Phoenix Workforce - phoenix-workforce": the main repository's path, readable as one folder name. */
const labelFor = (main) => main.replace(/^([A-Za-z]):[\\/]*/, (_, d) => `${d.toUpperCase()} - `)
  .split(/[\\/]+/).filter(Boolean).join(' - ').replace(/^C - Users - [^-]+ - /, 'C - home - ');

function describe(dir) {
  let main = dir, worktree = false;
  try {
    const git = path.join(dir, '.git');
    if (fs.statSync(git).isFile()) {
      worktree = true;
      const m = fs.readFileSync(git, 'utf8').match(/gitdir:\s*(.+)/);
      if (m) {
        const gd = path.resolve(dir, m[1].trim());
        const i = gd.toLowerCase().lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
        if (i >= 0) main = gd.slice(0, i);
      }
    }
  } catch {}
  return { dir, main, worktree, label: labelFor(main) };
}

/**
 * How many directories the last scan could not read. readdirSync throws EPERM or EBUSY on a tree
 * another process is holding — a build, an indexer, a session mid-checkout — and the walk below
 * swallows it, so a scan that trips comes back SHORTER than the truth. That matters because
 * loadRepos used to write the short list straight over the cache that every later sweep reads.
 */
let scanUnreadable = 0;

export function findRepos() {
  const found = [];
  scanUnreadable = 0;
  const walk = (d, depth) => {
    if (depth > 8) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { scanUnreadable++; return; }
    if (ents.some((e) => e.name === '.git')) found.push(d);
    for (const e of ents) {
      if (!e.isDirectory() || e.name === '.git' || FIND_SKIP.has(e.name.toLowerCase())) continue;
      walk(path.join(d, e.name), depth + 1);
    }
  };
  for (const d of DRIVES) if (fs.existsSync(d)) walk(path.resolve(d), 0);
  return found.filter((r) => !NOT_OWNER.test(r)).map(describe);
}

/** The repository (or worktree) holding this path, or null. */
export function repoFor(p) {
  let d = path.resolve(p);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  for (; path.dirname(d) !== d; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return NOT_OWNER.test(d) ? null : describe(d);
  }
  return null;
}

/**
 * The repository list, refreshed against the cache rather than replaced by the scan.
 *
 * The old form wrote whatever findRepos returned straight over _repos.json, which every later sweep
 * reads without refreshing — so one unreadable directory during one scan silently narrowed the net
 * until the next refresh happened to succeed. On 2026-10-09 the phoenix label went 20 -> 17 -> 20
 * trees across three refreshes twenty minutes apart; for as long as the 17 stood, the documents in
 * the three dropped trees were not being archived by anything, and nothing said so.
 *
 * A cached tree is now kept whenever it is STILL a repository on disk. A tree that has genuinely
 * been removed fails that check and drops out, which is how the worktree removed earlier the same
 * day left the list honestly.
 */
export function loadRepos(refresh) {
  const cached = () => { try { return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8')); } catch { return []; } };
  if (!refresh) return cached();
  const repos = findRepos();
  const seen = new Set(repos.map((r) => r.dir.toLowerCase()));
  let kept = 0, gone = 0;
  for (const r of cached()) {
    if (!r?.dir || seen.has(r.dir.toLowerCase())) continue;
    if (!fs.existsSync(path.join(r.dir, '.git'))) { gone++; continue; }
    repos.push(describe(r.dir)); // re-described, because the main repository it points at may have moved
    kept++;
  }
  if (kept || gone || scanUnreadable) {
    logLine(`scan: ${seen.size} trees found, ${scanUnreadable} director(ies) unreadable, ${kept} cached tree(s) kept, ${gone} gone`);
    if (kept) say(`${kept} tree(s) the scan missed are still on disk and stay in the list`);
  }
  try { fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2)); } catch {}
  return repos;
}

function loadIndex() {
  let ix = {};
  try { ix = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch {}
  ix.files ??= {}; ix.shas ??= {}; ix.gitBlobs ??= {};
  return ix;
}

/**
 * Marks an index the sweep changed. A symbol key, so JSON.stringify never writes it. The index is
 * ~13.5 MB: parsing it is ~190 ms and writing it back ~170 ms (measured 2026-11-06), and the guard
 * pays both before every worktree removal — so a sweep that found every document unchanged, the
 * normal case, no longer writes back the same bytes it read.
 */
const DIRTY = Symbol('index changed');

function saveIndex(ix) {
  const tmp = `${INDEX}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ix));
  fs.renameSync(tmp, INDEX);
}

function walkRepo(dir, out, top = dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  // A nested repository or worktree is swept as its own entry.
  if (dir !== top && ents.some((e) => e.name === '.git')) return;
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!WALK_SKIP.has(e.name.toLowerCase())) walkRepo(p, out, top); }
    else if (e.isFile() && EXTENSIONS.includes(extOf(e.name))) out.push(p);
  }
}

/**
 * One sweep at a time, decided by the filesystem and not by a read followed by a write.
 *
 * The old form stat'ed the lock, returned false if it was fresh, and otherwise wrote it: two sweeps
 * starting together both saw no lock (or the same stale one) and both ran. They then both called
 * saveIndex, so whichever finished second wrote an index missing everything the first had just
 * recorded — and the next sweep re-hashed those files, found the destination already there with the
 * same bytes, and re-recorded them. Harmless to the archive, wasted work on every run, and it hides a
 * genuine concurrent sweep behind a message that is sometimes a lie.
 *
 * 'wx' fails when the lock exists, which is the whole decision in one atomic call. A lock older than
 * LOCK_STALE_MS belonged to a sweep that was killed (this machine bluescreens under memory pressure and
 * mem-watchdog.ps1 reaps): it is removed and the create retried ONCE, so two sweeps racing on the same
 * stale lock still leave exactly one winner.
 */
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      let age = 0;
      try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS) return false;
      logLine(`took over a stale lock (${Math.round(age / 1000)}s old)`);
      try { fs.rmSync(LOCK, { force: true }); } catch { return false; }
    }
  }
  return false;
}

function sweepTree(r, ix, counts) {
  const files = [];
  walkRepo(r.dir, files);
  if (!ix.shas[r.label]) ix[DIRTY] = true;
  const shas = (ix.shas[r.label] ??= {});
  for (const src of files) {
    counts.seen++;
    try {
      const st = fs.statSync(src);
      const key = src.toLowerCase();
      const prev = ix.files[key];
      const ownPath = () => path.join(ARCHIVE, '_by-source', extOf(src), '_repos', r.label, path.relative(r.dir, src));
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
        counts.unchanged++;
        // 🔴 THE POINTER IS REPAIRED ON THE UNCHANGED PATH, which is where it was going stale for
        // ever. This fast path used to `continue` without looking at the destination at all, so a
        // recorded path the 2026-09-20 de-duplication removed was never revisited: the file is
        // unchanged every run, so every run skipped it. Measured 2026-10-09: 2,758 of 4,525
        // recorded destinations pointed at nothing, 1,946 of them for documents whose own-path copy
        // was sitting right there. Nothing is copied here and nothing is deleted — the copy already
        // exists, this only writes down where it is, which costs one existsSync per document.
        const recorded = prev.sha && shas[prev.sha];
        if (prev.sha && (!recorded || !fs.existsSync(recorded))) {
          const own = ownPath();
          if (fs.existsSync(own)) { shas[prev.sha] = own; counts.repointed++; ix[DIRTY] = true; }
        }
        continue;
      }
      const sha = hash(fs.readFileSync(src));
      ix.files[key] = { size: st.size, mtimeMs: st.mtimeMs, sha };
      ix[DIRTY] = true;
      // A recorded destination is only worth something if it is still THERE. Trusting the mapping
      // without that check is the same blindness one level up: it reported the content held while
      // the path named nothing, and the fall-through below re-records or re-copies it instead.
      if (shas[sha] && fs.existsSync(shas[sha])) { counts.alreadyHeld++; continue; }
      let dest = ownPath();
      if (fs.existsSync(dest)) {
        if (fs.statSync(dest).size === st.size && hash(fs.readFileSync(dest)) === sha) { shas[sha] = dest; counts.alreadyHeld++; continue; }
        dest = versioned(dest, st.mtimeMs);
        counts.versions++;
      }
      copyNoClobber(src, dest, st);
      shas[sha] = dest;
      noteInArchive(dest, st.size, sha);
      counts.copied++;
    } catch (e) {
      counts.failed++;
      logLine(`FAILED ${src}: ${e.message}`);
    }
  }
  return files;
}

/** Every protected file git history shows was deleted, at its content just before the deleting commit. */
function recoverDeleted(r, ix, counts) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const git = (args, buffer = false) => spawnSync('git', ['-c', 'core.quotepath=false', '-C', r.dir, ...args],
    { encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 1024 * 1024 * 1024, windowsHide: true, env });
  const log = git(['log', '--all', '--diff-filter=D', '--no-renames', '--name-only', '--format=@@@%H %ct']);
  if (log.status !== 0) { logLine(`git log failed in ${r.dir}: ${String(log.stderr).slice(0, 200)}`); return; }
  const deletions = [];
  let commit = null, when = 0;
  for (const line of log.stdout.split('\n')) {
    if (line.startsWith('@@@')) { [commit, when] = line.slice(3).split(' '); continue; }
    if (commit && line && EXTENSIONS.includes(extOf(line))) deletions.push({ commit, when: Number(when) * 1000, file: line });
  }
  if (!deletions.length) return;
  counts.deletions += deletions.length;
  // Resolve every "<commit>^:<path>" to a blob id in one git call.
  const check = spawnSync('git', ['-c', 'core.quotepath=false', '-C', r.dir, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
    { input: deletions.map((d) => `${d.commit}^:${d.file}`).join('\n') + '\n', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, env });
  const answers = String(check.stdout).split('\n');
  const blobs = (ix.gitBlobs[r.label] ??= {});
  const shas = (ix.shas[r.label] ??= {});
  deletions.forEach((d, i) => {
    const [blob, type] = (answers[i] ?? '').split(' ');
    if (type !== 'blob') { counts.unreadable++; return; }
    // 🔴 BOTH GUARDS ARE EXISTENCE-CHECKED, AND A DEAD ONE FALLS THROUGH TO A CONTENT LOOKUP, NEVER
    // STRAIGHT TO A WRITE. Until 2026-10-09 these two lines read `if (blobs[blob])` and
    // `if (shas[sha])`, so a recovered document whose archive copy had gone was reported ALREADY
    // HELD for ever and was never recovered again — the same hole the working-tree sweep had.
    //
    // But existence alone must not decide the write, or this becomes a resurrection machine: the
    // 2026-09-20 de-duplication removed ~945 of these copies and kept the content in the day
    // folders, so "the recorded path is gone" usually means "the content moved", not "the document
    // is lost". Writing on that would put back exactly the duplicates the owner had removed.
    // So a dead pointer asks the archive BY CONTENT (the same question --verify asks) and, when the
    // content is there, only the pointer is corrected — nothing is written.
    if (blobs[blob] && fs.existsSync(blobs[blob])) { counts.alreadyHeld++; return; }
    try {
      const out = git(['cat-file', 'blob', blob], true);
      if (out.status !== 0) throw new Error(String(out.stderr).slice(0, 200));
      const sha = hash(out.stdout);
      const recorded = shas[sha];
      if (recorded && fs.existsSync(recorded)) { blobs[blob] = recorded; counts.alreadyHeld++; return; }
      const elsewhere = findInArchive(out.stdout.length, sha);
      if (elsewhere) { blobs[blob] = elsewhere; shas[sha] = elsewhere; counts.repointed++; return; }
      let dest = path.join(ARCHIVE, '_by-source', extOf(d.file), '_repos-deleted-in-git', r.label, ...d.file.split('/'));
      if (fs.existsSync(dest)) dest = versioned(dest, d.when);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, out.stdout, { flag: 'wx' });
      try { fs.utimesSync(dest, new Date(d.when), new Date(d.when)); } catch {}
      try { fs.chmodSync(dest, 0o444); } catch {}
      blobs[blob] = dest; shas[sha] = dest;
      noteInArchive(dest, out.stdout.length, sha);
      counts.recovered++;
    } catch (e) {
      counts.failed++;
      logLine(`history FAILED ${r.label} ${d.file}: ${e.message}`);
    }
  });
}

/**
 * `only`: repo objects (from repoFor) — the pre-delete hook passes just the repository a command touches.
 * `history`: also recover files deleted in git history (one pass per main repository).
 */
export function sweepRepos({ only = null, history = false, refresh = false } = {}) {
  lastSweep = null; // a skipped or failed sweep leaves nothing for verify to reuse
  fs.mkdirSync(ARCHIVE, { recursive: true });
  if (!acquireLock()) { say('another repository sweep is running — skipped'); return null; }
  resetArchiveCache(); // a sweep must not answer "held nowhere" from a map built before it started
  const counts = { repos: 0, seen: 0, copied: 0, versions: 0, unchanged: 0, alreadyHeld: 0, repointed: 0, deletions: 0, recovered: 0, unreadable: 0, failed: 0 };
  try {
    const ix = loadIndex();
    const repos = only ?? loadRepos(refresh);
    const walked = new Map();
    for (const r of repos) { counts.repos++; walked.set(r.dir.toLowerCase(), sweepTree(r, ix, counts)); }
    if (history) {
      const mains = new Map();
      for (const r of repos) if (!mains.has(r.label)) mains.set(r.label, fs.existsSync(path.join(r.main, '.git')) ? { ...r, dir: r.main } : r);
      for (const r of mains.values()) recoverDeleted(r, ix, counts);
    }
    if (history || ix[DIRTY]) saveIndex(ix);
    lastSweep = { ix, walked };
    if (counts.copied || counts.recovered || counts.failed || counts.repointed) logLine(JSON.stringify(counts));
    return counts;
  } finally {
    try { fs.rmSync(LOCK, { force: true }); } catch {}
  }
}

/**
 * Is this CONTENT anywhere in the archive, under any name? Built at most once per process and only
 * when something actually asks — a history pass whose pointers are all alive never touches it.
 * This is what keeps the existence-checked guards in recoverDeleted from re-creating the copies the
 * 2026-09-20 de-duplication removed: the content is still in a day folder, so the answer is yes.
 */
let bySizeCache = null;
const contentHashes = new Map();
/**
 * 🔴 The cache is per SWEEP, not per process, and anything this run writes is added to it. The first
 * version held it for the life of the process: the map was built on the first dead pointer, and a
 * copy that appeared afterwards — written by this very run, or by anything else between two sweeps
 * in one process — was invisible, so the content lookup said "held nowhere" and a duplicate was
 * written. Its own test caught that, and the assertion stands as the proof.
 */
function resetArchiveCache() {
  bySizeCache = null;
  contentHashes.clear();
}
function noteInArchive(dest, size, sha) {
  if (!bySizeCache) return;
  if (!bySizeCache.has(size)) bySizeCache.set(size, []);
  bySizeCache.get(size).push(dest);
  contentHashes.set(dest, sha);
}
function findInArchive(size, sha) {
  if (!bySizeCache) bySizeCache = archiveBySize();
  for (const p of bySizeCache.get(size) ?? []) {
    if (!contentHashes.has(p)) {
      try { contentHashes.set(p, hash(fs.readFileSync(p))); } catch { contentHashes.set(p, null); }
    }
    if (contentHashes.get(p) === sha) return p;
  }
  return null;
}

/** Every file in the archive grouped by size — the cheap half of a content lookup. */
function archiveBySize() {
  const bySize = new Map();
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        let size; try { size = fs.statSync(p).size; } catch { continue; }
        if (!bySize.has(size)) bySize.set(size, []);
        bySize.get(size).push(p);
      }
    }
  };
  walk(ARCHIVE);
  return bySize;
}

/**
 * Is every live protected document actually held somewhere in the archive? Answered by content.
 *
 * A path out of the index is NOT evidence. On 2026-10-09 a session about to remove a worktree
 * checked whether its documents were archived, looked at the recorded destinations, found them
 * absent, and reported that the repo half of the delete guard had never archived anything in its
 * life. 2,934 of the 4,525 recorded destinations are indeed gone — the 2026-09-20 de-duplication
 * removed the duplicate _by-source copies and the day folders <ext>/<YYYY-MM-DD>/ hold that
 * content — and the number of documents actually missing was 0. A stale path reads exactly like a
 * lost document, so never answer the question with existsSync on a recorded destination: call this.
 *
 *   held     — the copy is at its recorded or expected _by-source path
 *   elsewhere— the content is in the archive under another name (a day folder, or a .v<stamp>)
 *   unswept  — appeared since the last sweep; the next sweep copies it
 *   LOST     — the sweep believed it was handled and no copy of that content exists anywhere
 */
/**
 * What the last sweepRepos in THIS process read: the index as it left it and each tree's file list.
 * The delete guard sweeps and then verifies the same trees a moment apart, so `verify({ afterSweep })`
 * takes both from here instead of parsing the 13.5 MB index and walking the tree a second time.
 * This changes no answer: a document the reused index cannot place still falls to pass two, which
 * searches the archive by CONTENT, and a tree the sweep did not walk is walked as before.
 */
let lastSweep = null;

export function verify({ only = null, json = false, quiet = false, afterSweep = false } = {}) {
  const reuse = afterSweep ? lastSweep : null;
  const ix = reuse?.ix ?? loadIndex();
  const out = { archiveFiles: null, live: 0, held: 0, elsewhere: 0, unswept: 0, lost: [] };

  // PASS ONE reads no archive at all: a document whose copy is at its own path needs no searching.
  // This matters because the delete guard calls this before every worktree removal, and a tree that
  // is fully archived — the normal case — must not pay for a walk of 10,000 archive files to hear so.
  const suspects = [];
  const ownPathFixes = [];
  for (const r of (only ?? loadRepos(false))) {
    let files = reuse?.walked.get(r.dir.toLowerCase());
    if (!files) { files = []; walkRepo(r.dir, files); }
    for (const src of files) {
      out.live++;
      let st; try { st = fs.statSync(src); } catch { continue; }
      const entry = ix.files[src.toLowerCase()];
      const dest = entry && ix.shas[r.label]?.[entry.sha];
      const expected = path.join(ARCHIVE, '_by-source', extOf(src), '_repos', r.label, path.relative(r.dir, src));
      if (dest && fs.existsSync(dest)) { out.held++; continue; }
      if (fs.existsSync(expected)) {
        out.held++;
        // Held at its own path, and the pointer says somewhere else or says nothing — so write down
        // the path that just answered. Until 2026-10-09 this arm held the document and left the
        // pointer dead, which is why `--verify` could report every document safe and heal none of
        // them: pass one short-circuits here and pass two, where the only repair lived, never ran.
        if (entry?.sha) ownPathFixes.push({ label: r.label, sha: entry.sha, dest: expected });
        continue;
      }
      suspects.push({ r, src, size: st.size, sha: entry?.sha, swept: Boolean(entry) });
    }
  }
  // Counted before pass two pushes into the same list, so the message can say which arm found what.
  const fromOwnPath = ownPathFixes.length;

  // PASS TWO, only if something is unaccounted for: find it by CONTENT, anywhere in the archive.
  if (suspects.length > 0) {
    const bySize = archiveBySize();
    out.archiveFiles = [...bySize.values()].reduce((n, a) => n + a.length, 0);
    const hashes = new Map();
    const hashOf = (p) => {
      if (!hashes.has(p)) { try { hashes.set(p, hash(fs.readFileSync(p))); } catch { hashes.set(p, null); } }
      return hashes.get(p);
    };
    for (const s of suspects) {
      let sha = s.sha;
      if (!sha) { try { sha = hash(fs.readFileSync(s.src)); } catch { continue; } }
      const match = (bySize.get(s.size) ?? []).find((c) => hashOf(c) === sha);
      if (match) { out.elsewhere++; if (sha) ownPathFixes.push({ label: s.r.label, sha, dest: match }); }
      else if (!s.swept) out.unswept++;
      else out.lost.push({ label: s.r.label, file: path.relative(s.r.dir, s.src), src: s.src });
    }
  }

  /**
   * THE INDEX HEALS, FROM BOTH PASSES. A destination the de-duplication removed stays in the index
   * pointing at nothing, so every later run re-discovers the same documents the same expensive way —
   * and a reader who trusts that path is told a safe document is lost, which is exactly the
   * 2026-10-09 incident. Every document whose pointer is dead is re-recorded WHERE IT ACTUALLY IS:
   * at its own `_by-source` path when pass one found it there, or wherever in the archive pass two
   * found its content.
   *
   * 🔴 Until 2026-10-09 only pass two repaired, and pass one is the arm that almost always answers —
   * so a verify could report every document held and heal nothing at all, run after run. Measured
   * that day: 1,946 dead destinations for documents sitting at their own path, none of them healable
   * by any number of verify runs.
   *
   * Nothing is copied and nothing is deleted: the owner had the duplicate _by-source copies removed
   * on 2026-09-20 and this must not quietly put them back. It only corrects the pointer.
   *
   * Written under the SAME lock the sweep takes, because an index written by two processes at once
   * loses whichever write finishes first. If a sweep holds it, the repair is skipped — a reading is
   * still correct without it, it just costs the same discovery again next time.
   */
  const repairs = ownPathFixes;
  if (repairs.length > 0 && acquireLock()) {
    try {
      const live = loadIndex(); // re-read under the lock: a sweep may have recorded more since
      for (const { label, sha, dest } of repairs) (live.shas[label] ??= {})[sha] = dest;
      saveIndex(live);
      out.repaired = repairs.length;
      out.repairedAtOwnPath = fromOwnPath;
      logLine(`verify repaired ${repairs.length} stale destination(s) in the index (${fromOwnPath} at their own path)`);
    } finally {
      try { fs.rmSync(LOCK, { force: true }); } catch {}
    }
  } else if (repairs.length > 0) {
    out.repaired = 0;
  }
  // 🔴 quiet prints NOTHING. The delete guard calls this from a PreToolUse hook whose stdout is
  // the decision JSON itself: one stray line there and the hook's answer is unparseable.
  if (quiet) return out;
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(out.archiveFiles === null
    ? `${out.live} live protected documents · every one at its own path, so the archive was not searched`
    : `${out.archiveFiles} files in the archive · ${out.live} live protected documents`);
  console.log(`  ${out.held} held at their own path in _by-source`);
  console.log(`  ${out.elsewhere} held elsewhere in the archive (a day folder or a .v<stamp> — the index path is stale, the document is safe)`);
  console.log(`  ${out.unswept} appeared since the last sweep (the next sweep copies them)`);
  if (out.repaired) console.log(`  ${out.repaired} stale index pointer(s) corrected to where the copy actually is — ${out.repairedAtOwnPath ?? 0} of them at the document's own path (nothing copied, nothing deleted)`);
  if (out.lost.length === 0) console.log('  0 LOST — every live document is held somewhere in the archive');
  else {
    console.log(`  ${out.lost.length} LOST — the sweep believed these were handled and no copy exists anywhere:`);
    for (const l of out.lost) console.log(`     ! ${l.label} :: ${l.file}`);
  }
  return out;
}

/** Files actually on disk under one of the two roots, for a label (or for all of them). */
function onDisk(root, label) {
  let total = 0;
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile()) total++;
    }
  };
  for (const ext of new Set(EXTENSIONS)) {
    const base = path.join(ARCHIVE, '_by-source', ext, root);
    walk(label ? path.join(base, label) : base);
  }
  return total;
}

function status() {
  const repos = loadRepos(false);
  const ix = loadIndex();
  // The paths FIRST: the index can only be trusted about what it was told, and a session checking
  // whether a document is safe needs somewhere to look. Counting the files answers it from disk.
  console.log(`archive root:   ${ARCHIVE}`);
  console.log(`working trees:  ${ARCHIVE}/_by-source/<ext>/_repos/<repo>/<path in the tree>`);
  console.log(`deleted in git: ${ARCHIVE}/_by-source/<ext>/_repos-deleted-in-git/<repo>/<path>`);
  console.log(`on disk:        ${onDisk('_repos')} from working trees, ${onDisk('_repos-deleted-in-git')} recovered from history`);
  // A recorded destination the de-duplication removed reads exactly like a lost document, which is
  // how 2026-10-09 produced a false "this archive is empty". Say so here, and name the real check.
  let recorded = 0, stale = 0;
  for (const shas of Object.values(ix.shas)) for (const d of Object.values(shas)) { recorded++; if (!fs.existsSync(d)) stale++; }
  console.log(`index:          ${recorded} destinations recorded, ${stale} no longer at that path (the day folders hold those copies)`);
  console.log(`is it held?     --verify answers by CONTENT; a recorded path is not evidence`);
  console.log(`trees:          ${repos.length} in _repos.json — a refresh keeps a cached tree that is still on disk`);
  console.log('');
  for (const l of [...new Set(repos.map((r) => r.label))].sort()) {
    const trees = repos.filter((r) => r.label === l).length;
    console.log(`${l}`);
    console.log(`  ${trees} working tree(s) · ${onDisk('_repos', l)} files on disk · ${Object.keys(ix.shas[l] ?? {}).length} distinct held in the index · ${Object.keys(ix.gitBlobs[l] ?? {}).length} from git history`);
  }
}

/**
 * Drop index pointers that name a path no longer on disk — but ONLY the ones that are inert.
 *
 * 🔴 A DEAD POINTER IS NOT NECESSARILY JUNK. `recoverDeleted` asks `if (shas[sha])` before writing
 * a document git history shows was deleted, and that question is NOT existence-checked: the entry
 * is a TOMBSTONE, and it is the only thing stopping the history pass from writing that copy again.
 * The owner had the duplicate copies removed on 2026-09-20; re-creating them because an index was
 * tidied would be exactly the "quietly put them back" this file forbids.
 *
 * So an entry goes only when `gitBlobs[label]` holds the SAME destination. That guard is asked
 * FIRST in recoverDeleted and is keyed by git blob id — content-addressed, so one content is one
 * blob — which means recovery stays suppressed with the sha entry gone. Everything else is KEPT and
 * counted, with the reason, because a smaller index is worth nothing next to a re-created document.
 *
 * Measured on the real archive, 2026-10-09: 2,758 dead pointers, 945 with a blob twin (inert, these
 * go), 1,813 without one (tombstones, these stay). The index is backed up before it is written.
 */
export function prunePointers({ apply = false } = {}) {
  const out = { dead: 0, pruned: 0, keptAsTombstone: 0, live: 0, backup: null, applied: false };
  const ix = loadIndex();
  const plan = [];
  for (const [label, shas] of Object.entries(ix.shas ?? {})) {
    const blobDests = new Set(Object.values(ix.gitBlobs?.[label] ?? {}));
    for (const [sha, dest] of Object.entries(shas)) {
      if (fs.existsSync(dest)) { out.live++; continue; }
      out.dead++;
      if (blobDests.has(dest)) plan.push({ label, sha });
      else out.keptAsTombstone++;
    }
  }
  out.pruned = plan.length;
  if (!apply || plan.length === 0) return out;

  if (!acquireLock()) { say('another repository sweep is running — the prune was skipped'); return out; }
  try {
    const live = loadIndex(); // re-read under the lock, like every other write here
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    out.backup = `${ARCHIVE}/_repo-index.pre-prune-${stamp}.json`;
    fs.writeFileSync(out.backup, JSON.stringify(live));
    let gone = 0;
    for (const { label, sha } of plan) {
      const dest = live.shas?.[label]?.[sha];
      // Re-checked under the lock: a sweep may have re-recorded this pointer since the plan was made.
      if (!dest || fs.existsSync(dest)) continue;
      const blobDests = new Set(Object.values(live.gitBlobs?.[label] ?? {}));
      if (!blobDests.has(dest)) continue;
      delete live.shas[label][sha];
      gone++;
    }
    saveIndex(live);
    out.pruned = gone;
    out.applied = true;
    logLine(`pruned ${gone} inert dead pointer(s) from the index, kept ${out.keptAsTombstone} tombstone(s); backup ${path.basename(out.backup)}`);
  } finally {
    try { fs.rmSync(LOCK, { force: true }); } catch {}
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  try {
    if (process.argv.includes('--status')) status();
    else if (process.argv.includes('--verify')) {
      // --repo <dir> limits it to the repository (or worktree) holding that path.
      const i = process.argv.indexOf('--repo');
      let only = null;
      if (i >= 0 && process.argv[i + 1]) {
        const r = repoFor(process.argv[i + 1]);
        if (!r) { console.error(`not inside a git repository: ${process.argv[i + 1]}`); process.exit(2); }
        only = [r];
      }
      const v = verify({ only, json: process.argv.includes('--json') });
      if (v.lost.length) process.exitCode = 1;
    }
    else if (process.argv.includes('--prune-pointers')) {
      // Dry by default: it prints the plan and writes nothing until --apply.
      const apply = process.argv.includes('--apply');
      const p = prunePointers({ apply });
      console.log(`${p.live} pointer(s) still point at a file · ${p.dead} point at nothing`);
      console.log(`  ${p.pruned} inert (a gitBlobs entry holds the same path, so history recovery stays blocked) — ${apply ? 'PRUNED' : 'would be pruned with --apply'}`);
      console.log(`  ${p.keptAsTombstone} KEPT as tombstones: with no blob entry behind them, dropping one lets the history pass write that deleted document again`);
      if (p.backup) console.log(`  index backed up to ${p.backup}`);
      if (!apply) console.log('  nothing was written — add --apply');
    }
    else { const c = sweepRepos({ refresh: true, history: process.argv.includes('--history') }); if (c) say(JSON.stringify(c)); }
  } catch (e) {
    logLine(`sweep crashed: ${e.stack || e.message}`);
    if (!QUIET) console.error(e);
  }
}
