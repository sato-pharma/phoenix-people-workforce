# Direct-order delivery receipt books

The account behind the receipt rule in `.claude/rules/direct-orders.md`. The paper side (the printed books, their
security marks, the guides, the sample book, the proposal email and the never-email rules) lives in the
`direct-order-receipt-books` skill, `.claude/skills/direct-order-receipt-books/SKILL.md`.

## What it is

- **The owner's decisions.**
  - 26 Nov 2026: "Build the check"; the books belong to "Finance"; an order with no receipt is flagged after
    "14 days". On 27 Nov he cut it to a week: «حد اقصى اسبوع ولا ينفذ له اوردارات اخرى فى حاله عدم رفعه».
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

- 🔴 **This wave is the Pedia line only, from Sunday 29 November 2026** (owner, 28 Nov 2026: the new rule is for
  the Pedia line in this wave; Anti Infective will work the same later, not now — keep its documents and
  everything, and no change to Anti Infective's direct-order policy). `RECEIPT_BOOK_LINES` and
  `RECEIPT_RULE_START_ISO` in `src/lib/direct-orders/receipt-rules.ts` hold it:
  - an order whose own `line` is not in the list never owes a receipt: it is never late, never flagged
    "no book", never blocks its manager and never sends a reminder;
  - nothing approved before Sunday 29 November 2026, 00:00 Cairo, owes one, even if a book went out earlier;
  - Finance cannot hand a book to a manager outside the list. Books 1 to 7 carry Anti Infective managers'
    names and stay in the store, and the desk says so in place of the hand-out button. A spare goes only to a
    Pedia manager.
  - Starting Anti Infective later is one word added to `RECEIPT_BOOK_LINES`, with its own start day.
- An order owes a receipt from a book only if it was approved while its requester held one
  (`bookHeldAtApproval`).
- From the first hand-out of any book (`receiptRolloutStart`), an approved order raised by someone holding NO
  book that day is `no_book`. It is listed on Finance's Receipt Books desk under "Approved with no receipt
  book", never silently excused. Nothing approved before the first hand-out is listed.
- An order owes nothing until Finance records its warehouse exit (`awaiting_exit`). From the day after the
  exit, Original 1 is due in 3 calendar days and Original 2 in 6 working days (see the last section). A late
  original turns the order red on the desk, and the manager who raised it cannot raise a new order until it is
  entered. Each book's line on the desk says how many approved orders still owe a receipt from it.

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

## An order without a receipt — the CEO's approval alone (27 Nov 2026)

The owner, 27 Nov 2026: «صلاحيه عمل اى اوردر بدون ايصال هى صلاحيه انور فقط لاغير موافقه منه والتنفيذ من خلال
استاذ احمد». Making any order without a receipt is Dr Anwar's authority alone. It is his approval, carried out
through Ahmed El Maraghy. He chose "Anwar approves in Phoenix".

- **Who asks:** Finance (`canManageDirectOrderReceiptBooks`), on the order's own page, always with a written
  reason. Only an order that owes a receipt (`waiting`, `overdue`, `no_book`) and has no ask waiting or approved
  can be asked.
- **Who decides:** the CEO alone (`canDecideDirectOrderWithoutReceipt`, by role). The Super Admin has no override.
  This is deliberate: the owner named the CEO alone. The CEO sees each ask in Needs action, and the count joins
  the sidebar badge. Approving needs no note; refusing always says why. A receipt entered while the ask waits
  makes approval impossible, so the ask can only be refused.
- **What an approval does:** the order's standing becomes `without_receipt`. It leaves Finance's overdue and
  no-book lists, and its book no longer counts it as owing. No receipt can be entered on it afterwards. It still
  gates no month and no collection.
- **The record:** `direct_order_no_receipt_requests` (migration `20261127142537`). It is service role only, and
  each order has at most one ask waiting or approved. A decided ask never changes, and no row is deleted.
  A refused order may be asked again, as a new row. Every ask and decision writes an audit row and an order
  event (`receipt_waiver_asked`, `receipt_waiver_approved`, `receipt_waiver_refused`).

## Two originals and a copy, due from the warehouse exit (27 Nov 2026)

The owner, 27 Nov 2026, after Dr Anwar asked what the original and the copy were for: «نخليه 3 نسخ… نسخة في
الدفتر ونسخة يشحنها لأحمد المراغي ونسخة مع الصيدلي», then the final design: every order has **two originals and
one copy**.

- **Original 1 — the custody page.** The manager signs that he received the goods (date, value), that they are
  in his custody and that not delivering them is a breach of trust; the law is printed on it. It stays in the
  book and its photo is entered in Phoenix (`recordDirectOrderReceipt`, which claims the receipt for the order;
  the photo path holds `-custody-`).
- **Original 2 — the customer's page.** No manager details. The customer signs and stamps it; the carbon copy
  under it is torn off for the customer. The manager keeps Original 2 and enters its photo
  (`recordDirectOrderDelivery`): the same serial and code as Original 1, entered once, refused before Original 1.
  It is a compare-and-set on the serial, state `used`, the order, and `delivery_photo_storage_path is null`.
- **The warehouse exit.** Finance alone records the day the goods left the warehouse
  (`recordDirectOrderWarehouseExit`, table `direct_order_warehouse_exits`, one row per order). Never before the
  approval day, never a day still to come. A correction overwrites the day; the old day is kept in the audit row
  and the order event `warehouse_exit_recorded` (`previousDate`).
- **Due dates** (`receiptDueDates`, `src/lib/direct-orders/receipt-rules.ts`): the count starts the day after the
  exit. Original 1 is due 3 calendar days later (`CUSTODY_DUE_DAYS`); Original 2 is due 6 working days later,
  Friday off (`DELIVERY_DUE_WORKING_DAYS`). Example: exit Thursday 10 Dec 2026 → Original 1 due 13 Dec, Original 2
  due 17 Dec. Days are Cairo dates.
- **Standing:** `awaiting_exit` until the exit is recorded (it holds nobody); then `waiting` or `overdue`;
  `has_receipt` only when both originals are in.
- **The verified print** (`/print/direct-order-receipt/<id>`, `loadDirectOrderReceiptPrint`): Finance only. It
  shows both originals with the order, the exit day and who entered each, so a photo Ahmed prints from Phoenix is
  marked as verified, while a printout of a photo alone is not an original.
- **The undo** (`direct_order_release_receipt`) clears both originals; the release row keeps both photo paths.
- Migration `20261127173244_direct_order_receipt_two_originals.sql`: the exits table (service role only), the four
  `delivery_*` columns on receipts (check `direct_order_receipts_delivery`) and on releases, the guard and the
  release function replaced.

## A late original stops its manager's next order (27 Nov 2026)

The owner, 27 Nov 2026: «the 14 days طبعا يقلوا حد اقصى اسبوع ولا ينفذ له اوردارات اخرى فى حاله عدم رفعه فى خلال
المده المحدده». Asked who is blocked, he chose "The manager who raised it". The same day the 7 days from approval
were replaced by the two due dates above.

- `listLateReceiptsForRequester` lists one manager's orders with an original past its due date, each with
  which original and how many days late. While any is listed, `submitDirectOrder`
  refuses a new order from that manager, for any pharmacy, before anything is written, and so does
  `reviseDirectOrder` for an order sent back and resubmitted. The refusal names how many, the longest overdue,
  which original and its pharmacy. The last approval refuses too (`assertRequesterHasNoLateReceipts`), so an
  order already climbing when the receipt went late, or revived from hold, is not finished until it is entered.
- Not a block: an order still waiting for its warehouse exit, a `no_book` order (Finance's flag), an order
  approved from a book Finance has since recorded lost (its receipt can no longer be entered, so it stays on
  Finance's desk), an order the CEO approved to stand without a receipt, an order that has both originals, and a
  reversal. An ask still waiting for the CEO does **not** lift the block.
- The manager's orders, and the exits, are read in batches of 100 ids: about 400 in one request overflow the
  address and read back empty with no error.
- Pinned by `tests/direct-order-payment-standing.test.ts` and `tests/direct-order-receipt-books.test.ts`.

## The live camera, the QR read and the hand-entered original (28 Nov 2026)

The owner's words: "لايف مش ابلود … منوره بالاحمر طول ما هو مش قادر يتعرف عليهم. اول ما … يقدر يتعرف عليهم تنور
بالاخضر ويعمل ابلود"; for a damaged QR, "المدير يدخله مانوال بس يروح للريفيو، ما يدخلش اوتوماتيك … ممكن الاثنين
المدير يدخله بايده والماليه تدخله، بس هو بيروح للريفيو الاول"; and who reviews: "المالية، وإنت لو المالية دخلته".

- **The order page opens the live camera** (`src/components/direct-orders/receipt-qr-camera.tsx`), never the gallery.
  The frame is red until the same receipt is read twice, then green, and the photo saves itself with the number and
  code taken from the QR. Original 2 must carry Original 1's number; another number stays red.
- **How the camera makes sure a correct receipt is recognised** (the owner, 28 Nov 2026: "max effort to be sure the
  camera can recognize the receipt if it is correct"):
  - it asks for the 2560 x 1440 the signboard camera already uses on the reps' phones and reads every frame WHOLE —
    a 1080-wide frame read at 960, the first version, needed the page to fill three quarters of the picture;
  - the phone's own QR reader (`BarcodeDetector`, Chrome on Android) reads first, jsQR after it; a native reader
    that fails once is dropped and jsQR carries on;
  - the lock is `stepReceiptQrLock` (`receipt-rules.ts`): two reads of the same receipt, each within 2 s of the one
    before. A frame that reads nothing in between does NOT undo it — a hand-held phone reads, misses and reads again;
  - it asks the lens for continuous focus, and after 4 s with nothing read the line under the frame asks for the
    phone to come closer to the QR;
  - the photo saved is the very frame that was read, so the server sees what turned the frame green; a photo that
    fails to save no longer stops the camera.
  - Measured on 28 Nov 2026 with the real component and a simulated camera showing the sample pages: green from
    the page filling the picture down to a third of it when sharp; at 15° and 30°, upside down, at 30 % brightness and
    under strong glare; Original 2 of another receipt stayed red. All 25 photos the camera saved were read and
    matched again by the server reader. The server's 1,200 / 1,800 / 2,600 px ladder already read every photo that a
    full-size or sharpened read could; only a badly shaken photo reads nowhere, and it waits for review.
  A manager has no "Choose file"; Finance keeps it for a page it already holds (`mayChooseFile`).
- **The camera is only a help — the server reads the QR again** (`src/lib/direct-orders/receipt-photo-qr.ts`, sharp
  plus jsqr, at 1,200, 1,800 and 2,600 px wide; it never throws). `classifyReceiptPhotoQr` decides:
  - the QR names the typed receipt → the original counts at once;
  - the QR names another receipt (or the right number with a wrong code) → refused, written on the order as
    `qr_other_receipt`, and the other receipt's code is never written down;
  - no receipt QR read, a PDF, or a reader failure → the original is saved with the order (so the paper can never
    be used twice and the manager is not held late), and a pending row goes in
    `direct_order_receipt_hand_entries`. Unread is the safe side: never let an unread photo count.
- **"QR won't read? Type the number"** opens the typed number and code with a shutter; that original always waits.
- **The table** (migration `20261128134224_direct_order_receipt_hand_entries`) is append-only by trigger, server
  only, one pending entry per receipt original. The hand entry is opened BEFORE the receipt is claimed, so the
  one-pending index stops a race; if the claim then fails, the entry is closed, never left waiting.
- **Who reviews** (`canReviewDirectOrderHandEntry`, `finance-authority.ts`): Finance reviews a manager's (or the
  Super Admin's); the Super Admin alone reviews Finance's own; nobody reviews one they typed.
- **A decision is one database call**, `direct_order_decide_hand_entry`. Approving keeps the original. Rejecting
  needs a written reason: Original 1 goes through `direct_order_release_receipt` (the release record keeps the
  photo) and any waiting Original 2 entry closes with it; Original 2 clears only itself, through the receipt
  guard's `phoenix.receipt_delivery_clear` door. The order then says which original was rejected and why.
- **The manager reads the reviewer's own reason** (owner, 28 Nov 2026: "it must show the manager the reason of the
  rejection, the accurate reason"). The order's red notice names the original, the receipt number, who rejected it
  and when (Cairo), then the reason on a line of its own, word for word, its direction taken from its words so an
  Arabic reason reads right to left, then what to do now. The reviewer's box says the manager reads exactly what is
  written. Which rejection shows is `rejectionToShowManager` (`receipt-rules.ts`): the newest decision a reviewer
  made, while that original is still missing. Rejecting Original 1 closes a waiting Original 2 in the SAME instant
  with `RECEIPT_O2_CLOSED_WITH_O1_NOTE` — measured on staging, both rows carry one timestamp to the microsecond,
  and the page reads Original 2 first — so that closing note is never shown as the reason, and on a tie Original 1
  comes first. Until 28 Nov 2026 the order showed "Original 2 … Original 1 was rejected, so the receipt was taken
  off the order" instead of Finance's words.
- **A review never outlives its receipt** (migration `20261128152929_direct_order_receipt_hand_entry_review_fixes`,
  from the code review of PR 858, 28 Nov 2026). Taking a receipt off the order closes every review still waiting on
  it with `RECEIPT_CLOSED_BY_RELEASE_NOTE` ("Not reviewed: the receipt was taken off the order."), which is never
  shown as a reason. Rejecting Original 1 takes the receipt off only when that entry's photo is still Original 1 on
  the receipt of its order, so a stale review never removes a newer, QR-read original; the order then says nothing
  was taken off. The decision locks the receipt before the hand entry, the same order as every other function, so
  two reviewers of one receipt never deadlock. Measured on staging before the fix: the review stayed pending after
  the release, and rejecting it released the receipt entered again; after it: closed, and the receipt stayed. An
  Original 2 rejection shows only for the receipt still on the order with its Original 1 and without its Original 2.
  A reason is cut at 500 characters, and an unsaved original is closed with up to three tries.
- **Camera only holds on the server too** (`photoQrVerdict`, `isPhoenixCameraFrame`): a manager's PDF is refused,
  and a manager's picture Phoenix's camera did not draw (a phone or gallery photo carries EXIF; a canvas frame
  never does) waits for review even when its QR reads. Finance may attach a file it holds. A forged upload with its
  EXIF stripped still counts: the bytes cannot prove the page was in front of the lens.
- **Where it shows:** each original on the order says whether its QR was read or it waits; Finance's Receipt Books
  desk lists every entry waiting, with its photo and the Approve and Reject buttons; the verified print says for
  each original whether its QR was read, or it was typed by hand and approved, or it still waits.

## Who is told, and when (28 Nov 2026)

The owner, 28 Nov 2026, choosing "both": Finance sees a count, and each manager is told inside Phoenix before an
original is due and once it is late. Never an email.

- **Finance's count.** The Direct Orders row in the sidebar adds Finance's receipt work to its one number
  (`countDirectOrderReceiptWork`, the fifth term of `/api/direct-orders/needs-action-count`). The Needs Action inbox
  shows the same number as one group, «N delivery receipts need you», which opens the Receipt Books desk. It counts
  three things, the same way the desk lists them:
  - originals typed by hand that this viewer may review (Finance a manager's, the Administrator both, never the
    author's own);
  - orders with an original past its due date;
  - approved orders still waiting for Finance to record the warehouse exit.
  Anyone who does not manage the books gets 0 with no read. The order half of the count is read once a minute and
  shared by every poll, so the badge can lag the desk by up to a minute. A late original also turns the badge's
  overdue colour on.
- **The manager's notices.** The daily direct-orders sweep (`/api/cron/direct-orders-expire-held`) runs
  `sendDirectOrderReceiptReminders` after the held-order expiry. It sends in-app notices only, to the manager who
  raised the order:
  - «Delivery receipt due tomorrow» the day before (or «due today», if the day before was missed);
  - «Delivery receipt late» once the due date has passed, saying he cannot raise a new direct order until it is in.
  Only the first original not yet entered is spoken of. Nothing is sent before the warehouse exit, for an order the
  CEO let stand without a receipt, or for one from a book recorded lost. Each notice has its own key (order,
  original, kind), so a re-run sends nothing twice. A failing notice is logged and never stops the others or the
  expiry.

Pinned by `tests/direct-order-receipt-books.test.ts`.
