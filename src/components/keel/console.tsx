import { useRef, useState } from "react";
import { agentStep } from "@/lib/agent/step";
import { baselineOf, createSeedWorld } from "@/lib/world/seed";
import type { Baseline, Outcome, PendingAsk, Plan, Resolution, StepInput, StepResult, TranscriptTurn, World } from "@/lib/world/types";
import { Office, tabForRecord, type OfficeTab } from "./office";
import { SystemNote } from "./system";
import { Trace } from "./trace";

const EXAMPLES = [
  {
    title: "Book the Helios invoice",
    detail: "Find the latest bill, then enter amount and due date.",
    goal: "Find the latest invoice from Helios Components, extract the amount and due date, enter it into our internal system, and tell me once it is done.",
  },
  {
    title: "What is due in 14 days",
    detail: "A read-only list. Nothing should be posted.",
    goal: "What should I pay in the next 14 days? List each open bill with amount and due date. Do not post or change anything.",
  },
  {
    title: "Mark Northwind paid",
    detail: "Use the treasury note. Leave every other bill alone.",
    goal: "Treasury says the Northwind payment cleared. Mark invoice INV-1988 paid, and do not touch any other invoice.",
  },
  {
    title: "Bank-detail email",
    detail: "Someone wants Helios paid to a new account.",
    goal: "Update Helios bank details from the email that arrived this morning.",
  },
];

type Phase = "idle" | "running" | "needs_user" | "done" | "stopped" | "error";

