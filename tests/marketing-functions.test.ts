import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { permissionMatrix, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import {
  carryForwardItems,
  missingForSignature,
  monthFigures,
  normalizeFieldFeedbackInput,
} from "../src/lib/marketing-functions/rules.ts";
import {
  canEditFieldFeedback,
  canEditMonth,
  canReopenMonth,
  canStampMonth,
  canSubmitMonth,
  canViewFieldFeedback,
  FIELD_FEEDBACK_PORTAL_ROLES,
  MARKETING_FUNCTIONS_PORTAL_ROLES,
  resolveFieldFeedbackVisibility,
  resolveMonthAuthor,
} from "../src/lib/marketing-functions/scope.ts";
import { buildRepTracks, buildTeamGaps, type TrackedForm } from "../src/lib/marketing-functions/tracking.ts";
import type { MarketingFunctionItem } from "../src/lib/marketing-functions/types.ts";
import {
  CALL_RATING_LABELS,
  CALL_REMARKS,
  FIELD_FEEDBACK_LABELS,
  MARKETING_FUNCTION_CATEGORIES,
  MARKETING_FUNCTION_COLUMNS,
  MARKETING_FUNCTION_EMPHASIS_COLOR,
  type CallRating,
  type CallRemarkKey,
} from "../src/lib/marketing-functions/vocabulary.ts";

// Monthly Marketing Functions and the Marketing Field Visit Feedback (owner, 2026-11-10). The people
// are the live chain: Ahmed Sharaf (B-155, Product Manager) → Rasha Sabry (A-8, Group Product
// Manager) → Hossam Reda (A-9, Marketing Manager) → the CEO.

const AHMED = { role: "Product Manager" as PhoenixRole, hrId: "B-155" };
const OTHER_PM = { role: "Product Manager" as PhoenixRole, hrId: "B-200" };
const RASHA = { role: "Group Product Manager" as PhoenixRole, hrId: "A-8" };
const HOSSAM = { role: "Marketing Manager" as PhoenixRole, hrId: "A-9" };
const CEO = { role: "CEO" as PhoenixRole, hrId: "AA" };
const NSM = { role: "National Sales Manager" as PhoenixRole, hrId: "AI-0008" };
const REP = { role: "Medical Rep" as PhoenixRole, hrId: "AI-0100" };

function item(overrides: Partial<MarketingFunctionItem> = {}): MarketingFunctionItem {
  return {
    id: null,
    categoryKey: "planning",
    product: "Xerovent",
    description: "IMS analysis",
    dueDate: null,
    origin: "planned",
    statusMid: null,
    noteMid: null,
    statusEnd: null,
    noteEnd: null,
    ...overrides,
  };
}

function ratingsAll(rating: CallRating, overrides: Partial<Record<CallRemarkKey, CallRating>> = {}) {
  return { ...Object.fromEntries(CALL_REMARKS.map((remark) => [remark.key, rating])), ...overrides } as Record<CallRemarkKey, CallRating>;
}

/** Her two files, word for word and fill for fill. A drifted label or colour is the regression. */
export function runMarketingFunctionsVocabularyTests() {
  assert.deepEqual(
    MARKETING_FUNCTION_CATEGORIES.map((category) => [category.title, category.detail, category.fill]),
    [
      ["Planning", "(IMS analysis, Activities sheets, Plan review, TOP)", "#D8EACC"],
      ["Promotional materials", "(creation of new materials; printings/ giveaways/ booth… etc.)", "#FFF2CC"],
      ["Trainings", "(new comers training, refreshments, quiz… etc.)", "#E2EFDA"],
      ["Event Preparation", "(events lists revision, reservations, conferences arrangements)", "#DEEBF7"],
      ["Field Activity", "(double visits/conference attendance/ company meetings… etc.)", "#BDD7EE"],
      ["Clinical Trials", "(if any)", "#FFE699"],
      ["Digital activity", "(if any)", "#EDEDED"],
      ["Admin. Work", "(release of materials/ requests approvals… etc.)", "#F4B084"],
    ],
    "her eight categories, in her order, her words and her cell fills",
  );
  const promotional = MARKETING_FUNCTION_CATEGORIES.find((category) => category.key === "promotional")!;
  assert.equal(promotional.emphasis, "creation", "the word she set in red");
  assert.equal(MARKETING_FUNCTION_EMPHASIS_COLOR, "#FF0000");
  assert.equal(MARKETING_FUNCTION_CATEGORIES.find((category) => category.key === "field")?.dueDateFill, "#B4C7E7");
  assert.deepEqual(
    [MARKETING_FUNCTION_COLUMNS.category, MARKETING_FUNCTION_COLUMNS.description, MARKETING_FUNCTION_COLUMNS.descriptionDetail, MARKETING_FUNCTION_COLUMNS.dueDate, MARKETING_FUNCTION_COLUMNS.statusMid, MARKETING_FUNCTION_COLUMNS.statusEnd],
    ["M", "Item Description", "(please specify the product)", "Due Date", "Status/ mid month", "Status/ end of month"],
  );
  assert.deepEqual(
    CALL_REMARKS.map((remark) => remark.label),
    [
      "Conveying message",
      "Grasping of selling points",
      "Medical knowledge",
      "Product knowledge",
      "Competitors knowledge",
      "Sticking to product strategy",
      "Usage/handling of Detail Aid",
      "Usage of samples",
      "Usage of giveaways",
      "Pharmacies visits",
      "Feed back collection",
    ],
    "her eleven call remarks, in her order",
  );
  assert.deepEqual(Object.values(CALL_RATING_LABELS), ["Excellent", "Good", "Average", "Poor"]);
  assert.equal(FIELD_FEEDBACK_LABELS.doctorsComments, "Doctors' comments (if Any)");
  assert.equal(FIELD_FEEDBACK_LABELS.comments, "Comments/ explanation of the call remarks");

  // The export draws from the same vocabulary rather than a second copy of the words.
  const exportSource = readFileSync(new URL("../src/lib/marketing-functions/export.ts", import.meta.url), "utf8");
  assert.match(exportSource, /MARKETING_FUNCTION_CATEGORIES/, "the workbook reads her categories from vocabulary.ts");
  assert.doesNotMatch(exportSource, /Promotianal/, "the one typo fixed stays fixed");
}

/** Who fills, who reads, and the National Sales Manager's narrow window. */
export function runMarketingFunctionsAccessTests() {
  assert.deepEqual(permissionMatrix["Product Manager"].marketing_functions, ["read", "create", "update", "export"]);
  assert.deepEqual(permissionMatrix["Product Manager"].marketing_field_feedback, ["read", "create", "update"]);
  assert.equal(permissionMatrix["National Sales Manager"].marketing_functions, undefined, "the NSM never opens the monthly sheet");
  assert.deepEqual(permissionMatrix["National Sales Manager"].marketing_field_feedback, ["read"]);
  assert.equal(permissionMatrix["Medical Rep"].marketing_functions, undefined, "the rep holds neither");
  assert.equal(permissionMatrix["Medical Rep"].marketing_field_feedback, undefined, "the rep never sees his own feedback");
  assert.ok(permissionMatrix["Group Product Manager"].marketing_functions?.includes("approve"), "Dr. Rasha reviews");
  assert.ok(!permissionMatrix["CEO"].marketing_functions?.includes("approve"), "the CEO reads, he does not stamp");
  assert.ok(!MARKETING_FUNCTIONS_PORTAL_ROLES.includes("National Sales Manager"));
  assert.ok(FIELD_FEEDBACK_PORTAL_ROLES.includes("National Sales Manager"));
  assert.ok(!FIELD_FEEDBACK_PORTAL_ROLES.includes("Medical Rep"));

  assert.equal(resolveMonthAuthor(AHMED, "B-200"), "B-155", "a Product Manager opens his own month whatever a link names");
  assert.equal(resolveMonthAuthor(RASHA, "B-155"), "B-155");
  assert.equal(resolveMonthAuthor(NSM, "B-155"), null, "the NSM opens no monthly sheet");
  assert.equal(resolveMonthAuthor(REP, "B-155"), null);

  const signedOnLine = { authorHrId: "B-155", repHrId: "AI-0100", signedAt: "2026-11-09T10:00:00Z" };
  const draftOnLine = { ...signedOnLine, signedAt: null };
  const signedOffLine = { ...signedOnLine, repHrId: "B-9999" };
  const nsm = resolveFieldFeedbackVisibility(NSM, new Set([canonicalHrIdKey("AI-0100")!]));
  assert.equal(canViewFieldFeedback(nsm, signedOnLine), true, "the NSM reads a signed form on his own rep");
  assert.equal(canViewFieldFeedback(nsm, draftOnLine), false, "a draft is still the Product Manager's notes");
  assert.equal(canViewFieldFeedback(nsm, signedOffLine), false, "another line's rep is not his");
  const rasha = resolveFieldFeedbackVisibility(RASHA);
  assert.equal(canViewFieldFeedback(rasha, signedOffLine), true);
  assert.equal(canViewFieldFeedback(rasha, draftOnLine), false);
  assert.equal(canViewFieldFeedback(resolveFieldFeedbackVisibility(AHMED), draftOnLine), true, "his own draft");
  assert.equal(canViewFieldFeedback(resolveFieldFeedbackVisibility(OTHER_PM), signedOnLine), false, "another Product Manager's form");
  assert.equal(resolveFieldFeedbackVisibility(REP).kind, "none");
  assert.equal(resolveFieldFeedbackVisibility(CEO).kind, "all");

  // Every route asserts the permission the access registry declares for it, before it touches data.
  const registry = readFileSync(new URL("../src/lib/security/access-registry.ts", import.meta.url), "utf8");
  const routes: Array<[string, string, string]> = [
    ["app/api/marketing-functions/items/route.ts", "marketing_functions", "update"],
    ["app/api/marketing-functions/submit/route.ts", "marketing_functions", "update"],
    ["app/api/marketing-functions/review/route.ts", "marketing_functions", "approve"],
    ["app/api/marketing-functions/carry-forward/route.ts", "marketing_functions", "update"],
    ["app/api/marketing-functions/export/route.ts", "marketing_functions", "export"],
    ["app/api/marketing-field-feedback/route.ts", "marketing_field_feedback", "create"],
  ];
  for (const [file, resource, action] of routes) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(source.includes(`assertPermission(access, "${resource}", "${action}")`), `${file} asserts ${resource}:${action}`);
    const pattern = "/" + file.replace(/^app\//, "").replace(/\/route\.ts$/, "");
    assert.ok(
      registry.includes(`pattern: "${pattern}", permission: { resource: "${resource}", action: "${action}" }`),
      `${pattern} is registered with ${resource}:${action}`,
    );
  }
  for (const file of ["src/lib/marketing-functions/notify.ts", "src/lib/marketing-functions/service.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /sendEmail|sendTransactionalEmail|resend/i, `${file} sends no email: bell only`);
  }
}

/** Strengths, recurring gaps and the trend, from signed forms only. */
export function runMarketingFunctionsTrackingTests() {
  const form = (id: string, visitDate: string, ratings: Record<CallRemarkKey, CallRating>, signed = true): TrackedForm => ({
    id,
    repHrId: "AI-0100",
    repName: "Mona Adel",
    repArea: "Giza",
    visitDate,
    signedAt: signed ? `${visitDate}T12:00:00Z` : null,
    ratings,
  });
  const forms = [
    form("a", "2026-11-01", ratingsAll("good", { samples: "poor", pharmacies_visits: "average" })),
    form("b", "2026-11-05", ratingsAll("excellent", { samples: "average", pharmacies_visits: "good" })),
    form("c", "2026-11-09", ratingsAll("good", { samples: "good", medical_knowledge: "poor" })),
    form("d", "2026-11-10", ratingsAll("poor"), false),
  ];
  const [track] = buildRepTracks(forms);
  assert.equal(track.visits, 3, "the unsigned draft does not count");
  assert.equal(track.lastVisitDate, "2026-11-09");
  assert.ok(track.recurringGaps.includes("samples"), "Average or Poor on 2 of the last 3 is a recurring gap");
  assert.ok(!track.recurringGaps.includes("pharmacies_visits"), "one Average in three is not recurring");
  assert.ok(track.strengths.includes("conveying_message"), "Excellent or Good on the last two is a strength");
  assert.ok(!track.strengths.includes("samples"));
  assert.ok(track.latestGaps.includes("medical_knowledge"), "a gap on the latest visit that is not yet recurring");
  const samples = track.remarks.find((remark) => remark.key === "samples")!;
  assert.equal(samples.trend, "up", "Good after Average is better than last visit");
  const medical = track.remarks.find((remark) => remark.key === "medical_knowledge")!;
  assert.equal(medical.trend, "down");

  const gaps = buildTeamGaps([track]);
  const medicalGap = gaps.find((gap) => gap.key === "medical_knowledge");
  assert.equal(medicalGap?.owner, "marketing", "medical knowledge is worked on from the Marketing side");
  assert.equal(medicalGap?.reps, 1);
  assert.equal(gaps.find((gap) => gap.key === "samples")?.recurring, 1);
}

/** A reviewed month locks, a reopened one comes back, a signed form locks. */
export function runMarketingFunctionsLifecycleTests() {
  const subject = (status: "draft" | "submitted" | "reviewed" | null) => ({ authorHrId: "B-155", status });
  assert.equal(canEditMonth(AHMED, subject(null)), true, "a month not started yet is his to fill");
  assert.equal(canEditMonth(AHMED, subject("draft")), true);
  assert.equal(canEditMonth(AHMED, subject("submitted")), false, "submitted is out of his hands");
  assert.equal(canEditMonth(AHMED, subject("reviewed")), false, "reviewed is the record");
  assert.equal(canEditMonth(OTHER_PM, subject("draft")), false, "never another Product Manager's month");
  assert.equal(canEditMonth(RASHA, subject("draft")), false, "the reviewer reads, she does not fill");
  assert.equal(canSubmitMonth(AHMED, { ...subject("draft"), itemCount: 0 }), false, "an empty month is not submitted");
  assert.equal(canSubmitMonth(AHMED, { ...subject("draft"), itemCount: 3 }), true);

  assert.equal(canStampMonth(RASHA, subject("submitted")), true);
  assert.equal(canStampMonth(HOSSAM, subject("submitted")), true, "the Marketing Manager covers a sheet with no GPM above it");
  assert.equal(canStampMonth(RASHA, subject("draft")), false, "only a submitted month is stamped");
  assert.equal(canStampMonth(CEO, subject("submitted")), false);
  assert.equal(canStampMonth(NSM, subject("submitted")), false);
  assert.equal(canReopenMonth(RASHA, subject("reviewed")), true, "a reviewed month can be handed back");
  assert.equal(canReopenMonth(RASHA, subject("draft")), false);

  const carried = carryForwardItems(
    [
      item({ description: "done", statusEnd: "done" }),
      item({ description: "cancelled", statusMid: "cancelled" }),
      item({ description: "late", statusMid: "in_progress", dueDate: "2026-11-20", origin: "actual" }),
      item({ description: "next", statusEnd: "postponed", dueDate: "2026-12-05", id: "x" }),
    ],
    "2026-12-01",
  );
  assert.deepEqual(carried.map((entry) => entry.description), ["late", "next"], "done and cancelled stay behind");
  assert.equal(carried[0].dueDate, null, "a past due date is not a plan");
  assert.equal(carried[1].dueDate, "2026-12-05");
  assert.ok(carried.every((entry) => entry.id === null && entry.origin === "planned" && entry.statusMid === null && entry.statusEnd === null));
  assert.deepEqual(monthFigures([item({ statusEnd: "done" }), item({ origin: "actual" })]), { planned: 1, actual: 1, done: 1, donePercent: 50 });

  const parsed = normalizeFieldFeedbackInput({
    repHrId: "AI-0100",
    visitDate: "2026-11-09",
    amClinics: "6",
    pmClinics: 4,
    pharmacies: 3,
    ratings: { samples: "good", nonsense: "excellent", product_knowledge: "great" },
    actionOwners: ["training", "nobody", "marketing"],
  });
  assert.deepEqual([parsed.amClinics, parsed.pmClinics, parsed.pharmacies], [6, 4, 3], "AM, PM and pharmacies stay three numbers");
  assert.deepEqual(parsed.ratings, { samples: "good" }, "only her remarks and her four words are kept");
  assert.deepEqual(parsed.actionOwners, ["marketing", "training"]);
  assert.equal(parsed.visitType, "double");
  assert.equal(missingForSignature({ objectives: null, ratings: {} }).length, 2);
  assert.deepEqual(missingForSignature({ objectives: "Launch message", ratings: ratingsAll("good") }), []);

  assert.equal(canEditFieldFeedback(AHMED, { authorHrId: "B-155", signedAt: null }), true);
  assert.equal(canEditFieldFeedback(AHMED, { authorHrId: "B-155", signedAt: "2026-11-09T12:00:00Z" }), false, "a signed form is locked");
  assert.equal(canEditFieldFeedback(OTHER_PM, { authorHrId: "B-155", signedAt: null }), false);
  assert.equal(canEditFieldFeedback(RASHA, null), false, "only a Product Manager starts a form");

  // Saving a month writes the new items BEFORE removing the old ones: a delete first left a failed insert
  // with an empty month (a carry-forward empties next month, which no screen holds to save again).
  const service = readFileSync(new URL("../src/lib/marketing-functions/service.ts", import.meta.url), "utf8");
  const replace = service.slice(service.indexOf("async function replaceItems("), service.indexOf("async function touchMonth("));
  assert.ok(replace.includes(".insert(rows)") && replace.includes(".delete()"), "replaceItems writes and removes items");
  assert.ok(replace.indexOf(".insert(rows)") < replace.indexOf(".delete()"), "a month's new items go in before its old ones leave");
  // A form signed between the check and the write is refused, never answered "saved".
  assert.ok(service.includes(`.is("signed_at", null).select("id")`), "the unsigned-only update reads back what it changed");
}
