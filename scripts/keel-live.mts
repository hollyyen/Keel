import { executeStep } from "../src/lib/agent/engine.server.ts";
import { baselineOf, createSeedWorld } from "../src/lib/world/seed.ts";
import type { StepInput } from "../src/lib/world/types.ts";

const goal = process.argv.slice(2).join(" ") || "Post the open Quill Studio invoice into the ledger and tell me when it is done.";
const world = createSeedWorld();
let input: StepInput = {
  goal,
  world,
  baseline: baselineOf(world),
  plan: null,
  transcript: [],
};

for (let step = 0; step < 12; step += 1) {
  const result = await executeStep(input);
  const call = result.transcript.at(-1)?.calls[0];
  console.log(`\n# ${step + 1} ${result.status} ${call?.name ?? ""} ${call?.ok ? "ok" : "fail"}`);
  if (call) console.log(call.summary.slice(0, 500));
  if (result.error) console.log("ERROR", result.error);
  input = {
    goal,
    world: result.world,
    baseline: input.baseline,
    plan: result.plan,
    transcript: result.transcript,
  };
  if (result.status === "needs_user" && result.pending?.kind === "approval" && result.pending.approvalId) {
    input.resolution = { kind: "approval", approvalId: result.pending.approvalId, decision: "approved" };
    console.log("AUTO-APPROVED", result.pending.approvalId);
    continue;
  }
  if (result.status !== "continue") {
    console.log("\nFINAL", result.status);
    if (result.outcome) console.log(result.outcome.summary);
    process.exit(result.status === "done" ? 0 : 1);
  }
}
console.log("EXHAUSTED");
process.exit(1);
