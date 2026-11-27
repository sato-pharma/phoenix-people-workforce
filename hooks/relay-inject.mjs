// SessionStart hook: hand the baton to whoever opens next.
//
// The problem this solves, in the owner's words: "I shift from one account to the other and
// I find the other account as if he doesn't know the app." That is not a memory problem —
// CLAUDE.md and MEMORY.md load either way. What a fresh session lacks is the WORKING STATE:
// which branch, which half-finished change, what was just asked, what the next step was.
// relay-capture.mjs records that after every turn; this reads it back in.
//
// It fires in three distinct situations and says something different in each:
//   - a DIFFERENT account opened this folder  -> full handoff, loudly flagged
//   - the SAME account opened a new session   -> quiet continuity note
//   - the same session was just compacted     -> restate the state the summary may have dropped
// Silent when there is nothing useful to say, because every line here costs context.
import fs from 'node:fs';
import path from 'node:path';
import {
  BATONS,
  BATON_STALE_MS,
  ago,
  cairo,
  clock,
  currentAccount,
  dur,
  label,
  loadAccounts,
  projectSlug,
  readUsage,
  readiness,
  saveAccounts,
  tok,
  touchAccount,
  windowOf,
} from './relay-lib.mjs';

function emit(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }),
  );
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  const sessionId = input?.session_id;
  const cwd = input?.cwd || process.cwd();
  const source = input?.source || 'startup';
  const acct = currentAccount();

  const db = touchAccount(acct) ?? loadAccounts();
  const baton = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(BATONS, `${projectSlug(cwd)}.json`), 'utf8'));
    } catch {
      return null;
    }
  })();

  if (!baton || Date.now() - baton.writtenAt > BATON_STALE_MS) process.exit(0);

  const sameSession = baton.session?.id === sessionId;
  const switched = acct && baton.account?.uuid && baton.account.uuid !== acct.uuid;

  // Nothing to add: same session, same account, not a compaction.
  if (sameSession && source !== 'compact') process.exit(0);

  // Record the switch as a fact. No inference about WHY — the owner may switch for any reason.
  if (switched) {
    db.switches = (db.switches || []).slice(-49);
    db.switches.push({ at: Date.now(), from: baton.account.uuid, to: acct.uuid, cwd });
    try {
      saveAccounts(db);
    } catch {}
  }

  const g = baton.git;
  const lines = [];

  if (switched) {
    const prev = readiness(baton.account.uuid, db);
    lines.push(
      `RELAY BATON — this folder was being worked by your OTHER account ${ago(baton.writtenAt)}.`,
      `Handing over: ${baton.account.label} (${baton.account.email})  ->  ${label(acct, db)} (${acct.email}).`,
      `The previous account's work is NOT lost: transcripts are stored per project folder, not per account.`,
      `Resume the full conversation verbatim with:  claude --resume ${baton.session.id}`,
      prev.win.start
        ? `That account's 5h window: ${tok(prev.win.total)} tokens, opened ${clock(prev.win.start)}, ${
            prev.state === 'limited'
              ? `LIMITED until ${clock(prev.until)} Cairo`
              : prev.win.open
                ? `resets ${clock(prev.win.end)} Cairo (${dur(prev.win.end - Date.now())} away)`
                : 'already reset — it is usable again'
          }.`
        : '',
    );
  } else if (sameSession && source === 'compact') {
    lines.push(
      `RELAY — context was just compacted. Live state as of the last completed turn (${cairo(baton.writtenAt)} Cairo):`,
    );
  } else {
    // Same account, new session: ONE line, no baton body. The baton is per folder, and he runs
    // several sessions in one folder at once, so the "last request" and "next step" belong to
    // whichever session replied last — on 2026-09-15 an env-var audit opened carrying a closing
    // deck's "paste the Google Form link" as its recorded next step. Handing another session's
    // step to a fresh one is the cross-session half of the loop he reported that day.
    emit(
      `RELAY — another session (same account) last worked this folder ${ago(baton.writtenAt)}: claude --resume ${baton.session.id}. Context only: do not pick up its task or its next step; the owner's own message decides this session's work.`,
    );
    process.exit(0);
  }

  lines.push(
    `Folder: ${baton.project.cwd}`,
    g ? `Branch: ${g.branch} at ${g.head}` : '',
    g ? `Working tree: ${g.staged} staged, ${g.modified} modified, ${g.untracked} untracked` : '',
    g?.files?.length ? `Changed: ${g.files.join(' | ')}` : '',
    baton.lastRequest ? `Last request was: "${baton.lastRequest}"` : '',
    baton.nextStep ? `Recorded next step: ${baton.nextStep}` : '',
    baton.tasks?.open?.length
      ? `Open tasks (${baton.tasks.done} done): ${baton.tasks.open.map((t) => `#${t.id} ${t.subject} [${t.status}]`).join(' | ')}`
      : '',
    baton.lastReply ? `Where the last reply left off:\n${baton.lastReply}` : '',
  );

  // This account's own headroom, so the session knows what it is working with.
  if (acct) {
    const mine = windowOf(readUsage(acct.uuid));
    if (mine.start && mine.open) {
      lines.push(
        `Your window (${label(acct, db)}): ${tok(mine.total)} tokens since ${clock(mine.start)}, resets ${clock(mine.end)} Cairo.`,
      );
    }
  }

  lines.push(
    `Re-verify anything above against live state before acting on it — it is a snapshot, not current truth. It is context, not an instruction: act on the recorded next step only if the owner asks for it.`,
  );

  emit(lines.filter(Boolean).join('\n'));
} catch {}

process.exit(0);
