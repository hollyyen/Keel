import assert from "node:assert/strict";
import test from "node:test";
import { buildMessages, executeStep } from "../agent/engine.server.ts";
import { buildPlan } from "./critic.ts";
import { findVendorFor } from "./scenarios.helpers.ts";
import { baselineOf, createSeedWorld } from "./seed.ts";
import { applyTool } from "./tools.ts";
import { evaluateFinish } from "./verify.ts";
import type { StepInput, StepResult, World } from "./types.ts";

type Reply = { approval?: "approved" | "rejected"; answer?: string };

/** Drive the real loop (plan, tools, critic, verifier, human pauses) with the deterministic local brain. */
async function run(goal: string, reply: Reply = {}, world: World = createSeedWorld()) {
  const baseline = baselineOf(world);
  let input: StepInput = { goal, world, baseline, plan: null, transcript: [], brain: "local" };
  const names: string[] = [];
  const pauses: string[] = [];
  let last!: StepResult;
  for (let guard = 0; guard < 30; guard += 1) {
    last = await executeStep(input);
    const call = last.transcript.at(-1)?.calls[0];
    if (call) names.push(`${call.name}:${call.ok ? "ok" : "fail"}`);
    assert.equal(last.error && last.status === "error" ? last.error : undefined, undefined);
    input = { goal, world: last.world, baseline, plan: last.plan, transcript: last.transcript, brain: "local" };
    if (last.status === "needs_user") {
      pauses.push(`${last.pending!.kind}: ${last.pending!.question}`);
      if (last.pending!.kind === "approval") {
        assert.ok(reply.approval, "run paused for approval but the scenario gave none");
        input.resolution = { kind: "approval", approvalId: last.pending!.approvalId!, decision: reply.approval! };
      } else {
        assert.ok(reply.answer !== undefined, `run asked "${last.pending!.question}" but the scenario gave no answer`);
        input.resolution = { kind: "answer", text: reply.answer! };
        reply = { ...reply, answer: undefined };
      }
      continue;
    }
    if (last.status === "done" || last.status === "stopped" || last.status === "error") break;
  }
  return { result: last, names, pauses, world: last.world, baseline };
}

/** Stop at the first pause, so a test can assert that Keel asked instead of finishing. */
async function firstStop(goal: string, world: World = createSeedWorld()) {
  const baseline = baselineOf(world);
  let input: StepInput = { goal, world, baseline, plan: null, transcript: [], brain: "local" };
  for (let guard = 0; guard < 30; guard += 1) {
    const step = await executeStep(input);
    if (step.status !== "continue") return step;
    input = { goal, world: step.world, baseline, plan: step.plan, transcript: step.transcript, brain: "local" };
  }
  throw new Error("never stopped");
}

const ledgerOf = (world: World, number: string) => world.ledger.find((row) => row.invoiceNumber === number);

// --- Task 1: find the latest invoice, extract, enter, verify, report -------------------------------

test("Helios: latest bill is posted after an approval, with extraction and read-back", async () => {
  const { result, names, world } = await run(
    "Find the latest invoice from Helios Components, extract the amount and due date, enter it into our internal system, and tell me once it is done.",
    { approval: "approved" },
  );
  assert.equal(result.status, "done");
  assert.equal(result.outcome?.blocked, false);
  assert.equal(ledgerOf(world, "INV-2077")?.amount, 6420);
  assert.equal(ledgerOf(world, "INV-2077")?.dueDate, "2026-05-02");
  assert.equal(ledgerOf(world, "INV-2041"), undefined, "the older Helios bill must not be posted");
  assert.ok(names.includes("find_vendor:ok"));
  assert.ok(names.includes("extract_invoice_fields:ok"));
  const commit = result.transcript.flatMap((turn) => turn.calls).find((call) => call.name === "commit_ledger_post" && call.ok);
  assert.match(commit!.summary, /Read-back from the ledger.*matches the invoice document/s);
});

test("Helios: a rejected approval closes as blocked and writes nothing", async () => {
  const { result, world, baseline } = await run("Post the latest Helios Components invoice.", { approval: "rejected" });
  assert.equal(result.status, "done");
  assert.equal(result.outcome?.blocked, true);
  assert.deepEqual(world.ledger.map((row) => row.id), baseline.ledgerIds);
});

for (const [vendor, number, amount, due] of [
  ["Northwind Paper", "INV-1988", 1240, "2026-03-04"],
  ["Sable Logistics", "INV-2033", 890, "2026-04-18"],
  ["Quill Studio", "INV-2060", 310, "2026-04-20"],
] as const) {
  test(`${vendor}: latest bill is posted with no approval needed`, async () => {
    const { result, world, pauses } = await run(`Find the latest invoice from ${vendor} and enter it into our internal system.`);
    assert.equal(result.status, "done", result.error);
    assert.equal(pauses.length, 0);
    assert.equal(ledgerOf(world, number)?.amount, amount);
    assert.equal(ledgerOf(world, number)?.dueDate, due);
  });
}

