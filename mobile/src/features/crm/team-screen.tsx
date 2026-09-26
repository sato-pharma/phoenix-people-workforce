import { useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";

import { CrmEmpty, CrmNote, CrmPhotoThumb, CrmPill, CrmSection, type CrmTone } from "@/components/crm/crm-kit";
import { ErrorNotice, Field, LoadingScreen, PrimaryButton, SecondaryButton, StatTile } from "@/components/ui";
import { crmPost, crmUrl, useCrm, useCrmAction } from "@/lib/crm/client";
import { DROP_REASON_MAX, PLAN_DECISION_NOTE_MAX, UNPLANNED_DECISION_NOTE_MAX } from "@/lib/crm/entry-rules";
import { cairoStamp, dayLabelLong, weekLabel } from "@/lib/crm/format";
import { listText } from "@/lib/crm/labels";
import { useSession } from "@/lib/session";
import { hairline, radius, space, type as type_ } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

import type { PlanReviewRow, PlanReviewView, TeamRequest, TeamUnplannedVisit, TeamView } from "@/lib/crm/types";

/**
 * Phoenix CRM — Team, on the phone. The web twin is src/components/phoenix-crm/team-tab.tsx.
 *
 * B3 of the owner's plan: **a manager approving a plan from the car is the point.** So this is not the
 * web Team tab shrunk — it is the three queues that WAIT ON HIM, in the order they cost the field
 * force time, each with the decision on the card itself:
 *
 *   1. the weekly plans sent for review — a rep whose plan is not approved starts his week blind;
 *   2. the off-plan visits — until both decisions they count in NOTHING (owner, 2026-09-26);
 *   3. the grade and drop requests — the list itself.
 *
 * Everything the web Team tab holds and this one does not — readiness per territory, the monthly
 * plans, the filters, the search, opening a rep's plan to edit it — is deliberately absent: a phone is
 * where he DECIDES and the browser is where he studies. Nothing is approvable on the web and invisible
 * here, because both read the same two routes.
 *
 * 🔴 **Nothing on this screen is derived from a role.** The shell shows the tab only when
 * `overview.tabs.team` is true, the server sets `canDecide` / `canApprove` / `canReturn` on each row,
 * and all three routes narrow the decision AGAIN inside their service. A button drawn here is never
 * what authorises a decision.
 *
 * Golden Rule #1's blind half is about the REP's own screens. This one is a manager's, and it carries
 * what a decision needs — the live photo, the rep's written reason — in the same words the browser
 * uses, so the two can never disagree about what was decided on.
 */

type Notice = { tone: CrmTone; title: string; message: string | null };

/** What the rep asked for, in one line — the phone's copy of the web `requestSubject`. */
function requestSubject(request: TeamRequest): string {
  if (request.kind === "drop") return `Leave the list · ${request.dropReasonLabel ?? "Reason not given"}`;
  if (request.currentGrade === null) return `Grade ${request.proposedGrade ?? "—"} proposed · no grade yet`;
  return `Grade change · ${request.currentGrade} to ${request.proposedGrade ?? "—"}`;
}

/** A plan that is sent AND this viewer may act on. Everything else is the browser's to study. */
function waitsOnHim(row: PlanReviewRow): boolean {
  return row.plan !== null && row.plan.status === "submitted" && (row.canApprove || row.canReturn);
}

function planDetail(row: PlanReviewRow): string {
  // AM and PM apart, never summed — the call-rate golden rule reaches every count of a customer.
  const apart = `${row.accounts} AM · ${row.doctors} PM`;
  const days = row.farApartDays.length;
  return days > 0 ? `${apart} · ${days} day${days === 1 ? "" : "s"} far apart` : apart;
}

/**
 * One card with its decision on it: the heading, whatever has to be read before deciding, and the two
 * buttons. The refusing half always needs a note, because the rep reads why.
 */
function DecisionCard({
  busy,
  children,
  meta,
  negativeLabel,
  noteHint,
  noteMax,
  onDecide,
  positiveLabel,
  status,
  title,
}: {
  busy: boolean;
  children?: ReactNode;
  meta: string;
  /** Return, or Refuse. */
  negativeLabel: string;
  noteHint: string;
  noteMax: number;
  onDecide: (decision: "positive" | "negative", note: string) => void;
  positiveLabel: string;
  status: string;
  title: string;
}) {
  const palette = usePalette();
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function press(decision: "positive" | "negative") {
    const trimmed = note.trim();
    if (decision === "negative" && !trimmed) {
      setProblem("Write a note for the rep explaining why.");
      return;
    }
    setProblem(null);
    onDecide(decision, trimmed);
  }

  return (
    <View
      style={{
        backgroundColor: palette.surface,
        borderColor: palette.line,
        borderRadius: radius,
        borderWidth: hairline,
        gap: space.sm,
        padding: space.md,
      }}
    >
      <View style={{ gap: 2 }}>
        <Text style={[type_.bodyStrong, { color: palette.ink }]}>{title}</Text>
        <Text style={[type_.meta, { color: palette.inkSoft }]}>{meta}</Text>
      </View>
      <CrmPill tone="warn">{status}</CrmPill>
      {children}
      <Field
        label="Note for the rep"
        maxLength={noteMax}
        multiline
        numberOfLines={3}
        onChangeText={setNote}
        placeholder={noteHint}
        value={note}
      />
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <View style={{ flexBasis: 0, flexGrow: 1, minWidth: 0 }}>
          <PrimaryButton busy={busy} label={positiveLabel} onPress={() => press("positive")} />
        </View>
        <View style={{ flexBasis: 0, flexGrow: 1, minWidth: 0 }}>
          <SecondaryButton label={negativeLabel} onPress={() => press("negative")} />
        </View>
      </View>
    </View>
  );
}

export function TeamScreen({ test }: { test: boolean }) {
  const palette = usePalette();
  const { token } = useSession();
  const action = useCrmAction();

  const team = useCrm<TeamView>(crmUrl("/api/phoenix-crm/team", { test }), "team");
  const reviews = useCrm<PlanReviewView>(crmUrl("/api/phoenix-crm/plans/reviews", { test }), "reviews");

  const [notice, setNotice] = useState<Notice | null>(null);

  const teamView = team.data;
  const reviewView = reviews.data;

  if (!teamView || !reviewView) {
    const failure = team.error ?? reviews.error;
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, gap: space.lg, padding: space.lg }}>
        {failure ? <ErrorNotice message={failure} /> : <LoadingScreen label="Opening your team" />}
      </View>
    );
  }

  const plans = reviewView.rows.filter(waitsOnHim);
  const unplanned = teamView.unplannedVisits.filter(
    (visit) => visit.canDecide && visit.status !== "approved" && visit.status !== "refused",
  );
  const requests = teamView.requests.filter((request) => request.canDecide && request.status === "pending");
  const waiting = plans.length + unplanned.length + requests.length;

  function after(title: string, message: string | null) {
    setNotice({ tone: "good", title, message });
    team.reload();
    reviews.reload();
  }

  async function decidePlan(row: PlanReviewRow, decision: "positive" | "negative", note: string) {
    const plan = row.plan;
    if (!plan) return;
    setNotice(null);
    // `run` answers undefined when the save was refused — its sentence is in `action.error`, already
    // on screen — so the work returns a value of its own rather than the route's, which would read a
    // successful save of nothing as a refusal.
    const done = await action.run(plan.planId, async () => {
      await crmPost<unknown>(
        "/api/phoenix-crm/plans/decide",
        "plan",
        { action: decision === "positive" ? "approve" : "return", expectedVersion: plan.version, note: note || null, planId: plan.planId },
        token,
      );
      return true;
    });
    if (!done) return;
    after(
      decision === "positive" ? "Plan approved" : "Plan returned for changes",
      `${row.territory.name} · ${weekLabel(plan.weekStart)}${teamView.isTest ? " · a test plan, so nobody is notified" : ""}`,
    );
  }

  async function decideUnplanned(visit: TeamUnplannedVisit, decision: "positive" | "negative", note: string) {
    setNotice(null);
    const done = await action.run(visit.visitId, async () => {
      await crmPost<unknown>(
        "/api/phoenix-crm/visits/unplanned",
        "visit",
        { decision: decision === "positive" ? "approve" : "refuse", expectedVersion: visit.version, note: note || null, visitId: visit.visitId },
        token,
      );
      return true;
    });
    if (!done) return;
    after(decision === "positive" ? "Off-plan visit approved" : "Off-plan visit refused", `${visit.customerName} · ${visit.repName}`);
  }

  async function decideRequest(request: TeamRequest, decision: "positive" | "negative", note: string) {
    setNotice(null);
    const done = await action.run(request.requestId, async () => {
      await crmPost<unknown>(
        "/api/phoenix-crm/list/requests/decide",
        "request",
        { decision: decision === "positive" ? "approve" : "refuse", note: note || null, requestId: request.requestId },
        token,
      );
      return true;
    });
    if (!done) return;
    after(decision === "positive" ? "Request approved" : "Request refused", `${request.customerName} · ${request.territoryName}`);
  }

  return (
    <ScrollView contentContainerStyle={{ gap: space.lg, padding: space.lg }} style={{ backgroundColor: palette.paper, flex: 1 }}>
      <View style={{ gap: 2 }}>
        <Text style={[type_.title, { color: palette.ink }]}>Your team</Text>
        <Text style={[type_.meta, { color: palette.inkSoft }]}>
          {`${teamView.summary.territories} territories · week of ${weekLabel(reviewView.weekStart)}`}
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <StatTile label="Waiting for you" tone={waiting > 0 ? "accent" : "default"} value={String(waiting)} />
        <StatTile label="No rep in the seat" value={String(teamView.summary.vacant)} />
      </View>

      {notice ? (
        <CrmNote title={notice.title} tone={notice.tone}>
          {notice.message}
        </CrmNote>
      ) : null}
      {action.error ? <ErrorNotice message={action.error} /> : null}

      {waiting === 0 ? <CrmEmpty message="Nothing in your team is waiting on a decision from you." title="Nothing to decide" /> : null}

      {plans.length > 0 ? (
        <CrmSection title={`Plans sent for review · ${plans.length}`}>
          <View style={{ gap: space.md }}>
            {plans.map((row) => (
              <DecisionCard
                busy={action.busy === row.plan?.planId}
                key={row.territory.seatId}
                meta={`${row.territory.repName ?? "No rep"} · ${planDetail(row)}`}
                negativeLabel="Return"
                noteHint="What to change"
                noteMax={PLAN_DECISION_NOTE_MAX}
                onDecide={(decision, note) => void decidePlan(row, decision, note)}
                positiveLabel="Approve"
                status={row.plan?.statusLabel ?? "Sent for review"}
                title={row.territory.name}
              />
            ))}
          </View>
        </CrmSection>
      ) : null}

      {unplanned.length > 0 ? (
        <CrmSection title={`Off-plan visits · ${unplanned.length}`}>
          <View style={{ gap: space.md }}>
            {unplanned.map((visit) => (
              <DecisionCard
                busy={action.busy === visit.visitId}
                key={visit.visitId}
                meta={`${dayLabelLong(visit.visitDate)} · ${listText(visit.customerListType)} · ${visit.territoryName}`}
                negativeLabel="Refuse"
                noteHint="Why it does not count"
                noteMax={UNPLANNED_DECISION_NOTE_MAX}
                onDecide={(decision, note) => void decideUnplanned(visit, decision, note)}
                positiveLabel="Approve"
                status={visit.statusLabel}
                title={visit.customerName}
              >
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <CrmPhotoThumb path={visit.photoPath} />
                  <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                    <Text style={[type_.bodyStrong, { color: palette.ink }]}>{visit.repName}</Text>
                    <Text style={[type_.body, { color: palette.ink }]}>{`Why he went: ${visit.clarification}`}</Text>
                    {visit.products.length > 0 ? (
                      <Text style={[type_.meta, { color: palette.inkSoft }]}>{`Products: ${visit.products.join(", ")}`}</Text>
                    ) : null}
                    {visit.comment ? <Text style={[type_.meta, { color: palette.inkSoft }]}>{visit.comment}</Text> : null}
                    {/* The first step, once it is past: the SFE reads who already said yes before saying it too. */}
                    {visit.managerDecidedByName ? (
                      <Text style={[type_.meta, { color: palette.inkSoft }]}>
                        {`Approved by ${visit.managerDecidedByName}${visit.managerNote ? ` · ${visit.managerNote}` : ""}`}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </DecisionCard>
            ))}
          </View>
        </CrmSection>
      ) : null}

      {requests.length > 0 ? (
        <CrmSection title={`Grade and drop requests · ${requests.length}`}>
          <View style={{ gap: space.md }}>
            {requests.map((request) => (
              <DecisionCard
                busy={action.busy === request.requestId}
                key={request.requestId}
                meta={`${listText(request.listType)} · ${request.territoryName} · ${cairoStamp(request.requestedAt)}`}
                negativeLabel="Refuse"
                noteHint="Why it is refused"
                noteMax={DROP_REASON_MAX}
                onDecide={(decision, note) => void decideRequest(request, decision, note)}
                positiveLabel="Approve"
                status={requestSubject(request)}
                title={request.customerName}
              >
                {request.note ? (
                  <Text style={[type_.meta, { color: palette.inkSoft }]}>{`${request.requestedByName}: ${request.note}`}</Text>
                ) : null}
              </DecisionCard>
            ))}
          </View>
        </CrmSection>
      ) : null}
    </ScrollView>
  );
}
