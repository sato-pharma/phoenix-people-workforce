---
name: direct-order-receipt-books
description: Everything about the direct-order delivery-receipt books (إذن تسليم وتسلم بضاعة) built on 26–27 Nov 2026 — the 16 printed books and their security marks (ready-made anti-copy VOID paper for the two originals, the red serial, blue-ink signatures, per-receipt seal, microtext, QR), the register of 800 codes, the Phoenix check that ships with PR 812 (Finance's Receipt Books desk, the receipt panel on an order), the two Arabic guides (management summary, area managers' guide), the sample book, the proposal email to Dr Anwar and Ahmed El Maraghy, and what is still open. Use whenever the owner mentions receipt books, دفاتر الإيصالات, إيصال, the custody acknowledgement, the printer, the copier test, the guides, the sample book, the proposal email, or handing a book to a manager.
---

# Direct-order receipt books

Built in one session, 26 Nov 2026 19:30 to 27 Nov 2026 01:00 Cairo. It is recorded here so that no later session
has to rediscover it. The code side is module memory: the first bullet of `.claude/rules/direct-orders.md`.

## His words, and what is NOT decided

- 26 Nov ~19:30: "Build the check". Book owner: **"Finance"**, meaning Ahmed El Maraghy. Flag an approved order
  with no receipt after **"14 days"**. 27 Nov ~15:00 he cut it to a week: «حد اقصى اسبوع ولا ينفذ له اوردارات
  اخرى»; the manager who raised the late order is blocked from raising another ("The manager who raised it").
- 27 Nov ~00:15: "Merge 812". PR 812 merged at 00:18 (merge sha `efbccb86b`) and served from 00:23. The error
  check stayed CLEAN for 15 minutes.
- **NOT decided, and never decided in chat (money):** whether a missing receipt stops the order counting in that
  month's sales or collection. Today it does not; the receipt proves and flags only. The proposal email puts
  this to Dr Anwar and Ahmed El Maraghy as THEIR decision.
- 27 Nov ~14:15: «صلاحيه عمل اى اوردر بدون ايصال هى صلاحيه انور فقط لاغير موافقه منه والتنفيذ من خلال استاذ احمد».
  He chose "Anwar approves in Phoenix". Built: Finance (أستاذ أحمد) asks on the order with a reason, and the CEO
  alone approves or refuses it on the same order and in his Needs action list. An approved order leaves the
  missing-receipt lists. The Receipt Books desk lists every ask.
- He asked for the guides **in Arabic**, "المختصر المفيد والمهم" (short and to the point). He asked for REAL
  screenshots, and a labelled drawing only where no real screen exists yet.

## 🔴 Rules that must never be broken

- **Never put a real receipt code in any document, chat, email, PR or commit.** The codes live only in the
  production database, the printed books, `register.json` and `Receipt Book Register.xlsx`.
  - Guide sample code: `K7Q2MX`, sample book number `00`, sample serial `000000`.
  - The app's placeholders: `000123` and `AB3K7Q`.
  - None of these four is in the register.
- **Never email the full book PDFs.**
  - They are about 21 MB each and 325 MB in total, so Outlook refuses even one.
  - Each one prints the real codes of its 50 receipts, so anyone holding the file can print a receipt Phoenix
    accepts.
  - Proposed route: hand them to Ahmed El Maraghy on a USB stick, straight to the printer, and wipe the stick
    after printing. He has not chosen the route yet.
- **Never attach or forward `Receipt Book Register.xlsx` or `register.json`**: they list all 800 codes.
- **`Book Custody Acknowledgements - all books.pdf` carries every manager's national ID number and home
  address.** It may go only to the people who run the books, Dr Anwar and Ahmed El Maraghy.
- **Never re-run `build.mjs` into the books folder after deleting `register.json`.** It would mint 800 NEW
  codes that are not in Phoenix. The register is made once and reused, so that a re-run never re-issues codes.
- **Leave the security marks out of the area managers' guide.** The managers are the people the receipts check.
  The marks are described only in the management summary and the email.
- **Every guide and drawing uses the house document identity.** That means the Sato logo, deep blue `#0A527D`,
  the engine-turned band, the 6% zebra and square edges.

