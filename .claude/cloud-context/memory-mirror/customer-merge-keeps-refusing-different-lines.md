---
name: customer-merge-keeps-refusing-different-lines
description: "Owner chose on 3 Nov 2026 that the customer merge screen keeps refusing two rows on different lines, even though his own hand merges of 21 Aug crossed lines"
metadata:
  node_type: memory
  type: project
  originSessionId: 8f2404f8-1938-4b37-9d1f-a6bb8117cb7f
  modified: 2026-11-03T08:47:26.313Z
---

On 3 Nov 2026, about 06:50 Cairo, asked by multiple choice, the owner chose "Keep refusing": `phx_merge_marketing_customers` and `customerMergeRefusal` refuse a pair on different lines. His hand merges of 21 Aug 2026 did cross lines ("A duplicate person is a duplicate person"), and he saw that when he chose.

**Why:** the safe default until a real pair needs otherwise.

**How to apply:** do not offer to widen it again unless he brings a real pair. Widening is one guard in the SQL function and one in `customerMergeRefusal`.
