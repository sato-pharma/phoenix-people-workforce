"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { phxFormErrorClassName } from "@/components/ui/form-tokens";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

export const headerClassName =
  "bg-phx-accent-soft px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft";
export const cellClassName = "border-b border-phx-line px-3 py-3 align-top";
export const textLinkClassName = "inline-block text-phx-xs font-bold text-phx-accent hover:underline";
export const fileLinkClassName =
  "inline-flex h-10 items-center border border-phx-line bg-white px-3 text-sm font-bold text-phx-ink hover:border-phx-accent";

async function readAnswer(response: Response) {
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  throw new Error(body?.message ?? "That did not save. Try again.");
}

export async function sendJson(url: string, method: "DELETE" | "PATCH" | "POST", body?: unknown) {
  await readAnswer(
    await fetch(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      method,
    }),
  );
}

/** Posts a JSON body and saves the file that comes back under the name the server gave it. */
export async function downloadPosted(url: string, body: unknown, fallbackName: string) {
  const response = await fetch(url, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
  await readAnswer(response);
  const named = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1];
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await response.blob());
  link.download = named ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export async function sendForm(url: string, form: FormData) {
  await readAnswer(await fetch(url, { body: form, method: "POST" }));
}

/** One save at a time per form: its busy flag, its error, and the page re-read once it lands. */
export function useSave() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = React.useCallback(
    async (work: () => Promise<void>, afterwards?: () => void) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        afterwards?.();
        router.refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "That did not save. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  return { busy, error, save };
}

export function SaveError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className={phxFormErrorClassName} role="alert">{error}</p>;
}

const cairoStamp = stableEnGbFormatter({
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

export function cairoDateTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : cairoStamp.format(at);
}
