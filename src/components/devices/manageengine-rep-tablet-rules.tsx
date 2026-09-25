"use client";

/**
 * The company's rep tablet rules, and the one button that writes them into ManageEngine.
 *
 * WHY IT IS HERE. The Rules section inside a tablet can only offer rule sets the company already
 * owns, and until this existed the tenant owned none — so that section read "this tablet carries none
 * of the company's rule sets" and there was nothing anyone could do about it from Phoenix. This card
 * is the missing half: it shows the rules Phoenix would write, builds them in ManageEngine once, and
 * then steps out of the way.
 *
 * IT SHOWS THE GAPS AS LOUDLY AS THE RULES. Three of the eight rules a Google-managed tablet follows
 * cannot be expressed as a ManageEngine profile at all. Listing only the seven that can would let the
 * page imply the overnight update window came with them, which is exactly the kind of quiet
 * overstatement this module exists to avoid.
 *
 * BUILDING IS NOT APPLYING. This creates the rules; putting a tablet on them is the Rules section on
 * that tablet, one at a time, with its own audit row. Nothing in a rep's hands changes when this
 * button is pressed.
 *
 * DESIGN IDENTITY is the Rep Tablets page around it — slate borders, square corners, 9px
 * micro-labels. It fits the screen: a `table-fixed` two-column table on desktop with a `colgroup`,
 * cards on a phone, and nothing truncated.
 */

import { Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";

type Setting = { rule: string; detail: string };
type Gap = { rule: string; detail: string };
type RulesState = {
  exists: boolean;
  name: string;
  profileId: string | null;
  settings: Setting[];
  gaps: Gap[];
};
type BuildResult = {
  created: boolean;
  published: boolean;
  carriesRestrictions: boolean;
  carriesPasscode: boolean;
  error: string | null;
  name: string;
};

async function readJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const failure = (payload ?? {}) as { message?: unknown };
    throw new Error(
      typeof failure.message === "string" && failure.message
        ? failure.message
        : "The server answered with an error and no explanation. Reload the page and try again.",
    );
  }
  return payload as T;
}

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/**
 * One line per rule, with the settings that carry it joined into a sentence.
 *
 * Several settings can carry one rule — "no side-loaded apps" is three of them — and listing the
 * rule three times would read as three rules. They are joined in the order they were written.
 */
function groupByRule(settings: readonly Setting[]): Array<{ rule: string; detail: string }> {
  const order: string[] = [];
  const details = new Map<string, string[]>();
  for (const setting of settings) {
    if (!details.has(setting.rule)) {
      details.set(setting.rule, []);
      order.push(setting.rule);
    }
    details.get(setting.rule)?.push(setting.detail);
  }
  return order.map((rule) => ({ detail: (details.get(rule) ?? []).join(" "), rule }));
}

function buildOutcome(result: BuildResult): { tone: "good" | "bad"; message: string } {
  if (!result.created) {
    return {
      message: `ManageEngine already holds "${result.name}", so nothing was changed. Open a tablet to put it on that tablet.`,
      tone: "good",
    };
  }
  if (result.published) {
    return {
      message: `"${result.name}" is built and published in ManageEngine. Open a tablet and put it on that tablet — building the rules does not apply them to anyone.`,
      tone: "good",
    };
  }
  return {
    message:
      result.error ??
      `"${result.name}" was created but not published, so it restricts nothing yet. Check it in the ManageEngine console before relying on it.`,
    tone: "bad",
  };
}

