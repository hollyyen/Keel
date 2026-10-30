import { baselineOf } from "./seed.ts";
import { buildPlan } from "./critic.ts";
import { applyTool } from "./tools.ts";
import type { World } from "./types.ts";

export function findVendorFor(world: World, query: string) {
  const plan = buildPlan("Look up a vendor.", world, [], "look up a vendor", [], []);
  return applyTool(world, "find_vendor", { query }, { goal: "x", plan, baseline: baselineOf(world) });
}
