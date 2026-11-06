#!/usr/bin/env node
/**
 * scratchpad-guard.mjs — the "never delete" half of the scratchpad archive (owner instruction 2026-09-14).
 *
 *   PreToolUse  (Bash|PowerShell)  node scratchpad-guard.mjs pre
 *     - a command that deletes AND names an HTML / PDF / spreadsheet / Word / SVG / image file, or
 *       touches the archive folder, is DENIED — the owner said never delete those types.
 *     - any other deleting command first runs a synchronous archive sweep, so whatever it removes
 *       from a scratchpad is already safe in the archive.
 *   SessionStart / Stop              node scratchpad-guard.mjs sweep
 *     - starts the full detached background sweep at most once per 10 minutes machine-wide and returns at
 *       once; in between, a detached sweep of this session's own folder when it holds a protected file.
 *   node scratchpad-guard.mjs selftest
 *     - cases over the stand-down and the deny, run in-process. Expect "0 failed" after editing this file.
 *
 * It fails OPEN on its own errors (a broken guard must not wedge every shell call), and logs them.
 *
 * THE STAND-DOWN (owner, 2026-10-06 — "add a stand-down to the delete guard so my own yes can go through")
 * -------------------------------------------------------------------------------------------------------
 * Until today this was the one guard with NO override, and that cost him a real instruction: he typed
 * "delete the duplicate worktree-copy PDF in _deliverables", this hook refused it, and the rule's own
 * "do not look for another way to delete it" correctly stopped the session routing round it. His yes could
 * not reach the machine. It can now — but NOT through the `=1` shape every other guard here uses:
 *
 *   PHX_DELETE_OK=<file> rm "<path>/<file>"                      (bash)
 *   $env:PHX_DELETE_OK='<file>'; Remove-Item "<path>/<file>"     (PowerShell)
 *
 * The marker must NAME the file, because `PHX_DELETE_OK=1` would be a blanket off switch and a blanket off
 * switch is exactly what a session talks itself into — which is why he built this one without any. So the
 * value must name nothing vague (`1`, `yes`, `all`, `*` stay DENIED), the name must actually appear in the
 * command, and EVERY protected file the command names must match it. One yes, one file, one command: it
 * does not persist, and it never covers a wildcard or a whole directory.
 *
 * The file is COPIED INTO THE ARCHIVE FIRST, synchronously, and the delete is DENIED if that copy fails.
 * That one step fails CLOSED, against the rest of this file's fail-open rule, because an approved delete
 * still must not take the last copy with it — and a path outside a scratchpad and outside a git tree
 * (`F:\Phoenix Workforce\_deliverables` was the first) is swept by NEITHER archiver, so without this step
 * the hatch would be the one unbacked delete on the machine.
 *
 * F:/Claude Scratchpad Archive and F:/Hiring Posts are NEVER standable down — his words there are
 * absolute, and the archive holding the only copy of an approved delete is itself the reason.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const ARCHIVER = 'C:/Users/satoh/.claude/scripts/scratchpad-archive.mjs';
const LOG = 'F:/Claude Scratchpad Archive/_archive.log';
const mode = process.argv[2];

const DELETE_VERB = /(^|[\s;&|(`{])(rm|del|erase|rmdir|rd|ri|unlink|shred|rimraf|trash|Remove-Item|Clear-RecycleBin)(?=$|[\s;&|)}])|git\s+clean\b|\.(rmSync|unlinkSync|rmdirSync|unlink|rm)\s*\(|\[(System\.)?IO\.(File|Directory)\]::Delete|robocopy\b[^\n]*\/(MIR|PURGE)\b|\bdel\s*\/|Remove-Item/i;
// 2026-09-20 (owner): images, csv, css, json and patch files are no longer protected. Previous list is in
// backups/hook-backups/scratchpad-guard.mjs.pre-2026-09-20.
const PROTECTED_EXT = /\.(html?|pdf|xlsx|xlsm|xls|docx?|svg)\b/i;
const ARCHIVE_PATH = /Claude[ _-]?Scratchpad[ _-]?Archive/i;
// 2026-10-02 (owner): F:\Hiring Posts keeps every hiring post ever made — historical, current and
// upcoming — in EVERY format, and nothing in it is ever deleted. It is named here as well as covered
// by PROTECTED_EXT because PNG and JPG lost their protection on 2026-09-20, which is exactly how the
// image of the Talent Acquisition poster was lost while its HTML and PDFs survived.
const HIRING_POSTS = /Hiring[ _-]?Posts/i;
const REPO_ARCHIVER = 'C:/Users/satoh/.claude/scripts/repo-archive.mjs';
// Git commands that remove or overwrite working-tree files without naming a delete verb.
const GIT_WIPE = /\bgit\b[^\n;|&]*\b(clean|worktree\s+remove|stash\b[^\n;|&]*(\s-u\b|--include-untracked|\s-a\b|--all)|reset\b[^\n;|&]*--hard|checkout\b[^\n;|&]*(\s-f\b|\s--(\s|$))|restore\b)|new-session\.mjs[^\n]*--remove/i;

const logLine = (s) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()}  guard: ${s}\n`); } catch {} };

function readStdin() {
  // Strip a BOM: Windows PowerShell 5.1 prepends one when it pipes text in.
  try { return JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}'); } catch { return {}; }
}

// Stop fires at the end of EVERY turn in EVERY open session (1,028 times in the 48 hours to 2026-09-16 01:00 Cairo),
// and each full chain (every scratchpad, every repository's git history, then the day folders) costs ~17 CPU-seconds
// and ~30 seconds of disk walking, so on a busy night it ran back to back. The full chain now starts at most once per
// FULL_EVERY_MS machine-wide; in between, a turn's end sweeps only its own session's folder, and only when that folder
// holds a protected file. The hourly task and the synchronous pre-delete sweep are untouched.
const STAMP = 'F:/Claude Scratchpad Archive/_hook-sweep.stamp';
// 10 -> 30 min on 2026-10-03 (perf audit): 19 full chains ran in one day, median 51 s, longest 12 min. The hourly task and the
// own-folder sweep below still bound how long a protected file can sit unarchived. Previous file:
// backups/hook-backups/scratchpad-guard.mjs.pre-2026-10-03-perf.
const FULL_EVERY_MS = 30 * 60 * 1000;
const TEMP_CLAUDE = 'C:/Users/satoh/AppData/Local/Temp/claude';
const PROTECTED_FILE = /\.(html?|pdf|xlsx|xlsm|xls|docx?|svg)$/i;

function holdsProtected(dir, depth = 0, filesOnly = false) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) if (e.isFile() && PROTECTED_FILE.test(e.name)) return true;
  if (filesOnly || depth >= 8) return false;
  for (const e of ents) {
    if (!e.isDirectory() || /^(node_modules|\.git)$/i.test(e.name)) continue;
    // A session-launched Chrome profile holds ~12k icons; only its top level can hold a saved screenshot.
    if (holdsProtected(path.join(dir, e.name), depth + 1, /^chrome-/i.test(e.name))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// The stand-down. Shape and reasoning: the header. The marker names the file; `=1` is not accepted.
// ---------------------------------------------------------------------------------------------------
const STAND_DOWN = /(?:^|[\s;&|(])\s*(?:\$env:)?PHX_DELETE_OK\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s;'"&|)]*))/i;
// Values that authorise nothing in particular — the blanket-off-switch shapes, plus anything too short
// or too wildcard to be a filename. A name must be specific enough that he could only have meant one file.
const VAGUE = /^(|[01]|y|n|yes|no|true|on|ok|okay|go|all|any|every|\*|\.\*|\*\.\*|\.|\/|\\)$/i;

/** Every protected-type path the command names, in any quoting style. */
function protectedFilesIn(cmd) {
  const out = [];
  for (const m of String(cmd).matchAll(/"([^"]+)"|'([^']+)'|([^\s;'"`&|()]+)/g)) {
    const tok = m[1] ?? m[2] ?? m[3];
    // Strip a PowerShell/bash flag value boundary and a trailing comma from a list.
    const clean = tok ? tok.replace(/,$/, '') : '';
    if (clean && PROTECTED_FILE.test(clean)) out.push(clean);
  }
  return out;
}

/**
 * Does this command carry the owner's named yes, for every protected file it touches?
 * Returns { present, value, ok, why } — `why` is what the deny message tells the session.
 */
export function standDown(cmd, env = process.env) {
  const text = String(cmd ?? '');
  const m = STAND_DOWN.exec(text);
  const raw = m ? (m[1] ?? m[2] ?? m[3] ?? '') : (env.PHX_DELETE_OK ?? '');
  const present = Boolean(m) || Boolean(env.PHX_DELETE_OK);
  const value = String(raw).trim();
  if (!present) return { present: false, value: '', ok: false, why: '' };
  if (VAGUE.test(value) || value.length < 5) {
    return {
      present, value, ok: false,
      why: 'PHX_DELETE_OK must NAME the file (at least 5 characters of its filename), not be a blanket "' +
        (value || '<empty>') + '". A blanket off switch is what this guard exists to prevent.',
    };
  }
  // Scan the command WITHOUT the marker: `PHX_DELETE_OK=report.pdf` is itself a token ending in .pdf, so
  // leaving it in counted the yes as one of the files it authorises — which let a marker applying to no
  // real file at all read as "every file matches". Caught by the selftest, 2026-10-06.
  const files = protectedFilesIn(text.replace(STAND_DOWN, ' '));
  if (!files.length) {
    return { present, value, ok: false, why: 'PHX_DELETE_OK was set but the command names no protected file to apply it to.' };
  }
  const needle = value.toLowerCase();
  const unmatched = files.filter((f) => !f.toLowerCase().includes(needle));
  if (unmatched.length) {
    return {
      present, value, ok: false,
      why: `PHX_DELETE_OK names "${value}", but this command also deletes ${unmatched.length} file(s) it does not match: ` +
        unmatched.slice(0, 3).map((f) => path.basename(f)).join(', ') + '. One yes authorises one file.',
    };
  }
  return { present, value, ok: true, why: '', files };
}

/**
 * Copy one file into the archive's flat day folder before an approved delete. Returns the destination,
 * or throws — the caller DENIES on a throw, so an approved delete is never the last copy.
 */
export function archiveBeforeDelete(file, now = new Date()) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const pad = (x) => String(x).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dir = path.join('F:/Claude Scratchpad Archive', ext, day);
  const st = fs.statSync(file);
  let dest = path.join(dir, path.basename(file));
  if (fs.existsSync(dest)) {
    // Same bytes already archived today — nothing to do. Different bytes keep BOTH, as the archiver does.
    const same = fs.statSync(dest).size === st.size && fs.readFileSync(dest).equals(fs.readFileSync(file));
    if (same) return dest;
    const stamp = `${day.replace(/-/g, '')}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const e = path.extname(dest);
    dest = `${dest.slice(0, -e.length)}.v${stamp}${e}`;
    for (let i = 2; fs.existsSync(dest); i++) dest = `${dest.slice(0, -e.length)}.v${stamp}-${i}${e}`;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
  try { fs.utimesSync(dest, st.atime, st.mtime); } catch {}
  try { fs.chmodSync(dest, 0o444); } catch {}
  if (fs.statSync(dest).size !== st.size) throw new Error(`archive copy is ${fs.statSync(dest).size} bytes, source is ${st.size}`);
  return dest;
}

