#!/usr/bin/env node
// PostCompact: record how long each compaction summary actually came out, so the short-summary rule
// is measured and never assumed. Added 2026-10-09 — the rule went into ~/.claude/CLAUDE.md at 00:30
// Cairo and the next three summaries were 27,212 / 25,201 / 13,603 characters, i.e. no shorter than
// the 19,218-character baseline, and the documentation says only the PROJECT-root CLAUDE.md is
// re-injected from disk after a compaction (the user-level file is not named either way).
//
// 2026-10-09 06:55 Cairo, deep slowness audit: transcripts show the user-level CLAUDE.md IS
// re-injected after every compaction, and the rule was in context for 17 of the 23 compactions
// after 00:30 — they still wrote a median 19,000 characters. `compact_summary` here is the model's
// WHOLE output: the hidden <analysis> block (stripped before the summary lands in the transcript)
// plus the summary — 400 to 11,000 characters more than the transcript copy. The freeze tracks that
// whole output (about 5 s per 1,000 characters), so the rule was rewritten the same morning to cap
// the analysis and replace the nine default sections, and this hook now records each part and the
// template the summary used, so the rewrite is judged by the numbers.
//
// It writes one line per compaction to ~/.claude/logs/compact-summary-length.jsonl and nothing else:
// no stdout (PostCompact stdout reaches no one), no decision, no side effect on the session.
// PostCompact gives `trigger` (auto|manual) and `compact_summary`.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const LOG = path.join(homedir(), '.claude', 'logs', 'compact-summary-length.jsonl');

const read = () =>
  new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
    setTimeout(() => resolve(s), 4000).unref?.();
  });

// Split the model's output into the thrown-away analysis and the summary that is kept. Null when the
// output carries no <analysis> block, so a missing tag is never read as a zero-length analysis.
const split = (text) => {
  const m = text.match(/<analysis>([\s\S]*?)<\/analysis>/i);
  if (!m) return { analysisChars: null, summaryChars: text.length };
  return { analysisChars: m[1].trim().length, summaryChars: text.replace(m[0], '').trim().length };
};

// Which shape did the summary take: the four headings the rule asks for, or the built-in nine.
// Judged on the kept summary only, and the default only by a heading at the start of a line
// ("1. Primary Request and Intent:", "## 1. …", "1. **…:**") — 2026-10-09: a four-heading summary
// that quoted the phrase mid-sentence was tagged default-nine, and the daily slowness check alarms
// on any default-nine summary. Same pattern as DEFAULT_SUMMARY_TEMPLATE in phoenix-workforce's
// scripts/slow-audit.mjs.
const DEFAULT_HEADING =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(?:\d+\.[ \t]*)?(?:\*\*)?(?:Primary Request and Intent|Key Technical Concepts)\b/im;
const template = (whole) => {
  const text = whole.replace(/<analysis>[\s\S]*?<\/analysis>/i, '');
  if (DEFAULT_HEADING.test(text)) return 'default-nine';
  if (/His words/i.test(text) && /Open items/i.test(text) && /Next step/i.test(text)) return 'rule-four';
  return text ? 'other' : null;
};

try {
  const raw = await read();
  let j = {};
  try { j = JSON.parse(raw || '{}'); } catch { /* a shape we do not know is still worth a line */ }
  const summary = typeof j.compact_summary === 'string' ? j.compact_summary : '';
  const parts = split(summary);
  const cairo = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false });
  mkdirSync(path.dirname(LOG), { recursive: true });
  appendFileSync(
    LOG,
    JSON.stringify({
      atCairo: cairo,
      at: new Date().toISOString(),
      trigger: j.trigger ?? null,
      chars: summary.length, // the whole output, analysis included - comparable with older lines
      words: summary ? summary.trim().split(/\s+/).length : 0,
      analysisChars: parts.analysisChars,
      summaryChars: parts.summaryChars,
      template: template(summary),
      sessionId: j.session_id ?? null,
      cwd: j.cwd ?? null,
      // the targets the rule asks for, so a later reader needs no other file to judge the line
      targetChars: 8000,
      ceilingChars: 10000,
      overCeiling: summary.length > 10000,
      summaryOverCeiling: parts.summaryChars > 10000,
      sawSummaryField: typeof j.compact_summary === 'string',
    }) + '\n',
    'utf8',
  );
} catch {
  // a logging hook never interferes with a compaction
}
process.exit(0);
