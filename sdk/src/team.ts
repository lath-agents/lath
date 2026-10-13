/**
 * Orchestrator loops, pure half, as the audit reads them: the shapes a team step committed.
 *
 * An orchestrator loop is an ordinary loop whose agent ends each step with a list of tasks, one
 * per member of a team the wallet owns. The runner opens a delegation per tasked member, waits for
 * them in parallel on their own chains, and folds their answers back into the step's memory before
 * the checkpoint closes.
 *
 * Teams are on the roadmap: this build writes no team step and audits none, and has no task parser,
 * memory writer or `verifyMembers`, which checks what a member actually *did* against its chain.
 * What is here is the member commitment the manifest's eleventh key carries, because
 * `decodeLoopManifest` reads it and a team step already on devnet must keep re-deriving its leaf.
 * Types only — no Anchor, no Node built-in — which is what lets `browser.ts` re-export it.
 */

/**
 * What one member did with the task a step gave it — the outcome the manifest commits.
 *
 * `failed` and `crashed` are kept apart because they are different claims about the same member:
 * `failed` is a session that ran and resolved unsuccessfully (its own chain says so, with a
 * resolution), `crashed` is one that never resolved at all, so the member's chain may end at its
 * genesis. `refused` is earlier still — the delegation itself could not be opened, so nothing was
 * spent and the member's chain has nothing about this task on it.
 */
export type LoopMemberOutcome = "done" | "failed" | "crashed" | "refused";

/**
 * One member's chain, as the orchestrator's step saw it when the step closed.
 *
 * This is the whole point of a team being on the chain rather than in a log: `args_hash` of the
 * `loop.step` record commits to these five fields per member, so the claim *these three chains
 * did this step's work* is in the record the orchestrator already writes, and anyone with an RPC
 * can go and look.
 */
export interface LoopMemberCommit {
  /** The member's `agent_id`, hex. */
  agentId: string;
  /** `${sessionId}:${name}`. `sha256(taskId)` is the delegation's reference and the member's session id. */
  taskId: string;
  outcome: LoopMemberOutcome;
  /** `AgentState.seq` of the member's chain when the step closed, decimal. `"0"` when refused. */
  seq: string;
  /** `AgentState.head` of the member's chain at that seq, hex. `""` when refused — nothing ran. */
  head: string;
  /**
   * `sha256` of the decision blob this member's own verdict was written to, hex. The sixth key,
   * emitted only when a second model answered for this member: a stage-2 step, and a step whose
   * verifier was unreachable, carry the five-key object, so the chain says *this member was not
   * judged* rather than saying nothing.
   *
   * Inside the member object rather than beside it, so the step's `args_hash` commits to every
   * member's verdict, its confidence, the model build and the voucher — and an older manifest with
   * no verdicts re-hashes to exactly the bytes it committed.
   */
  verifyHash?: string;
  /**
   * `sha256` of the routing blob that chose this member for an `any:` line, hex. The seventh key,
   * and only ever on the member a `choice` actually named: a routing call that failed falls back to
   * an idle member and writes none, because a fallback is the runner's decision and not the model's.
   */
  routeHash?: string;
  /**
   * `sha256` of the replay record this member's own sandbox wrote for this step
   * (`replayRecordBytes` in `runtime/src/zeroclaw/replay.ts`), hex. The eighth key, emitted only for
   * a member whose session ran in a sandbox and wrote a record: a refused or crashed member, one
   * whose sandbox could not write its record, and every member of an older step that commits no
   * member records carry the object without it.
   *
   * Inside the member object rather than as a fourteenth manifest key, for the reason the sixth
   * and seventh are: the record is this member's and no one else's, so it belongs beside the
   * `(seq, head)` it replays up to — and a member object without it rebuilds exactly the bytes a
   * step already on devnet committed. The step's own `replayHash` is session A's (folded with its
   * synthesis); a member runs one session a step, so there is nothing to fold.
   */
  replayHash?: string;
}
