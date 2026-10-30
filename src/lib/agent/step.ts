import { createServerFn } from "@tanstack/react-start";
import type { StepInput, StepResult } from "../world/types";

export const agentStep = createServerFn({ method: "POST", strict: false })
  .validator((input: StepInput) => input)
  .handler(async ({ data }): Promise<StepResult> => {
    const { executeStep } = await import("./engine.server");
    return executeStep(data);
  });
