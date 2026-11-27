---
name: direct-order-receipt-books
description: Everything about the direct-order delivery-receipt books (إذن تسليم وتسلم بضاعة) built on 26–27 Nov 2026 — the 16 printed books and their security marks (hidden "photocopied — not valid" watermark, per-receipt seal, microtext, QR), the register of 800 codes, the Phoenix check that ships with PR 812 (Finance's Receipt Books desk, the receipt panel on an order), the two Arabic guides (management summary, area managers' guide), the sample book, the proposal email to Dr Anwar and Ahmed El Maraghy, and what is still open. Use whenever the owner mentions receipt books, دفاتر الإيصالات, إيصال, the custody acknowledgement, the printer, the copier test, the guides, the sample book, the proposal email, or handing a book to a manager.
---

# Direct-order receipt books

Built in one session, 26 Nov 2026 19:30 to 27 Nov 2026 01:00 Cairo. It is recorded here so that no later session
has to rediscover it. The code side is module memory: the first bullet of `.claude/rules/direct-orders.md`.

## His words, and what is NOT decided

- 26 Nov ~19:30: "Build the check". Book owner: **"Finance"**, meaning Ahmed El Maraghy. Flag an approved order
  with no receipt after **"14 days"**.
- 27 Nov ~00:15: "Merge 812". PR 812 merged at 00:18 (merge sha `efbccb86b`) and served from 00:23. The error
  check stayed CLEAN for 15 minutes.
- **NOT decided, and never decided in chat (money):** whether a missing receipt stops the order counting in that
  month's sales or collection. Today it does not; the receipt proves and flags only. The proposal email puts
  this to Dr Anwar and Ahmed El Maraghy as THEIR decision.
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
- **Leave the hidden marks out of the area managers' guide.** The managers are the people the receipts check.
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
| `void-pantograph-600dpi.png`, `preview-*.png` | the hidden-watermark layer, and previews (real codes: never share) |
| `_superseded v1 - no copy mark\` | the first build, before the hidden watermark: never print it |
| `_generator\build.mjs`, `guides.mjs`, `managers.json` | the generators; `managers.json` holds the national IDs and is never committed |
| `Guides\دفاتر إيصالات الطلبات المباشرة - ملخص للإدارة.pdf` | management summary, 4 pages |
| `Guides\دليل العمل - إيصالات الطلبات المباشرة - لمديري المناطق.pdf` | area managers' guide, 3 pages |
| `Guides\عينة دفتر - دفتر 01 القاهرة - إيصالان للعرض.pdf` | sample book, 7 pages, 1.1 MB, codes NOT in Phoenix |
| `Guides\مسودة الإيميل - مقترح دفاتر الإيصالات.txt` | the Arabic proposal email draft |
| `Guides\_img\desk-top.png`, `desk-bottom.png` | real screenshots of Finance's desk |

A copy of both generators is in this skill's `generator/` folder, so they survive the laptop. To use the copy,
put `managers.json` beside it.

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
  1. **Hidden watermark (void pantograph).** «مُصوَّر — غير صالح» is printed three times, rotated −14°, at 600 dpi.
     - Outside the words: 1-pixel dots on a 2-pixel grid. These are too fine for a copier to keep.
     - Inside the words: 4×4 dots on an 8-pixel grid, which a copier keeps.
     - Both cover ¼ of the area, so the original reads as one even tint, and a photocopy or scan shows the words.
     - A PDF zoomed out ON SCREEN shows them too. That is normal, and the email warns about it.
  2. **Guilloche seal per receipt.** Its rosette is seeded from the serial and code, so no two of the 800 match.
     The serial and code run round its ring.
  3. **Visible watermark**: the same rosette, large and pale, behind the items table.
  4. **Microtext line** at 2.6 pt: `SATOPHARMA` + serial + code + part, repeated. It reads as a hairline and does
     not survive a copy.
  5. **QR code** carrying `SATO-DO|<serial>|<code>`. Phoenix does not scan it yet, so never claim it does.
- **Printing conditions (in the email):**
  - Print the files as they are, at 600 dpi, with no scaling and no image "enhancement".
  - **Photocopy one page of the printer's proof BEFORE the full run** and confirm the hidden words appear.
  - 🔴 This physical copier test has NOT been done yet.

## Phoenix (PR 812, live since 27 Nov 00:23)

- Tables `direct_order_receipt_books` and `direct_order_receipts`. All 800 codes are seeded on production.
- When this was written, all 16 books stood **"With Finance"** with 0 used. **Nothing is accepted from a book
  until Finance records the hand-over.** So Ahmed's first action is "Hand to <name>" on the day each book changes
  hands.
- **Finance's desk:** Direct Orders → Receipt Books, at `/admin/direct-orders/receipts`. It shows only for Ahmed
  El Maraghy and the Super Admin. It has four parts:
  - "Approved with no receipt": red after 14 days.
  - The 16 books, with these buttons:
    - "Hand to <name>";
    - "Hand out" (for a spare, after choosing a manager);
    - "Returned to Finance";
    - "Record lost": cancels the book's unused receipts.
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
- **What Phoenix refuses:**
  - a wrong code: refused FIRST, so guessing learns nothing;
  - an unknown serial;
  - a receipt already used;
  - another manager's book;
  - a book not handed out, returned, or lost;
  - a cancelled receipt;
  - an order that is not approved;
  - an order that already has a receipt.

  Every refusal is logged on the order. The exact messages, with what each one means, are in the guide's section 5.

## The guides (`_generator/guides.mjs`)

- Run with `node guides.mjs "<Guides folder>"`. It uses puppeteer-core with headless Chrome, which prints LOCAL
  HTML, so it is allowed. Check every page with `pdftoppm -r 80`.
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
  3. On Phoenix within 14 days. This section has the panel DRAWING, captioned as a drawing.
  4. Rules.
  5. Refusal messages.
- Screenshots come from the spare's live page, signed in as Super Admin role-only, in the browser pane.
- **Swap the drawing for a real screenshot once the first book is handed out.**

## The sample book

- Made by running `build.mjs <new empty folder> --sample` from a folder WITHOUT spaces. `HERE` is
  URL-encoded, so a path with spaces fails with ENOENT on `managers.json`; copy `build.mjs` and `managers.json` to
  the scratchpad first.
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
- Attachments: the summary, the guide, the custody acknowledgements and the sample book. The full books are
  deliberately not attached, and the email says why.
- Never send it from a business system. It is his to send.

## Still open (when he asks)

- The physical copier test on a printed proof.
- Swapping the guide's drawing for the real entry screen after the first hand-over.
- The book files' route to the printer: USB is proposed.
- Dr Anwar and Ahmed's decision on whether a missing receipt holds the sales month.
