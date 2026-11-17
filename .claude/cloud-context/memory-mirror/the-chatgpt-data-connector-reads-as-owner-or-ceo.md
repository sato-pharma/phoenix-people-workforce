---
name: the-chatgpt-data-connector-reads-as-owner-or-ceo
description: "17 Nov 2026 — ChatGPT connects to live Phoenix at /api/mcp as the owner or the CEO only, sees everything that role sees, read-only, Phoenix builds the sheets/PDFs; branch claude/chatgpt-data-connector"
metadata:
  node_type: memory
  type: project
  originSessionId: 0a8a71f8-717c-4ecb-84f3-697188bd99c3
  modified: 2026-11-17T11:26:08.625Z
---

The owner asked (17 Nov 2026) for ChatGPT to answer questions about any module from live data and to build sheets and PDFs. His MCQ choices: live Phoenix app; "Everything" including bank, ID and medical; "Me + CEO"; "Phoenix makes them". He turned off model training in ChatGPT.

Built on branch `claude/chatgpt-data-connector`: OAuth 2.1 + PKCE + dynamic registration (ChatGPT return addresses only), 4 tables `connector_oauth_*` + `connector_files`, live account re-check per call, `chatgpt_connector` audit rows, read-only tools.

**Why:** separate from the Phoenix Inspector (screenshots, staging); this one is data, production.
**How to apply:** never add a write tool or a third seat; account in `docs/phoenix-intelligence/CHATGPT_DATA_CONNECTOR.md`, rule in `.claude/rules/platform-access.md`. Related: [[b-10-is-the-owner-himself]].
