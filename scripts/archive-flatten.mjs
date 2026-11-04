#!/usr/bin/env node
/**
 * archive-flatten.mjs — one folder per file type, then one folder per day. Owner, 2026-09-14: "make them
 * all in one folder" ("one folder per type", "keep the browser icons in a side folder"), then "rename
 * folders by the date created" ("type, then one folder per day").
 *
 *   <ARCHIVE>/<ext>/<YYYY-MM-DD>/  every archived file of that type made that day (modified time, Cairo),
 *                                  each distinct content once
 *   <ARCHIVE>/_by-source/<ext>/    the same files where they came from (scratchpad session, repository, recovery)
 *   <ARCHIVE>/_browser-icons/      the ~12k icons from browser profiles that sessions opened — kept, out of the way
 *
 * The day folders hold HARD LINKS to the files in _by-source: no extra disk space, and removing either
 * name leaves the other intact. Nothing is ever deleted. A same-named file with different content gets
 * where it came from added to its name. Any subfolder or stray file a script writes straight into <ext>/
 * is moved into _by-source on the next run and linked from there.
 *
 *   node archive-flatten.mjs [--quiet]
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ARCHIVE, EXTENSIONS } from './scratchpad-archive.mjs';

export const BY_SOURCE = path.join(ARCHIVE, '_by-source');
export const ICONS = path.join(ARCHIVE, '_browser-icons');
const FLAT_INDEX = path.join(ARCHIVE, '_flat-index.json');
const LOCKS = [path.join(ARCHIVE, '_sweep.lock'), path.join(ARCHIVE, '_repo-sweep.lock')];
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOG = path.join(ARCHIVE, '_archive.log');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const QUIET = process.argv.includes('--quiet');
const say = (s) => { if (!QUIET) console.log(s); };
const logLine = (s) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()}  flatten: ${s}\n`); } catch {} };
const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
/** The file's day in this machine's local time (Cairo). */
const dayOf = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

/** Both archivers' locks, so no sweep writes while files move. */
function acquire() {
  const taken = [];
  for (const l of LOCKS) {
    let busy = false;
    try { busy = Date.now() - fs.statSync(l).mtimeMs < LOCK_STALE_MS; } catch {}
    if (busy) { for (const t of taken) try { fs.rmSync(t, { force: true }); } catch {} return null; }
    fs.writeFileSync(l, `flatten ${process.pid}`);
    taken.push(l);
  }
  return taken;
}

/** "name (2).ext", "name (3).ext" … — the first that does not exist. */
function freeName(p) {
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  let i = 2;
  while (fs.existsSync(`${stem} (${i})${ext}`)) i++;
  return `${stem} (${i})${ext}`;
}

/** Move a file or folder, merging into an existing folder; a clashing file is kept under a free name. */
function moveInto(src, dest, counts) {
  const st = fs.statSync(src);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(src, dest); counts.moved++; return; }
    catch (e) { if (!st.isDirectory()) throw e; fs.mkdirSync(dest, { recursive: true }); }
  }
  if (st.isDirectory() && fs.statSync(dest).isDirectory()) {
    for (const name of fs.readdirSync(src)) moveInto(path.join(src, name), path.join(dest, name), counts);
    try { fs.rmdirSync(src); } catch {} // only an emptied folder; never a file
  } else {
    fs.renameSync(src, freeName(dest));
    counts.moved++;
  }
}

/** Where a file came from, short enough to add to its name: "phoenix-workforce", "recovered cef2439a"… */
function sourceHint(relDirs) {
  const segs = relDirs.filter((s) => s && !/^scratchpad$/i.test(s));
  const kind = segs[0]?.startsWith('_') ? segs.shift().slice(1).replace(/-/g, ' ') : null;
  let where = segs[0] ?? '';
  if (kind?.startsWith('repos')) where = where.split(' - ').pop();
  where = where.replace(/^.*phoenix-workforce--claude-worktrees-/i, 'wt ').replace(/^F--Phoenix-Workforce-phoenix-workforce$/i, 'phoenix').replace(/^[A-Z]--/, '');
  const session = segs.find((s) => /^[0-9a-f]{8}$/i.test(s));
  const bits = [kind === 'repos' ? null : kind, where.slice(-40), session].filter(Boolean);
  return [...new Set(bits)].join(' ').replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim() || 'other';
}

