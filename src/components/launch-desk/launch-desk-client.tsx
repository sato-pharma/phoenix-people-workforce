"use client";

import { AlertTriangle, Boxes, CalendarDays, CheckCircle2, ClipboardList, Loader2, Rocket, Send, ShieldCheck, Sparkles, Users, Wrench } from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";

type FormState = {
  productBrief: string;
  audience: string;
  launchDate: string;
  constraints: string;
  assets: string;
};

type ToolProgress = {
  id: string;
  stage: "started" | "completed";
  tool: string;
  message: string;
};

type ParsedStreamEvent =
  | { type: "tool_progress"; stage: "started" | "completed"; tool: string; message: string }
  | { type: "text_delta"; delta: string }
  | { type: "final"; output: string }
  | { type: "error"; message: string };

const initialForm: FormState = {
  productBrief:
    "We want to launch a self-serve beta for engineering managers to create release checklists from a product idea, then export the plan to Slack and a changelog draft. The beta should start with three design partners and expand after the first week if reliability looks good.",
  audience: "Engineering managers, product managers, QA leads, and customer-facing launch owners at mid-market SaaS teams.",
  launchDate: "",
  constraints: "Small team, must avoid customer data exposure, needs feature flag rollback, and support needs a short FAQ before the announcement.",
  assets: "Early Figma mock, product brief, beta customer list, and a draft changelog outline.",
};

const toolLabels: Record<string, string> = {
  check_launch_readiness: "Readiness",
  draft_channel_launch_copy: "Copy",
  extract_launch_tasks: "Tasks",
  generate_owner_checklists: "Owners",
  launch_desk_agent: "Agent",
};

function FieldLabel({ icon: Icon, label }: { icon: typeof ClipboardList; label: string }) {
  return (
    <span className="flex items-center gap-2 text-sm font-semibold text-[#14213D]">
      <Icon className="size-4 text-[#0B6B6F]" aria-hidden="true" />
      {label}
    </span>
  );
}

function parseSseBlock(block: string): ParsedStreamEvent | null {
  let eventName = "";
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }

  if (!eventName || dataLines.length === 0) return null;

  try {
    const parsed = JSON.parse(dataLines.join("\n")) as ParsedStreamEvent;
    return parsed.type === eventName ? parsed : null;
  } catch {
    return null;
  }
}