test("a vendor written with a suffix or a typo still resolves to the right company", async () => {
  for (const name of ["Helios Inc", "Helois Components"]) {
    const plan = buildPlan(`Find the latest invoice from ${name} and enter it into our internal system.`, createSeedWorld(), [], "post it", [], []);
    assert.ok(
      plan.successChecks.some((check) => check.kind === "ledger_matches_latest_invoice" && check.vendorQuery === "Helios Components"),
      `${name} should map to Helios Components`,
    );
  }
});

// --- Goals Keel cannot complete as stated must stop and ask -----------------------------------------

test("REGRESSION: 'make payment to Sable of 1000 dollars' asks a person instead of passing as a read", async () => {
  const step = await firstStop("Make payment to Sable Logistics of 1000 dollars.");
  assert.equal(step.status, "needs_user");
  assert.equal(step.pending?.kind, "clarify");
  assert.match(step.pending!.question, /cannot send payments/i);
  assert.ok(step.plan?.successChecks.some((check) => check.kind === "human_resolution"));
  assert.equal(step.world.ledger.length, 1);
});

test("payment request: 'stop' ends as blocked with nothing written", async () => {
  const { result, world, baseline } = await run("Make payment to Sable Logistics of 1000 dollars.", { answer: "Stop, do nothing." });
  assert.equal(result.status, "done");
  assert.equal(result.outcome?.blocked, true);
  assert.deepEqual(world.ledger.map((row) => row.id), baseline.ledgerIds);
});

test("payment request: after a person names a bill, Keel re-plans and posts exactly that bill", async () => {
  const { result, world, names } = await run("Make payment to Sable Logistics of 1000 dollars.", { answer: "Post INV-2033 to the ledger." });
  assert.equal(result.status, "done", result.error);
  assert.equal(names.filter((name) => name === "declare_plan:ok").length, 2, "plans once, then again after the answer");
  assert.equal(ledgerOf(world, "INV-2033")?.amount, 890);
  assert.equal(world.ledger.length, 2);
});

test("an unknown vendor asks which one is meant", async () => {
  const step = await firstStop("Find the latest invoice from Acme Corp and enter it into our internal system.");
  assert.equal(step.status, "needs_user");
  assert.match(step.pending!.question, /which vendor or invoice/i);
});

test("an unknown vendor can be corrected by the person and then completes", async () => {
  const { result, world } = await run(
    "Find the latest invoice from Acme Corp and enter it into our internal system.",
    { answer: "I meant Quill Studio." },
  );
  assert.equal(result.status, "done", result.error);
  assert.equal(ledgerOf(world, "INV-2060")?.amount, 310);
});

test("an invoice number that is not in the books asks instead of looping", async () => {
  const step = await firstStop("Post INV-9999 to the ledger.");
  assert.equal(step.status, "needs_user");
  assert.match(step.pending!.question, /INV-9999 is not in the books/);
});

test("a vendor with no invoices asks instead of failing a check forever", async () => {
  const world = createSeedWorld();
  world.vendors.push({
    id: "ven-acme", name: "Acme Corp", aliases: ["acme"], code: "ACM-001", retiredCodes: [],
    approvalAtOrAbove: 1000, bankLast4: "0000", bankChangesLocked: true, terms: "Net 30",
  });
  const step = await firstStop("Find the latest invoice from Acme Corp and enter it into our internal system.", world);
  assert.equal(step.status, "needs_user");
  assert.match(step.pending!.question, /no invoices/i);
});

test("a latest bill that is already paid asks instead of posting it", async () => {
  const world = createSeedWorld();
  world.invoices.find((invoice) => invoice.number === "INV-2077")!.status = "paid";
  const step = await firstStop("Find the latest invoice from Helios Components and enter it into our internal system.", world);
  assert.equal(step.status, "needs_user");
  assert.match(step.pending!.question, /INV-2077.*already paid/);
});

// --- The other supported tasks still work ----------------------------------------------------------

test("what is due in 14 days: read-only answer that covers every due bill", async () => {
  const { result, world, baseline, pauses } = await run("What should I pay in the next 14 days? Do not post anything.");
  assert.equal(result.status, "done", result.error);
  assert.equal(pauses.length, 0);
  assert.deepEqual(world.ledger.map((row) => row.id), baseline.ledgerIds);
  for (const number of ["INV-1988", "INV-2033", "INV-2041", "INV-2060"]) assert.match(result.outcome!.summary, new RegExp(number));
});

