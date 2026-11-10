"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { offerHintClassName, offerInputClassName, offerLabelClassName } from "@/components/offers/offer-ui";
import { splitOfferCopyAddresses } from "@/lib/offers/copy-recipients";
import type { OfferCopyDirectory, OfferCopyPerson } from "@/lib/offers/copy-directory";
import { cn } from "@/lib/utils";

/**
 * Pick who to copy from lists, Line → Region → Area (owner, 2026-11-10: "in the cc email field and bcc
 * make them a droplist cascading as per area line region"). The chosen area lists its District Manager,
 * Regional Manager and National Sales Manager; the HR team is always listed. Each person has an
 * "Add to CC" and an "Add to BCC" button that writes their work email into that box — the boxes stay
 * typeable (he chose "Keep typing too"), and every check on them still applies.
 *
 * Native <select>s, like the Vacant seat picker: the option text wraps in the browser's own panel, so no
 * name is ever cut off, and they work the same at 375px as on a desktop.
 */
export function OfferCopyPicker({
  bcc,
  cc,
  directory,
  disabled,
  onAdd,
}: {
  bcc: string;
  cc: string;
  directory: OfferCopyDirectory;
  disabled: boolean;
  onAdd: (key: "bcc" | "cc", email: string) => void;
}) {
  const [lineCode, setLineCode] = useState("");
  const [regionCode, setRegionCode] = useState("");
  const [areaCode, setAreaCode] = useState("");

  const line = directory.lines.find((entry) => entry.code === lineCode) ?? null;
  const region = line?.regions.find((entry) => entry.code === regionCode) ?? null;
  const area = region?.areas.find((entry) => entry.code === areaCode) ?? null;

  // What is already in each box, so a person already copied says so instead of offering the button again.
  const present = useMemo(
    () => ({
      bcc: new Set(splitOfferCopyAddresses(bcc).map((address) => address.toLowerCase())),
      cc: new Set(splitOfferCopyAddresses(cc).map((address) => address.toLowerCase())),
    }),
    [bcc, cc],
  );

  if (directory.lines.length === 0 && directory.hrTeam.length === 0) return null;

  const person = (entry: OfferCopyPerson, index: number) => {
    const email = entry.email;
    const inCc = Boolean(email && present.cc.has(email));
    const inBcc = Boolean(email && present.bcc.has(email));
    return (
      <li
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-phx-line py-2 last:border-b-0"
        key={`${entry.role}-${email ?? "vacant"}-${index}`}
      >
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-bold text-phx-ink">
            {entry.vacant ? "Vacant" : entry.name}
            <span className="font-normal text-phx-ink-soft"> · {entry.role}</span>
          </p>
          {/* `[overflow-wrap:anywhere]`: an address has no space to break at; it wraps, never an ellipsis. */}
          <p className={cn(offerHintClassName, "mt-0 [overflow-wrap:anywhere]")}>
            {entry.vacant ? "Nobody holds this seat today." : email ?? "No work email on the employee record, so they cannot be copied from here."}
          </p>
        </div>
        {email ? (
          <div className="flex shrink-0 gap-2">
            <Button
              disabled={disabled || inCc}
              onClick={() => onAdd("cc", email)}
              size="sm"
              type="button"
              variant="outline"
            >
              {inCc ? "In CC" : "Add to CC"}
            </Button>
            <Button
              disabled={disabled || inBcc || inCc}
              onClick={() => onAdd("bcc", email)}
              size="sm"
              type="button"
              variant="outline"
            >
              {inBcc ? "In BCC" : "Add to BCC"}
            </Button>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="md:col-span-2 xl:col-span-3">
      <p className={offerLabelClassName}>Pick who to copy</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={offerLabelClassName} htmlFor="offer-copy-line">Line</label>
          <select
            className={offerInputClassName}
            disabled={disabled}
            id="offer-copy-line"
            onChange={(event) => {
              setLineCode(event.target.value);
              setRegionCode("");
              setAreaCode("");
            }}
            value={lineCode}
          >
            <option value="">Choose a line</option>
            {directory.lines.map((entry) => (
              <option key={entry.code} value={entry.code}>{entry.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={offerLabelClassName} htmlFor="offer-copy-region">Region</label>
          <select
            className={offerInputClassName}
            disabled={disabled || !line}
            id="offer-copy-region"
            onChange={(event) => {
              setRegionCode(event.target.value);
              setAreaCode("");
            }}
            value={regionCode}
          >
            <option value="">{line ? "Choose a region" : "Choose a line first"}</option>
            {(line?.regions ?? []).map((entry) => (
              <option key={entry.code} value={entry.code}>{entry.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={offerLabelClassName} htmlFor="offer-copy-area">Area</label>
          <select
            className={offerInputClassName}
            disabled={disabled || !region}
            id="offer-copy-area"
            onChange={(event) => setAreaCode(event.target.value)}
            value={areaCode}
          >
            <option value="">{region ? "Choose an area" : "Choose a region first"}</option>
            {(region?.areas ?? []).map((entry) => (
              <option key={entry.code} value={entry.code}>{entry.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="border border-phx-line bg-white px-3 py-1 shadow-none">
          <p className="pt-2 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
            {area ? `${area.name} managers` : "Area managers"}
          </p>
          {area ? (
            area.people.length > 0 ? (
              <ul>{area.people.map(person)}</ul>
            ) : (
              <p className={cn(offerHintClassName, "pb-2")}>No manager seat is mapped above this area.</p>
            )
          ) : (
            <p className={cn(offerHintClassName, "pb-2")}>
              Choose a line, a region and an area to list its District Manager, Regional Manager and National Sales
              Manager.
            </p>
          )}
        </div>
        <div className="border border-phx-line bg-white px-3 py-1 shadow-none">
          <p className="pt-2 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">HR team</p>
          {directory.hrTeam.length > 0 ? (
            <ul>{directory.hrTeam.map(person)}</ul>
          ) : (
            <p className={cn(offerHintClassName, "pb-2")}>The HR team could not be read just now. Type the address instead.</p>
          )}
        </div>
      </div>
      <p className={offerHintClassName}>
        Adding writes the work email into the CC or BCC box below. You can still type any address yourself.
      </p>
    </div>
  );
}