export function LaunchDeskClient() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [output, setOutput] = useState("");
  const [progress, setProgress] = useState<ToolProgress[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const completedTools = useMemo(() => new Set(progress.filter((item) => item.stage === "completed").map((item) => item.tool)), [progress]);

  function updateField(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("running");
    setOutput("");
    setProgress([]);
    setError("");

    try {
      const response = await fetch("/api/launch-desk/plan", {
        body: JSON.stringify(form),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Launch Desk request failed with HTTP ${response.status}.`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\n\n/);
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;

          if (parsed.type === "tool_progress") {
            setProgress((current) => [
              ...current,
              {
                id: `${parsed.tool}-${parsed.stage}-${current.length}`,
                message: parsed.message,
                stage: parsed.stage,
                tool: parsed.tool,
              },
            ]);
          }

          if (parsed.type === "text_delta") {
            setOutput((current) => current + parsed.delta);
          }

          if (parsed.type === "final") {
            setOutput((current) => current || parsed.output);
            setStatus("done");
          }

          if (parsed.type === "error") {
            throw new Error(parsed.message);
          }
        }
      }

      setStatus((current) => (current === "running" ? "done" : current));
    } catch (caught) {
      if (controller.signal.aborted) return;
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Launch Desk failed.");
    }
  }

  function stopRun() {
    abortRef.current?.abort();
    setStatus("idle");
  }

  return (
    <main className="min-h-screen bg-[#F5F7FB] text-[#14213D]">
      <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-[#D9E2EC] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-lg bg-[#14213D] text-white shadow-[0_12px_30px_rgba(20,33,61,0.22)]">
                <Rocket className="size-5" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase text-[#0B6B6F]">Launch planning agent</p>
                <h1 className="font-display text-4xl font-semibold text-[#14213D] sm:text-5xl">Launch Desk</h1>
              </div>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#4B5B73]">
              Convert a rough launch idea into a prioritized release plan, risk register, owner checklist, launch copy, and follow-up questions.
            </p>
          </div>

          <div className="grid min-w-[280px] grid-cols-4 overflow-hidden rounded-lg border border-[#D9E2EC] bg-white shadow-sm">
            {["Brief", "Tools", "Plan", "Gate"].map((label, index) => {
              const active = status === "running" ? index <= 1 : status === "done" ? true : index === 0;
              return (
                <div key={label} className={`border-r border-[#E6ECF2] px-3 py-3 last:border-r-0 ${active ? "bg-[#E8F7F3]" : "bg-white"}`}>
                  <p className="text-[11px] font-semibold uppercase text-[#617089]">{label}</p>
                  <div className={`mt-2 h-1.5 rounded-full ${active ? "bg-[#0B6B6F]" : "bg-[#D9E2EC]"}`} />
                </div>
              );
            })}
          </div>
        </header>

        <div className="grid flex-1 gap-5 py-5 lg:grid-cols-[minmax(360px,0.82fr)_minmax(520px,1.18fr)]">
          <section className="border border-[#D9E2EC] bg-white shadow-sm">
            <form onSubmit={submit} className="flex h-full flex-col">
              <div className="border-b border-[#E6ECF2] px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-[#14213D]">Launch input</h2>
                    <p className="mt-1 text-sm text-[#617089]">Give the agent enough signal to plan the release.</p>
                  </div>
                  <Sparkles className="size-5 text-[#E56B1F]" aria-hidden="true" />
                </div>
              </div>

              <div className="grid gap-4 p-5">
                <label className="grid gap-2">
                  <FieldLabel icon={ClipboardList} label="Product brief" />
                  <textarea
                    className="min-h-44 resize-y rounded-lg border border-[#C9D5E2] bg-[#FBFCFE] px-3 py-3 text-sm leading-6 text-[#14213D] outline-none transition focus:border-[#0B6B6F] focus:ring-3 focus:ring-[#0B6B6F]/15"
                    value={form.productBrief}
                    onChange={(event) => updateField("productBrief", event.target.value)}
                    required
                  />
                </label>

                <label className="grid gap-2">
                  <FieldLabel icon={Users} label="Audience" />
                  <textarea
                    className="min-h-20 resize-y rounded-lg border border-[#C9D5E2] bg-[#FBFCFE] px-3 py-3 text-sm leading-6 text-[#14213D] outline-none transition focus:border-[#0B6B6F] focus:ring-3 focus:ring-[#0B6B6F]/15"
                    value={form.audience}
                    onChange={(event) => updateField("audience", event.target.value)}
                  />
                </label>

                <label className="grid gap-2">
                  <FieldLabel icon={CalendarDays} label="Launch date" />
                  <input
                    className="h-11 rounded-lg border border-[#C9D5E2] bg-[#FBFCFE] px-3 text-sm text-[#14213D] outline-none transition focus:border-[#0B6B6F] focus:ring-3 focus:ring-[#0B6B6F]/15"
                    placeholder="2026-07-15 or Q3 beta"
                    value={form.launchDate}
                    onChange={(event) => updateField("launchDate", event.target.value)}
                  />
                </label>

                <label className="grid gap-2">
                  <FieldLabel icon={ShieldCheck} label="Constraints" />
                  <textarea
                    className="min-h-24 resize-y rounded-lg border border-[#C9D5E2] bg-[#FBFCFE] px-3 py-3 text-sm leading-6 text-[#14213D] outline-none transition focus:border-[#0B6B6F] focus:ring-3 focus:ring-[#0B6B6F]/15"
                    value={form.constraints}
                    onChange={(event) => updateField("constraints", event.target.value)}
                  />
                </label>

                <label className="grid gap-2">
                  <FieldLabel icon={Boxes} label="Available assets" />
                  <textarea
                    className="min-h-20 resize-y rounded-lg border border-[#C9D5E2] bg-[#FBFCFE] px-3 py-3 text-sm leading-6 text-[#14213D] outline-none transition focus:border-[#0B6B6F] focus:ring-3 focus:ring-[#0B6B6F]/15"
                    value={form.assets}
                    onChange={(event) => updateField("assets", event.target.value)}
                  />
                </label>
              </div>

              <div className="mt-auto flex items-center justify-between gap-3 border-t border-[#E6ECF2] px-5 py-4">
                <button
                  type="button"
                  onClick={stopRun}
                  disabled={status !== "running"}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#C9D5E2] px-3 text-sm font-semibold text-[#40516A] transition hover:bg-[#F5F7FB] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Wrench className="size-4" aria-hidden="true" />
                  Stop
                </button>
                <button
                  type="submit"
                  disabled={status === "running"}
                  className="inline-flex h-10 min-w-36 items-center justify-center gap-2 rounded-lg bg-[#E56B1F] px-4 text-sm font-semibold text-white shadow-[0_10px_22px_rgba(229,107,31,0.25)] transition hover:bg-[#C85415] disabled:cursor-wait disabled:opacity-70"
                >
                  {status === "running" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
                  Generate plan
                </button>
              </div>
            </form>
          </section>

          <section className="grid min-h-[720px] grid-rows-[auto_1fr] border border-[#D9E2EC] bg-white shadow-sm">
            <div className="border-b border-[#E6ECF2] px-5 py-4">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-[#14213D]">Agent run</h2>
                  <p className="mt-1 text-sm text-[#617089]">Tool activity and streamed plan appear here.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(toolLabels)
                    .filter(([tool]) => tool !== "launch_desk_agent")
                    .map(([tool, label]) => (
                      <span
                        key={tool}
                        className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold ${
                          completedTools.has(tool)
                            ? "border-[#BEE3DB] bg-[#E8F7F3] text-[#0B6B6F]"
                            : "border-[#D9E2EC] bg-[#F8FAFC] text-[#617089]"
                        }`}
                      >
                        {completedTools.has(tool) ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : <Wrench className="size-3.5" aria-hidden="true" />}
                        {label}
                      </span>
                    ))}
                </div>
              </div>
            </div>

            <div className="grid min-h-0 gap-0 xl:grid-cols-[300px_1fr]">
              <aside className="border-b border-[#E6ECF2] bg-[#F8FAFC] p-4 xl:border-b-0 xl:border-r">
                <h3 className="text-sm font-semibold text-[#14213D]">Progress</h3>
                <div className="mt-3 grid gap-2">
                  {progress.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[#C9D5E2] bg-white px-3 py-4 text-sm text-[#617089]">No run started.</div>
                  ) : (
                    progress.map((item) => (
                      <div key={item.id} className="rounded-lg border border-[#D9E2EC] bg-white px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-semibold uppercase text-[#617089]">{toolLabels[item.tool] ?? item.tool}</p>
                          <span
                            className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                              item.stage === "completed" ? "bg-[#E8F7F3] text-[#0B6B6F]" : "bg-[#FFF4E8] text-[#B45309]"
                            }`}
                          >
                            {item.stage}
                          </span>
                        </div>
                        <p className="mt-2 text-sm leading-5 text-[#40516A]">{item.message}</p>
                      </div>
                    ))
                  )}
                </div>
              </aside>

              <div className="flex min-h-0 flex-col bg-[#FCFDFF]">
                {error ? (
                  <div className="m-5 flex items-start gap-3 rounded-lg border border-[#F5C2C7] bg-[#FFF5F5] p-4 text-[#8A1F2D]">
                    <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                    <p className="text-sm font-semibold">{error}</p>
                  </div>
                ) : null}

                <article className="min-h-0 flex-1 overflow-y-auto p-5">
                  {output ? (
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-[#14213D]">{output}</pre>
                  ) : (
                    <div className="flex h-full min-h-[420px] items-center justify-center">
                      <div className="max-w-sm text-center">
                        <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-[#E8F7F3] text-[#0B6B6F]">
                          {status === "running" ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : <Rocket className="size-5" aria-hidden="true" />}
                        </div>
                        <p className="mt-4 text-sm font-semibold text-[#14213D]">{status === "running" ? "Waiting for streamed model output" : "Ready for a launch plan"}</p>
                        <p className="mt-2 text-sm leading-6 text-[#617089]">Tool progress appears first, then the model response streams into this pane.</p>
                      </div>
                    </div>
                  )}
                </article>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
