#!/usr/bin/env node
/**
 * scratchpad-find-elsewhere.mjs — for scratchpad files that are gone and no transcript could rebuild
 * (_lost-cannot-recover.txt), look for a surviving copy under the same file name elsewhere on this
 * machine (repo xlsx/ folders, Downloads, Desktop, other drives) and copy it into the archive.
 *
 *   node scratchpad-find-elsewhere.mjs           # report only
 *   node scratchpad-find-elsewhere.mjs --write   # copy matches to <ext>/_found-elsewhere/<name>
 *
 * A same-name file is a CANDIDATE, not proof it is the original — the copy keeps its source path in
 * _found-elsewhere.json so it can be judged. Never deletes, never overwrites.
 */
import fs from 'fs';
import path from 'path';
import { ARCHIVE, copyNoClobber } from './scratchpad-archive.mjs';

const WRITE = process.argv.includes('--write');
const ROOTS = process.argv.includes('--wide')
  ? ['C:/', 'D:/', 'E:/', 'F:/']
  : ['F:/', 'E:/', 'D:/', 'C:/Users/satoh/Downloads', 'C:/Users/satoh/Desktop', 'C:/Users/satoh/Documents', 'C:/Users/satoh/OneDrive', 'C:/Users/satoh/Pictures'];
const SKIP = new Set(['node_modules', '.git', '.next', '$RECYCLE.BIN', 'System Volume Information', '.pnpm-store', 'Claude Scratchpad Archive', 'Windows', 'WinSxS', 'Program Files', 'Program Files (x86)']);

const lostText = fs.readFileSync(path.join(ARCHIVE, '_lost-cannot-recover.txt'), 'utf8');
const lost = lostText.split(/\r?\n/).filter((l) => /^[A-Za-z]:/.test(l));
const wanted = new Map(); // basename lower -> [original paths]
for (const p of lost) {
  const b = path.basename(p).toLowerCase();
  if (!wanted.has(b)) wanted.set(b, []);
  wanted.get(b).push(p);
}

const found = new Map(); // basename -> [{path,size,mtimeMs}]
function walk(d) {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/[\\/]AppData[\\/]Local[\\/]Temp[\\/]claude$/i.test(p)) walk(p); }
    else if (e.isFile() && wanted.has(e.name.toLowerCase())) {
      try { const st = fs.statSync(p); (found.get(e.name.toLowerCase()) ?? found.set(e.name.toLowerCase(), []).get(e.name.toLowerCase())).push({ path: p, size: st.size, mtimeMs: st.mtimeMs, st }); } catch {}
    }
  }
}
for (const r of ROOTS) if (fs.existsSync(r)) walk(r);

// Keep what earlier runs archived; only add sources not already copied.
const JSON_OUT = path.join(ARCHIVE, '_found-elsewhere.json');
let out = [];
try { out = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8')); } catch {}
const already = new Set(out.map((o) => o.foundAt.toLowerCase()));
let copied = 0, newCandidates = 0;
for (const [b, hits] of found) {
  for (const h of hits) {
    if (already.has(h.path.toLowerCase())) continue;
    const ext = path.extname(b).slice(1).toLowerCase();
    const stem = path.basename(h.path).slice(0, -(ext.length + 1));
    let dest = path.join(ARCHIVE, ext, '_found-elsewhere', `${stem}.${ext}`);
    for (let i = 1; fs.existsSync(dest); i++) dest = path.join(ARCHIVE, ext, '_found-elsewhere', `${stem}.copy${i}.${ext}`);
    out.push({ lostOriginals: wanted.get(b), foundAt: h.path, size: h.size, archivedAs: dest });
    newCandidates++;
    if (WRITE) { try { copyNoClobber(h.path, dest, h.st); copied++; } catch (e) { console.error(`${h.path}: ${e.message}`); } }
  }
}
if (WRITE) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
const byExt = {};
for (const b of found.keys()) { const x = path.extname(b).slice(1); byExt[x] = (byExt[x] ?? 0) + 1; }
console.log(JSON.stringify({ lostPaths: lost.length, lostNames: wanted.size, namesFoundElsewhere: found.size, candidateFilesTotal: out.length, newCandidates, byExt, copied }, null, 2));
