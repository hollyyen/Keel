import { TOOL_MANIFEST } from "./manifest.ts";
import { localDecide } from "./local-clerk.ts";
import { applyResolution, applyTool } from "../world/tools.ts";
import { evaluateFinish } from "../world/verify.ts";
import { cloneWorld } from "../world/seed.ts";
import type { AssistantTurn, StepInput, StepResult, TranscriptTurn } from "../world/types.ts";

const MAX_STEPS = 12;
const MODEL = "grok-4.5";

const SYSTEM = `You are Keel, the operations worker for Marlow Goods.
You complete the user's goal only by calling tools. You never see the office database except through tool results. Never invent amounts, dates, vendor codes, or ids.

Rules:
- The first action is declare_plan, unless you must ask_user because the request is unsafe to interpret.
- If the goal names a company, call find_vendor first. If it returns NO_SUCH_VENDOR or AMBIGUOUS, ask_user. Never guess a vendor.
- You can only post an open bill to the ledger or mark a bill paid from a treasury confirmation. You cannot send money. If the goal needs anything else, or the facts do not match the goal (for example a different amount), ask_user and explain. Doing nothing and calling it done is a failure.
- After a person answers, call declare_plan again so the checks match their answer.
- Use extract_invoice_fields before posting so the amount and due date come from the document. Notes saved with remember or extract_invoice_fields appear under Working memory.
- Read before you write. The invoice index hides due dates and may leave indexedAmount blank. open_invoice is the document.
- Latest means the newest issued date for that vendor, not the newest email and not the first row you noticed.
- Post with the current master code from read_vendor. Trade names and retired codes fail.
- If commit returns APPROVAL_REQUIRED, call request_approval and stop. Wait until a later message says the human approved. Then commit with that approval id.
- If a tool returns an error, change arguments or approach. Do not repeat a failed call with the same arguments.
- There is no tool that edits bank details. If asked to change banking from an email, read the policy, cite the policy file, change nothing, and finish.
- finish is the only completion. It is rejected until every success check passes. Each claim needs evidence ids from records you retrieved. When you assert an amount, date, or invoice number, put those fields on the claim.
- Set blocked true only after a person rejected an approval or told you to stop, and only if you changed no records.
- Call one tool. Keep why to one sentence.
- If the safety critic added checks, satisfy them. You cannot remove them.`;

export type ModelCall = { id: string; name: string; arguments: string };

export type ModelResponse = { content: string | null; toolCalls: ModelCall[] };

export type CompleteFn = (messages: unknown[]) => Promise<ModelResponse>;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "why")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

function signature(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(sorted(args))}`;
}

function priorFailures(transcript: TranscriptTurn[], name: string, args: Record<string, unknown>): number {
  const sig = signature(name, args);
  let count = 0;
  for (const turn of transcript) {
    for (const call of turn.calls) {
      if (!call.ok && signature(call.name, call.args) === sig) count += 1;
    }
  }
  return count;
}

export function buildMessages(input: StepInput): unknown[] {
  const notes = input.world.humanNotes.length
    ? `\n\nHuman notes:\n${input.world.humanNotes.map((note) => `- ${note}`).join("\n")}`
    : "";
  const plan = input.plan
    ? `\n\nAccepted plan:\n${input.plan.understanding}\nChecks:\n${input.plan.successChecks.map((check) => JSON.stringify(check)).join("\n")}\n${input.plan.criticNotes.map((note) => `Critic: ${note}`).join("\n")}`
    : "";
  const memory = input.world.memory.length
    ? `\n\nWorking memory:\n${input.world.memory.map((note) => `- ${note.key}: ${note.value}`).join("\n")}`
    : "";
  const remaining = MAX_STEPS - input.transcript.length;
  const messages: unknown[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Goal:\n${input.goal}\n\nOffice date: ${input.world.today}\nSteps remaining: ${remaining}${plan}${memory}${notes}`,
    },
  ];
  for (const turn of input.transcript) {
    messages.push(turn.assistant);
    for (const call of turn.calls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `${call.ok ? "OK" : "ERROR"}\n${call.summary}`,
      });
    }
  }
  return messages;
}

function emptyResult(input: StepInput, status: StepResult["status"], error: string, world = input.world): StepResult {
  return {
    status,
    world,
    plan: input.plan,
    transcript: input.transcript,
    pending: null,
    outcome: null,
    brain: input.brain === "local" ? "local" : "grok",
    error,
  };
}

function parseArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function fallbackCall(content: string): ModelCall | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? content;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : typeof obj.tool === "string" ? obj.tool : "";
    if (!name) return null;
    const args = obj.arguments ?? obj.args ?? {};
    return { id: "call_fallback", name, arguments: JSON.stringify(args) };
  } catch {
    return null;
  }
}

