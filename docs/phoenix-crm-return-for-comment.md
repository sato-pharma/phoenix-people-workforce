# Phoenix CRM — SFE returns a request to the rep for a comment

Owner, 2026-10-12: "add an option for the SFE to return for comment." His two answers when asked:
after the rep answers the request goes **straight back to SFE**, and **every kind** of request can be
returned.

## The flow

    sfe ──Return for comment (note required)──▶ rep ──Send the comment──▶ sfe
    (a grade change on a territory with no manager: stage none ▶ rep ▶ none)

- A returned request is **not decided**. It stays `pending`; its stored `stage` becomes `rep`. Every
  queue, counter and nudge reads `stage`, so it drops out of SFE's waiting list on its own and comes back
  the moment the rep answers. The district manager is never asked again.
- **Only the step SFE holds can be returned**: the second step of a drop, an add or a bring-back, or a
  grade change on a territory with no district manager. The district manager's own step never is
  (`canReturnForComment`, `src/lib/phoenix-crm/list-request-rules.ts`).
- While it is with the rep nobody can approve it: the service refuses (`decideListRequest`) and the
  trigger `phoenix_crm_list_requests_with_rep_guard` refuses under every writer (`request_with_rep`). The
  rep can still withdraw it, and the Administrator can still decline it (he never approves).
- The rep's reply is appended to a drop's note (` — `) when both fit in 500 characters, so the Archive
  keeps the comment; otherwise it stands alone. It is also kept in `rep_reply`; SFE's question stays in
  `return_note`.
- The Team tab shows these under **With the rep for a comment**, not under "Waiting for another manager".

## Notifications

`request_returned` tells the rep; `request_answered` tells the SFE who returned it. Both are email,
Telegram, push and in-app like every person-to-person Phoenix CRM step (`policy.ts`,
`phoenix-crm-channel-guard.ts`, `tests/phoenix-crm-email-block.test.ts`). The approval nudge skips a
request with the rep.

## The bulk drop and a repeat ask

A rep can ask twice to drop the same customer. Approving the first at SFE's step takes the customer off the
list and the database closes the other one, so the second call would come back "already decided". The Team
tab's bulk drop now skips a customer already dropped in the same run and reports it as "N repeat requests
closed with them" (`repeatOfDropped`, `src/lib/phoenix-crm/bulk-drop.ts`).

## Migration

`supabase/migrations/20261012180000_phoenix_crm_return_request_for_comment.sql` — additive: five nullable
columns, the two stage constraints widened, one guard trigger, `phoenix_crm_return_request` and
`phoenix_crm_answer_request`. The decide function is untouched. Pinned by
`tests/phoenix-crm-return-for-comment.test.ts`.