if (mode === 'sweep') {
  try {
    const input = readStdin();
    let due = true;
    try { due = Date.now() - fs.statSync(STAMP).mtimeMs >= FULL_EVERY_MS; } catch {}
    if (due) {
      try { fs.writeFileSync(STAMP, `${new Date().toISOString()}  ${input.hook_event_name ?? 'sweep'}\n`); } catch {}
      spawn(process.execPath, [ARCHIVER, '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      const sid = String(input.session_id ?? '');
      let own = [];
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
        try { own = fs.readdirSync(TEMP_CLAUDE).map((p) => path.join(TEMP_CLAUDE, p, sid)).filter((d) => holdsProtected(d)); } catch {}
      }
      if (own.length) {
        const code = `import(${JSON.stringify(`file:///${ARCHIVER}`)}).then((m) => m.sweep({ only: ${JSON.stringify(own)}, skipChrome: true }))` +
          `.catch((e) => require('fs').appendFileSync(${JSON.stringify(LOG)}, new Date().toISOString() + '  guard: own-folder sweep failed: ' + e.message + '\\n'))`;
        spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    }
  } catch (e) { logLine(`could not start background sweep: ${e.message}`); }
  process.exit(0);
}

if (mode === 'pre') {
  try {
    const input = readStdin();
    const cmd = String(input?.tool_input?.command ?? '');
    const deletes = DELETE_VERB.test(cmd);
    const wipes = GIT_WIPE.test(cmd);
    if (!deletes && !wipes) process.exit(0);

    if (deletes && (ARCHIVE_PATH.test(cmd) || HIRING_POSTS.test(cmd) || PROTECTED_EXT.test(cmd))) {
      // The archive and Hiring Posts are absolute — no yes of his reaches them, by his own wording.
      const absolute = ARCHIVE_PATH.test(cmd) || HIRING_POSTS.test(cmd);
      const yes = absolute ? { present: false, ok: false, why: '' } : standDown(cmd, process.env);

      if (yes.ok) {
        // His named yes. Archive every file it covers FIRST; a failure here DENIES (fail closed).
        const copied = [];
        try {
          for (const tok of yes.files) {
            const file = path.isAbsolute(tok) ? tok : path.resolve(String(input.cwd ?? '.'), tok);
            if (!fs.existsSync(file)) continue; // nothing to lose — the delete is a no-op for this one
            copied.push(archiveBeforeDelete(file));
          }
        } catch (e) {
          logLine(`STAND-DOWN REFUSED (archive copy failed) in ${input.cwd ?? '?'}: ${e.message} :: ${cmd.slice(0, 200)}`);
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                'PHX_DELETE_OK named this file, but it could not be copied into F:/Claude Scratchpad Archive first — ' +
                `${e.message}. An approved delete must never take the last copy with it, so this one step fails closed. ` +
                'Copy the file into the archive by hand, then run the delete again.',
            },
          }));
          process.exit(0);
        }
        logLine(`STAND-DOWN ALLOWED (PHX_DELETE_OK="${yes.value}") in ${input.cwd ?? '?'}: archived ${copied.length} ` +
          `[${copied.map((c) => path.basename(c)).join(', ')}] :: ${cmd.slice(0, 200)}`);
        process.exit(0);
      }

      logLine(`DENIED in ${input.cwd ?? '?'}${yes.present ? ' (stand-down rejected: ' + yes.why + ')' : ''}: ${cmd.slice(0, 300)}`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'OWNER RULE (2026-09-14, narrowed 2026-09-20, extended 2026-10-02): never delete HTML, PDF, XLSX/XLSM/XLS, DOCX/DOC or SVG files, ' +
            'and never touch F:/Claude Scratchpad Archive or F:/Hiring Posts (every hiring post ever made, EVERY format, images included). ' +
            'Leave the file where it is (or move it aside), and do not look for another way to delete it. If a delete is genuinely needed, ask the owner in chat first.' +
            (absolute
              ? ' F:/Claude Scratchpad Archive and F:/Hiring Posts have NO stand-down — nothing deletes from them.'
              : yes.present
                ? ` The stand-down did not apply: ${yes.why}`
                : ' ONCE HE HAS SAID YES IN CHAT for this specific file, and only then, the delete runs as' +
                  ' `PHX_DELETE_OK=<filename> <the same command>` (`$env:PHX_DELETE_OK=\'<filename>\'; <the same command>`' +
                  ' in PowerShell). Without his yes in this conversation that marker is the thing you must not reach for.'),
        },
      }));
      process.exit(0);
    }

    // Some other delete. If it can reach a scratchpad, archive that scratchpad first, then let it run.
    // Scoped, because a full walk is ~8s and this runs before the command.
    const cwd = String(input.cwd ?? '');
    const SCRATCH = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+[\\/]+AppData[\\/]+Local[\\/]+Temp[\\/]+claude[\\/]+[^\\/\s"'`]+[\\/]+[^\\/\s"'`]+/gi;
    const dirs = [...`${cmd}\n${cwd}`.matchAll(SCRATCH)].map((m) => m[0]);
    const touchesScratch = dirs.length || /scratchpad|temp[\\/]+claude|scratch-workspaces/i.test(cmd);
    if (touchesScratch) {
      const { sweep } = await import(`file:///${ARCHIVER}`);
      // Chrome-profile icons (~70k entries) are walked only when the command targets a chrome-* folder;
      // the Stop and hourly sweeps always cover them.
      const skipChrome = !/chrome-/i.test(cmd);
      sweep(dirs.length ? { only: [...new Set(dirs)], skipChrome } : { skipChrome });
    }

    // Same for a git repository: archive the repository (or worktree) the command or its folder touches.
    const { repoFor, sweepRepos, verify } = await import(`file:///${REPO_ARCHIVER}`);
    const places = [cwd, ...[...cmd.matchAll(/"([A-Za-z]:[\\/][^"]*)"|'([A-Za-z]:[\\/][^']*)'|([A-Za-z]:[\\/][^\s"'`;|&)]*)/g)].map((m) => m[1] ?? m[2] ?? m[3])];
    const task = cmd.match(/new-session\.mjs[^\n]*--remove\s+["']?([\w.-]+)/i)?.[1];
    const repos = new Map();
    for (const p of places.filter(Boolean)) {
      const r = repoFor(p);
      if (r) repos.set(r.dir.toLowerCase(), r);
      // new-session.mjs --remove <task> deletes the sibling worktree _wt-<task>.
      if (r && task) { const wt = repoFor(path.join(path.dirname(r.main), `_wt-${task}`)); if (wt) repos.set(wt.dir.toLowerCase(), wt); }
    }
    if (repos.size) sweepRepos({ only: [...repos.values()] });

    // ── AND THEN: IS EVERY DOCUMENT IN THAT TREE ACTUALLY HELD? ────────────────────────────────
    //
    // The sweep above copies what is new. It cannot tell you whether the copies are still there —
    // and a path out of the index is not evidence that they are. On 2026-10-09 a session about to
    // remove a worktree checked exactly that, looked under a path the archive has never used
    // (<ext>/_repos/, where the real one is _by-source/<ext>/_repos/), read back nothing, and
    // reported that the repository half of this guard had never archived a single document in its
    // life. It had archived 1,666. That reading was wrong in the harmless direction; the same
    // blindness the other way round is a worktree removed while a document in it is held NOWHERE,
    // and nothing would ever have said so.
    //
    // verify() answers by CONTENT, which is the only honest answer: the copy may sit in a day
    // folder under another name, as 332 of them did. Only wipes pay for it — a per-file delete is
    // handled above — and after the sweep the usual answer needs no archive walk at all, about a
    // second, because verify re-records each copy where it actually is.
    //
    // FAIL OPEN on an error (the catch below), FAIL CLOSED on a finding. A bug in this check must
    // never stop him removing a worktree; a document that exists in one place in the world must
    // never be taken by a command that was not even about that document.
    if (wipes && repos.size) {
      // afterSweep: the index and file lists the sweep above just read, not a second read of both.
      const held = verify({ only: [...repos.values()], quiet: true, afterSweep: true });
      if (held.lost.length > 0) {
        const names = held.lost.slice(0, 8).map((l) => l.file);
        logLine(`WIPE DENIED in ${input.cwd ?? '?'}: ${held.lost.length} unarchived document(s) ` +
          `[${names.join(', ')}] :: ${cmd.slice(0, 200)}`);
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `This command destroys working-tree files, and ${held.lost.length} protected document(s) in that ` +
              'repository are held NOWHERE ELSE — not at their own path in F:/Claude Scratchpad Archive, and not ' +
              'anywhere else in it under any name (checked by content, not by path): ' +
              names.join(', ') + (held.lost.length > names.length ? `, and ${held.lost.length - names.length} more` : '') +
              '. Running it takes the last copy. Archive them first with `node ~/.claude/scripts/repo-archive.mjs`, ' +
              'then `node ~/.claude/scripts/repo-archive.mjs --verify --repo <the repository>` must report 0 LOST, ' +
              'and this command goes through. If the documents are meant to go, ask the owner in chat first.',
          },
        }));
        process.exit(0);
      }
    }
  } catch (e) {
    if (e?.[Symbol.for('phx.hook-exit')]) throw e; // an exit above ended this hook (hook-dispatch.mjs)
    logLine(`pre-hook error (failed open): ${e.message}`);
  }
  process.exit(0);
}