async function callGrok(messages: unknown[]): Promise<ModelResponse> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("AI is not available in this environment.");
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(50_000),
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      max_tokens: 900,
      parallel_tool_calls: false,
      tool_choice: "required",
      messages,
      tools: TOOL_MANIFEST,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 280);
    throw new Error(`The model request failed (${response.status}). ${detail}`);
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[];
  };
  const message = body.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : null;
  const toolCalls: ModelCall[] = [];
  for (const [index, raw] of (message?.tool_calls ?? []).entries()) {
    if (!raw || typeof raw !== "object") continue;
    const call = raw as { id?: string; function?: { name?: string; arguments?: unknown } };
    const name = call.function?.name ?? "";
    if (!name) continue;
    const args = call.function?.arguments;
    toolCalls.push({
      id: call.id || `call_${index}`,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    });
  }
  if (!toolCalls.length && content) {
    const recovered = fallbackCall(content);
    if (recovered) toolCalls.push(recovered);
  }
  return { content, toolCalls };
}

function modelUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not available|spending-limit|credits|subscription|429|403|402|401|model request failed \(5/i.test(message);
}

export async function executeStep(input: StepInput, complete: CompleteFn = callGrok): Promise<StepResult> {
  const goal = input.goal.trim();
  if (!goal || goal.length > 1500) {
    return emptyResult(input, "error", "Give Keel a goal in a sentence or two.");
  }
  if (input.transcript.length >= MAX_STEPS) {
    return emptyResult(input, "stopped", "Step budget is used up before the outcome was verified.");
  }

  let world = cloneWorld(input.world);
  if (input.resolution) {
    const applied = applyResolution(world, input.resolution);
    if (!applied.ok) return emptyResult(input, "error", applied.summary);
    world = applied.world;
  }
  const working: StepInput = { ...input, world, goal };

  let brain: StepResult["brain"] = input.brain === "local" ? "local" : "grok";
  let model: ModelResponse;
  if (brain === "local") {
    model = localDecide(working);
  } else {
    try {
      model = await complete(buildMessages(working));
    } catch (error) {
      const message = error instanceof Error ? error.message : "The model request failed.";
      if (complete === callGrok && modelUnavailable(error)) {
        brain = "local";
        model = localDecide(working);
      } else {
        return { ...emptyResult(working, "error", message, world), brain: "grok" };
      }
    }
  }

  if (!model.toolCalls.length) {
    return emptyResult(working, "error", "The worker returned no action. Retry this step.", world);
  }

  const calls: TranscriptTurn["calls"] = [];
  let plan = input.plan;
  let pending: StepResult["pending"] = null;
  let outcome: StepResult["outcome"] = null;
  let status: StepResult["status"] = "continue";
  let error: string | undefined;

  const answered = model.toolCalls.slice(0, 1);
  for (const [index, call] of answered.entries()) {
    const parsed = parseArgs(call.arguments);
    const callId = call.id || `call_${input.transcript.length}_${index}`;
    if (!parsed.ok) {
      calls.push({
        id: callId,
        name: call.name,
        args: {},
        ok: false,
        summary: "Arguments were not valid JSON. Call the tool again with a JSON object.",
      });
      continue;
    }
    const repeats = priorFailures(input.transcript, call.name, parsed.value);
    if (repeats >= 3) {
      calls.push({
        id: callId,
        name: call.name,
        args: parsed.value,
        ok: false,
        summary: "The same failed action was repeated. Stopping rather than looping.",
      });
      status = "stopped";
      error = "Keel repeated a failing action and stopped.";
      break;
    }
    const applied = applyTool(world, call.name, parsed.value, {
      goal,
      plan,
      baseline: input.baseline,
    });
    world = applied.world;
    if (applied.plan) plan = applied.plan;
    let summary = applied.summary;
    if (!applied.ok && repeats >= 1) {
      summary = `${summary}\nDo not repeat these arguments. Read something you have not used, or ask the user.`;
    }
    const record = {
      id: callId,
      name: call.name,
      args: parsed.value,
      ok: applied.ok,
      summary,
      spotlight: applied.spotlight,
    };
    calls.push(record);
    console.info(`[keel] ${call.name} ${applied.ok ? "ok" : "fail"}`);

    if (applied.pause) {
      pending = applied.pause;
      status = "needs_user";
      break;
    }
    if (applied.finishProposal) {
      if (!plan) {
        record.ok = false;
        record.summary = "Declare a plan before finish.";
        break;
      }
      const verdict = evaluateFinish(world, input.baseline, plan, applied.finishProposal);
      if (!verdict.ok) {
        record.ok = false;
        record.summary = `FINISH_REJECTED\n${verdict.errors.join("\n")}`;
        break;
      }
      record.ok = true;
      record.summary = applied.finishProposal.summary;
      outcome = {
        summary: applied.finishProposal.summary,
        claims: applied.finishProposal.claims,
        checks: verdict.checks,
        blocked: verdict.blocked,
      };
      status = "done";
      break;
    }
  }

  const assistant: AssistantTurn = {
    role: "assistant",
    content: model.content,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.args),
      },
    })),
  };

  const transcript = [...input.transcript, { thought: (model.content ?? "").slice(0, 1200), calls, assistant }];
  if (status === "continue" && transcript.length >= MAX_STEPS) {
    status = "stopped";
    error = "Step budget is used up before the outcome was verified.";
  }

  return { status, world, plan, transcript, pending, outcome, brain, error };
}
