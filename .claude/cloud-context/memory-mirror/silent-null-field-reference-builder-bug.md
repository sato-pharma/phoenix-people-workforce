---
name: silent-null-field-reference-builder-bug
description: "A reference/DTO builder that maps most fields but silently omits one causes that field to be null everywhere downstream, with no type error — verify end-to-end through the real pipeline, not hand-built mocks."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e651eae8-7971-491b-b629-13c088aa7fc4
---

When a function builds a reference/DTO object by copying fields from a source (e.g. `toEmployeeReference(employee) => ({ managerName: employee.managerName, ... })`), a field that's silently omitted (e.g. `managerHrId`) typechecks fine if the target type marks it optional — but every consumer downstream then sees that field as permanently `null`, with no error anywhere.

**Why it hid in production:** this exact bug ([[nsm-team-calendar-portal-build]]) shipped because the *symptom* looked plausible enough not to trigger suspicion — DSMs still split into their own groups (title-based detection worked), so only the *reps* silently collapsed into one flat "Other" bucket. A partial-looking failure is easy to mistake for a data quirk rather than a code bug.

**Why my own tests didn't catch it either:** my first regression test built `FieldWorkforceEmployeeSummary`-shaped mock objects by hand and fed them directly into the grouping function — which trivially passes since I hand-set `managerHrId` on the mocks myself. That only tests the grouping logic in isolation; it says nothing about whether the real reference-builder actually populates that field. The fix was building the test around the *real* classifier pipeline (`buildFieldWorkforceCompliancePreview` with plain `employeeReferences` input) so the assertion `ahmed.managerHrId === "B-1"` actually depends on the production code path from source object to summary.

**How to apply:** when adding a new consumer of a derived/summary field that traces back through a reference-builder or mapper function, trace the field back to its origin and confirm it's actually mapped — don't assume a builder "looks complete" just because most fields are there. When writing regression tests for a bug in a downstream consumer, prefer exercising the real upstream builder/pipeline over hand-constructing the consumer's input shape; the latter can't catch a bug in the builder itself.
