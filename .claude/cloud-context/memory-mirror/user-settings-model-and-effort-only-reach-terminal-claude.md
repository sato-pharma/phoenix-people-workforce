---
name: user-settings-model-and-effort-only-reach-terminal-claude
description: "`model: sonnet` and `effortLevel: high` in ~/.claude/settings.json do NOT steer desktop Code-tab sessions or the app's scheduled tasks — the app's picker does (646 sessions over 3 days to 8 Oct 2026: 585 desktop sessions started on Opus, 1 plain `claude` CLI run on Sonnet); the keys only set the default for a terminal `claude` run, so never read them as what sessions use."
metadata:
  node_type: memory
  type: reference
  originSessionId: 3a2cba8e-a064-42bb-bb4c-93a119e40088
  modified: 2026-10-08T14:17:42.135Z
---

Measured 2026-10-08. The file holds `"model": "sonnet"` and `"effortLevel": "high"`.

**646 session transcripts active in the 3 days to 8 Oct.** I looked at the first model to answer, by how each session started:

| Started from | Opus | Sonnet |
| --- | --- | --- |
| Desktop app | 585 | 53 |
| Plain `claude` in a terminal | 0 | 1 |

- **The desktop numbers follow the app's model picker.** The 53 desktop sessions on Sonnet are ones started on Sonnet on purpose.
- **The live app agrees.** `get_session` showed this session on `claude-opus-5-5` and another on `claude-sonnet-5-5`. The scheduled "health check" task ran `claude-opus-5`.
- **Effort is the same story.** One live desktop session ran at `xhigh` while the file says `high`.
- **Where the keys do count:** a `claude` started in a terminal without `--model`, which runs Sonnet at high. That happened once in 3 days.

**How to apply:**
- To learn a session's model or effort, read `get_session`, never this file.
- Removing or changing the keys only changes terminal runs, and it is the owner's call: that file is edited only on his word.
- This closes FUP-006 of the 8 Oct performance investigation.

Related: [[desktop-slowness-oct-2026-is-thinking-level-and-model-not-memory]].
