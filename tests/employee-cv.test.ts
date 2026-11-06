import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALLOWED_CV_TYPES,
  EMPLOYEE_CV_ACCEPT_ATTRIBUTE,
  MAX_EMPLOYEE_CV_BYTES,
  employeeCvHref,
  extensionForCvContentType,
  isAllowedCvContentType,
} from "../src/lib/employees/employee-cv-limits.ts";
import { canDownloadEmployeeCv, employeeCvReaderRoles } from "../src/lib/employees/employee-cv.ts";
import {
  CRM_ACCOUNT_SETUP_CV_CTA_LABEL,
  NO_CV_ON_FILE,
  crmAccountSetupCvHref,
  crmAccountSetupDetails,
  crmAccountSetupEmailSummary,
  crmAccountSetupMessage,
  hasCvOnFile,
  type CrmAccountSetupSubject,
} from "../src/lib/crm/account-setup-messages.ts";
import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";

const ROOT = process.cwd();

function subject(overrides: Partial<CrmAccountSetupSubject> = {}): CrmAccountSetupSubject {
  return {
    areaName: "Cairo 1",
    cvFileName: null,
    displayName: "Test Rep",
    hireDate: "2026-09-01",
    hrId: "B-999",
    jobTitle: "Medical Representative",
    lineName: "CNS",
    managerName: "Test Manager",
    mobileNumber: "01000000000",
    regionName: "Cairo",
    workEmail: "test.rep@satopharma.com",
    ...overrides,
  };
}

function accessFor(role: PhoenixRole, overrides: Partial<AccessContext> = {}) {
  return {
    role,
    scope: "self",
    source: "session",
    ...overrides,
  } as Pick<AccessContext, "role" | "scope" | "source">;
}

/**
 * The CV on the employee master record — owner instruction 2026-09-09.
 *
 * WHAT IS WORTH PINNING HERE, and what is not. Nothing in this file talks to Supabase: the
 * assertions are about the two things that could regress invisibly in production.
 *
 *   1. WHO CAN OPEN THE LINK. The SFE Manager holds neither `employees` nor `employee_documents`.
 *      A later tidy-up that "aligns" this with the neighbouring document routes would put a 403
 *      behind the button in his own notice — and that failure is invisible from every other seat,
 *      because Super Admin (the seat any test is likely to be run from) can open it either way.
 *
 *   2. THE ORDER OF THE TWO STEPS ON CREATE. The CV must be attached BEFORE the notice is
 *      composed. Reversed, the notice reads "Not attached" about somebody whose CV landed a
 *      second later, the download button is absent, and nothing errors anywhere.
 */
