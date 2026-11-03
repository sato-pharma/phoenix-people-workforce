---
name: a-held-pull-request-must-be-a-draft
description: "A hold said only in one session's chat cannot stop another session offering the merge. On 3 Nov 2026 pull request 54 merged while its Back fix was known wrong. A pull request being held goes to draft the moment the hold starts."
metadata:
  node_type: memory
  type: feedback
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-03T12:19:24.736Z
---

On 3 Nov 2026 this session had told him pull request 54 would wait, and that its Back change was wrong. Another session's box then offered "merge 54 when green". He sent it at 13:54 Cairo and that session merged it at 13:55, correctly, on his word. The "Do not merge yet" line only went on the pull request at 14:01, six minutes later. The fix had to go in a second pull request, 57.

**Why:** a hold in one chat is invisible to every other session, and a merge costs CI minutes and a production deployment. A green pull request looks ready from outside.

**How to apply:** the moment a pull request is known wrong or held, run `gh pr ready <n> --undo`, which makes it a draft that GitHub refuses to merge. A line in its body comes second. Before a box offers a merge of a pull request this session did not open, read its body and its draft state. After a surprise merge, ask who merged by reading the other sessions' transcripts, and never assume a fault: it was his word.