if (mode === 'selftest') {
  const { spawnSync } = await import('child_process');
  const os = await import('os');
  let failed = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) console.log(`  pass  ${name}`);
    else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  };

  // A fixture that is NOT deleted and NOT regenerated: the hook only decides, it never runs the command.
  const fixtureDir = path.join(os.tmpdir(), 'phx-delete-guard-selftest');
  const fixture = path.join(fixtureDir, 'phx-delete-guard-selftest-fixture.pdf');
  fs.mkdirSync(fixtureDir, { recursive: true });
  if (!fs.existsSync(fixture)) fs.writeFileSync(fixture, '%PDF-1.4\n% delete-guard selftest fixture\n');

  /** Run the REAL pre hook and report its decision — the emitted artifact, not the source. */
  const decide = (command, cwd = fixtureDir) => {
    const r = spawnSync(process.execPath, [process.argv[1], 'pre'], {
      input: JSON.stringify({ tool_input: { command }, cwd, hook_event_name: 'PreToolUse' }),
      encoding: 'utf8',
    });
    const out = String(r.stdout ?? '').trim();
    if (!out) return { decision: 'allow', reason: '' };
    try {
      const j = JSON.parse(out);
      return { decision: j.hookSpecificOutput?.permissionDecision ?? 'allow', reason: j.hookSpecificOutput?.permissionDecisionReason ?? '' };
    } catch { return { decision: 'allow', reason: out }; }
  };

  console.log('standDown() — the marker must name the file');
  ok('no marker at all',            standDown('rm "a/report.pdf"').ok === false);
  ok('=1 is refused',              standDown('PHX_DELETE_OK=1 rm "a/report.pdf"').ok === false);
  ok('=1 says why',                /must NAME the file/i.test(standDown('PHX_DELETE_OK=1 rm "a/report.pdf"').why));
  ok('=yes is refused',            standDown('PHX_DELETE_OK=yes rm "a/report.pdf"').ok === false);
  ok('=all is refused',            standDown('PHX_DELETE_OK=all rm "a/report.pdf"').ok === false);
  ok('=* is refused',              standDown('PHX_DELETE_OK=* rm "a/report.pdf"').ok === false);
  ok('empty value is refused',     standDown("PHX_DELETE_OK='' rm \"a/report.pdf\"").ok === false);
  ok('4 chars is too short',       standDown('PHX_DELETE_OK=rep rm "a/report.pdf"').ok === false);
  ok('a real name is accepted',    standDown('PHX_DELETE_OK=report.pdf rm "a/report.pdf"').ok === true);
  ok('quoted name is accepted',    standDown('PHX_DELETE_OK="report.pdf" rm "a/report.pdf"').ok === true);
  ok('$env: form is accepted',     standDown('$env:PHX_DELETE_OK=\'report.pdf\'; Remove-Item "a/report.pdf"').ok === true);
  ok('a name matching nothing',    standDown('PHX_DELETE_OK=invoice.pdf rm "a/report.pdf"').ok === false);
  ok('no protected file named',    standDown('PHX_DELETE_OK=report.pdf rm "a/notes.txt"').ok === false);
  ok('one yes, two files',         standDown('PHX_DELETE_OK=report.pdf rm "a/report.pdf" "a/other.pdf"').ok === false);
  ok('two files it says so',       /also deletes 1 file/i.test(standDown('PHX_DELETE_OK=report.pdf rm "a/report.pdf" "a/other.pdf"').why));
  ok('both copies of one name',    standDown('PHX_DELETE_OK=report.pdf rm "a/report.pdf" "b/report.pdf"').ok === true);
  // The marker is itself a .pdf token. Counting it as one of the covered files made a yes that names no
  // real file read as "all files match" — so a marker plus a directory delete sailed through.
  ok('the marker is not a file',   standDown('PHX_DELETE_OK=report.pdf rm -rf "a/somedir"').ok === false);
  ok('nor is it the only match',   (standDown('PHX_DELETE_OK=report.pdf rm "a/report.pdf"').files ?? []).length === 1);

  console.log('the pre hook — what it actually emits');
  ok('a PDF delete is denied',     decide('rm "./phx-delete-guard-selftest-fixture.pdf"').decision === 'deny');
  const plain = decide('rm "./phx-delete-guard-selftest-fixture.pdf"').reason;
  ok('the deny names the hatch',   /PHX_DELETE_OK=<filename>/.test(plain), plain.slice(0, 120));
  ok('a bare =1 is still denied',  decide('PHX_DELETE_OK=1 rm "./phx-delete-guard-selftest-fixture.pdf"').decision === 'deny');
  ok('a wrong name is denied',     decide('PHX_DELETE_OK=somethingelse.pdf rm "./phx-delete-guard-selftest-fixture.pdf"').decision === 'deny');
  ok('a .txt delete is allowed',   decide('rm "./scratch-notes.txt"').decision === 'allow');

  // The two absolute folders: his yes does not reach them.
  const arch = decide('PHX_DELETE_OK=phx-delete-guard-selftest-fixture.pdf rm "F:/Claude Scratchpad Archive/pdf/2026-10-06/phx-delete-guard-selftest-fixture.pdf"');
  ok('the ARCHIVE is absolute',    arch.decision === 'deny');
  ok('and says it has no hatch',   /NO stand-down/.test(arch.reason), arch.reason.slice(0, 120));
  const hire = decide('PHX_DELETE_OK=phx-delete-guard-selftest-fixture.pdf rm "F:/Hiring Posts/phx-delete-guard-selftest-fixture.pdf"');
  ok('Hiring Posts is absolute',   hire.decision === 'deny');

  // The named yes, end to end — and the archive copy it must make first.
  const allowed = decide(`PHX_DELETE_OK=phx-delete-guard-selftest-fixture.pdf rm "${fixture.split(path.sep).join('/')}"`);
  ok('his named yes is allowed',   allowed.decision === 'allow', allowed.reason.slice(0, 160));
  const day = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const copy = `F:/Claude Scratchpad Archive/pdf/${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}/phx-delete-guard-selftest-fixture.pdf`;
  ok('it archived the file first', fs.existsSync(copy), `expected ${copy}`);
  ok('and the copy is identical',  fs.existsSync(copy) && fs.readFileSync(copy).equals(fs.readFileSync(fixture)));

  console.log(`\n${failed} failed`);
  process.exit(failed ? 1 : 0);
}
