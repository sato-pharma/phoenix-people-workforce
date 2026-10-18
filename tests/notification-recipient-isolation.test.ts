import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canViewerSeeNotification,
  isPersonalBellCategory,
  isValidRecipientHrId,
  normalizeNotificationHrId,
  PERSONAL_BELL_CATEGORIES,
} from "../src/lib/notifications/recipients.ts";
import { mapInAppNotificationRows } from "../src/lib/communication/metrics.ts";

/**
 * P1 regression coverage: in-app notification recipient isolation. The viewer
 * visibility rule must be fail-closed (default DENY) and ignore invalid/fixture
 * recipients. The notification service/mapper are pure for this rule, so it is
 * unit-tested directly; the env-bound query path and the bell UI are locked via
 * source assertions.
 */
export function runNotificationRecipientIsolationTests() {
  const A = "A-1";
  const B = "B-2";
  const C = "C-3";

  // 1. Own employee_hr_id notification is visible.
  assert.equal(canViewerSeeNotification(A, { employeeHrId: A, recipients: [] }), true, "own employee notification visible");

  // 2. Visible when recipients includes the viewer.
  assert.equal(canViewerSeeNotification(A, { employeeHrId: null, recipients: [A] }), true, "recipient match visible");

  // 3. User A does NOT see User B's notification.
  assert.equal(canViewerSeeNotification(A, { employeeHrId: B, recipients: [B] }), false, "other employee's notification hidden");

  // 4. User A does NOT see a notification addressed to [B].
  assert.equal(canViewerSeeNotification(A, { employeeHrId: null, recipients: [B] }), false, "recipients [B] hidden from A");

  // 5. Invalid PHASE/fixture/email recipients never grant access.
  assert.equal(isValidRecipientHrId("PHASE17_MPBRQEFJ_521DF68E_VAC"), false, "PHASE id is not a valid recipient");
  assert.equal(isValidRecipientHrId("user@satopharma.com"), false, "email is not a valid recipient");
  // A4 fail-open tripwire — keep permanently. normalizeNotificationHrId delegates to
  // canonicalHrIdForDisplay, which KEEPS the "@", so an email token stays invalid. If a future
  // change delegated to normalizeHrIdForAccess instead it would strip "a@b.com" to "abcom", the
  // includes("@") guard would miss it, and this fail-closed check would silently flip to true.
  assert.equal(isValidRecipientHrId("a@b.com"), false, "a@b.com email token is never a valid recipient (fail-closed)");
  assert.equal(isValidRecipientHrId(""), false, "empty is not a valid recipient");
  assert.equal(isValidRecipientHrId("FIXTURE-1"), false, "fixture id is not a valid recipient");
  assert.equal(isValidRecipientHrId("A-1"), true, "real HR_ID is a valid recipient");
  assert.equal(
    canViewerSeeNotification("PHASE17_X", { employeeHrId: null, recipients: ["PHASE17_X"] }),
    false,
    "phase fixture recipient does not leak even to a matching token",
  );
  assert.equal(
    canViewerSeeNotification(A, { employeeHrId: null, recipients: ["PHASE17_X", A] }),
    true,
    "valid recipient still matches alongside an ignored fixture token",
  );
  assert.equal(
    canViewerSeeNotification(A, { employeeHrId: null, recipients: ["x@y.com"] }),
    false,
    "email recipient is ignored (no leak)",
  );

  // 6. No employee and no matching recipient -> denied.
  assert.equal(canViewerSeeNotification(A, { employeeHrId: null, recipients: [] }), false, "no subject + no recipient denied");
  assert.equal(canViewerSeeNotification(A, { recipients: [B] }), false, "no subject + non-matching recipient denied");

  // 7. Mixed recipients [A, B] shows to A and B only.
  assert.equal(canViewerSeeNotification(A, { recipients: [A, B] }), true, "mixed recipients visible to A");
  assert.equal(canViewerSeeNotification(B, { recipients: [A, B] }), true, "mixed recipients visible to B");
  assert.equal(canViewerSeeNotification(C, { recipients: [A, B] }), false, "mixed recipients hidden from C");

  // 8. Case-insensitive HR_ID matching.
  assert.equal(normalizeNotificationHrId(" a-1 "), "A-1", "normalization trims + uppercases");
  assert.equal(canViewerSeeNotification(A, { employeeHrId: "a-1", recipients: [] }), true, "employee match is case-insensitive");
  assert.equal(canViewerSeeNotification(A, { recipients: ["a-1"] }), true, "recipient match is case-insensitive");

  // 9. Admin/Super Admin personal bell does NOT auto-see everyone's notifications.
  assert.equal(
    canViewerSeeNotification("ADMIN-HR", { employeeHrId: B, recipients: [B] }),
    false,
    "admin does not auto-see another employee's notification (no implicit broadcast)",
  );
  assert.equal(
    canViewerSeeNotification("ADMIN-HR", { employeeHrId: null, recipients: ["ADMIN-HR", B] }),
    true,
    "admin sees a notification only when explicitly a recipient",
  );

  // Empty/invalid viewer is always denied (fail closed).
  assert.equal(canViewerSeeNotification("", { recipients: [A] }), false, "empty viewer denied");
  assert.equal(canViewerSeeNotification(null, { employeeHrId: A, recipients: [A] }), false, "null viewer denied");

  // Integration via mapInAppNotificationRows: filtering applies to all categories.
  const mapped = mapInAppNotificationRows(
    [
      { category: "leave", employeeHrId: A, id: "n1", metadata: { title: "Yours", message: "m" }, recipients: [A], status: "sent", subject: "Yours" },
      { category: "leave", employeeHrId: B, id: "n2", metadata: { title: "Theirs", message: "m" }, recipients: [B], status: "sent", subject: "Theirs" },
      { category: "vacation_request", employeeHrId: null, id: "n3", metadata: { title: "Fixture", message: "m" }, recipients: ["PHASE17_X"], status: "sent", subject: "Fixture" },
    ],
    A,
  ).map((row) => row.id);
  assert.deepEqual(mapped, ["n1"], "mapper keeps only the viewer's own notification across categories");

  // Sensitive metadata must not be surfaced in notification details.
  const detailRows = mapInAppNotificationRows(
    [
      {
        category: "general",
        employeeHrId: A,
        id: "s1",
        metadata: { title: "t", message: "m", orderId: "O-1", token: "super-secret-token", email: "a@b.com", password: "pw", netSalary: "99999", grossSalary: "123456" },
        recipients: [A],
        status: "sent",
        subject: "t",
      },
    ],
    A,
  );
  const details = detailRows[0]?.details ?? [];
  const detailBlob = JSON.stringify(details).toLowerCase();
  assert.equal(detailBlob.includes("super-secret-token"), false, "token value must not appear in details");
  assert.equal(detailBlob.includes("password"), false, "password must not appear in details");
  assert.equal(detailBlob.includes("a@b.com"), false, "email must not appear in details");
  // Salary amounts must never surface in a notification card (payslip privacy).
  assert.equal(detailBlob.includes("99999"), false, "net salary must not appear in details");
  assert.equal(detailBlob.includes("123456"), false, "gross salary must not appear in details");
  assert.ok(details.some((d) => d.label === "Order"), "non-sensitive details (Order) still render");

  // Explicit producer-provided details[] render verbatim, in order, sensitive dropped.
  const explicitRows = mapInAppNotificationRows(
    [
      {
        category: "vacation_request",
        employeeHrId: A,
        id: "v1",
        metadata: {
          title: "X submitted a vacation request",
          message: "m",
          details: [
            { label: "Employee", value: "Fiby Wagdy Luka (B-52)" },
            { label: "Type", value: "Annual" },
            { label: "Period", value: "2026-06-01 → 2026-06-05" },
            { label: "Status", value: "Pending manager decision" },
            { label: "Action", value: "Review request" },
            { label: "Net Salary", value: "99999" },
          ],
        },
        recipients: [A],
        status: "sent",
        subject: "X submitted a vacation request",
      },
    ],
    A,
  )[0]?.details ?? [];
  assert.deepEqual(
    explicitRows.map((d) => d.label),
    ["Employee", "Type", "Period", "Status", "Action"],
    "explicit details render in order with the sensitive 'Net Salary' row dropped",
  );
  assert.equal(explicitRows[0]?.value, "Fiby Wagdy Luka (B-52)", "employee detail value preserved");

  // Render-time polish for EXISTING (old-style) rows: humanized status + derived
  // action + no raw UUID, with NO producer/data change (metadata has no details[]).
  const polished = mapInAppNotificationRows(
    [
      {
        category: "vacation_request",
        employeeHrId: A,
        id: "old1",
        metadata: {
          title: "Vacation request pending HR final decision",
          message: "Taha approved Fiby's vacation request. HR final decision is required.",
          status: "pending_hr",
          requestId: "b2f92a6b-9dde-495e-9c10-542ca0fcf0dd",
          managerDecision: "approved",
        },
        recipients: [A],
        status: "sent",
        subject: "Vacation request pending HR final decision",
      },
    ],
    A,
  )[0]?.details ?? [];
  const polishedBlob = JSON.stringify(polished);
  assert.ok(
    polished.some((d) => d.label === "Status" && d.value === "Pending HR final decision"),
    "old-row status is humanized at render time",
  );
  assert.ok(
    polished.some((d) => d.label === "Action" && d.value === "Complete HR decision"),
    "old-row gets a derived action at render time",
  );
  assert.equal(polishedBlob.includes("b2f92a6b"), false, "raw request UUID is not shown for old rows");

  // ===========================================================================
  // WP-N2B: subject-first display model via read-time requestId enrichment.
  // OLD vacation rows must render the EMPLOYEE NAME as the prominent primaryText
  // (not the generic stored subject), with Employee/Type/Period/Status/Action.
  // ===========================================================================
  const REQUEST_UUID = "b2f92a6b-9dde-495e-9c10-542ca0fcf0dd";
  const vacationEnrichment = new Map([
    [
      REQUEST_UUID,
      {
        employeeHrId: "B-52",
        employeeName: "Fiby Wagdy Luka",
        endDate: "2026-05-24",
        startDate: "2026-05-22",
        status: "pending_hr",
        typeLabel: "Annual Vacation",
      },
    ],
  ]);

  const oldVacationRow = {
    category: "vacation_request",
    employeeHrId: A,
    id: "old-vac",
    metadata: {
      managerDecision: "approved",
      message: "Taha Mohamed Taha approved Fiby Wagdy Luka's vacation request. HR final decision is required.",
      requestId: REQUEST_UUID,
      status: "pending_hr",
      title: "Vacation request pending HR final decision",
    },
    recipients: [A],
    status: "sent",
    subject: "Vacation request pending HR final decision",
  };

  const enrichedView = mapInAppNotificationRows([oldVacationRow], A, vacationEnrichment)[0];
  assert.ok(enrichedView, "enriched vacation row is visible to its recipient");
  // Employee name is the prominent primaryText, NOT the generic stored subject.
  assert.equal(enrichedView?.primaryText, "Fiby Wagdy Luka", "enriched row uses employee name as primaryText");
  assert.notEqual(enrichedView?.primaryText, oldVacationRow.subject, "primaryText is not the generic stored subject");
  assert.equal(enrichedView?.title, "Vacation request pending HR final decision", "title is the human-readable event");
  assert.equal(enrichedView?.statusLabel, "Pending HR final decision", "statusLabel humanized from enrichment");
  assert.equal(enrichedView?.actionLabel, "Complete HR decision", "actionLabel derived from category + status");
  const enrichedDetails = enrichedView?.details ?? [];
  assert.deepEqual(
    enrichedDetails.map((d) => d.label),
    ["Employee", "Type", "Period", "Status", "Action"],
    "enriched details include Employee, Type, Period, Status, Action",
  );
  assert.equal(enrichedDetails[0]?.value, "Fiby Wagdy Luka (B-52)", "Employee detail shows name + HR_ID");
  assert.equal(enrichedDetails[1]?.value, "Annual Vacation", "Type detail comes from the resolved record");
  assert.equal(enrichedDetails[2]?.value, "2026-05-22 → 2026-05-24", "Period detail comes from the resolved record");
  assert.equal(enrichedDetails[3]?.value, "Pending HR final decision", "Status detail is humanized");
  assert.equal(enrichedDetails[4]?.value, "Complete HR decision", "Action detail is the next step");
  const enrichedBlob = JSON.stringify(enrichedView);
  assert.equal(enrichedBlob.includes(REQUEST_UUID), false, "raw request UUID never appears in the enriched view");
  // Enrichment only carries non-sensitive fields (name/type/dates/status); the
  // privacy guarantee is enforced structurally on the enrichment source below.

  // pending_manager enrichment -> manager-decision title + review action.
  const pendingManagerView = mapInAppNotificationRows(
    [{ ...oldVacationRow, id: "old-vac-2", metadata: { ...oldVacationRow.metadata, status: "pending_manager" } }],
    A,
    new Map([[REQUEST_UUID, { ...vacationEnrichment.get(REQUEST_UUID)!, status: "pending_manager" }]]),
  )[0];
  assert.equal(pendingManagerView?.title, "Vacation request pending manager decision", "pending_manager title");
  assert.equal(pendingManagerView?.statusLabel, "Pending manager decision", "pending_manager status humanized");
  assert.equal(pendingManagerView?.actionLabel, "Review request", "pending_manager action is Review request");

  // New-style notification (producer details[], no requestId/enrichment) still
  // renders details AND derives primaryText from the structured Employee row.
  const newStyleView = mapInAppNotificationRows(
    [
      {
        category: "vacation_request",
        employeeHrId: A,
        id: "new-vac",
        metadata: {
          details: [
            { label: "Employee", value: "Mariam Adel (C-7)" },
            { label: "Type", value: "Annual Vacation" },
            { label: "Period", value: "2026-06-01 → 2026-06-03" },
            { label: "Status", value: "Pending manager decision" },
            { label: "Action", value: "Review request" },
          ],
          message: "Mariam Adel submitted a vacation request.",
          status: "pending_manager",
          title: "Mariam Adel submitted a vacation request",
        },
        recipients: [A],
        status: "sent",
        subject: "Mariam Adel submitted a vacation request",
      },
    ],
    A,
  )[0];
  assert.equal(newStyleView?.primaryText, "Mariam Adel", "new-style primaryText derived from Employee detail row");
  assert.deepEqual(
    (newStyleView?.details ?? []).map((d) => d.label),
    ["Employee", "Type", "Period", "Status", "Action"],
    "new-style producer details[] still render in order",
  );

  // Fallback A: requestId present but NO enrichment record found, and the message
  // leads with "{Name} submitted ..." -> conservative name parse populates primaryText.
  const fallbackSubmitted = mapInAppNotificationRows(
    [
      {
        category: "vacation_request",
        employeeHrId: A,
        id: "fb-1",
        metadata: {
          message: "Mariam Adel submitted Annual Vacation for 3 day(s).",
          requestId: "11111111-2222-3333-4444-555555555555",
          status: "pending_manager",
          title: "Vacation request submitted",
        },
        recipients: [A],
        status: "sent",
        subject: "Vacation request submitted",
      },
    ],
    A,
    new Map(), // no enrichment resolved
  )[0];
  assert.equal(fallbackSubmitted?.primaryText, "Mariam Adel", "fallback parses employee name from a 'submitted' message");
  assert.equal(fallbackSubmitted?.title, "Vacation request pending manager decision", "fallback still derives event title from status");
  assert.equal(JSON.stringify(fallbackSubmitted).includes("11111111-2222"), false, "fallback never shows the raw requestId");

  // Fallback B: no enrichment, possessive "{Actor} approved {Employee}'s vacation
  // request" -> primaryText is the EMPLOYEE (the request owner), not the actor.
  const fallbackApproverPossessive = mapInAppNotificationRows(
    [
      {
        category: "vacation_request",
        employeeHrId: A,
        id: "fb-2",
        metadata: {
          message: "Taha Mohamed Taha approved Fiby Wagdy Luka's vacation request. HR final decision is required.",
          requestId: "99999999-8888-7777-6666-555555555555",
          status: "pending_hr",
          title: "Vacation request pending HR final decision",
        },
        recipients: [A],
        status: "sent",
        subject: "Vacation request pending HR final decision",
      },
    ],
    A,
    new Map(),
  )[0];
  assert.equal(
    fallbackApproverPossessive?.primaryText,
    "Fiby Wagdy Luka",
    "possessive message resolves the EMPLOYEE (request owner), not the acting manager",
  );
  assert.equal(fallbackApproverPossessive?.title, "Vacation request pending HR final decision", "fallback title still derives from status");
  assert.equal(JSON.stringify(fallbackApproverPossessive).includes("99999999-8888"), false, "possessive fallback never shows the raw requestId");

  // Fallback C: "{Employee}'s vacation request was approved" -> employee name.
  const fallbackDecisionPossessive = mapInAppNotificationRows(
    [
      {
        category: "vacation_request",
        employeeHrId: A,
        id: "fb-3",
        metadata: {
          message: "Fiby Wagdy Luka's vacation request was approved.",
          requestId: "77777777-6666-5555-4444-333333333333",
          status: "approved",
          title: "Vacation request approved",
        },
        recipients: [A],
        status: "sent",
        subject: "Vacation request approved",
      },
    ],
    A,
    new Map(),
  )[0];
  assert.equal(fallbackDecisionPossessive?.primaryText, "Fiby Wagdy Luka", "decision message resolves the employee name");
  assert.equal(fallbackDecisionPossessive?.title, "Vacation request approved", "approved fallback title derives from status");

  // Wiring: the read path resolves enrichment and passes it to the mapper.
  const n2bInAppSource = readFileSync(new URL("../src/lib/notifications/in-app.ts", import.meta.url), "utf8");
  assert.match(n2bInAppSource, /fetchVacationNotificationEnrichments/, "in-app must resolve vacation enrichment");
  assert.match(
    n2bInAppSource,
    /mapInAppNotificationRows\(mappedRows, employeeHrId, enrichmentByRequestId\)/,
    "in-app must pass the enrichment map to the mapper",
  );
  const n2bMetricsSource = readFileSync(new URL("../src/lib/communication/metrics.ts", import.meta.url), "utf8");
  assert.match(n2bMetricsSource, /buildNotificationDisplay/, "mapper must build a normalized display model");
  assert.match(n2bMetricsSource, /resolvePrimaryText/, "mapper must resolve a subject-first primaryText");
  assert.match(n2bMetricsSource, /primaryText/, "mapper output must include primaryText");

  // Wiring: the enrichment source is read-only, non-sensitive, and cycle-free.
  const enrichmentSource = readFileSync(new URL("../src/lib/vacation/notification-enrichment.ts", import.meta.url), "utf8");
  assert.match(enrichmentSource, /v2_vacation_requests/, "enrichment reads the vacation requests table");
  assert.match(enrichmentSource, /employee_name,employee_hr_id,vacation_type,start_date,end_date,status/, "enrichment selects only non-sensitive columns");
  const enrichmentSelect = enrichmentSource.match(/\.select\("([^"]+)"\)/)?.[1] ?? "";
  assert.ok(enrichmentSelect.length > 0, "enrichment must have a bounded column select (no select *)");
  assert.equal(
    /salary|bank|national|balance|notes|net_?pay|gross|iban|attachment/i.test(enrichmentSelect),
    false,
    "enrichment select must not include sensitive columns",
  );
  assert.equal(
    /from\s+"@\/lib\/notifications\/in-app"/.test(enrichmentSource),
    false,
    "enrichment must not import in-app (no circular dependency)",
  );

  // Wiring: the bell renders the subject-first model.
  const n2bBellSource = readFileSync(new URL("../src/components/layout/in-app-notifications-bell.tsx", import.meta.url), "utf8");
  assert.match(n2bBellSource, /notification\.primaryText/, "bell renders primaryText as the prominent line");
  assert.match(n2bBellSource, /notification\.statusLabel/, "bell renders the status badge");

  // Wiring: the query path selects employee_hr_id and applies the canonical filter.
  const inAppSource = readFileSync(new URL("../src/lib/notifications/in-app.ts", import.meta.url), "utf8");
  assert.match(inAppSource, /employee_hr_id/, "in-app query must select employee_hr_id");
  assert.match(inAppSource, /canViewerSeeNotification\(employeeHrId/, "in-app must fail-closed filter after the DB query");

  // Write-path guard: marking a notification "read" must verify the event was
  // actually addressed to the caller before upserting read-state (no marking
  // arbitrary notification ids read via crafted PATCH bodies).
  assert.match(
    inAppSource,
    /export async function markInAppNotificationRead[\s\S]*?canViewerSeeNotification\(identity\.hrId/,
    "markInAppNotificationRead must verify recipient ownership before upserting read-state",
  );

  const metricsSource = readFileSync(new URL("../src/lib/communication/metrics.ts", import.meta.url), "utf8");
  assert.match(metricsSource, /canViewerSeeNotification\(employeeHrId/, "mapper must use the canonical recipient rule");
  assert.match(metricsSource, /isSensitiveMetadataKey/, "mapper must screen sensitive metadata keys");
  assert.match(metricsSource, /const explicit = metadata\.details/, "mapper must support explicit producer-provided detail rows");
  assert.match(metricsSource, /humanizeNotificationStatus|deriveNotificationAction/, "mapper must polish status/action for existing rows at render time");
  assert.match(metricsSource, /isUuidLike/, "mapper must suppress raw UUID identifiers from details");

  // Wiring: the bell UI premium states + recipient clarity.
  const bellSource = readFileSync(new URL("../src/components/layout/in-app-notifications-bell.tsx", import.meta.url), "utf8");
  assert.match(bellSource, /You&rsquo;re all caught up\.|You're all caught up\./, "empty state present");
  assert.match(bellSource, /Try again/, "error state has a retry control");
  assert.match(bellSource, /animate-pulse/, "loading skeleton present");
  assert.match(bellSource, /Action required/, "action-required badge present");
  assert.match(bellSource, /notificationsSubtitle/, "header uses the recipient-clarity subtitle");

  const settingsSource = readFileSync(new URL("../src/config/system-settings.ts", import.meta.url), "utf8");
  assert.match(settingsSource, /notificationsSubtitle: "Only updates assigned to you\."/, "subtitle clarifies recipient scope");

  // ===========================================================================
  // WP-N1: notification CONTENT clarity (who / what / when / status / action).
  // Vacation + probation services are env-bound, so content is locked via source.
  // ===========================================================================
  const vacationSource = readFileSync(new URL("../src/lib/vacation/service.ts", import.meta.url), "utf8");
  // Submitted: employee + type + period (start->end) + clear action.
  assert.match(
    vacationSource,
    /\$\{input\.request\.employeeName\} submitted \$\{vacationTypeLabel\(input\.request\.vacationType\)\} from \$\{input\.request\.startDate\} to \$\{input\.request\.endDate\}[\s\S]*Review is pending your decision\./,
    "vacation submitted message must include employee, type, dates and the pending-decision action",
  );
  // Manager review + HR decision messages must include type + period.
  assert.match(
    vacationSource,
    /\$\{input\.request\.employeeName\}'s \$\{vacationTypeLabel\(input\.request\.vacationType\)\} \(\$\{input\.request\.startDate\} to \$\{input\.request\.endDate\}\)[\s\S]*HR final decision is required\./,
    "vacation manager-review message must include type, period and required HR action",
  );
  assert.match(
    vacationSource,
    /\$\{vacationTypeLabel\(input\.request\.vacationType\)\} \(\$\{input\.request\.startDate\} to \$\{input\.request\.endDate\}\) was/,
    "vacation HR-decision message must include type and period",
  );
  // WP-N2: titles must LEAD with the employee name.
  assert.match(
    vacationSource,
    /title: `\$\{input\.request\.employeeName\} submitted a vacation request`/,
    "vacation submitted title must start with the employee name",
  );
  assert.match(
    vacationSource,
    /`\$\{input\.request\.employeeName\}'s vacation request needs HR acknowledgement`/,
    "vacation manager-review title must lead with the employee name",
  );
  assert.match(
    vacationSource,
    /title: `\$\{input\.request\.employeeName\}'s vacation request was \$\{input\.decision === "approve" \? "approved" : "rejected"\}`/,
    "vacation HR-decision title must lead with the employee name",
  );
  // WP-N2: structured details rows (Status + Action) present on vacation producers.
  assert.match(vacationSource, /label: "Status", value: "Pending manager decision"/, "submitted details include manager-pending status");
  assert.match(vacationSource, /label: "Action", value: "Review request"/, "submitted details include the review action");
  assert.match(vacationSource, /label: "Status", value: sequential \? "Pending HR acknowledgement" : "Pending HR final decision"/, "manager-review details include HR-pending status (acknowledgement for the sequential workflow)");
  assert.match(vacationSource, /label: "Action", value: sequential \? "Acknowledge \/ record in the Action Center" : "Complete HR decision"/, "manager-review details include the HR action");
  assert.match(vacationSource, /label: "Manager"/, "manager-review details include the manager");

  // ===========================================================================
  // Personal-bell category allowlist: legacy/orphaned categories are hidden even
  // when correctly recipient-matched (B-175 legacy "leave" leak fix).
  // ===========================================================================
  assert.equal(isPersonalBellCategory("vacation_request"), true, "current vacation category is shown");
  assert.equal(isPersonalBellCategory("probation"), true, "probation category is shown");
  assert.equal(isPersonalBellCategory("coaching_report"), true, "coaching category is shown");
  assert.equal(isPersonalBellCategory("general"), true, "general category is shown");
  assert.equal(isPersonalBellCategory("internal_message"), true, "internal message category is shown");
  assert.equal(isPersonalBellCategory("excuse"), true, "excuse category is shown");
  assert.equal(isPersonalBellCategory("recruitment"), true, "recruitment category is shown");
  assert.equal(isPersonalBellCategory("LEAVE"), false, "legacy 'leave' category is hidden (case-insensitive)");
  assert.equal(isPersonalBellCategory("leave"), false, "legacy 'leave' category is hidden");
  assert.equal(isPersonalBellCategory(null), false, "missing category is hidden");
  assert.equal((PERSONAL_BELL_CATEGORIES as readonly string[]).includes("leave"), false, "allowlist must not contain the legacy category");
  // A legacy 'leave' row addressed to B-175 is recipient-matched but must be hidden by category.
  assert.equal(
    canViewerSeeNotification("B-175", { employeeHrId: "B-175", recipients: ["B-175"] }) && !isPersonalBellCategory("leave"),
    true,
    "B-175's legacy 'leave' row is recipient-matched yet excluded by the category allowlist",
  );
  // The in-app read path must filter on the category allowlist (SQL + post-query).
  assert.match(inAppSource, /isPersonalBellCategory\(row\.category\)/, "in-app must drop non-allowlisted categories post-query");
  assert.match(inAppSource, /\.in\("category", allowedCategories\)/, "in-app SQL must restrict to allowlisted categories");
  // The bell is polled by every open page, and each database round trip costs 300-600 ms (Sentry, 2026-10-16): its
  // two independent reads (the person's own rows, the rows that list them as a recipient) must run TOGETHER. The
  // Talent Acquisition seat's third read (her non-CV notices) joins that same Promise.all, never a round trip after it.
  assert.match(
    inAppSource,
    /const \[employeeResult, recipientResult(?:, otherKindsResult)?\] = await Promise\.all\(\[[\s\S]*?\.eq\("employee_hr_id"[\s\S]*?\.overlaps\("recipients"/,
    "in-app must read the person's own rows and the recipient rows in one Promise.all, never one after the other",
  );

  const probationSource = readFileSync(new URL("../src/lib/probation/service.ts", import.meta.url), "utf8");
  assert.match(probationSource, /Submit manager probation feedback\./, "probation reminder must state the required action");
  assert.match(
    probationSource,
    /title: `\$\{employee\.displayName\}'s probation feedback is due`/,
    "probation reminder title must lead with the employee name",
  );
  assert.match(probationSource, /label: "Action", value: "Submit feedback"/, "probation details include the submit-feedback action");
  assert.match(probationSource, /label: "Status", value: "Feedback required"/, "probation details include the feedback-required status");

  // Defensive: salary terms are in the sensitive-key denylist (payslip privacy).
  assert.match(metricsSource, /sensitiveMetadataKeyPattern[\s\S]*salary/, "sensitive-key denylist must cover salary terms");
}
