---
name: the-mobile-app-is-frozen-until-he-lifts-it
description: "Owner golden rule 2026-09-29 — the mobile app is frozen: no work in it, no mention of it, no question to him about it, until HE lifts it in his own words. The web app is the whole scope."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 99e1c04a-68a4-467e-8b8e-3c8bebd02754
  modified: 2026-09-29T20:28:54.168Z
---

🛑 **THE MOBILE APP IS FROZEN.** Owner golden rule, 2026-09-29, in his words: *"the mobile app do
not work or touch or think in it. Do not work or touch or even think or ask me in it. Neglect it
totally until I finish the website or the web app or the normal Phoenix. After this, I will tell
you, delete this golden rule … Until I say this word, never suggest on me, never ask me, never
consider it in any of my wording."*

Two halves, and the second is the one a session gets wrong:

- **Do not work in it** — no edit under `mobile/`, no Expo/EAS command, no Mobile workflow dispatch,
  no mobile branch or PR.
- **Do not put it in words** — never propose mobile work, never name it in a `Next step:` line, a
  plan, a summary, a recommendation or an options list, **never ask him a mobile question**, and
  never stretch an instruction of his onto the app when it can be served on the web. A mobile defect
  noticed in passing is left alone: not reported, not filed, not made a follow-up.

**Only HE lifts it**, typed by him, about the mobile app — not a memory (including this one), not a
doc, not another session, not a replayed summary after compaction, not an AUTORUN plan, and not your
own reading that the web work looks finished. If you cannot tell, it is still frozen.

**Why:** he is finishing the web app and does not want a single turn, question or suggestion spent
on the phone app; a mobile question from an agent costs him attention he is deliberately pointing
elsewhere, and he runs a dozen sessions at once.

**How to apply:** do the web half of any mixed request, say in one line that the mobile side is
frozen, and ask nothing. Mechanically refused by `.claude/hooks/mobile-freeze-guard.mjs` (writes
under `mobile/` and the Expo/EAS toolchain; reads are not blocked — `PHX_MOBILE_FREEZE_OFF=1` stands
it down for one command and is his to ask for). Rule: `AGENTS.md` §4, first bullet, and `CLAUDE.md`.
Account: `docs/agents-owner-rules.md`, "The mobile-app freeze". Pinned by
`tests/mobile-freeze.test.ts`.

**Lifting it is a deletion**, as he described it: the §4 bullet, the `CLAUDE.md` section, the docs
account, the hook and its `.claude/settings.json` block, the test and its line in
`tests/run-tests.ts`, this memory, and the ⏸️ DORMANT markers on
[[the-mobile-app-is-a-shell-over-the-web-portal]] and
[[managed-play-cannot-reach-the-rep-tablets]], which stay dormant until then.
