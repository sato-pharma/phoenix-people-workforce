# Direct-order delivery receipt books

The account behind the receipt rule in `.claude/rules/direct-orders.md`. The paper side (the printed books, their
security marks, the guides, the sample book, the proposal email and the never-email rules) lives in the
`direct-order-receipt-books` skill, `.claude/skills/direct-order-receipt-books/SKILL.md`.

## What it is

- **The owner's decisions.**
  - 26 Nov 2026: "Build the check"; the books belong to "Finance"; an order with no receipt is flagged after
    "14 days".
  - 27 Nov 2026, after a gap audit: orders raised by someone with no book: "Flag them"; a returned book: "Allow
    late entry"; a receipt entered on the wrong order: "make an undo option"; all of it "Fix all in PR 829".
- 16 books × 50 = 800 numbered receipts, each with a six-character printed code
  (`direct_order_receipt_books`, `direct_order_receipts`). The codes live only in the database and the printed
  books, never in Git, a document, a chat, an email, a pull request or a commit.
- A receipt proves ONE approved order for ever. The manager who raised the order types the serial and the code
  and uploads a photo of the signed page.

## How a receipt is checked

The order of the checks is deliberate (`checkReceiptForOrder`, `src/lib/direct-orders/receipt-rules.ts`):

1. **The order:** approved, not a reversal, with no receipt yet.
2. **The serial:** a receipt that exists in one of the books.
3. **The book's custody:** handed out (not in store), not lost, held by the person who raised the order. A
   RETURNED book still proves an order approved while its manager held it (late entry), never one approved
   after it came back.
4. **The printed code.**
5. **The receipt's state:** not used, not cancelled.

A wrong code is always refused before "already used" is said, so guessing a code learns nothing.

The claim itself is one compare-and-set on `state = 'unused'` and `request_id IS NULL`. A lost race is a 409.
A book reported lost while the photo was uploading refuses the claim too, because the database re-reads the
book.

Every refused attempt is written on the order's history: not allowed, a bad serial, a bad code, a bad photo, a
lost race, a book that changed, an order that already has a receipt, and every rule refusal above. The typed
code is never written anywhere.

## Which orders owe a receipt

- An order owes a receipt from a book only if it was approved while its requester held one
  (`bookHeldAtApproval`).
- From the first hand-out of any book (`receiptRolloutStart`), an approved order raised by someone holding NO
  book that day is `no_book`. It is listed on Finance's Receipt Books desk under "Approved with no receipt
  book", never silently excused. Nothing approved before the first hand-out is listed.
- An order still owing a receipt 14 days after approval turns red on the desk. Each book's line on the desk says
  how many approved orders still owe a receipt from it.

## Who does what

- **Finance** (`canManageDirectOrderReceiptBooks`: Ahmed El Maraghy and the Super Admin) hands a book out (only
  to an employee still at work, `active` or `on_leave`), takes it back, records it lost (a spare still in store
  too; its unused receipts are cancelled), and cancels a spoiled page (never a used one). Returning or losing a
  book is ONE database call, `direct_order_close_receipt_book`.
- **The undo.** Finance can take a receipt off the order it was entered on by mistake, with a written reason:
  `releaseDirectOrderReceipt` calls `direct_order_release_receipt`. The receipt goes back to unused for the
  right order; the reason, the photo and who entered it are kept in `direct_order_receipt_releases`
  (append-only), the audit log and the order's history (`receipt_released`). The manager cannot undo his own
  entry.

## The database guards it too

Migration `20261127121951_direct_order_receipt_guards.sql`:

- A used receipt goes back to unused only through `direct_order_release_receipt`, which sets
  `phoenix.receipt_release` to that serial for its own transaction.
- A cancelled receipt stays cancelled.
- A claim (unused → used) re-reads its book `FOR SHARE` and needs it `issued` or `returned`.
- A receipt's serial, book and code never change; a book's range never changes; a book's holder and issue date
  are frozen once it leaves the store.
- A book moves only in store → issued or lost, and issued → returned or lost.
- Nothing in either table, or in the releases table, is ever deleted.
- Both functions are `security invoker`, revoked from `public`, `anon` and `authenticated`, granted to
  `service_role` only.

Never "fix" a guard refusal with a plain update: the refusal is the guard doing its job.

## What it does not do

It gates no sales month and no collection. Whether a missing receipt should hold anything is a money decision
for Dr Anwar and Ahmed El Maraghy, made on its own screen, never in chat.

Pinned by `tests/direct-order-receipt-books.test.ts`.
