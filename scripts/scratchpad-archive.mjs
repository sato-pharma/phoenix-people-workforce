#!/usr/bin/env node
/**
 * scratchpad-archive.mjs — copy every HTML, PDF, spreadsheet, Word file, SVG and screenshot out of
 * the Claude scratchpads into a permanent archive, one folder per extension. It NEVER deletes.
 *
 * Owner instruction 2026-09-14: "push all html, pdfs, xlsxs, docx, svg and screenshots in scratch
 * pad to separate folders per extension — never delete any of those, recover the deleted ones, and
 * in future never delete."
 *
 * WHY: the scratchpads live under %LOCALAPPDATA%\Temp, and Windows Storage Sense on this machine is
 * set to empty Temp. Anything a session produced there is one cleanup away from gone.
 *
 *   node scratchpad-archive.mjs            # sweep once (incremental — unchanged files are skipped)
 *   node scratchpad-archive.mjs --quiet    # same, for hooks and the scheduled task
 *   node scratchpad-archive.mjs --status   # print what the archive holds, change nothing
 *
 * RULES THIS SCRIPT OBEYS
 *  - Never deletes or overwrites anything, source or archive. A file whose content changed since
 *    the last sweep is kept as a NEW version beside the old one (name.v<stamp>.ext).
 *  - Archived copies are marked read-only, so a casual delete fails.
 *  - Layout: <ARCHIVE>/<ext>/<project>/<session>/<path inside the scratchpad>.
 *  - Never throws out of main: a hook that crashes blocks nothing but also archives nothing, so
 *    every failure is logged to <ARCHIVE>/_archive.log.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { spawnSync } from 'child_process';

export const ARCHIVE = 'F:/Claude Scratchpad Archive';
// 2026-09-20 (owner): screenshots/images, csv, css, json and patch files are NO LONGER archived or protected.
// Kept: html, pdf, xlsx/xlsm/xls, docx/doc, svg. Previous list: backups/hook-backups/scratchpad-archive.mjs.pre-2026-09-20.
export const EXTENSIONS = ['html', 'htm', 'pdf', 'xlsx', 'xlsm', 'xls', 'docx', 'doc', 'svg'];
const HOME = 'C:/Users/satoh';
const SOURCES = [
  `${HOME}/AppData/Local/Temp/claude`,
  `${HOME}/AppData/Roaming/Claude/scratch-workspaces`,
  `${HOME}/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/scratch-workspaces`,
  // The desktop app's local agent sessions keep their uploads and outputs here.
  `${HOME}/AppData/Roaming/Claude/local-agent-mode-sessions`,
  `${HOME}/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/local-agent-mode-sessions`,
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'bundled-skills', 'lo_audit_profile']);
const INDEX = `${ARCHIVE}/_index.json`;
const LOG = `${ARCHIVE}/_archive.log`;
const LOCK = `${ARCHIVE}/_sweep.lock`;
const LOCK_STALE_MS = 15 * 60 * 1000;

const QUIET = process.argv.includes('--quiet');
const say = (s) => { if (!QUIET) console.log(s); };
const logLine = (s) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()}  ${s}\n`); } catch {} };

/** A short, readable project label: the worktree name or the scratch-workspace name, not the whole mangled path. */
export function projectLabel(dirName) {
  let n = dirName;
  const ws = n.match(/scratch-(\d{4}-\d{2}-\d{2}-[0-9a-f]+)$/i);
  if (ws) return `scratch-${ws[1]}`;
  n = n.replace(/-phoenix-workforce--claude-worktrees-/i, '-wt-');
  return n.length > 60 ? n.slice(-60) : n;
}

/** <ext>/<project>/<session>/<rest> for a source file, or null when it is not an archivable type. */
export function destFor(sourceRoot, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!EXTENSIONS.includes(ext)) return null;
  const rel = path.relative(sourceRoot, file).split(path.sep);
  const project = rel.length > 1 ? projectLabel(rel.shift()) : '_root';
  let session = rel.length > 1 ? rel.shift() : '_root';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(session)) session = session.slice(0, 8);
  if (rel[0] === 'scratchpad' && rel.length > 1) rel.shift();
  // A Chrome profile a session launched (scratchpad/chrome-*/Default/...) holds ~12k app and extension
  // icons. Keep them — never drop — but out of the way of the real screenshots and documents.
  const c = rel.findIndex((s) => /^chrome-/i.test(s));
  // Stored by source under _by-source; archive-flatten.mjs links each into the flat <ext> folder.
  if (c >= 0 && rel.length - c > 2) return path.join(ARCHIVE, '_browser-icons', ext, project, session, ...rel);
  return path.join(ARCHIVE, '_by-source', ext, project, session, ...rel);
}

function versioned(dest, mtimeMs) {
  const d = new Date(mtimeMs);
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = path.extname(dest);
  let candidate = `${dest.slice(0, -ext.length)}.v${stamp}${ext}`;
  for (let i = 2; fs.existsSync(candidate); i++) candidate = `${dest.slice(0, -ext.length)}.v${stamp}-${i}${ext}`;
  return candidate;
}

const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

/** Copy without ever overwriting; keep the source's modified time; mark the copy read-only. */
export function copyNoClobber(src, dest, st) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  try { fs.utimesSync(dest, st.atime, st.mtime); } catch {}
  try { fs.chmodSync(dest, 0o444); } catch {}
}

function walk(dir, out, skipChrome = false) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      // Inside a session-launched Chrome profile only the top level can hold a saved screenshot.
      if (skipChrome && /[\\/]chrome-[^\\/]+$/i.test(dir)) continue;
      walk(p, out, skipChrome);
    }
    else if (e.isFile() && EXTENSIONS.includes(path.extname(e.name).slice(1).toLowerCase())) out.push(p);
  }
}