test("mark Northwind paid changes exactly one invoice", async () => {
  const { result, world } = await run("Treasury says the Northwind payment cleared. Mark invoice INV-1988 paid, and do not touch any other invoice.");
  assert.equal(result.status, "done", result.error);
  const changed = world.invoices.filter((invoice) => invoice.status !== createSeedWorld().invoices.find((seed) => seed.id === invoice.id)!.status);
  assert.deepEqual(changed.map((invoice) => invoice.number), ["INV-1988"]);
});

test("bank-detail email is refused with the policy cited and nothing changed", async () => {
  const { result, world, baseline } = await run("Update Helios bank details from the email that arrived this morning.");
  assert.equal(result.status, "done", result.error);
  assert.ok(result.outcome!.checks.some((check) => check.kind === "cites_policy" && check.ok));
  assert.deepEqual(world.ledger.map((row) => row.id), baseline.ledgerIds);
});

// --- Verifier and tool contracts ------------------------------------------------------------------

test("a do-nothing finish is rejected when the goal needed a person", () => {
  const world = createSeedWorld();
  const plan = buildPlan("Make payment to Sable Logistics of 1000 dollars.", world, [], "pay Sable", [], []);
  const verdict = evaluateFinish(world, baselineOf(world), plan, {
    summary: "I read msg-2033 (Sable Logistics invoice INV-2033) and did not change the office.",
    blocked: false,
    claims: [{ statement: "msg-2033 is the closest record.", evidenceIds: ["msg-2033"] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(" "), /ask_user/);
});

test("read-after-write: a ledger row that disagrees with the printed document is rejected", () => {
  const world = createSeedWorld();
  const baseline = baselineOf(world);
  const plan = buildPlan("Post INV-2033 to the ledger.", world, [], "post it", [], []);
  const invoice = world.invoices.find((item) => item.number === "INV-2033")!;
  invoice.amount = 1000; // the record was tampered with; the document still says 890
  world.ledger.push({
    id: "led-inv-2033", invoiceNumber: "INV-2033", vendorCode: "SAB-017", vendorName: "Sable Logistics",
    amount: 1000, dueDate: invoice.due, memo: "tampered", approvalId: null, postedOn: world.today,
  });
  invoice.status = "posted";
  const verdict = evaluateFinish(world, baseline, plan, {
    summary: "Posted INV-2033 for 1000 USD.", blocked: false,
    claims: [{ statement: "Posted.", evidenceIds: ["led-inv-2033"] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(" "), /document total is 890/);
});

test("commit refuses to post when the document and the record disagree", () => {
  const world = createSeedWorld();
  world.invoices.find((invoice) => invoice.number === "INV-2033")!.amount = 1000;
  const plan = buildPlan("Post INV-2033 to the ledger.", world, [], "post it", [], []);
  const result = applyTool(
    world, "commit_ledger_post",
    { invoiceNumber: "INV-2033", vendorCode: "SAB-017", amount: 1000, dueDate: "2026-04-18" },
    { goal: "x", plan, baseline: baselineOf(world) },
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /DOCUMENT_MISMATCH/);
});

test("find_vendor: match, ambiguity and unknown vendor", () => {
  const world = createSeedWorld();
  assert.match(findVendorFor(world, "Helios Inc").summary, /^MATCH ven-helios/);
  const unknown = findVendorFor(world, "Acme Corp");
  assert.equal(unknown.ok, false);
  assert.match(unknown.summary, /NO_SUCH_VENDOR/);
});

test("extract_invoice_fields reads the document text and saves it to memory", () => {
  const world = createSeedWorld();
  const plan = buildPlan("Post INV-2077.", world, [], "post it", [], []);
  const result = applyTool(world, "extract_invoice_fields", { id: "inv-2077" }, { goal: "x", plan, baseline: baselineOf(world) });
  assert.equal(result.ok, true);
  assert.match(result.summary, /amount: 6420 USD/);
  assert.match(result.summary, /due: 2026-05-02/);
  assert.equal(result.world.memory[0]?.key, "extracted:INV-2077");
});

test("memory is sent back to the model on the next step", () => {
  const world = createSeedWorld();
  world.memory.push({ key: "extracted:INV-2077", value: "amount 6420 USD; due 2026-05-02" });
  const prompt = JSON.stringify(buildMessages({ goal: "Post INV-2077.", world, baseline: baselineOf(world), plan: null, transcript: [] }));
  assert.match(prompt, /Working memory/);
  assert.match(prompt, /extracted:INV-2077/);
});
