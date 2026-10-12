# Phoenix CRM — a rep's drop request carries a comment, and the viewer drops many at once

Owner, 2026-10-12: *"when the sfe receives the request to drop from reps i want 2 things — that he can
multi select or select all and drop, and to make the comment required not optional for the reps when
submitting the drop request."*

## The comment

- `parseDropDraft(body, { requireNote: true })` in `src/lib/phoenix-crm/entry-rules.ts` refuses an empty
  comment on **every** reason. Before this it was refused only for "Other".
- It is applied in `createListRequest` (`src/lib/phoenix-crm/server/list.ts`), the rep's own ask, and the
  rep's screen (`DropScreen` in `list-screens.tsx`) says "Required" and refuses before sending.
- `sfeDropFromList` — the SFE Manager dropping a customer off a list himself — is not the rep's ask and
  keeps its comment optional. So does a rep archiving a customer he met outside his list, which is not a
  request at all.

## The bulk drop

- Team tab, requests section, "Waiting for your decision". Each **drop** waiting at the viewer's own step
  gets a tick box, with a **Select all** above the cards. Offered from two drops up (`BULK_DROP_FROM`).
- **Drop the N selected** asks for a confirm, then calls `/api/phoenix-crm/list/requests/decide` once per
  request, **in turn and never in parallel**, with the body the card's own Approve sends for a drop
  (`bulkDropDecisionBody`), carrying the step the screen showed so the stage-race guard still bites.
- No new route and no migration: the district-manager-then-SFE steps, the permission check and the rep's
  notification are the single-request ones. A district manager's approval sends the request on to SFE
  (`final: false`); only SFE's step moves the customer to the Archive. The notice says which.
- A request that cannot be approved is named with its reason and the rest stand.
- Only a drop can be ticked (`isBulkDroppable`): never an add, a grade change, a bring-back, another
  manager's step or a decided request, and a tick on a request that left the screen is dropped from the
  selection before anything is sent (`pruneSelection`).

Logic: `src/lib/phoenix-crm/bulk-drop.ts`. Pinned by `tests/phoenix-crm-bulk-drop.test.ts`.
