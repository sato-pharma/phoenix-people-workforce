"use client";

import { AlertTriangle, CheckCircle, Clock, FileText, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SalesHistoryRow } from "@/lib/sales/types";
import { cn } from "@/lib/utils";

type Props = {
  initialData: SalesHistoryRow[] | null;
  initialError: string | null;
};

function statusBadge(status: string) {
  switch (status) {
    case "approved": return <Badge variant="success">Approved</Badge>;
    case "rejected": return <Badge variant="danger">Rejected</Badge>;
    case "needs_review": return <Badge variant="warning">Needs Review</Badge>;
    case "validated": return <Badge variant="neutral">Validated</Badge>;
    case "replaced": return <Badge variant="neutral">Replaced</Badge>;
    default: return <Badge variant="neutral">{status}</Badge>;
  }
}

export function SalesQueue({ initialData, initialError }: Props) {
  const [batches, setBatches] = useState(initialData ?? []);
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleAction(batchId: string, action: "approve" | "reject") {
    setLoading(batchId);
    setMessage(null);
    try {
      const res = await fetch(`/api/sales/imports/${batchId}/${action}`, { method: "POST" });
      const payload = await res.json();
      if (payload.success) {
        setMessage({ type: "success", text: payload.message });
        const updated = await fetch("/api/sales/imports?view=queue").then((r) => r.json());
        if (updated.success) setBatches(updated.data);
      } else {
        setMessage({ type: "error", text: payload.error ?? "Action failed." });
      }
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setLoading(null);
    }
  }

  if (initialError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-text">Sales Import Queue</h1>
          <p className="mt-1 text-text-secondary">Review and approve incoming sales batches.</p>
        </div>
        <Card className="border-danger/20 bg-red-50 dark:bg-red-950/20">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-danger" />
            <p className="text-sm text-danger">{initialError}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Sales Import Queue</h1>
          <p className="mt-1 text-text-secondary">
            {batches.length === 0 ? "No batches awaiting review." : `${batches.length} batch${batches.length === 1 ? "" : "es"} awaiting review.`}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/sales">
            <Button variant="secondary">Dashboard</Button>
          </Link>
          <Link href="/sales/upload">
            <Button>Upload Sales File</Button>
          </Link>
        </div>
      </div>

      {message && (
        <Card className={cn("border", message.type === "success" ? "border-green-200 bg-green-50 dark:bg-green-950/20" : "border-red-200 bg-red-50 dark:bg-red-950/20")}>
          <div className="flex items-center gap-3">
            {message.type === "success" ? <CheckCircle className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-danger" />}
            <p className="text-sm font-medium">{message.text}</p>
          </div>
        </Card>
      )}

      {batches.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <Clock className="h-10 w-10 text-text-secondary" />
            <p className="font-medium text-text">Queue is clear</p>
            <p className="text-sm text-text-secondary">All sales batches have been reviewed. Upload a new file to start the review process.</p>
            <Link href="/sales/upload">
              <Button className="mt-2">Upload Sales File</Button>
            </Link>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {batches.map((batch) => (
            <Card key={batch.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FileText className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-text">{batch.fileName}</p>
                    <p className="text-sm text-text-secondary">{batch.line} Â· {batch.period}</p>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-text-secondary">
                      <span>{batch.totalRecords} rows</span>
                      <span className="text-warning">{batch.warningRecords} warnings</span>
                      <span className="text-danger">{batch.failedRecords} failures</span>
                      <span className="text-success">{batch.linkedRecords} linked ({Math.round(batch.linkageRate * 100)}%)</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {statusBadge(batch.status)}
                  {batch.canApprove && (
                    <Button
                      className="px-3 py-1.5 text-xs"
                      onClick={() => handleAction(batch.id, "approve")}
                      disabled={loading === batch.id}
                    >
                      {loading === batch.id ? "Processing..." : "Approve"}
                    </Button>
                  )}
                  <Button
                    className="px-3 py-1.5 text-xs"
                    variant="secondary"
                    onClick={() => handleAction(batch.id, "reject")}
                    disabled={loading === batch.id || batch.status === "rejected"}
                  >
                    Reject
                  </Button>
                </div>
              </div>

              {batch.approvalBlockedReason && (
                <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-2 dark:border-orange-800 dark:bg-orange-950/20">
                  <p className="text-xs font-medium text-warning">{batch.approvalBlockedReason}</p>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
