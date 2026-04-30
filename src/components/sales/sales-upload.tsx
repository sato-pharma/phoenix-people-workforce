"use client";

import { FileSpreadsheet } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function SalesUpload() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">Sales Upload</h1>
        <p className="mt-1 text-text-secondary">
          Sales uploads are not active in the Phoenix Workforce sidebar.
        </p>
      </div>
      <Card>
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <FileSpreadsheet className="h-10 w-10 text-text-secondary" />
          <p className="font-medium text-text">Sales import is parked</p>
          <p className="max-w-md text-sm text-text-secondary">
            This placeholder keeps the route compile-safe while payroll and HR
            workflows are being built.
          </p>
          <Link href="/">
            <Button variant="secondary">Back to Dashboard</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
