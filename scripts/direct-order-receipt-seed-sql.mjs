#!/usr/bin/env node
// Turns the receipt printer's register.json into idempotent SQL that seeds
// public.direct_order_receipt_books and public.direct_order_receipts (owner, 26 Nov 2026).
//
// The codes are printed on the paper that is the evidence, so they never enter Git: register.json
// lives beside the printed books (F:\Phoenix Workforce\Direct Order Receipt Books\register.json),
// and this script only reads it and prints SQL. Nothing is connected to; nothing is written.
//
//   node scripts/direct-order-receipt-seed-sql.mjs <path-to-register.json> > seed.sql
//
// Re-running is safe: a book or a receipt already present is left exactly as it is
// (`on conflict do nothing`), so a used or cancelled receipt is never reset.
import { readFileSync } from "node:fs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "direct-order-receipt-seed-sql",
  entry: import.meta.url,
  known: [],
});

const [file, ...rest] = process.argv.slice(2);
if (!file || rest.length > 0) {
  console.error("Usage: node scripts/direct-order-receipt-seed-sql.mjs <path-to-register.json>");
  process.exit(2);
}

const ALPHABET = /^[2-9A-HJKMNP-Z]{6}$/;
const books = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(books) || books.length === 0) throw new Error("register.json holds no books.");

const quote = (value) => (value === null || value === undefined || value === "" ? "null" : `'${String(value).replace(/'/g, "''")}'`);
const serials = new Set();
const codes = new Set();
const bookRows = [];
const receiptRows = [];
for (const book of books) {
  const bookNo = Number(book.book);
  const first = Number(book.first);
  const last = Number(book.last);
  if (!Number.isInteger(bookNo) || !Number.isInteger(first) || !Number.isInteger(last) || last < first) {
    throw new Error(`Book ${book.book} has no valid range.`);
  }
  const receipts = book.receipts ?? [];
  if (receipts.length !== last - first + 1) throw new Error(`Book ${bookNo} lists ${receipts.length} receipts for ${last - first + 1} serials.`);
  bookRows.push(`(${bookNo}, ${first}, ${last}, ${quote(book.holder?.hr_id ?? null)})`);
  for (const receipt of receipts) {
    const serial = Number(receipt.serial);
    const code = String(receipt.code ?? "");
    if (serial < first || serial > last) throw new Error(`Receipt ${serial} is outside book ${bookNo}.`);
    if (!ALPHABET.test(code)) throw new Error(`Receipt ${serial} has a code outside the printer's alphabet.`);
    if (serials.has(serial)) throw new Error(`Receipt ${serial} appears twice.`);
    if (codes.has(code)) throw new Error(`Code on receipt ${serial} repeats another receipt's.`);
    serials.add(serial);
    codes.add(code);
    receiptRows.push(`(${serial}, ${bookNo}, '${code}')`);
  }
}

process.stdout.write(
  [
    "begin;",
    "insert into public.direct_order_receipt_books (book_no, first_serial, last_serial, printed_holder_hr_id) values",
    `  ${bookRows.join(",\n  ")}`,
    "on conflict (book_no) do nothing;",
    "insert into public.direct_order_receipts (serial, book_no, check_code) values",
    `  ${receiptRows.join(",\n  ")}`,
    "on conflict (serial) do nothing;",
    "commit;",
    "",
  ].join("\n"),
);
console.error(`${bookRows.length} books, ${receiptRows.length} receipts, ${codes.size} distinct codes.`);