## Where everything is

`F:\Phoenix Workforce\Direct Order Receipt Books\` (not in Git):

| File | What it is |
| --- | --- |
| `Receipt Book NN - <area> - <line> - <first>-<last>.pdf` × 16 | the print files: books 01–14 named, 15–16 spare |
| `Book Custody Acknowledgements - all books.pdf` | 16 pages, one acknowledgement per book (signature + right-thumb print) |
| `Receipt Book Register.xlsx`, `register.json` | 🔴 every serial ⇄ code ⇄ book ⇄ holder |
| `preview-*.png` | previews of the real pages (real codes: never share) |
| `_superseded v1 - no copy mark\` | the first build, before the hidden watermark: never print it |
| `_generator\build.mjs`, `guides.mjs`, `managers.json` | the generators; `managers.json` holds the national IDs and is never committed |
| `Guides\دفاتر إيصالات الطلبات المباشرة - ملخص للإدارة.pdf` | management summary, 4 pages |
| `Guides\دليل العمل - إيصالات الطلبات المباشرة - لمديري المناطق.pdf` | area managers' guide, 3 pages |
| `Guides\عينة دفتر - دفتر 01 القاهرة - إيصالان للعرض.pdf` | sample book, 7 pages, 1.1 MB, codes NOT in Phoenix |
| `Guides\مسودة الإيميل - مقترح دفاتر الإيصالات.txt` | the Arabic proposal email draft (5 attachments) |
| `Guides\تعليمات الطباعة - للمطبعة.pdf` | printer's instructions, 2 pages: spec, 3-part sets, proof copier test, secrecy |
| `Guides\اختبار ورق الأمان - ماكينة التصوير.pdf` | security-paper copier test: instructions + one sample receipt (codes NOT in Phoenix) |
| `Guides\_img\desk-top.png`, `desk-bottom.png` | real screenshots of Finance's desk |

A copy of both generators is in this skill's `generator/` folder, so they survive the laptop. To use the copy,
put `managers.json` beside it. Each script finds the repo four folders up from itself, so its libraries resolve
from any checkout. A copy kept outside the repo needs `PHOENIX_REPO=<checkout>`, and `CHROME=<chrome.exe>` sets
the browser on another machine.

## The books

- 16 books × 50 receipts = **800**, serials `000001`–`000800`.
- Books 01–14 belong to the 14 District Managers. Each one's name, line and area is printed on every page.
- Books 15–16 are spares, for a new manager or an area without a book.
- No book for now: the manager who resigned, and the National Sales Manager (his orders are rare).
- Each receipt has three parts:
  - **Original**: stays in the book.
  - **Copy 1**: goes to the customer (the delivery venue).
  - **Copy 2**: stays in the book.
- Printed on every page:
  - the serial;
  - a 6-character check code. Its alphabet is `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, so there is no 0/O or 1/I;
  - the holder;
  - the venue's acknowledgement text;
  - five rules.