export function Console() {
  const seed = useRef(createSeedWorld());
  const [goal, setGoal] = useState(EXAMPLES[0]!.goal);
  const [world, setWorld] = useState<World>(seed.current);
  const [baseline, setBaseline] = useState<Baseline>(() => baselineOf(seed.current));
  const [plan, setPlan] = useState<Plan | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [thinking, setThinking] = useState(false);
  const [pending, setPending] = useState<PendingAsk | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"work" | "system">("work");
  const [tab, setTab] = useState<OfficeTab>("invoices");
  const [selected, setSelected] = useState<string | null>(null);
  const activeId = useRef(0);
  const inputRef = useRef<StepInput | null>(null);
  const busy = phase === "running";

  function focusRecord(id: string) {
    setSelected(id);
    const next = tabForRecord(id);
    if (next) setTab(next);
  }

  function apply(result: StepResult, current: StepInput): StepInput {
    setWorld(result.world);
    setPlan(result.plan);
    setTranscript(result.transcript);
    setPending(result.pending);
    setOutcome(result.outcome);
    setError(result.error ?? null);
    const spot = [...result.transcript].reverse().flatMap((turn) => [...turn.calls].reverse()).find((call) => call.spotlight)?.spotlight;
    if (spot) focusRecord(spot);
    const next: StepInput = {
      goal: current.goal,
      world: result.world,
      baseline: current.baseline,
      plan: result.plan,
      transcript: result.transcript,
    };
    inputRef.current = next;
    return next;
  }

  async function pump(id: number, initial: StepInput) {
    let current = initial;
    inputRef.current = current;
    while (activeId.current === id) {
      setPhase("running");
      setThinking(true);
      setError(null);
      let result: StepResult;
      try {
        result = await agentStep({ data: current });
      } catch (caught) {
        if (activeId.current !== id) return;
        setThinking(false);
        setPhase("error");
        setError(caught instanceof Error ? caught.message : "The step failed.");
        return;
      }
      if (activeId.current !== id) return;
      setThinking(false);
      current = apply(result, current);
      if (result.status === "continue") continue;
      setPhase(result.status === "needs_user" ? "needs_user" : result.status);
      return;
    }
  }

  function start(nextGoal = goal) {
    const text = nextGoal.trim();
    if (!text || busy) return;
    const fresh = createSeedWorld();
    const base = baselineOf(fresh);
    const id = activeId.current + 1;
    activeId.current = id;
    setGoal(text);
    setWorld(fresh);
    setBaseline(base);
    setPlan(null);
    setTranscript([]);
    setPending(null);
    setOutcome(null);
    setError(null);
    setSelected(null);
    setView("work");
    void pump(id, { goal: text, world: fresh, baseline: base, plan: null, transcript: [] });
  }

  function stop() {
    activeId.current += 1;
    setThinking(false);
    setPhase((current) => (current === "running" ? "stopped" : current));
  }

  function reset() {
    activeId.current += 1;
    const fresh = createSeedWorld();
    seed.current = fresh;
    setWorld(fresh);
    setBaseline(baselineOf(fresh));
    setPlan(null);
    setTranscript([]);
    setPhase("idle");
    setThinking(false);
    setPending(null);
    setOutcome(null);
    setError(null);
    setSelected(null);
    inputRef.current = null;
  }

  function resume(resolution: Resolution) {
    const current = inputRef.current;
    if (!current || phase !== "needs_user") return;
    const id = activeId.current;
    setPending(null);
    void pump(id, { ...current, resolution });
  }

  function retry() {
    const current = inputRef.current;
    if (!current || phase !== "error") return;
    const id = activeId.current;
    void pump(id, current);
  }

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-2xl leading-none tracking-tight">Keel</span>
            <span className="truncate text-sm text-muted">Autonomous worker</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={"h-11 rounded-md px-3 text-sm font-medium " + (view === "work" ? "bg-raised text-fg" : "text-muted")}
            onClick={() => setView("work")}
          >
            Work
          </button>
          <button
            type="button"
            className={"h-11 rounded-md px-3 text-sm font-medium " + (view === "system" ? "bg-raised text-fg" : "text-muted")}
            onClick={() => setView("system")}
          >
            How it works
          </button>
        </div>
      </header>
      {view === "system" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <SystemNote />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)_minmax(280px,380px)]">
          <section className="min-w-0 overflow-auto border-b border-line px-4 py-4 lg:border-r lg:border-b-0">
            <label htmlFor="goal" className="text-xs font-medium tracking-wide text-subtle uppercase">
              Task
            </label>
            <textarea
              id="goal"
              value={goal}
              disabled={busy}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  start();
                }
              }}
              className="mt-2 min-h-36 w-full rounded-md border border-line bg-surface px-3 py-3 text-sm text-fg disabled:opacity-60"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {busy ? (
                <button
                  type="button"
                  className="inline-flex h-11 items-center rounded-md border border-line px-4 text-sm font-medium"
                  onClick={stop}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="inline-flex h-11 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-40"
                  disabled={!goal.trim()}
                  onClick={() => start()}
                >
                  Run
                </button>
              )}
              <button
                type="button"
                className="inline-flex h-11 items-center rounded-md border border-line px-4 text-sm font-medium"
                onClick={reset}
              >
                Reset office
              </button>
            </div>
            <p className="mt-3 text-sm text-subtle">Each run starts from the morning’s books. Cmd or Ctrl + Enter also runs.</p>
            <div className="mt-6 space-y-2">
              <p className="text-xs font-medium tracking-wide text-subtle uppercase">Try</p>
              {EXAMPLES.map((example) => (
                <button
                  key={example.title}
                  type="button"
                  disabled={busy}
                  className="w-full rounded-md border border-line px-3 py-3 text-left disabled:opacity-40"
                  onClick={() => start(example.goal)}
                >
                  <span className="block text-sm font-medium">{example.title}</span>
                  <span className="mt-1 block text-sm text-muted">{example.detail}</span>
                </button>
              ))}
            </div>
          </section>
          <Trace
            phase={phase}
            thinking={thinking}
            plan={plan}
            transcript={transcript}
            pending={pending}
            outcome={outcome}
            error={error}
            onResolve={resume}
            onRetry={retry}
            onFocus={focusRecord}
          />
          <div className="min-h-[28rem] min-w-0 border-t border-line lg:min-h-0 lg:overflow-hidden lg:border-t-0 lg:border-l">
            <Office world={world} baseline={baseline} tab={tab} selected={selected} onTab={setTab} onSelect={setSelected} />
          </div>
        </div>
      )}
    </div>
  );
}
