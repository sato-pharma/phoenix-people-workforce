"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * How many people each field prints for, fetched once per key set and then remembered.
 *
 * THE CACHE IS THE POINT, not an optimisation. The field table asks for a count for every row it
 * shows — 33 on Form 1 — and then asks again for the DRAFT key set on every keystroke while a rule
 * is being typed. Each answer costs the server a roster load, so without a cache typing
 * `{{jobTitleAr}}` would fire a dozen roster loads to arrive at one number. Key sets are stable
 * strings, so a set already answered is answered instantly and is never asked for twice.
 *
 * IT IS STATE, NOT A REF, and that is a correctness matter rather than a preference: the answers
 * decide what renders, and a ref read during render is both a lint error here and a genuine way to
 * paint a number that has already been superseded.
 *
 * THE DEBOUNCE IS THE OTHER HALF. A half-typed `{{jobTi` is a key set of its own, valid to ask about
 * and certain to be wrong; waiting for the typing to settle means the intermediate spellings are
 * never asked at all rather than being asked and discarded.
 */

/** Mirrors `FILLS_FOR_EVERYONE` in `field-fill-rate.ts` — a field that does not vary by person. */
export const FILLS_FOR_EVERYONE = -1;

export type FieldFillRate = {
  id: string;
  bound: string[];
  unbound: string[];
  filled: number;
  /** Up to three of the people this field would print nothing for, by name. */
  blankNames: string[];
};

export type FillRateBook = {
  /** Everybody this module can print for. 0 until the first answer arrives. */
  roster: number;
  error: string | null;
  loading: boolean;
  /** The answer for one key set, or null while it is still unknown. */
  rateFor: (keys: readonly string[]) => FieldFillRate | null;
};

const DEBOUNCE_MS = 400;

/** More than any document places, and the same ceiling the route enforces. */
const MAX_FIELDS = 200;

export function useFieldFillRates(
  keySets: readonly (readonly string[])[],
  enabled: boolean,
): FillRateBook {
  const [answers, setAnswers] = useState<Record<string, FieldFillRate>>({});
  const [roster, setRoster] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * The ids still unknown, as one stable string — the effect's whole dependency.
   *
   * Sorted and deduped so that re-ordering the table (a search, a filter) does not look like a new
   * question, and so a row that appears twice is asked about once.
   */
  const missing = useMemo(() => {
    if (!enabled) return "";
    const ids = new Set<string>();
    for (const keys of keySets) {
      const id = keys.join(",");
      if (id === "" || id in answers) continue;
      ids.add(id);
    }
    return Array.from(ids).sort().slice(0, MAX_FIELDS).join("|");
  }, [answers, enabled, keySets]);

  useEffect(() => {
    if (!enabled || missing === "") return;
    let live = true;

    const timer = setTimeout(() => {
      const ids = missing.split("|");
      const query = ids.map((id) => `field=${encodeURIComponent(id)}`).join("&");
      setLoading(true);
      void fetch(`/api/hiring-pack/field-fill-rate?${query}`)
        .then(async (response) => {
          const body = (await response.json()) as {
            roster?: number;
            fields?: FieldFillRate[];
            message?: string;
          };
          if (!response.ok) throw new Error(body.message ?? "Could not count the roster.");
          return body;
        })
        .then(
          (body) => {
            if (!live) return;
            setAnswers((current) => {
              const next = { ...current };
              for (const field of body.fields ?? []) next[field.id] = field;
              return next;
            });
            setRoster(body.roster ?? 0);
            setError(null);
            setLoading(false);
          },
          (cause: unknown) => {
            if (!live) return;
            // The ids stay out of the cache, so a later render asks again — which is right: this is
            // a number beside a text box, and a failed count must never look like a count of zero.
            setError(cause instanceof Error ? cause.message : "Could not count the roster.");
            setLoading(false);
          },
        );
    }, DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled, missing]);

  return {
    error,
    loading,
    roster,
    rateFor: (keys: readonly string[]) => answers[keys.join(",")] ?? null,
  };
}
