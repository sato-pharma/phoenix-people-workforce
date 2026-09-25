---
name: windows-env-var-shadows-every-env-local-key
description: "A Windows user OPENAI_API_KEY env var silently overrides every .env.local — Node's --env-file never overwrites an already-set variable, so editing .env.local changes nothing. Which of the 3 keys is the LIVE one has flipped once; always re-probe."
metadata:
  node_type: memory
  type: project
---

**There is an `OPENAI_API_KEY` set in the WINDOWS environment on this machine, and it wins over
every `.env.local` in every worktree.** `node --env-file` / `--env-file-if-exists` **does not
overwrite a variable that is already set in the process environment** — it only fills in the ones
that are missing. So editing `.env.local` and re-running changes nothing at all, with no warning.

**WHICH COPY IS VALID HAS ALREADY FLIPPED ONCE — never reuse a previous session's answer, re-probe
all three.** Both readings below are real, hours apart on the same day:

| when (2026-08-21) | Process env | `.env.local` | Windows **User** env |
| --- | --- | --- | --- |
| ~10:00 Cairo | `…CesA` **401, and the one actually used** | `…7pgA` **200 VALID** | — |
| ~12:35 Cairo | `033CA94DA1` / `…CesA` **401** | `B835891BED` / `…7pgA` **401** | `469EBD3D56` / `…sVQA` **200 VALID** |

So the situation **inverted**: the env var went from being the dead one shadowing a good file, to
being the *only* live key while the file went dead. Three distinct 164-char keys existed at once.

**What it costs to get this wrong:** a `node --env-file-if-exists=.env.local` reread run used the
Process key, every model call 401'd, and **16 rows were written that looked like successful reads**
but were the free rules engine. See
[[openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules]].

**The two diagnostics, neither of which reveals a secret.** Compare the tails:

```
if [ -n "$OPENAI_API_KEY" ]; then echo "len ${#OPENAI_API_KEY} tail ...${OPENAI_API_KEY: -4}"; fi
```

and probe validity by HTTP status only — `GET https://api.openai.com/v1/models` with the key as a
bearer token returns **200 valid / 401 dead**. That is far cheaper than a CV extraction and it
proves the key rather than inferring it. Strip `\r` before taking a tail: these files are CRLF, so
a naive `${line: -4}` reads the carriage return and every comparison silently mismatches. Use
`curl.exe -s -o NUL -w "%{http_code}"`, **not** `Invoke-WebRequest` — the latter hit "PowerShell is
in NonInteractive mode" on one key and returned no status at all.

**The workaround that does not touch his machine** — pass the copy you proved good, explicitly:

```
K=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')" | tr -d '\r\n')
OPENAI_API_KEY="$K" node --env-file-if-exists=.env.local ... script.ts
```

`env -u OPENAI_API_KEY node --env-file=<path> …` is the other direction — unset it and let the file
supply the value — but that only helps when the *file* is the live one, which it was not at 12:35.
Also note a worktree has its OWN `.env.local` (`git worktree add` never copies gitignored files), so
the owner editing the main checkout does not reach a worktree run.

**The permanent fix is his to make, not mine** — it holds a credential, so never set or delete it
programmatically. System Properties → Environment Variables → delete the dead user/Process
`OPENAI_API_KEY`, then restart the terminal.

Consequence worth remembering: **`pnpm run dev` also uses whichever copy is live**, so a dead one
silently degrades every local CV extraction. Related: [[local-env-already-points-at-production]] ·
[[openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules]] ·
[[env-file-reads-fully-auto-approved-2026-08-09]]
