"use client";

import { ShieldAlert } from "lucide-react";

import { Card } from "@/components/ui/card";
import type { OutstationFraudFlag } from "@/lib/outstation/types";

function label(flag: OutstationFraudFlag) {
  return flag.replace(/_/g, " ");
}

export function FraudFlagsPanel({
  fraudFlags,
  score,
}: {
  fraudFlags: OutstationFraudFlag[];
  score: number;
}) {
  return (
    <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
          <ShieldAlert className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
            Fraud Signals
          </p>
          <h3 className="mt-1 text-lg font-black tracking-[-0.03em] text-slate-950">
            Suspicious location score: {score.toFixed(0)}/100
          </h3>
          {fraudFlags.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {fraudFlags.map((flag) => (
                <span
                  className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700 ring-1 ring-amber-100"
                  key={flag}
                >
                  {label(flag)}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">
              No fraud flags were raised for this request.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
