---
name: groq-inference-zero-data-retention-is-on
description: "Groq's Inference APIs Zero Data Retention switch is ON for the account that holds production's key (owner's choice, 14 Nov 2026); what was left as it was, and how to read it back"
metadata:
  node_type: memory
  type: project
  originSessionId: 10ba1c01-8641-48a5-97e7-a15f406ecef1
  modified: 2026-11-14T01:34:19.212Z
---

**Groq no longer keeps what Phoenix sends it.** "Inference APIs ZDR" reads **Enabled** on `https://console.groq.com/settings/data-controls`, turned on 14 Nov 2026 at 03:33 Cairo and read back after a page reload.

- **His words:** asked by multiple choice, he chose "Turn on Inference ZDR (Recommended)". He signed in himself; I clicked that one switch and its confirm box in his Chrome.
- **Which account:** organisation "Personal", project "Default Project", the one holding the API key named `phoenix-crm-voice` (production's `GROQ_API_KEY`). His Claude browser pane is signed in to a DIFFERENT Groq account ("Achiever", no keys); a reading taken there says nothing about production.
- **What it covers:** everything Phoenix sends to Groq: voice transcription (`whisper-large-v3`) and the sales-text fallback. Before the switch Groq could keep inputs and outputs for up to 30 days.
- **Left as it was, on purpose:** "Global ZDR" Disabled; "Batch" On; "Fine-tuning & LoRA Inference" On. Phoenix uses neither batch nor fine-tuning, so those two hold no Phoenix data. Turning Global on would also switch those features off; that is his decision.
- **Read it back:** the page needs his sign-in (Claude in Chrome, the browser he picks); the text beside each switch is the answer. There is no API read of this setting that I found.

**Why:** the integrations audit of 13 Nov 2026 listed Groq's retention as "Not verified"; voice notes and sales text can name real customers and employees.
**How to apply:** stop listing Groq retention as unverified or as his click. The integrations list (`src/lib/integrations/registry.ts`, the Groq entry) and `docs/observability.md` still said "Not verified" on 14 Nov 2026: correct both in the next change that touches the integrations list, never as a one-line pull request. Related: [[maps-static-daily-cap-is-300-on-phoenix-hr-2026]].