- **Security marks on every page:**
  1. 🔴 **The copy mark is the PAPER: ready-made anti-copy (VOID) security paper for Original 1 and Original 2**
     (owner, 28 Nov 2026 ~02:00 Cairo, his pick: "Ready-made anti-copy paper"; his words: "a sign … not appear if
     print original; if this original is then scanned or printed it has a mark that shows it's not the original").
     The press buys it; its own pre-printed pattern shows a word (VOID, COPY …) on any photocopy or scan while the
     original looks plain. Nothing in the files draws it. The customer copy is plain white NCR.
     - 🔴 **The yellow «أصل · ORIGINAL» ground is DROPPED — never bring it back** (built 27 Nov ~23:58, dropped 28 Nov
       ~02:00). On the owner's black-and-white copier the copy KEPT the yellow ("الابيض والاسود كل حاجه بطبع التاني
       عادي"), so a copy still said «أصل» — worse than no mark. The only proof had been a brightness simulation.
     - 🔴 **The drawn hidden "photocopied — not valid" word (void pantograph) is DROPPED too — never bring it back.**
       On his office laser and copier (27 Nov, three test sheets) it showed on the print itself, or on neither: an
       office laser cannot print the fine dots. Ready-made VOID paper is that same mark made by a security printer.
       A stuck-on hologram (peeled and reused) and a raised seal (re-made by any seal maker) were rejected too.
  2. **The serial in red** (`#C8102E`).
  3. **Every signature line says «بالقلم الأزرق»**.
  4. **Guilloche seal per receipt.** Its rosette is seeded from the serial and code, so no two of the 800 match.
     The serial and code run round its ring.
  5. 🔴 **Visible watermark — DROPPED** (owner, 28 Nov 2026: «من غير علامة مائية، من غير اللون الاصفر … اهم حاجة تبقى
     الدفاتر عادية»). The large pale rosette behind the items table is gone; never bring it back.
  6. **Microtext line** at 2.6 pt: `SATOPHARMA` + serial + code + part, repeated. It reads as a hairline. Never
     claim a copy loses it: his copier keeps what the eye can see.
  7. **QR code = a Phoenix link**, `https://phoenix-hr.satopharma.com/r/<serial>-<code>` (owner, 28 Nov 2026:
     «كيو ار كود يقرا فينيكس ده اساسي»). A scan asks for a sign-in; signed in, a used receipt opens its order
     (`/admin/direct-orders/<id>`, which keeps its own scope rule), any other says genuine-unused, cancelled or
     not genuine. Page `app/r/[receipt]/page.tsx`; rules `receiptScanPath` / `decideReceiptScan` in `receipt-rules.ts`.
     A photocopy carries the same link — the one-use code in Phoenix is what stops it, never the QR.
- **Print spec, written by Claude on 27 Nov and NOT yet confirmed by the owner or the printer:**
  - each receipt is a 3-part self-copying (NCR) set: the two originals on anti-copy VOID paper, the customer copy white;
  - the order is Original on top, then Copy 1, then Copy 2;
  - only the Copy 1 ply is perforated to tear out;
  - the cover and 50 sets are bound in file order and cannot be taken apart;
  - spoiled pages go back to Finance, and the files are deleted from the printer's machines.
- **Printing conditions (in the email):**
  - Original 1 and Original 2 on ready-made anti-copy (VOID) security paper; print the files as they are, with no
    scaling and no image "enhancement".
  - **Photocopy one receipt of the printer's proof BEFORE the full run**: the paper's word must show on the copy and
    not on the original. No paper test yet.

## 🔴 Two originals and a copy (owner, 27 Nov 2026 ~17:10) — the design every sheet moves to

After Dr Anwar asked what the original and Copy 2 were for, the owner settled it: «نخليه 3 نسخ… نسخة في الدفتر
ونسخة يشحنها لأحمد المراغي ونسخة مع الصيدلي», then the final design:

- **Original 1 — the manager's custody page.** He signs that he received the goods (date, value), that they are
  in his custody and that not delivering them is a breach of trust; the law articles are printed on it (drafted
  from Labour Law 14/2025 and Penal Code art. 341, strong, for the lawyer to approve — never an invented article
  number). It stays in the book; its photo goes on Phoenix.
- **Original 2 — the customer's delivery page.** No manager details. The customer signs and stamps it; its carbon
  copy is torn off for the customer. The manager keeps Original 2 and enters its photo.
- **Due dates** count from the day after Ahmed El Maraghy records the warehouse exit: Original 1 in 3 calendar
  days, Original 2 in 6 working days, Friday off. Phoenix verifies both, and a photo on Phoenix is not an original, so
  Finance prints the "verified on Phoenix" page for its file instead.
- Phoenix side: PR 844 (`docs/direct-order-receipt-books.md`, "Two originals and a copy").
- **Optional book — the owner's sentence, 27 Nov ~18:45, "add this sentence every where":** «استلام الدفاتر اختياري،
  وفي حالة عدم الاستلام لا يحق للمدير عمل أي أوردر بيع مباشر نهائيًا.» It is `OPTIONAL_AR` in both generator
  files: rule 1 on the book cover, a paragraph on the custody acknowledgement, the summary's first rows and the
  managers' guide's lead and first rule; both videos and the email carry it too. Never drop it from a rebuild.
- **Paper rebuilt 27 Nov ~18:30–19:00** in `_staging-two-originals/` (`books-v2`, `sample-v3`, `guides-v2`):
  the two zones are pinned with `position:absolute` (zone A bottom 61.4mm, height 78mm; zone B bottom 15mm,
  height 44mm), so the three sheets line up; the spill check also fails on zone overlap, content leaving a zone,
  and a part line that wraps. 16 × 151 pages, 800 of 800 codes on all three sheets, register sha unchanged.
- **The videos speak Egyptian colloquial** (owner, 27 Nov ~19:05: "pure arabic local egyptian voice"): Gemini's
  "Charon" voice through `~/.claude/scripts/speak-arabic-reply.py`, never the Salma fallback; check a narration by
  transcribing it before sending.

## Phoenix (PR 812, live since 27 Nov 00:23)

- Tables `direct_order_receipt_books` and `direct_order_receipts`. All 800 codes are seeded on production.
- When this was written, all 16 books stood **"With Finance"** with 0 used. **Nothing is accepted from a book
  until Finance records the hand-over.** So Ahmed's first action is "Hand to <name>" on the day each book changes
  hands.
- **Finance's desk:** Direct Orders → Receipt Books, at `/admin/direct-orders/receipts`. It shows only for Ahmed
  El Maraghy and the Super Admin. It has six parts:
  - "Approved with no receipt": red once an original is past its due date (PR 844; before it, 7 days from approval).
  - "Approved with no receipt book" (PR 829, owner 27 Nov: "Flag them"): from the first hand-out on, every
    approved order raised by someone who held no book that day. Nothing before the first hand-out is listed.
  - The 16 books, with these buttons:
    - "Hand to <name>";
    - "Hand out" (for a spare, after choosing a manager);
    - "Returned to Finance";
    - "Record lost": cancels the book's unused receipts, in one database call. Works on a spare still in store too
      (the first version's database check refused that).
    - A red line under the counts: how many approved orders still owe a receipt from that book.
  - "Without a receipt — N waiting for the CEO, N approved" (PR 840): every order Finance asked to stand
    without a receipt, with its reason. Finance asks from the order's own page ("Ask the CEO to approve it
    without a receipt"); only the CEO decides.
  - "Cancel a spoiled receipt": a used receipt can never be cancelled.
  - "Receipts entered and cancelled".
- **The receipt panel ("DELIVERY RECEIPT")** sits under the order detail, on both order pages.
  - It renders NOTHING while the order needs no receipt. That means an order approved before its manager's book
    was handed over, or a manager with no book.
  - So the real entry screen cannot be photographed until the first book is handed out.
  - Its labels:
    - "From book N (range). A receipt proves one order only and can never be used again."
    - "Receipt number*", with the hint "Six digits, at the top of the page".
    - "Code beside the number*", with the hint "Six letters and digits".
    - "Photograph the signed page" / "Choose file".
    - The orange "Save the receipt".
- **What Phoenix refuses** (checked in this order: the order, the book's custody, the code, then used/cancelled;
  a wrong code is always refused before "already used", so guessing learns nothing):
  - an order that is not approved, or already has a receipt;
  - an unknown serial;
  - a book not handed out, or lost, or another manager's;
  - a RETURNED book, unless the order was approved while the manager held it (late entry, owner 27 Nov:
    "Allow late entry");
  - a wrong code;
  - a receipt already used, or cancelled.

  Every refusal is logged on the order, including not allowed, a bad serial, a bad code, a bad photo and a lost
  race, and never with the typed code. The exact messages, with what each one means, are in the guide's section 5.
- **The undo** (PR 829, owner 27 Nov: "make an undo option"): on an order with a receipt, Finance and the Super
  Admin see "Undo — entered on the wrong order". A written reason is required. The receipt goes back to unused for
  the right order; the reason, the photo and who entered it are kept in `direct_order_receipt_releases`, the audit
  log and the order's history. The manager cannot undo his own entry.
- **The database guards the paper too** (migration `20261127121951`): a used receipt goes back to unused only
  through `direct_order_release_receipt`; a cancelled one stays cancelled; a claim re-reads its book (a book lost
  while the photo uploads refuses the claim); serials, codes and ranges never change; nothing is ever deleted; a
  book moves only in store → issued or lost, issued → returned or lost. A hand-out names an employee still at work.

## The guides (`_generator/guides.mjs`)

- Run with `node guides.mjs "<Guides folder>"`. It uses puppeteer-core with headless Chrome, which prints LOCAL
  HTML, so it is allowed. Check every page with `pdftoppm -r 80`.
- It refuses to start unless the Guides folder holds `_img\desk-top.png`, `_img\desk-bottom.png` and the
  sample book. It writes the four PDFs, then builds the copier test with pdf-lib. That file is
  `_copier-test-page1.pdf` plus page 2 of the sample book (receipt 1's Original).
- **The management summary**, "ملخص للإدارة — الإدارة العليا والمالية". Dr Anwar is the CEO, so the header does
  not say "Chairman". Its sections:
  1. What was prepared.
  2. What Phoenix refuses.
  3. Protection of the paper itself.
  4. Who does what.
  5. The cycle in 5 steps, plus notes.
  6. Finance's screen, with the two real screenshots.
- **The area managers' guide:**
  1. Know your receipt, with the sample.
  2. On paper.
  3. On Phoenix within 7 days. This section has the panel DRAWING, captioned as a drawing. Its note says a
     late receipt stops the manager's new orders and the final approval of his waiting ones.
  4. Rules, with the 27 Nov rules: a late receipt blocks; nothing paid on the same product, no second order;
     part-paid or a late payer, only Dr Anwar finishes it; an order without a receipt only with his approval.
  5. Refusal messages, with the two new ones ("… no new order can be raised until then", "This pharmacy has
     not paid anything on its earlier order of …").
- The guides were rebuilt for these rules on 27 Nov ~16:20, after PR 840 shipped. The 14-day versions are in
  the Guides folder's `_old versions - not for use.zip`.
- Screenshots come from the spare's live page, signed in as Super Admin role-only, in the browser pane.
- **Swap the drawing for a real screenshot once the first book is handed out.**

## The sample book

- Made by running `build.mjs <new empty folder> --sample`.
  - It refuses a folder that holds a `register.json`, mints throwaway codes and never saves them.
  - It writes no custody acknowledgements, no register and no previews, so the folder holds only the sample.
- An empty folder has no `register.json`, so the run mints fresh random codes. Those codes are not in Phoenix,
  which is exactly what a sample needs.
- Before copying the sample out, confirm that none of its codes equals a real one.

## The proposal email (draft only; the owner sends it himself)

- To Dr Anwar Gaweesh and Ahmed El Maraghy, from Omar Gawish, HR Manager. Its sections:
  1. What changes: the approval cycle is unchanged.
  2. What was prepared.
  3. How the receipts are protected: (a) on the paper, the 6 marks; (b) on Phoenix, 9 checks.
  4. Work steps.
  5. Roles.
  6. Points for their decision, including the sales-month question.
  7. What is needed: approval, printing under the two conditions, the hand-over.
- Five attachments: the summary, the guide, the custody acknowledgements, the sample book and the printer's
  instructions (`تعليمات الطباعة - للمطبعة.pdf`). The email's request for printing depends on that last one. The
  full books are deliberately not attached, and the email says why.
- Never send it from a business system. It is his to send.

## Still open (when he asks)

- ✅ **Rebuilt on 27 Nov 2026, 11:55 Cairo, with the cover fix.**
  - Cover rules 2 and 5 now say the receipt proves delivery, not that a sale "is not counted"; the money question
    stays with the management. The year on the date lines is blank (`20.....`).
  - What was rebuilt: the 16 books, the custody PDF, the register workbook and the sample book.
  - `register.json` is unchanged (sha256 `34abe243…`), and all 800 codes were found in the new books.
  - The new sample's 2 codes match no real code.
  - The old files are in `_superseded v2 - old cover wording\` and `Guides\_superseded - old cover wording\`.
    Never print them.
  - The copier test still carries a receipt page from the OLD sample. That page is unaffected (no cover, fake codes).

- ✅ **The guides and the email draft were updated on 27 Nov 2026, 12:32 Cairo, for PR 829.**
  - The guides now say: a returned book's page is accepted only for an order approved while the manager held it;
    an order raised with no book is flagged at Finance; Finance alone can undo a receipt entered on the wrong
    order, with a reason. The managers' guide's section 5 gained "… reported lost" and "… while the photo was
    uploading" rows. Page counts are unchanged (summary 4, guide 3).
  - The copier test was rebuilt with them, so its receipt page now comes from the NEW sample.
  - The old files are in `Guides\_superseded - before late entry\`. The generator copy in `_generator\` is the
    same as this skill's `generator/guides.mjs`; run it with `PHOENIX_REPO` set to the primary checkout.

- ✅ **Rebuilt on 28 Nov 2026, ~00:20 Cairo, with the yellow «أصل» in place of the hidden word** (owner, 27 Nov
  ~23:58: "Rebuild the books").
  - What was rebuilt: the 16 books, the summary, the managers' guide, the printer's instructions, the sample book,
    the copier test (now `اختبار أصل الصفراء - ماكينة التصوير.pdf`) and the management video's scenes 4, 5, 6, 10
    and 15.
  - `register.json` is unchanged (sha256 `34abe243…`); `vp/verify-yellow.py` read all 800 codes back on all three
    sheets of every receipt, and the yellow on Original 1 and Original 2 only.
  - The old books are in `_superseded v3 - hidden word (pale blue)\`; the old guides, the five hidden-word test
    sheets and the old management video are in `Guides\_superseded - hidden word\`. Never print them.
  - The custody PDF and the register workbook were not swapped: neither carries the yellow.

- ✅ **Rebuilt on 28 Nov 2026, ~02:20 Cairo, WITHOUT the yellow, for anti-copy paper** (owner's pick, ~02:00).
  - Rebuilt: the 16 books, the sample, the summary, the printer's instructions (a new «الورق» row), the copier
    test (now `اختبار ورق الأمان - ماكينة التصوير.pdf`) and the management video's scenes 4, 6 and 15.
  - `register.json` unchanged (sha256 `34abe243…`); all 800 codes read back on all three sheets; 0 yellow pixels.
  - The yellow books are in `_superseded v4 - yellow ground\`, the yellow guides and video in
    `Guides\_superseded - yellow ground\`. Never print them.
  - The managers' guide still names no security mark.

- ✅ **Rebuilt on 28 Nov 2026, ~03:30 Cairo, with NO visible watermark and the QR as a Phoenix link** (owner, ~02:30:
  «سيب الكيو ار وسيب … الحاجات المتامنه، يعني امن نفسك بس بحاجه غير العلامه المائيه وغير اللون الاصفر»).
  - Kept: the per-receipt seal, the microtext, the red serial, «بالقلم الأزرق», the secret code and the QR.
  - The owner asked which press options need a special request: UV ink, impressed numbering and thermochromic ink
    all do, so none is in the files; he asked for every protection that needs NO special request.
  - The watermark books are in `_superseded v5 - watermark\`. Never print them.

- The physical copier test. Two ways to do it:
  - on a sheet of the press's security paper: `اختبار ورق الأمان - ماكينة التصوير.pdf`, page 2, printed on it at
    100%, then photocopied and scanned (the paper's word must show on both);
  - on the printer's proof, before the full run.
  A session cannot do this test.
- Swapping the guide's drawing for the real entry screen after the first hand-over.
  - Production renders no panel until a book is issued.
  - Staging has the tables and the 800 rows, but `/api/dev-auth` answers 404 there, so a session cannot sign in to
    photograph it.
  - Never record a fake hand-over on production to get the picture.
- The book files' route to the printer: USB is proposed.
- Dr Anwar and Ahmed's decision on whether a missing receipt holds the sales month. An order may now stand
  without a receipt only once Dr Anwar approves it in Phoenix.
- The management video (scene 13) and its covering message still ask them to decide the missing-receipt
  question. Update both once the owner finishes his edits.
