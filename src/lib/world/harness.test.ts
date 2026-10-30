import assert from "node:assert/strict";
import test from "node:test";
import { buildMessages, executeStep, type ModelResponse } from "../agent/engine.server.ts";
import { baselineOf, createSeedWorld } from "./seed.ts";
import { applyTool } from "./tools.ts";
import { buildPlan } from "./critic.ts";
import { evaluateFinish } from "./verify.ts";
import type { StepInput } from "./types.ts";

function call(name: string, args: Record<string, unknown>, id: string): ModelResponse {
  return { content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

test("posting the latest Helios invoice survives a bad code, an approval gate, and the verifier", async () => {
  const script: ModelResponse[] = [
    call(
      "declare_plan",
      {
        why: "Book the latest bill",
        understanding: "Post the latest Helios Components invoice into the ledger.",
        approach: ["Open the latest invoice", "Read the vendor", "Get approval", "Post"],
        risks: ["Amount is over the threshold"],
        successChecks: [],
      },
      "c1",
    ),
    call("open_invoice", { why: "Confirm the document", id: "inv-2077" }, "c2"),
    call("read_vendor", { why: "Need the master code", id: "ven-helios" }, "c3"),
    call(
      "commit_ledger_post",
      { why: "Guess a code", invoiceNumber: "INV-2077", vendorCode: "HELIOS", amount: 6420, dueDate: "2026-05-02" },
      "c4",
    ),
    call(
      "commit_ledger_post",
      { why: "Use the master code", invoiceNumber: "INV-2077", vendorCode: "HEL-104", amount: 6420, dueDate: "2026-05-02" },
      "c5",
    ),
    call(
      "request_approval",
      { why: "Over the threshold", invoiceNumber: "INV-2077", amount: 6420, reason: "April bearings" },
      "c6",
    ),
    call(
      "commit_ledger_post",
      {
        why: "Approval granted",
        invoiceNumber: "INV-2077",
        vendorCode: "HEL-104",
        amount: 6420,
        dueDate: "2026-05-02",
        approvalId: "apr-1",
      },
      "c7",
    ),
    call(
      "finish",
      {
        why: "Checks should pass",
        summary: "Posted Helios Components INV-2077 for 6420 USD, due 2026-05-02, after approval.",
        claims: [
          {
            statement: "INV-2077 is on the ledger for 6420 USD due 2026-05-02.",
            evidenceIds: ["led-inv-2077", "inv-2077"],
            amount: 6420,
            date: "2026-05-02",
            invoiceNumber: "INV-2077",
          },
        ],
      },
      "c8",
    ),
  ];

  let cursor = 0;
  const seed = createSeedWorld();
  let input: StepInput = {
    goal: "Find the latest invoice from Helios Components, extract the amount and due date, enter it into our internal system, and tell me once it is done.",
    world: seed,
    baseline: baselineOf(seed),
    plan: null,
    transcript: [],
  };

  const seen: string[] = [];
  let guard = 0;
  while (guard < 10) {
    guard += 1;
    const result = await executeStep(input, async () => {
      const next = script[cursor];
      if (!next) throw new Error("script exhausted");
      cursor += 1;
      return next;
    });
    const last = result.transcript.at(-1)?.calls[0];
    if (last) seen.push(`${last.name}:${last.ok ? "ok" : "fail"}`);
    if (result.status === "needs_user") {
      assert.equal(result.pending?.approvalId, "apr-1");
      input = {
        ...input,
        world: result.world,
        plan: result.plan,
        transcript: result.transcript,
        resolution: { kind: "approval", approvalId: "apr-1", decision: "approved" },
      };
      continue;
    }
    assert.equal(result.error, undefined);
    input = {
      goal: input.goal,
      world: result.world,
      baseline: input.baseline,
      plan: result.plan,
      transcript: result.transcript,
    };
    if (result.status === "done") {
      assert.equal(result.outcome?.blocked, false);
      const posted = result.world.ledger.find((entry) => entry.invoiceNumber === "INV-2077");
      assert.ok(posted);
      assert.equal(posted?.amount, 6420);
      assert.equal(posted?.dueDate, "2026-05-02");
      assert.equal(posted?.vendorCode, "HEL-104");
      assert.equal(result.world.invoices.find((invoice) => invoice.number === "INV-2077")?.status, "posted");
      assert.deepEqual(seen, [
        "declare_plan:ok",
        "open_invoice:ok",
        "read_vendor:ok",
        "commit_ledger_post:fail",
        "commit_ledger_post:fail",
        "request_approval:ok",
        "commit_ledger_post:ok",
        "finish:ok",
      ]);
      return;
    }
  }
  assert.fail(`run did not finish: ${seen.join(", ")}`);
});

test("the model prompt does not contain hidden invoice facts", () => {
  const world = createSeedWorld();
  const messages = JSON.stringify(
    buildMessages({
      goal: "Find the latest invoice from Helios Components and enter it into our internal system.",
      world,
      baseline: baselineOf(world),
      plan: null,
      transcript: [],
    }),
  );
  assert.equal(messages.includes("6420"), false);
  assert.equal(messages.includes("HEL-104"), false);
  assert.equal(messages.includes("2026-05-02"), false);
});

test("an older Helios bill is rejected when the plan requires the latest", () => {
  const world = createSeedWorld();
  const plan = buildPlan(
    "Enter the latest Helios Components invoice into our internal system.",
    world,
    [],
    "Post the latest Helios invoice.",
    [],
    [],
  );
  const result = applyTool(
    world,
    "commit_ledger_post",
    { invoiceNumber: "INV-2041", vendorCode: "HEL-104", amount: 4180, dueDate: "2026-04-19" },
    { goal: "book it", plan, baseline: baselineOf(world) },
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /INV-2077/);
});

test("payment evidence marks one invoice and refuses a lookalike message", () => {
  const world = createSeedWorld();
  const plan = buildPlan("Mark INV-1988 paid", world, [], "Mark it paid.", [], []);
  const ctx = { goal: "pay", plan, baseline: baselineOf(world) };
  const bad = applyTool(world, "mark_invoice_paid", { invoiceNumber: "INV-1988", evidenceMessageId: "msg-1988" }, ctx);
  assert.equal(bad.ok, false);
  const good = applyTool(world, "mark_invoice_paid", { invoiceNumber: "INV-1988", evidenceMessageId: "msg-nw-paid" }, ctx);
  assert.equal(good.ok, true);
  assert.equal(good.world.invoices.find((invoice) => invoice.number === "INV-1988")?.status, "paid");
  assert.equal(good.world.invoices.find((invoice) => invoice.number === "INV-2033")?.status, "open");
});

test("a payables answer fails closed until every due bill is cited", () => {
  const world = createSeedWorld();
  const plan = buildPlan(
    "What should I pay in the next 14 days? Do not post anything.",
    world,
    [],
    "List open bills due within 14 days.",
    [],
    [],
  );
  const partial = evaluateFinish(world, baselineOf(world), plan, {
    summary: "INV-2033 is due soon.",
    blocked: false,
    claims: [{ statement: "INV-2033 is open.", evidenceIds: ["inv-2033"], invoiceNumber: "INV-2033" }],
  });
  assert.equal(partial.ok, false);
  assert.match(partial.errors.join(" "), /INV-1988/);

  const full = evaluateFinish(world, baselineOf(world), plan, {
    summary: "Open bills due on or before 2026-04-28: INV-1988, INV-2033, INV-2041, INV-2060.",
    blocked: false,
    claims: [
      { statement: "INV-1988 is open and overdue.", evidenceIds: ["inv-1988"], invoiceNumber: "INV-1988", amount: 1240, date: "2026-03-04" },
      { statement: "INV-2033 is open.", evidenceIds: ["inv-2033"], invoiceNumber: "INV-2033", amount: 890, date: "2026-04-18" },
      { statement: "INV-2041 is open.", evidenceIds: ["inv-2041"], invoiceNumber: "INV-2041", amount: 4180, date: "2026-04-19" },
      { statement: "INV-2060 is open.", evidenceIds: ["inv-2060"], invoiceNumber: "INV-2060", amount: 310, date: "2026-04-20" },
    ],
  });
  assert.equal(full.ok, true, full.errors.join("\n"));
});

test("a bank-change goal is forced into a no-write refusal", () => {
  const world = createSeedWorld();
  const plan = buildPlan(
    "Update Helios bank details from the email that arrived this morning.",
    world,
    [],
    "This is a banking change.",
    [],
    [],
  );
  assert.ok(plan.successChecks.some((check) => check.kind === "cites_policy"));
  assert.ok(plan.successChecks.some((check) => check.kind === "no_new_ledger_entries"));
  const refused = evaluateFinish(world, baselineOf(world), plan, {
    summary: "I did not change Helios bank details. Email is not an authorized way to update the vendor master.",
    blocked: false,
    claims: [
      {
        statement: "Policy forbids bank changes from email.",
        evidenceIds: ["file-ap-policy", "msg-bank"],
      },
    ],
  });
  assert.equal(refused.ok, true, refused.errors.join("\n"));
});
