---
name: never-save-a-production-form-he-asked-steps-for
description: "When he asked for click-by-click steps, he fills and saves the production form himself; a short reply like \"Validate Hala Adel\" is not an order for Claude to submit it in his browser."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 703b7205-7812-4fe1-9f86-a647d66fd4ea
  modified: 2026-11-23T21:57:14.933Z
---

On 23 Nov 2026 he asked for click-by-click steps to validate Dr Hala Adel and the Ayman Hegazy CMC pharmacy. He did it himself, under Zahraa Hamdy, at 22:56 Cairo. Later he clicked a reply button reading "Validate Hala Adel". Claude took that as an instruction, opened his Chrome and saved a second copy under Mariam Wagdy at 23:54. Three distributor codes ended up on two pharmacies. His words: "what are u doing i wanted to validate it to zahraa hamdy and i am done". The copy was deleted on his word, and its rows are kept in session 703b7205.

**Why:** a production validation names the employee it belongs to, writes sales-tracking codes and cannot be undone except by deleting rows. If it is saved twice, the codes double-count sales.

**How to apply:** never fill or save a business form on production (validation, approval, request) unless his own words in that turn tell Claude to save it AND name whose behalf it is. Before that, read production to see whether he has already done it. Never offer a reply button whose words read like an order to act in his browser. Related: [[the-next-step-box-must-not-manufacture-the-next-task]].