export function ManageEngineRepTabletRules() {
  const [state, setState] = useState<RulesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // A promise chain rather than an async effect body, so no setState runs synchronously in an effect.
  const load = useCallback(
    (isCurrent: () => boolean) =>
      readJson<RulesState>("/api/devices/manageengine/rep-tablet-profile")
        .then((result) => {
          if (!isCurrent()) return;
          setState(result);
          setLoadError(null);
        })
        .catch((caught: unknown) => {
          if (isCurrent()) setLoadError(messageOf(caught, "Could not read the company's rep tablet rules."));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        }),
    [],
  );

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  const build = useCallback(() => {
    setBusy(true);
    setNotice(null);
    setFailure(null);
    void readJson<BuildResult>("/api/devices/manageengine/rep-tablet-profile", {})
      .then((result) => {
        const outcome = buildOutcome(result);
        if (outcome.tone === "good") setNotice(outcome.message);
        else setFailure(outcome.message);
        return load(() => true);
      })
      .catch((caught: unknown) => {
        setFailure(messageOf(caught, "Could not build the rep tablet rules in ManageEngine."));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [load]);

  const rules = groupByRule(state?.settings ?? []);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-black text-slate-900">The rules on a rep tablet</h2>
        <p className="text-[11px] font-semibold text-slate-500">Super Admin only</p>
      </div>
      <p className="mt-1 max-w-3xl text-[12px] font-semibold text-slate-600">
        These are the rules every company tablet follows. Phoenix writes them into ManageEngine as one rule set, so the
        wording here and the settings on the tablets cannot drift apart. Building them changes no tablet on its own —
        open a tablet below to put it on these rules.
      </p>

      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-[12px] font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading the rules from ManageEngine…
        </p>
      ) : null}

      {loadError ? (
        <div className="mt-4 border border-rose-300 bg-rose-50 px-4 py-3 text-[12px] font-semibold text-rose-800">
          {loadError}
        </div>
      ) : null}

      {state && !loading ? (
        <div className="mt-4 border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <p className="text-[12px] font-bold text-slate-900">
              {state.exists ? (
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-emerald-700" aria-hidden />
                  ManageEngine holds these rules as &ldquo;{state.name}&rdquo;.
                </span>
              ) : (
                <>ManageEngine does not hold these rules yet, so no tablet can be put on them.</>
              )}
            </p>
            {state.exists ? null : (
              <button
                className="inline-flex items-center gap-1.5 border border-slate-900 bg-slate-900 px-3 py-1.5 text-[12px] font-bold text-white transition hover:bg-slate-700 disabled:opacity-50"
                disabled={busy}
                onClick={build}
                type="button"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Build them in ManageEngine
              </button>
            )}
          </div>

          {notice ? (
            <p className="border-b border-emerald-300 bg-emerald-50 px-4 py-3 text-[12px] font-semibold text-emerald-900">
              {notice}
            </p>
          ) : null}
          {failure ? (
            <p className="border-b border-rose-300 bg-rose-50 px-4 py-3 text-[12px] font-semibold text-rose-800">
              {failure}
            </p>
          ) : null}

          {/* DESKTOP — two columns, table-fixed with a colgroup so nothing is shrunk to fit. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[30%]" />
                <col className="w-[70%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-300 bg-slate-50">
                  {["Rule", "What it does"].map((heading) => (
                    <th className={`px-4 py-2 text-left ${MICRO_LABEL}`} key={heading} scope="col">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr className="border-b border-slate-100 align-top" key={rule.rule}>
                    <td className="break-words px-4 py-2 text-[12px] font-black text-slate-900">{rule.rule}</td>
                    <td className="break-words px-4 py-2 text-[12px] font-semibold text-slate-600">{rule.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* MOBILE — one card per rule. */}
          <div className="space-y-3 px-4 py-3 md:hidden">
            {rules.map((rule) => (
              <div className="border border-slate-200 px-3 py-2" key={rule.rule}>
                <p className="break-words text-[12px] font-black text-slate-900">{rule.rule}</p>
                <p className="mt-1 break-words text-[12px] font-semibold text-slate-600">{rule.detail}</p>
              </div>
            ))}
          </div>

          {state.gaps.length > 0 ? (
            <div className="border-t border-amber-300 bg-amber-50 px-4 py-3">
              <p className={MICRO_LABEL}>What these rules cannot cover</p>
              <ul className="mt-2 space-y-2">
                {state.gaps.map((gap) => (
                  <li className="break-words text-[12px] font-semibold text-amber-900" key={gap.rule}>
                    <span className="font-black">{gap.rule}.</span> {gap.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
