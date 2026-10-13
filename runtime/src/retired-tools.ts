/**
 * Tool names that older policies carry but that this build gives nothing behind.
 *
 * `hire` named a paid-task path: a caller reserved a price and delegated a task to another agent,
 * which ran it, and the caller settled. This build has no such path and no marketplace. What stays
 * is the tool *name* (`retiredHireTool`), because policy hashes commit to the tool list of agents
 * already deployed.
 */
import { ToolDefinition } from "./runtime";

/** The tool name retired policies still carry. Reserved the way `delegate` is. */
export const HIRE_TOOL = "hire";

// ─── The retired `hire` tool ────────────────────────────────────────────────

/**
 * `hire`: the name, with nothing behind it.
 *
 * In an older policy the tool reserves a price, delegates the task to another agent and settles
 * against the billing vault; none of that machinery is in this build. The entry stays because a
 * session's `policy_version_hash` commits to the tool list it ran with, and older agents carry
 * `hire` in their policy: drop the name and their tool list, and therefore a hash already written
 * to chain, would change. It settles nothing, spends nothing and writes no delegation; a model
 * that calls it is told the tool is gone, which is the truthful answer.
 */
export function retiredHireTool(): ToolDefinition {
  return {
    name: HIRE_TOOL,
    description:
      "Retired. Paying another agent for a task is no longer part of this market; agents are copied, not hired. " +
      "Answer from your own tools instead.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { ok: false, retired: true, message: "the hire tool is no longer available" };
    },
  };
}