/**
 * One sweep at a time, decided by the filesystem and not by a read followed by a write.
 *
 * The form this replaces stat'ed the lock, returned false if it was fresh, and otherwise wrote it —
 * so two sweeps starting together both saw no lock (or the same stale one) and both ran. They then
 * both wrote _index.json at the end, and whichever finished second wrote an index missing everything
 * the first had just recorded, which costs a full re-hash on the next run and can turn an unchanged
 * file into a .v<stamp> duplicate. This sweep is the one the Stop hook fires at the end of EVERY turn
 * in EVERY open session, so overlapping runs are its normal condition, not an edge case.
 *
 * 'wx' fails when the lock exists, which is the whole decision in one atomic call: six processes
 * racing it leave exactly one winner, where the old form left six (measured 2026-10-09 on the
 * repo-archive twin of this function). A lock past LOCK_STALE_MS belonged to a sweep that was killed
 * — this machine bluescreens under memory pressure and mem-watchdog.ps1 reaps — so it is removed and
 * the create retried ONCE, leaving one winner even when two sweeps meet on the same stale lock.
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

/**
 * `only` limits the walk to these folders (each must sit inside a source root) — the pre-delete
 * hook passes the one scratchpad a command touches, because a full walk is ~70k entries and ~8s.
 */
export function sweep({ only = null, skipChrome = false } = {}) {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  if (!acquireLock()) { say('another sweep is running — skipped'); return null; }
  const counts = { seen: 0, copied: 0, versions: 0, unchanged: 0, failed: 0 };
  try {
    let index = {};
    try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch {}
    for (const root of SOURCES) {
      if (!fs.existsSync(root)) continue;
      const rootAbs = path.resolve(root);
      const starts = only
        ? only.map((d) => path.resolve(d)).filter((d) => d.toLowerCase().startsWith(rootAbs.toLowerCase() + path.sep) && fs.existsSync(d))
        : [rootAbs];
      const files = [];
      for (const s of starts) walk(s, files, skipChrome);
      for (const src of files) {
        counts.seen++;
        try {
          const st = fs.statSync(src);
          const key = src.toLowerCase();
          const prev = index[key];
          if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) { counts.unchanged++; continue; }
          let dest = destFor(path.resolve(root), src);
          if (!dest) continue;
          if (fs.existsSync(dest)) {
            // Same bytes already archived (e.g. only the timestamp moved): record it, copy nothing.
            if (fs.statSync(dest).size === st.size && sha1(dest) === sha1(src)) {
              index[key] = { size: st.size, mtimeMs: st.mtimeMs, dest: prev?.dest ?? dest };
              counts.unchanged++;
              continue;
            }
            dest = versioned(dest, st.mtimeMs);
            counts.versions++;
          }
          copyNoClobber(src, dest, st);
          index[key] = { size: st.size, mtimeMs: st.mtimeMs, dest };
          counts.copied++;
        } catch (e) {
          counts.failed++;
          logLine(`FAILED ${src}: ${e.message}`);
        }
      }
    }
    const tmp = `${INDEX}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, INDEX);
    if (counts.copied || counts.failed) logLine(`sweep: ${JSON.stringify(counts)}`);
    return counts;
  } finally {
    try { fs.rmSync(LOCK, { force: true }); } catch {}
  }
}

function status() {
  const byExt = {};
  const count = (dir, ext) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) count(p, ext);
      else { const s = fs.statSync(p); byExt[ext] ??= { files: 0, bytes: 0 }; byExt[ext].files++; byExt[ext].bytes += s.size; }
    }
  };
  for (const ext of fs.existsSync(ARCHIVE) ? fs.readdirSync(ARCHIVE) : []) {
    if (!ext.startsWith('_') && fs.statSync(path.join(ARCHIVE, ext)).isDirectory()) count(path.join(ARCHIVE, ext), ext);
  }
  for (const [ext, v] of Object.entries(byExt)) console.log(`${ext.padEnd(6)} ${String(v.files).padStart(6)} files  ${(v.bytes / 1048576).toFixed(1)} MB`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  // 2026-10-03 (perf audit): the full chain walks ~70 repositories and runs for 50 s (median) to 12 min while the
  // owner works, at about one core. BelowNormal lets his sessions win the CPU; Windows hands the class on to the
  // repo-archive and archive-flatten children below. Only this entry point: the synchronous pre-delete sweep imports
  // the functions in the guard's own process, so a delete is never made to wait behind a lowered priority.
  // Previous file: backups/hook-backups/scratchpad-archive.mjs.pre-2026-10-03-perf.
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
  try {
    if (process.argv.includes('--status')) status();
    else {
      const c = sweep(); if (c) say(JSON.stringify(c));
      // The same protection for every git repository on the machine (owner, 2026-09-14). A child process,
      // not an import: repo-archive.mjs imports this file.
      spawnSync(process.execPath, [path.join(path.dirname(process.argv[1]), 'repo-archive.mjs'), '--history', ...(QUIET ? ['--quiet'] : [])],
        { stdio: QUIET ? 'ignore' : 'inherit', windowsHide: true, timeout: 20 * 60 * 1000 });
      // Then type and day folders (owner, 2026-09-14/15: "all in one folder", "by the date created").
      spawnSync(process.execPath, [path.join(path.dirname(process.argv[1]), 'archive-flatten.mjs'), ...(QUIET ? ['--quiet'] : [])],
        { stdio: QUIET ? 'ignore' : 'inherit', windowsHide: true, timeout: 20 * 60 * 1000 });
    }
  } catch (e) {
    logLine(`sweep crashed: ${e.stack || e.message}`);
    if (!QUIET) console.error(e);
  }
}