export function runEmployeeCvTests() {
  // ── 1. the seats the owner named, and nobody else ─────────────────────────────────────────
  assert.deepEqual(
    [...employeeCvReaderRoles].sort(),
    ["HR Administration", "HR Operations", "SFE Manager", "Super Admin"],
    "the owner named Super Admin, SFE Manager, the HR Business Partner and HR Operations; the HR Business Partner seat was retired on 2026-10-08, and the HR Operations Specialist (HR Administration) joined on 2026-11-06",
  );

  for (const role of employeeCvReaderRoles) {
    assert.equal(canDownloadEmployeeCv(accessFor(role)), true, `${role} must be able to download an employee CV`);
  }

  // THE HR OPERATIONS SPECIALIST FILES CVs, SO SHE MUST BE ABLE TO OPEN ONE (owner, 2026-11-06).
  // Her people_master function holds `employees:update`, which is the write gate on this route —
  // left off this set, she attached a CV through the bulk upload and then met a 403 on the details
  // panel's "is one on file" read for the very person she had just filed it for.
  assert.equal(
    canDownloadEmployeeCv(accessFor("HR Administration")),
    true,
    "the HR Operations Specialist attaches and removes CVs; refusing her the read leaves her filing documents she cannot see",
  );

  // THE SFE MANAGER IS THE ASSERTION THIS FILE EXISTS FOR. He receives the notice and owns the
  // screen it lands on, and he holds no employee-master grant at all — so any gate written in
  // terms of `employees` or `employee_documents` refuses exactly the person it was built for.
  assert.equal(
    canDownloadEmployeeCv(accessFor("SFE Manager")),
    true,
    "the SFE Manager receives this notice; a gate that refuses him defeats the whole feature",
  );

  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Training Manager", "Finance Manager", "CEO", "Employee"] as const) {
    assert.equal(
      canDownloadEmployeeCv(accessFor(role)),
      false,
      `${role} was not named by the owner and must not be able to download an employee CV`,
    );
  }

  // An unauthenticated caller resolves to role "Employee" with source "guest" rather than to null,
  // so the guest test is the one doing the work. Asserted against a role that IS on the list, so
  // it cannot pass merely because "Employee" happens to be excluded.
  assert.equal(
    canDownloadEmployeeCv(accessFor("Super Admin", { source: "guest" })),
    false,
    "a guest context must be refused even when its role is on the list",
  );
  assert.equal(
    canDownloadEmployeeCv(accessFor("Employee", { scope: "system" })),
    true,
    "a system-scope caller is the platform itself and reads everything",
  );

  // ── 2. the CV goes on the record BEFORE the notice is composed ────────────────────────────
  const employeesRoute = readFileSync(join(ROOT, "app/api/employees/route.ts"), "utf8");
  const attachAt = employeesRoute.indexOf("attachEmployeeCvOnCreate(");
  const announceAt = employeesRoute.indexOf("openAndAnnounceCrmAccountSetup(");
  assert.ok(attachAt > 0, "the create route must attach the CV");
  assert.ok(announceAt > 0, "the create route must still announce the new hire");
  assert.ok(
    attachAt < announceAt,
    "the CV must be attached BEFORE the notice is composed — reversed, the notice says 'Not attached' about somebody whose CV arrived a second later, with no error anywhere",
  );
  assert.match(
    employeesRoute,
    /isNewEmployee[\s\S]{0,200}?attachEmployeeCvOnCreate\(/,
    "the CV attach must sit on the CREATE branch — an edit that re-attached would overwrite a replaced CV on every save",
  );

  // ── 3. the CV row is ALWAYS present, and says what the file is called ─────────────────────
  const without = crmAccountSetupDetails(subject());
  const withCv = crmAccountSetupDetails(subject({ cvFileName: "Ahmed-Hassan-CV.pdf" }));
  assert.equal(without.length, withCv.length, "the CV row must be present either way, never conditional");
  assert.equal(
    without.find((detail) => detail.label === "CV")?.value,
    NO_CV_ON_FILE,
    `no CV must read "${NO_CV_ON_FILE}" — a row that vanished would make "this hire has no CV" look like "this notice predates the feature"`,
  );
  assert.equal(
    withCv.find((detail) => detail.label === "CV")?.value,
    "Ahmed-Hassan-CV.pdf",
    "the reader decides whether to open the CV from what it is called, so the notice carries the filename",
  );
  assert.equal(without.at(-1)?.label, "CV", "the CV row goes last, after the nine facts the owner named in 2026-09");

  assert.equal(hasCvOnFile(subject()), false);
  assert.equal(hasCvOnFile(subject({ cvFileName: "   " })), false, "whitespace is not a filename");
  assert.equal(hasCvOnFile(subject({ cvFileName: "cv.pdf" })), true);

  // The email's opening paragraph mentions the CV only when there is one — an email that promises
  // a second button that is not rendered is worse than one that says nothing.
  assert.ok(
    crmAccountSetupEmailSummary(subject({ cvFileName: "cv.pdf" })).includes("cv.pdf"),
    "the summary names the CV when one is attached",
  );
  assert.ok(
    !/CV is attached/i.test(crmAccountSetupEmailSummary(subject())),
    "the summary must not mention a CV when there is none",
  );

  // Standing owner rule: nothing is ever truncated with an ellipsis.
  for (const text of [...withCv.map((d) => `${d.label}${d.value}`), crmAccountSetupEmailSummary(subject({ cvFileName: "cv.pdf" })), CRM_ACCOUNT_SETUP_CV_CTA_LABEL]) {
    assert.ok(!text.includes("…"), `the CV notice must never truncate with an ellipsis: ${text}`);
  }

  // ── 3b. the IN-APP reader learns about the CV, which the detail rows alone cannot tell him ─
  // notificationDetails() caps a notification at its first EIGHT rows. This notice carries ten, so
  // the CV row never reaches the bell menu — the sentence in the body is the only thing that does.
  // Pinned here because the sentence looks like a duplicate of the row and would be "tidied away".
  const metrics = readFileSync(join(ROOT, "src/lib/communication/metrics.ts"), "utf8");
  assert.match(
    metrics,
    /return rows\.slice\(0, 8\);/,
    "the in-app detail cap is 8 rows — if this changed, re-check whether the CV row now survives on its own",
  );
  assert.ok(
    crmAccountSetupDetails(subject({ cvFileName: "cv.pdf" })).findIndex((detail) => detail.label === "CV") >= 8,
    "the CV row sits beyond the in-app cap, which is exactly why the body must name the CV too",
  );
  assert.ok(
    crmAccountSetupMessage(subject({ cvFileName: "Ahmed-CV.pdf" })).includes("Ahmed-CV.pdf"),
    "the in-app body must name the CV — it is the only place the bell menu can learn there is one",
  );
  assert.ok(
    !crmAccountSetupMessage(subject()).includes("CV"),
    "with no CV attached the body must not mention one",
  );

  // ── 4. the two copies of the download URL agree ───────────────────────────────────────────
  // account-setup-messages.ts deliberately imports nothing, so it spells the route out rather than
  // importing employeeCvHref. That is a second copy of a URL, and this is the thing that keeps it
  // honest — without it a route rename half-lands and the notice's button 404s.
  assert.equal(
    crmAccountSetupCvHref("B-999"),
    employeeCvHref("B-999"),
    "the notice's link and the app's own helper must resolve to the same route",
  );
  assert.equal(crmAccountSetupCvHref("B-999"), "/api/employees/B-999/cv");
  assert.equal(
    crmAccountSetupCvHref("B/9"),
    "/api/employees/B%2F9/cv",
    "an HR ID is URL-encoded, so a stray separator cannot point the link at another route",
  );

  // ── 5. the download route refuses a guest and gates writes separately ─────────────────────
  const cvRoute = readFileSync(join(ROOT, "app/api/employees/[hrId]/cv/route.ts"), "utf8");
  assert.match(cvRoute, /canDownloadEmployeeCv\(access\)/, "the download must be gated on the named reader set");
  assert.match(
    cvRoute,
    /assertPermission\(access, "employees", "update"\)/,
    "attaching, replacing or removing a CV is an edit to the employee master record",
  );
  assert.match(
    cvRoute,
    /assertSameOriginMutation\(request\)/,
    "every mutation on this route carries the same-origin guard",
  );
  assert.ok(
    !/canSeeEmployee\([\s\S]{0,80}?streamEmployeeCv/.test(cvRoute),
    "the READ path must not be narrowed by canSeeEmployee — the SFE Manager sees almost nobody through it, which would refuse the person the notice is addressed to",
  );

  const stagingRoute = readFileSync(join(ROOT, "app/api/employees/cv-staging/route.ts"), "utf8");
  assert.match(
    stagingRoute,
    /assertPermission\(access, "employees", "update"\)/,
    "staging a file is gated on the same grant the Add Employee form itself requires",
  );

  // ── 6. the client component must not drag the server module into the browser ──────────────
  // employee-cv.ts imports node:crypto and the service-role client. A component importing a
  // constant from it fails the webpack build, and the error names neither the import nor the
  // reason — so this assertion is cheaper than rediscovering it.
  const controls = readFileSync(join(ROOT, "src/components/employees/employee-cv-controls.tsx"), "utf8");
  assert.ok(
    !/from "@\/lib\/employees\/employee-cv"/.test(controls),
    "a client component must import from employee-cv-limits, never from the server module beside it",
  );
  assert.match(controls, /from "@\/lib\/employees\/employee-cv-limits"/);

  // ── 7. what a CV may be — one list, three places ──────────────────────────────────────────
  const migration = readFileSync(
    join(ROOT, "supabase/migrations/20260909210000_employee_cv_master_record.sql"),
    "utf8",
  );
  for (const contentType of ALLOWED_CV_TYPES.keys()) {
    assert.ok(
      migration.includes(`'${contentType}'`),
      `the bucket's allow-list must carry ${contentType}, or the code accepts a file storage then refuses`,
    );
    assert.equal(isAllowedCvContentType(contentType), true);
    assert.ok(
      EMPLOYEE_CV_ACCEPT_ATTRIBUTE.includes(extensionForCvContentType(contentType)),
      `the file picker's accept list must offer .${extensionForCvContentType(contentType)}`,
    );
  }
  assert.equal(isAllowedCvContentType("application/zip"), false);
  assert.equal(isAllowedCvContentType(""), false);
  assert.equal(isAllowedCvContentType(null), false);
  assert.equal(
    isAllowedCvContentType("APPLICATION/PDF"),
    true,
    "a browser may report the type in any case, and refusing a real PDF over capitalisation is a support call",
  );
  assert.ok(
    migration.includes(String(MAX_EMPLOYEE_CV_BYTES)),
    "the bucket's size limit and the code's must be the same number, or one of them is decoration",
  );

  // The bucket is private. This is the assertion that matters most in this file after the access
  // one: `public = true` here would put every employee's CV behind a guessable URL.
  assert.match(
    migration,
    /'employee-cvs',\s*'employee-cvs',[\s\S]{0,400}?false,/,
    "the employee-cvs bucket must be created PRIVATE",
  );
  assert.match(migration, /set public = false/, "and must be forced private again on a re-run");

  for (const column of ["cv_path", "cv_file_name", "cv_content_type", "cv_size_bytes", "cv_uploaded_at", "cv_source"]) {
    assert.ok(migration.includes(column), `the migration must add ${column}`);
  }

  // ── 8. the email's second button renders only when BOTH halves are set ────────────────────
  // A label with no href is a dead button; an href with no label is an unnamed one. Either alone
  // must render the email that was always rendered.
  const emailModule = readFileSync(join(ROOT, "src/lib/notifications/email.ts"), "utf8");
  assert.match(
    emailModule,
    /if \(!href \|\| !label\) return undefined;/,
    "the secondary action must require both halves",
  );
  const layout = readFileSync(join(ROOT, "src/emails/phoenix-email-layout.tsx"), "utf8");
  assert.match(
    layout,
    /renderPhoenixAction\(input\.secondaryAction/,
    "the layout must render the secondary action",
  );

  // ── 9. the notice offers the button only when a CV exists ─────────────────────────────────
  const notify = readFileSync(join(ROOT, "src/lib/crm/account-setup-notify.ts"), "utf8");
  assert.match(
    notify,
    /hasCvOnFile\(subject\) \? crmAccountSetupCvHref\(subject\.hrId\) : null/,
    "a download button that answers 404 teaches the reader to stop trusting the button",
  );
  assert.match(
    notify,
    /secondaryCtaLabel: cvHref \? CRM_ACCOUNT_SETUP_CV_CTA_LABEL : null/,
    "the label follows the link, so the two can never disagree",
  );
}
