// UserPromptSubmit hook: match the model and effort to the task actually being asked for.
//
// WHY THIS IS ADVISORY AND NOT AUTOMATIC
// Claude Code takes effort from `--effort` at launch or `/effort <level>` mid-session. No hook
// can set it — session-lifecycle hooks are not even TOLD the current effort (it is handed only
// to hooks firing inside a tool-use context). So this classifies the request, reads the effort
// the Stop hook last recorded, and speaks up only when the gap is worth a keystroke.
// Delegated work IS routed automatically: see ~/.claude/agents/*.md, whose frontmatter pins a
// model and effort per task class.
//
// THE NUMBERS ARE THE APP'S OWN (`effort_cost_index`, Claude Code 2.1.227, read 2026-08-13),
// normalised to each model's default effort = 1.0:
//   opus-5    low .60  medium .77  high 1  xhigh 1.74  max 1.91
//   sonnet-5  low .47  medium .74  high 1  xhigh 2.41  max 5.59
// Sonnet at max is the trap: a near-6x multiplier on the model picked for being cheap.
import fs from 'node:fs';
import path from 'node:path';
import {
  EFFORT_ORDER,
  RELAY,
  effortCost,
  loadRunMode,
  normModel,
  shortModel,
  writeJSON,
} from './relay-lib.mjs';

// Ordered most severe first; the first list to match wins.
const TIERS = [
  {
    name: 'critical',
    effort: 'xhigh',
    model: 'opus',
    why: 'money, production or access control is in scope',
    re: /\b(payroll|salar|deduction|incentive|migration|migrat|production|prod\b|deploy|merge|rls|permission|grant|policy|revoke|truncate|drop\s+table|credential|secret|service[- ]role|security)\b/i,
  },
  {
    name: 'hard',
    effort: 'high',
    model: 'opus',
    why: 'it needs reasoning, not typing',
    re: /\b(design|architect|refactor|investigat|debug|root cause|why is|why does|why did|audit|optimi[sz]|race|deadlock|inconsistent|regress|broken|failing|wrong|discrepan|reconcile)\b/i,
  },
  {
    name: 'routine',
    effort: 'medium',
    model: 'sonnet',
    why: 'a known change, mechanically applied',
    re: /\b(add|implement|create|write|update|change|rename|move|wire|hook up|scaffold|format|lint|typo|bump|copy)\b/i,
  },
  {
    name: 'lookup',
    effort: 'low',
    model: 'sonnet',
    why: 'reading, not deciding',
    re: /^\s*(what|where|which|who|when|show|list|read|find|check|does|is|are|how many|how much|tell me)\b/i,
  },
];

const rank = (e) => EFFORT_ORDER.indexOf(e);

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  const prompt = String(input?.prompt ?? '').slice(0, 4000);
  const sessionId = input?.session_id;
  if (!prompt.trim()) process.exit(0);

  const tier = TIERS.find((t) => t.re.test(prompt)) ?? TIERS[2]; // default: routine
  const mode = loadRunMode(sessionId);
  const model = normModel(mode?.model);
  const effort = mode?.effort;

  // Publish for the statusline even when we stay quiet.
  try {
    writeJSON(path.join(RELAY, 'advice', `${sessionId}.json`), {
      at: Date.now(),
      tier: tier.name,
      effort: tier.effort,
      model: tier.model,
    });
  } catch {}

  if (!effort || rank(effort) === -1) process.exit(0); // nothing recorded yet — stay silent

  const now = effortCost(model, effort);
  const want = effortCost(model, tier.effort);
  const isSonnet = /sonnet/.test(model);
  const sonnetTrap = isSonnet && (effort === 'max' || effort === 'xhigh');

  // Speak only when it is worth a keystroke: the Sonnet multiplier trap, or a real saving
  // on a task that does not need the effort it is getting.
  const saving = now > 0 ? 1 - want / now : 0;
  if (!sonnetTrap && (rank(effort) <= rank(tier.effort) || saving < 0.25)) process.exit(0);

  // Say it ONCE per session for the same advice (2026-10-08): it used to repeat on every matching
  // prompt — 1.8 MB over 467 sessions in three days, 89% of it an exact repeat. It speaks again only
  // when the advice CHANGES: another model, another effort, or another suggested level.
  const adviceKey = `${model}|${effort}|${tier.effort}|${sonnetTrap}`;
  if (sessionId) {
    const shownFile = path.join(RELAY, 'advice-shown', `${String(sessionId).replace(/[^\w.-]/g, '')}.json`);
    let shown = null;
    try { shown = JSON.parse(fs.readFileSync(shownFile, 'utf8'))?.key ?? null; } catch {}
    if (shown === adviceKey) process.exit(0);
    try { writeJSON(shownFile, { key: adviceKey, at: Date.now() }); } catch {}
  }

  const lines = [
    `EFFORT ROUTER — this reads as a "${tier.name}" task (${tier.why}).`,
    `Running: ${shortModel(model)} at ${effort} (${now.toFixed(2)}x that model's default cost).`,
    `Suggested: ${tier.effort} (${want.toFixed(2)}x) — about ${Math.round(saving * 100)}% less for this turn.`,
  ];
  if (sonnetTrap)
    lines.push(
      `WARNING: Sonnet at ${effort} costs ${now.toFixed(2)}x its own default. Sonnet is the cheap model; at this effort it is not. Cap Sonnet at high.`,
    );
  lines.push(
    `He changes it with:  /effort ${tier.effort}   (interactive terminal; it applies from the next turn)`,
    `Mention this in ONE short line at most, then do the work as asked. Never refuse or stall over it, and do not repeat it if it was already raised this session.`,
  );

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: lines.join('\n'),
      },
    }),
  );
} catch (err) {
  if (process.env.RELAY_DEBUG) process.stderr.write(`effort-advisor: ${err?.stack || err}\n`);
}

process.exit(0);