function nameFor(dir, file, relDirs) {
  const base = path.basename(file);
  if (!fs.existsSync(path.join(dir, base))) return base;
  const ext = path.extname(base);
  const withHint = `${base.slice(0, base.length - ext.length)} (${sourceHint(relDirs)})${ext}`;
  const p = path.join(dir, withHint);
  return path.basename(fs.existsSync(p) ? freeName(p) : withHint);
}

function walk(dir, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) { const st = fs.statSync(p); out.push({ p, size: st.size, mtimeMs: st.mtimeMs }); }
  }
}

export function flatten() {
  const locks = acquire();
  if (!locks) { say('an archive sweep is running — flatten skipped'); return null; }
  const counts = { moved: 0, seen: 0, linked: 0, relinked: 0, sameContent: 0, failed: 0 };
  try {
    let ix = {};
    try { ix = JSON.parse(fs.readFileSync(FLAT_INDEX, 'utf8')); } catch {}
    ix.bySha ??= {}; ix.bySrc ??= {};

    // 1. Anything nested inside a type folder, other than its day folders, moves to _by-source
    //    (browser icons to their side folder); a stray file moves to _by-source/<ext>/_loose.
    for (const ext of EXTENSIONS) {
      const top = path.join(ARCHIVE, ext);
      if (!fs.existsSync(top)) continue;
      for (const e of fs.readdirSync(top, { withFileTypes: true })) {
        const p = path.join(top, e.name);
        if (e.isDirectory() && DAY.test(e.name)) continue;
        try {
          if (e.isDirectory()) moveInto(p, e.name === '_browser-profile-internals' ? path.join(ICONS, ext) : path.join(BY_SOURCE, ext, e.name), counts);
          else moveInto(p, path.join(BY_SOURCE, ext, '_loose', e.name), counts);
        } catch (err) { counts.failed++; logLine(`move FAILED ${p}: ${err.message}`); }
      }
    }

    // 2. Every distinct file in _by-source gets one name in <ext>/<day>/ (oldest first keeps the plain name).
    for (const ext of fs.existsSync(BY_SOURCE) ? fs.readdirSync(BY_SOURCE) : []) {
      const root = path.join(BY_SOURCE, ext);
      const files = [];
      walk(root, files);
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of files) {
        counts.seen++;
        try {
          const key = path.relative(BY_SOURCE, f.p).toLowerCase();
          const prev = ix.bySrc[key];
          const sha = prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs ? prev.sha : hash(fs.readFileSync(f.p));
          ix.bySrc[key] = { size: f.size, mtimeMs: f.mtimeMs, sha };
          const have = ix.bySha[sha];
          if (have && fs.existsSync(path.join(ARCHIVE, have))) { counts.sameContent++; continue; }
          const day = dayOf(f.mtimeMs);
          const dir = path.join(ARCHIVE, ext, day);
          fs.mkdirSync(dir, { recursive: true });
          const name = nameFor(dir, f.p, path.relative(root, path.dirname(f.p)).split(path.sep));
          fs.linkSync(f.p, path.join(dir, name));
          ix.bySha[sha] = path.join(ext, day, name);
          if (have) counts.relinked++; else counts.linked++;
        } catch (err) { counts.failed++; logLine(`link FAILED ${f.p}: ${err.message}`); }
      }
    }

    const tmp = `${FLAT_INDEX}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ix));
    fs.renameSync(tmp, FLAT_INDEX);
    if (counts.moved || counts.linked || counts.relinked || counts.failed) logLine(JSON.stringify(counts));
    return counts;
  } finally {
    for (const l of locks) try { fs.rmSync(l, { force: true }); } catch {}
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  try { const c = flatten(); if (c) say(JSON.stringify(c)); }
  catch (e) { logLine(`crashed: ${e.stack || e.message}`); if (!QUIET) console.error(e); }
}
