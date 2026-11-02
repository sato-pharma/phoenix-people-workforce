import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A payroll download is a plain anchor, never next/link.
 *
 * Link fetches its address as soon as it scrolls into view, and these addresses are real exports: the
 * smoke test only opened /payroll on 31 Oct 2026 and its browser pulled every employee's bank file,
 * which wrote "Bank transfer file downloaded" under its login, and a person opening the page on
 * 2 Nov 2026 left a row of the same shape. prefetch={false} is NOT the cure: a click on Link still
 * fetches the address once for the router, gets a file instead of a page, then navigates to it
 * again, so one real download would write two audit rows.
 *
 * The anchor is the Button's own element (asChild), because a browser may refuse to follow an anchor
 * from a button nested inside it.
 */
const PAYROLL_PAGE_DOWNLOADS: ReadonlyArray<{ file: string; links: number }> = [
  { file: "src/components/payroll/payroll-dashboard.tsx", links: 6 },
  { file: "src/components/payroll/dashboard/payroll-history.tsx", links: 2 },
  { file: "src/components/payroll/dashboard/salary-upload-validation.tsx", links: 2 },
];

const LINK_TO_AN_API_ROUTE = /<Link\b[^>]*?href=\{?.\/api\//;
const PAYROLL_ADDRESS = /href=\{.\/api\/payroll/g;
const BUTTON_AS_THE_ANCHOR = /<Button asChild\b[^>]*>\s*<a href=\{.\/api\/payroll/g;

export function runPayrollDownloadLinksNeverPrefetchTests() {
  for (const { file, links } of PAYROLL_PAGE_DOWNLOADS) {
    const code = stripComments(readFileSync(file, "utf8"));

    assert.equal(
      LINK_TO_AN_API_ROUTE.test(code),
      false,
      `${file} draws next/link to an API route, so opening the page runs that export`,
    );
    assert.equal(
      code.match(PAYROLL_ADDRESS)?.length ?? 0,
      links,
      `${file} should offer ${links} payroll downloads; a moved one must be pinned where it went`,
    );
    assert.equal(
      code.match(BUTTON_AS_THE_ANCHOR)?.length ?? 0,
      links,
      `${file}: every payroll download is <Button asChild><a>, not an anchor around a button`,
    );
  }
}
