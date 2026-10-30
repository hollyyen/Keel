import { useState } from "react";
import type { Outcome, PendingAsk, Plan, Resolution, TranscriptTurn } from "@/lib/world/types";

const TOOL_LABEL: Record<string, string> = {
  declare_plan: "Plan",
  list_mailbox: "List mail",
  read_message: "Read mail",
  list_invoices: "List invoices",
  open_invoice: "Open invoice",
  list_vendors: "List vendors",
  find_vendor: "Find vendor",
  extract_invoice_fields: "Extract fields",
  read_vendor: "Read vendor",
  list_files: "List files",
  read_file: "Read file",
  read_policy: "Read policy",
  list_ledger: "List ledger",
  remember: "Remember",
  request_approval: "Request approval",
  commit_ledger_post: "Post to ledger",
  mark_invoice_paid: "Mark paid",
  ask_user: "Ask",
  finish: "Finish",
};

type Phase = "idle" | "running" | "needs_user" | "done" | "stopped" | "error";

type Props = {
  phase: Phase;
  thinking: boolean;
  plan: Plan | null;
  transcript: TranscriptTurn[];
  pending: PendingAsk | null;
  outcome: Outcome | null;
  error: string | null;
  onResolve: (resolution: Resolution) => void;
  onRetry: () => void;
  onFocus: (id: string) => void;
};

export function Trace({
  phase,
  thinking,
  plan,
  transcript,
  pending,
  outcome,
  error,
  onResolve,
  onRetry,
  onFocus,
}: Props) {
  const status = statusLine(phase, thinking, transcript.length);
  return (
    <section className="min-w-0 bg-bg px-4 py-4 lg:overflow-auto" aria-live="polite">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-xl leading-tight">Run</h2>
        <p className="text-sm text-muted">{status}</p>
      </div>
      {transcript.length === 0 && !thinking && (
        <p className="max-w-xl text-sm text-muted">
          Keel has not started. It will say what the goal means, use the back office, and refuse to
          call the job done until the records match.
        </p>
      )}
      {plan && (
        <article className="rise mb-4 rounded-xl bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-subtle uppercase">Understood as</p>
          <p className="mt-2 text-sm">{plan.understanding}</p>
          {plan.approach.length > 0 && (
            <ol className="mt-3 list-decimal space-y-1 pl-4 text-sm text-muted">
              {plan.approach.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          {plan.criticNotes.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-muted">
              {plan.criticNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </article>
      )}
      <ol className="space-y-3">
        {transcript.map((turn, index) => (
          <li key={`${index}-${turn.calls[0]?.id ?? "turn"}`} className="rise">
            {turn.calls.map((call) => (
              <article key={call.id} className="rounded-xl bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium">{TOOL_LABEL[call.name] ?? call.name}</p>
                  <span className={"text-xs font-medium " + (call.ok ? "text-ok" : "text-danger")}>
                    {call.ok ? "Ok" : "Failed"}
                  </span>
                </div>
                {typeof call.args.why === "string" && call.args.why && (
                  <p className="mt-1 text-sm text-muted">{call.args.why}</p>
                )}
                <pre className="mt-3 max-h-64 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
                  {call.summary}
                </pre>
                {call.spotlight && (
                  <button
                    type="button"
                    className="mt-3 h-11 text-sm font-medium text-fg underline decoration-line underline-offset-4"
                    onClick={() => onFocus(call.spotlight!)}
                  >
                    Show in the office
                  </button>
                )}
              </article>
            ))}
          </li>
        ))}
      </ol>
      {thinking && (
        <p className="rise mt-3 flex items-center gap-2 text-sm text-muted">
          <span className="pulse-dot inline-block size-2 rounded-full bg-fg" aria-hidden="true" />
          Choosing the next action
        </p>
      )}
      {pending && phase === "needs_user" && <Gate pending={pending} onResolve={onResolve} />}
      {outcome && phase === "done" && <Result outcome={outcome} onFocus={onFocus} />}
      {error && phase !== "running" && (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4">
          <p className="text-sm text-danger">{error}</p>
          {phase === "error" && (
            <button
              type="button"
              className="mt-3 inline-flex h-11 items-center rounded-md border border-line px-4 text-sm font-medium"
              onClick={onRetry}
            >
              Retry this step
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function statusLine(phase: Phase, thinking: boolean, steps: number): string {
  if (thinking) return `Step ${steps + 1} of 12`;
  if (phase === "needs_user") return "Waiting for you";
  if (phase === "done") return "Verified";
  if (phase === "stopped") return "Stopped";
  if (phase === "error") return "Step failed";
  if (steps > 0) return `${steps} of 12 steps`;
  return "Idle";
}

function Gate({ pending, onResolve }: { pending: PendingAsk; onResolve: (resolution: Resolution) => void }) {
  const [answer, setAnswer] = useState("");
  if (pending.kind === "approval" && pending.approvalId) {
    const approvalId = pending.approvalId;
    return (
      <div className="rise mt-4 rounded-xl bg-raised p-4">
        <p className="text-xs font-medium tracking-wide text-warn uppercase">Approval needed</p>
        <h3 className="mt-2 text-base font-medium">{pending.question}</h3>
        {pending.detail && <p className="mt-1 text-sm text-muted">{pending.detail}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex h-11 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
            onClick={() => onResolve({ kind: "approval", approvalId, decision: "approved" })}
          >
            Approve
          </button>
          <button
            type="button"
            className="inline-flex h-11 items-center rounded-md border border-line px-4 text-sm font-medium text-danger"
            onClick={() => onResolve({ kind: "approval", approvalId, decision: "rejected" })}
          >
            Reject
          </button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="rise mt-4 rounded-xl bg-raised p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!answer.trim()) return;
        onResolve({ kind: "answer", text: answer.trim() });
        setAnswer("");
      }}
    >
      <p className="text-xs font-medium tracking-wide text-subtle uppercase">Keel needs an answer</p>
      <h3 className="mt-2 text-base font-medium">{pending.question}</h3>
      <textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        className="mt-3 min-h-24 w-full rounded-md border border-line bg-bg px-3 py-3 text-sm text-fg"
        placeholder="Your answer"
      />
      <button
        type="submit"
        className="mt-3 inline-flex h-11 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
      >
        Send
      </button>
    </form>
  );
}

function Result({ outcome, onFocus }: { outcome: Outcome; onFocus: (id: string) => void }) {
  const ids = [...new Set(outcome.claims.flatMap((claim) => claim.evidenceIds))];
  return (
    <article className="rise mt-4 rounded-xl bg-surface p-4">
      <p className={"text-xs font-medium tracking-wide uppercase " + (outcome.blocked ? "text-warn" : "text-ok")}>
        {outcome.blocked ? "Stopped with your decision" : "Verified from the records"}
      </p>
      <p className="mt-2 text-sm">{outcome.summary}</p>
      <ul className="mt-3 space-y-1">
        {outcome.checks.map((check) => (
          <li key={check.kind + check.detail} className="text-sm text-muted">
            <span className={check.ok ? "text-ok" : "text-danger"}>{check.ok ? "Pass" : "Fail"}</span>
            {" · "}
            {check.detail}
          </li>
        ))}
      </ul>
      {ids.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {ids.map((id) => (
            <button
              key={id}
              type="button"
              className="inline-flex h-11 items-center rounded-md border border-line px-3 text-sm"
              onClick={() => onFocus(id)}
            >
              {id}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
