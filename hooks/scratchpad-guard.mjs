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

// 2026-11-16 (owner: "fix the gap") — a delete word straight after a quote mark was invisible: `bash -c 'rm a.pdf'`,
// `ssh box "del report.docx"`, `os.system('rm a.pdf')`, `execSync("rm " + f)`, and the argument-list form
// `subprocess.run(["rm", "a.pdf"])` / `spawn('rm', [f])`. A quote now opens a delete like a space does, but only
// when the word is followed by a space (`'rm -f x'`), never the bare word in quotes (`"rm"` in prose); the argument
// list is ARGV_DELETE: the word as a whole quoted string followed by a comma.
const ARGV_DELETE = /"(?:rm|del|erase|rmdir|rd|unlink|shred|rimraf|trash|Remove-Item)"\s*,|'(?:rm|del|erase|rmdir|rd|unlink|shred|rimraf|trash|Remove-Item)'\s*,/i;
const DELETE_VERB = new RegExp(String.raw`(^|[\s;&|(` + '`' + String.raw`{'"])(rm|del|erase|rmdir|rd|ri|unlink|shred|rimraf|trash|Remove-Item|Clear-RecycleBin)(?=$|[\s;&|)}])|git\s+clean\b|\.(rmSync|unlinkSync|rmdirSync|unlink|rm)\s*\(|\[(System\.)?IO\.(File|Directory)\]::Delete|robocopy\b[^\n]*\/(MIR|PURGE)\b|\bdel\s*\/|Remove-Item|` + ARGV_DELETE.source, 'i');
// DELETE_VERB split in two (2026-11-16). A SHELL delete is judged by the statement it sits in; an IN-CODE delete
// (a script, git clean, robocopy) can carry its target in a variable the guard cannot follow, so it is still judged
// by the whole command, exactly as before.
const SHELL_DELETE = /(^|[\s;&|(`{'"])(rm|del|erase|rmdir|rd|ri|unlink|shred|rimraf|trash|Remove-Item|Clear-RecycleBin)(?=$|[\s;&|)}])|\bdel\s*\/|Remove-Item/i;
const IN_CODE_DELETE = /git\s+clean\b|\.(rmSync|unlinkSync|rmdirSync|unlink|rm)\s*\(|\[(System\.)?IO\.(File|Directory)\]::Delete|robocopy\b[^\n]*\/(MIR|PURGE)\b/i;
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

// ---------------------------------------------------------------------------------------------------
// WHICH FILES DOES THE DELETE ITSELF NAME? (2026-11-16)
//
// Until today a command was denied when a delete word appeared ANYWHERE in it and a protected name appeared
// ANYWHERE in it. So `rm -f p1.png p2.png && python -c "<render pages>" "<the company register>.pdf"` — four
// throwaway images deleted, the PDF only READ — was refused at 12:28 Cairo on 16 Nov, and the guard's log shows
// the same shape four times in the three days before (a temp test file removed after a script that read a PDF
// or wrote an HTML). The owner's rule is about what is DELETED, so a shell delete is now judged by its own
// statement: split at && || ; and newlines, never inside quotes or brackets, with heredoc and here-string bodies
// split on their own. A pipe is NOT a split (`ls *.pdf | xargs rm` stays one statement), and a variable the
// delete uses is followed back to wherever the command sets it (`F=a.pdf; rm "$F"`, `for f in *.pdf`,
// `$f = 'a.pdf'; Remove-Item $f`, `... | while read f`). Everything else here is unchanged.
// ---------------------------------------------------------------------------------------------------

/** Split one stretch of shell text into statements, respecting quotes, brackets and escapes. */
function splitStatements(s) {
  const out = [];
  let cur = '', q = '', depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const two = s.slice(i, i + 2);
      if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
      if (c === ';' || c === '\n') { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** A statement's text outside quotes, and the contents of each quoted string in it. */
function splitQuotes(s) {
  let outside = '', q = '', buf = '';
  const quoted = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < s.length) { buf += c + s[++i]; continue; }
      if (c === q) { quoted.push(buf); buf = ''; q = ''; outside += ' '; continue; }
      buf += c; continue;
    }
    if (c === '\\' && i + 1 < s.length) { outside += c + s[++i]; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    outside += c;
  }
  if (q) quoted.push(buf); // an unclosed quote: still judge what is in it
  return { outside, quoted };
}

/** Every statement in the command — the command's own, and each heredoc / here-string body's, split apart. */
export function statementsOf(cmd) {
  const lines = String(cmd ?? '').replace(/\r/g, '').replace(/\\\n|`\n/g, ' ').split('\n');
  const main = [], bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    main.push(line);
    const here = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
    const ps = /@(['"])\s*$/.exec(line);
    let end = null;
    if (here) end = (l) => l.trim() === here[2];
    else if (ps) end = (l) => l.trimStart().startsWith(`${ps[1]}@`);
    if (!end) continue;
    const body = [];
    for (i++; i < lines.length && !end(lines[i]); i++) body.push(lines[i]);
    bodies.push(body.join('\n'));
    if (i < lines.length) main.push(lines[i]); // the closing line may carry more of the command ('@ | Out-File …)
  }
  return [main.join('\n'), ...bodies].flatMap(splitStatements).map((x) => x.trim()).filter(Boolean);
}

const VAR_REF = /\$\{?([A-Za-z_]\w*)\}?|\$env:([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/gi;
const varsIn = (seg) => [...seg.matchAll(VAR_REF)].map((m) => (m[1] ?? m[2] ?? m[3]).toLowerCase());
/** The variables a statement sets: NAME=…, $name = …, $env:NAME=…, set NAME=…, for NAME in …, foreach ($NAME in …), read NAME. */
function varsSetBy(seg) {
  const out = [];
  for (const m of seg.matchAll(/(?:^|[\s;(])(?:export\s+|local\s+|set\s+|declare\s+(?:-\w+\s+)*)?\$(?:env:)?([A-Za-z_]\w*)\s*=(?!=)|(?:^|[\s;(])(?:export\s+|local\s+|set\s+|declare\s+(?:-\w+\s+)*)?([A-Za-z_]\w*)=(?!=)/gi)) out.push(m[1] ?? m[2]);
  for (const m of seg.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b|\bforeach\s*\(\s*\$([A-Za-z_]\w*)\s+in\b|\bread\s+(?:-\w+\s+)*([A-Za-z_]\w*)/gi)) out.push(m[1] ?? m[2] ?? m[3]);
  return out.map((v) => v.toLowerCase());
}

/**
 * Does this command delete a protected file? Returns { hit, scope } — `scope` is the text whose protected
 * names the delete reaches, which is what the stand-down must match (not every file the command reads).
 */
export function deletesProtected(cmd) {
  const text = String(cmd ?? '');
  if (!PROTECTED_EXT.test(text)) return { hit: false, scope: '' };
  if (IN_CODE_DELETE.test(text)) return { hit: true, scope: text };
  // The argument-list form: judge the list itself. A document named in it is a hit; a list that is not all
  // literal strings (`spawn('rm', ['-f', p])`) can carry one in a variable, so it is judged by the whole command.
  for (const m of text.matchAll(new RegExp(ARGV_DELETE.source, 'gi'))) {
    const rest = text.slice(m.index + m[0].length);
    const args = rest.slice(0, rest.search(/[\])]|$/));
    if (PROTECTED_EXT.test(args)) return { hit: true, scope: args };
    if (/\w/.test(args.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ''))) return { hit: true, scope: text };
  }
  const segs = statementsOf(text);
  // Variables that can hold a protected name: set in a statement naming one, or set from such a variable.
  const tainted = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const seg of segs) {
      const sets = varsSetBy(seg);
      if (!sets.length) continue;
      if (!PROTECTED_EXT.test(seg) && !varsIn(seg).some((v) => tainted.has(v))) continue;
      for (const v of sets) if (!tainted.has(v)) { tainted.add(v); grew = true; }
    }
  }
  const names = (s) => PROTECTED_EXT.test(s) || varsIn(s).some((v) => tainted.has(v));
  const reaches = (seg) => {
    if (!SHELL_DELETE.test(seg)) return false;
    const { outside, quoted } = splitQuotes(seg);
    if (SHELL_DELETE.test(outside)) return names(seg);
    // The delete word is only inside a quoted string — a script handed to python, node, bash -c, ssh. Judge that
    // script by ITS statements (Python's own `del x` is not a file delete); a statement that deletes through a
    // positional argument (`bash -c 'rm "$1"' _ a.pdf`, `xargs -I{}`) is judged by the whole statement around it.
    // A delete command BUILT inside the script — `os.system('rm ' + p)`, `execSync(\`rm ${f}\`)`, `'rm %s' % p` — names
    // its file in the script's own variable, which no shell reading can follow: judged by the whole statement too.
    const built = (st) => /[`'"]\s*(rm|del|erase|rmdir|rd|ri|unlink|shred|rimraf|trash|Remove-Item)\s/i.test(st) &&
      /\+|\$\{|%s|%\(|\.format\(|\bf['"]|\$\w|,/.test(st);
    return quoted.some((inner) => statementsOf(inner).some((st) => SHELL_DELETE.test(st) &&
      (names(st) || ((/\$[\d@*]|\{\}|%\d|%~/.test(st) || built(st)) && names(seg)))));
  };
  const reached = segs.filter(reaches);
  if (!reached.length) return { hit: false, scope: '' };
  // A delete through a variable reaches the statement that set it — hand the stand-down the whole command.
  return { hit: true, scope: reached.every((seg) => PROTECTED_EXT.test(seg) && !varsIn(seg).some((v) => tainted.has(v))) ? reached.join('\n') : text };
}

/**
 * Does this command carry the owner's named yes, for every protected file it touches?
 * Returns { present, value, ok, why } — `why` is what the deny message tells the session.
 * `scope` (2026-11-16): the part of the command the delete reaches; files only READ elsewhere are not counted.
 */
export function standDown(cmd, env = process.env, scope = cmd) {
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
  const files = protectedFilesIn(String(scope ?? text).replace(STAND_DOWN, ' '));
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

    // The archive and Hiring Posts stay judged by the WHOLE command (a `cd` into either makes any delete
    // reach it); a protected file type is judged by what the delete itself names (deletesProtected above).
    const doc = deletes ? deletesProtected(cmd) : { hit: false, scope: '' };
    if (deletes && (ARCHIVE_PATH.test(cmd) || HIRING_POSTS.test(cmd) || doc.hit)) {
      // The archive and Hiring Posts are absolute — no yes of his reaches them, by his own wording.
      const absolute = ARCHIVE_PATH.test(cmd) || HIRING_POSTS.test(cmd);
      const yes = absolute ? { present: false, ok: false, why: '' } : standDown(cmd, process.env, doc.scope || cmd);

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
    // Git Bash spells the same folders /c/Users/... and /tmp/... (cygpath: /tmp IS %TEMP%). Unread, those
    // fell to the FULL walk of every scratchpad below — 214 times in three days to 2026-11-06. Read here as the
    // C:/... form they are, so they get the same one-folder sweep. $TMPDIR is left alone: it is not
    // %TEMP% in every session, and a wrong guess would sweep the wrong folder instead of every folder.
    const TEMP_DIR = String(process.env.TEMP ?? '').replace(/\\/g, '/');
    const asWindows = input.tool_name === 'PowerShell' ? cmd : cmd
      .replace(/(^|[\s"'`=(;|&])\/tmp(?=\/)/g, (m, lead) => (TEMP_DIR ? lead + TEMP_DIR : m))
      .replace(/(^|[\s"'`=(;|&])\/([A-Za-z])(?=\/)/g, '$1$2:');
    const dirs = [...`${asWindows}\n${cwd}`.matchAll(SCRATCH)].map((m) => m[0]);
    const touchesScratch = dirs.length || /scratchpad|temp[\\/]+claude|scratch-workspaces/i.test(cmd);
    if (touchesScratch) {
      const { sweep } = await import(`file:///${ARCHIVER}`);
      // Chrome-profile icons (~70k entries) are walked only when the command targets a chrome-* folder;
      // the Stop and hourly sweeps always cover them.
      const skipChrome = !/chrome-/i.test(cmd);
      sweep(dirs.length ? { only: [...new Set(dirs)], skipChrome, quiet: true } : { skipChrome, quiet: true });
    }

    // Same for a git repository: archive the repository (or worktree) the command or its folder touches.
    const { repoFor, sweepRepos, verify, archiveUnlocked } = await import(`file:///${REPO_ARCHIVER}`);
    // asWindows, so a repository named as /c/... is archived too, as its C:/... spelling always was.
    const places = [cwd, ...[...asWindows.matchAll(/"([A-Za-z]:[\\/][^"]*)"|'([A-Za-z]:[\\/][^']*)'|([A-Za-z]:[\\/][^\s"'`;|&)]*)/g)].map((m) => m[1] ?? m[2] ?? m[3])];
    const task = cmd.match(/new-session\.mjs[^\n]*--remove\s+["']?([\w.-]+)/i)?.[1];
    const repos = new Map();
    for (const p of places.filter(Boolean)) {
      const r = repoFor(p);
      if (r) repos.set(r.dir.toLowerCase(), r);
      // new-session.mjs --remove <task> deletes the sibling worktree _wt-<task>.
      if (r && task) { const wt = repoFor(path.join(path.dirname(r.main), `_wt-${task}`)); if (wt) repos.set(wt.dir.toLowerCase(), wt); }
    }
    // Another sweep holding the lock used to mean nothing was archived before the delete (2026-11-06,
    // ~100 times in two days). Now the new and changed documents are copied anyway, without the index.
    let unlocked = null;
    if (repos.size && sweepRepos({ only: [...repos.values()], quiet: true }) === null) unlocked = archiveUnlocked({ only: [...repos.values()] });
    if (wipes && unlocked?.failed.length) {
      const names = unlocked.failed.slice(0, 8).map((f) => path.basename(f.src));
      logLine(`WIPE DENIED in ${input.cwd ?? '?'}: ${unlocked.failed.length} document(s) could not be copied while another sweep ran ` +
        `[${names.join(', ')}] :: ${cmd.slice(0, 200)}`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `This command destroys working-tree files, and ${unlocked.failed.length} protected document(s) in that repository ` +
            'could not be copied into F:/Claude Scratchpad Archive first (another archive sweep was running, so the guard copied ' +
            `them itself, and these copies failed): ${names.join(', ')}` +
            (unlocked.failed.length > names.length ? `, and ${unlocked.failed.length - names.length} more` : '') +
            `. First error: ${unlocked.failed[0].error}. Run the same command again in a minute, once the sweep has finished.`,
        },
      }));
      process.exit(0);
    }

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

  // 2026-11-16 — the delete is judged by what IT names. The first case is the command refused at 12:28 Cairo.
  console.log('a delete is judged by what it names, not by every file the command reads');
  const allow = (name, c) => { const d = decide(c); ok(name, d.decision === 'allow', d.reason.slice(0, 100)); };
  const deny = (name, c) => { const d = decide(c); ok(name, d.decision === 'deny', 'was allowed'); };
  allow('PNGs deleted, PDF only read (16 Nov)', 'cd "C:/nowhere/pad" && rm -f p1.png p2.png && python -I -c "\nimport pymupdf,sys\nd=pymupdf.open(sys.argv[1])\ndel d\n" "C:/nowhere/سجل تجاري ١٩-١٠-٢٠٢٦.pdf"; ls');
  allow('temp test removed after a heredoc naming a PDF', "cat > t.tmp.mjs <<'EOF'\n// don't reopen report.pdf (it's big)\nconsole.log(1)\nEOF\nnode t.tmp.mjs && rm t.tmp.mjs");
  allow('a variable that holds no document', 'SP="C:/nowhere/pad" && rm -f "$SP/p1.png" && python -c "print(1)" "$SP/report.pdf"');
  allow('PowerShell: image removed, HTML read', "Remove-Item C:/nowhere/a.png; Get-Content C:/nowhere/page.html");
  deny('a PDF among the deleted images',        'rm -f p1.png report.pdf && ls');
  deny('a delete through a variable',           'F=report.pdf; rm "$F"');
  deny('a variable set from a variable',        'A=report.pdf && B=$A && rm -f "$B"');
  deny('PowerShell delete through a variable',  "$f = 'C:/nowhere/report.pdf'; Remove-Item $f");
  deny('a for loop over PDFs',                  'for f in *.pdf; do rm "$f"; done');
  deny('read loop over PDFs',                   'ls *.pdf | while read f; do rm "$f"; done');
  deny('xargs over PDFs',                       'ls *.pdf | xargs rm');
  deny('find -exec rm over PDFs',               'find . -name "*.pdf" -exec rm {} \\;');
  deny('Get-ChildItem PDFs into Remove-Item',   'Get-ChildItem -Filter *.pdf | Remove-Item');
  deny('PowerShell foreach over PDFs',          'foreach ($x in Get-ChildItem *.pdf) { Remove-Item $x }');
  deny('a Remove-Item list over several lines', "Remove-Item -Path @(\n  'a.png',\n  'report.pdf'\n)");
  deny('a delete continued onto the next line', 'rm -f \\\n  report.pdf');
  deny('a delete inside a bash heredoc',        "bash <<'EOF'\nrm report.pdf\nEOF");
  deny('an in-code delete, name as argument',   "node -e \"require('fs').unlinkSync(process.argv[1])\" report.pdf");
  deny('rm with a substituted list',            'rm $(ls *.pdf)');
  deny('bash -c delete of a named PDF',         "bash -c 'cd /x && rm -f report.pdf'");

  // 2026-11-16 ("fix the gap") — a delete word straight after a quote mark.
  console.log('a delete written straight after a quote mark');
  deny("bash -c 'rm …'",                        "bash -c 'rm -f report.pdf'");
  deny("bash -c 'rm \"$1\"' _ file",            "bash -c 'rm -f \"$1\"' _ report.pdf");
  deny('ssh "del …"',                           'ssh office "del /q C:/share/report.docx"');
  deny("os.system('rm …') in python -c",        'python -c "import os; os.system(\'rm -f report.pdf\')"');
  deny('os.system built from a variable',       'python -c "import os\np=\'report.pdf\'\nos.system(\'rm -f \' + p)\n"');
  deny('execSync template literal',             "node -e \"const f='report.pdf'; require('child_process').execSync(`rm -f ${f}`)\"");
  deny('subprocess argv list naming a PDF',     'python -c "import subprocess; subprocess.run([\'rm\', \'-f\', \'report.pdf\'])"');
  deny('spawn argv list through a variable',    "node -e \"const p='report.html'; require('child_process').spawnSync('rm', ['-f', p])\"");
  deny("PowerShell -Command 'Remove-Item …'",   "powershell -Command 'Remove-Item C:/x/sheet.xlsx'");
  allow('argv list deleting only images',       'python -c "import subprocess; subprocess.run([\'rm\', \'-f\', \'a.png\'])" C:/nowhere/report.pdf');
  allow("os.system('rm' a png), PDF only read", 'python -c "import os,sys; os.system(\'rm -f a.png\'); print(sys.argv[1])" C:/nowhere/report.pdf');
  allow('the word "rm" in quotes is not a delete', 'echo "use \\"rm\\" carefully" && cat C:/nowhere/report.pdf');
  allow("bash -c 'rm' of an image",             "bash -c 'rm -f a.png' && cat C:/nowhere/report.pdf");
  deny('bash -c delete through $1',             "bash -c 'cd /x && rm -f \"$1\"' _ report.pdf");
  deny('cmd /c del of a named PDF',             'cmd /c "del /q report.pdf"');
  deny('a delete inside a quoted script',       'python -c "\nimport os\nos.system(\'cd /x; rm -f report.pdf\')\n"');
  deny('a .docx and an .xlsx',                  'del /q notes.docx && del sheet.xlsx');
  deny('Hiring Posts stays whole-command',      'cd "F:/Hiring Posts" && rm poster.png');
  // His named yes is not spoiled by a document the same command only reads.
  const yesRead = decide(`PHX_DELETE_OK=phx-delete-guard-selftest-fixture.pdf rm "${fixture.split(path.sep).join('/')}" && python -c "print(1)" C:/nowhere/other.pdf`);
  ok('the yes ignores a PDF only read', yesRead.decision === 'allow', yesRead.reason.slice(0, 160));

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
