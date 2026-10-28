import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "./support/comment-strip.ts";

// The mailbox monitor renders Arabic free text that arrives live over IMAP — sender names, subjects,
// IMAP folder names and the message body itself. None of it is stored in Phoenix, so there is no
// fixture to assert against and no row count to measure; what CAN be pinned is the markup, which is
// where this class of defect lives. Measured at 375px on 2026-08-30, not inferred from source.

const FILE = path.join(process.cwd(), "src/components/admin/mailbox-monitor-dashboard.tsx");

export function runMailboxMonitorTextDirectionTests() {
  const raw = readFileSync(FILE, "utf8");
  const source = stripComments(raw);

  // 1. The message body. dir="auto" resolves direction from the first strong character, so an
  //    Arabic opening line would take the whole element RTL — EXCEPT that dir="auto" maps to
  //    unicode-bidi:plaintext, and whitespace-pre-wrap makes every newline a forced break, so each
  //    line resolves independently. Both halves have to stay true together.
  const bodyTag = source.match(/<pre[^>]*reader\.message\.text|<pre[\s\S]{0,400}?reader\.message\.text/);
  assert.ok(bodyTag, "the plain-text body must still render through a <pre> — the whole fix rests on it");

  const preOpen = source.match(/<pre\s[^>]*>/);
  assert.ok(preOpen, "expected a <pre> opening tag for the message body");
  assert.match(
    preOpen[0],
    /dir="auto"/,
    'the message body <pre> must carry dir="auto" — without it an Arabic mail renders left-aligned, against the reader',
  );
  assert.match(
    preOpen[0],
    /whitespace-pre-wrap/,
    'the body <pre> must keep whitespace-pre-wrap: it is what makes each newline a forced break, ' +
      'which is the ONLY reason block-level dir="auto" is sufficient here. Remove it and the English ' +
      "half of a bilingual mail gets right-aligned with the Arabic.",
  );

  // 2. The From line is an English sentence carrying a Cairo timestamp. Measured: with the Arabic
  //    sender name NOT isolated, the "28" of "28 Aug 2026" tears out of the date and renders next to
  //    "From". So the name takes dir="auto" on its own span and the line itself must never take one.
  const fromLine = source.match(/From <span dir="auto">[\s\S]{0,140}?<\/span> · \{formatCairo/);
  assert.ok(
    fromLine,
    'the sender name on the From line must sit in its own <span dir="auto"> — isolating it is what ' +
      "keeps the date from being torn apart by an Arabic name",
  );
  const fromContainer = source.match(/<div className="mt-1 text-xs text-slate-500"[^>]*>/);
  assert.ok(fromContainer, "expected the From line container div");
  assert.doesNotMatch(
    fromContainer[0],
    /dir=/,
    'the From line container must NOT take dir="auto": it would resolve on the English word "From" ' +
      "today and silently flip the whole line — separator and timestamp included — the day that " +
      "label changes",
  );

  // 3. The single-language fields take the ordinary house treatment: dir="auto" on the block.
  //    These are names, subjects and IMAP folder labels — one language each, so block level is right.
  for (const [label, pattern] of [
    ["message subject in the reader", /<div className="text-base font-bold text-slate-900" dir="auto">\{reader\.message\.subject/],
    ["message subject in the list", /<span className="min-w-0 break-words text-sm text-slate-500" dir="auto">\{summary\.subject/],
    ["sender name in the list", /className=\{cn\("min-w-0 break-words text-sm"[\s\S]{0,120}?\)\} dir="auto"/],
    ["IMAP folder name", /<span className="min-w-0 break-words" dir="auto">\{folder\.name\}/],
  ] as const) {
    assert.match(source, pattern, `${label} must carry dir="auto" — it can be an Arabic value`);
  }

  // 4. Both monitor titles — the desktop table cell and the mobile card. A monitor's label is the
  //    employee's own name or a hand-typed label, so either can be Arabic, and the admin shell shows
  //    the table on desktop and cards on mobile (owner rule), meaning a fix to one is only half.
  const titleSites = [...source.matchAll(/<div className="[^"]*font-semibold text-slate-900"[^>]*>\{monitorTitle\(monitor\)\}/g)];
  assert.equal(titleSites.length, 2, "expected exactly two monitorTitle render sites (desktop table + mobile card)");
  for (const site of titleSites) {
    assert.match(site[0], /dir="auto"/, "both monitorTitle render sites must carry dir=\"auto\", not just the desktop one");
  }

  // 5. The untrusted-HTML iframe is deliberately left alone: it carries the sender's own markup with
  //    its own direction, and it stays sandboxed with no allow-scripts. Pin the sandbox, because this
  //    file is now edited for direction reasons and that attribute must not be collateral damage.
  assert.match(
    source,
    /<iframe[\s\S]{0,220}?sandbox=""/,
    "the HTML preview iframe must stay sandboxed with NO allow-scripts",
  );
}
