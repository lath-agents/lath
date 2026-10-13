/**
 * The loop scheduler that lives inside the Next server process.
 *
 * A loop is an agent that keeps running: `LoopRunner` (`runtime/src/loop.ts`) steps it, runs one
 * ordinary session, and appends one `loop.step` checkpoint. What the console adds is the part a
 * library cannot have — a clock, a place to write down where a loop got to, and the rule that
 * only one thing writes a chain at a time.
 *
 * Three pieces:
 *
 * - **the registry**: `LATH_TRACE_DIR/loops.json`, written the same atomic way `agents.json`
 *   is. It is the only thing that survives a restart, and it holds nothing secret: the agent's
 *   keys are re-derived from its deployed name exactly as `/api/run` re-derives them.
 * - **the scheduler**: one `setTimeout` per running loop on a `globalThis` singleton, rehydrated
 *   from the registry the first time anything asks for it. `globalThis` because Next may
 *   evaluate a route module twice in one process, and two schedulers would run every loop twice.
 * - **the step**: the same construction `/api/run` uses for a session — derived key, funded,
 *   registered, epochs anchored through the owner's `LocatorRegistry`, billed against the
 *   owner's allowance when there is one — with the provider paid only where a charge lands.
 *   A loop with no live allowance runs scripted and unbilled, exactly as an anonymous session
 *   does, so a judge with no wallet can still watch one run.
 *
 * This file is the door: every route, test and module imports the scheduler from here, and it
 * re-exports the whole of the scheduler's surface. The code is in the modules below, each importing
 * only the ones listed before it (a cycle among them would be a module read before it has finished
 * evaluating, `tests/console-module-graph.ts`):
 *
 *   loop-terms.ts          the limits, the decision model's terms, the goal, the trigger, and the
 *                          sentences that refuse what this build does not run
 *   loop-record.ts         `LoopRecord`, one row of `loops.json`
 *   loop-budget.ts         the loop's one budget and Lath's Jev share of it, as arithmetic
 *   loop-state.ts          the scheduler's `globalThis` state and the run slot
 *   loop-registry.ts       reading and writing `loops.json`, and the lifecycle records a write owes
 *   loop-meter.ts          what a step's spend and Jev's calls write back to the row
 *   loop-sandbox.ts        the ZeroClaw sandbox every step runs in, and its config
 *   loop-sources.ts        a loop's pinned sources: the check, the fetch and the copy on Irys
 *   loop-receipt.ts        the loop's receipt on SAS
 *   loop-channel-state.ts  what the console knows of a loop's Tempo channel without touching it
 *   loop-key.ts            the loop's Tempo access key: its rows, revoke and sweep
 *   loop-services.ts       the loop's Tempo services (storage and RPC)
 *   loop-step-base.ts      what a step is built from: its policy, storage meter and epoch anchors
 *   loop-channel.ts        opening and settling the channel, the runner a step and a settle share,
 *                          and `stopLoop`
 *   loop-views.ts          the public view of a loop and its step rows
 *   loop-step.ts           one step, and the stops it checks for
 *   loop-rebuild.ts        the lists rebuilt from the chain's lifecycle records
 *   loop-request.ts        a start: its checks, its preparation and its plan
 *   loop-scheduler.ts      the clock: ticks, start, pause, resume, archive
 *   loop-retry.ts          Retry and Discard of a run whose checkpoint did not land
 *
 * Environment: everything `runner.ts` documents, plus
 *   LATH_LOOP_MIN_INTERVAL_MS  floor on a loop's interval (default 10 000)
 *   LATH_LOOP_MAX_STEPS        ceiling on a loop's step count (default 48)
 *   LATH_LOOPS_PER_WALLET      running loops one wallet may hold (default 3)
 *   LATH_ANCHOR_EVERY          epochs per locator manifest cell (default 1: one cell per epoch)
 *   LATH_LOOP_BUDGET_MAX_USDC  the most one loop's whole budget may be (default 25)
 *   LATH_JEV_BUDGET_PERCENT    Lath's Jev spend per loop, as a share of the loop's budget (default 15)
 *   LATH_FALLBACK_MODEL        the model a loop's chat call is tried on after its own got no answer twice
 */
export {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MAX_STEPS,
  LOOPS_PER_WALLET,
  LOOPS_PER_HOUR,
  HISTORY_KEPT,
  boundedEnvNumber,
  LOOP_BUDGET_MAX_MICRO,
  JEV_BUDGET_PERCENT,
  DEFAULT_VERIFY_MODEL,
  DEFAULT_MIN_CONFIDENCE,
  VERIFY_ALIAS_REFUSAL,
  JEV_ONLY_REFUSAL,
  fallbackModelFor,
  checkVerify,
  checkGoalCheck,
  asksForTraceAudit,
  TRACE_AUDIT_START_REFUSAL,
  traceAuditResumeRefusal,
  traceAuditRetryRefusal,
  TRACE_AUDIT_STOP_DETAIL,
  GATE_ASK_DEPOSIT_BASE,
  triggerOf,
  triggerLabel,
  LoopRefused,
  LoopKeyStopped,
  refusalReason,
  promptHashOf,
  goalHashOf,
  MAX_GOAL,
  GOAL_REACHED_STOP_REASON,
  DEFAULT_GOAL_PROMPT,
  checkGoal,
  TEAM_REFUSAL,
  checkWorkersRequest,
  teamRunRefusal,
  grantsRefusal,
  checkGrants,
} from "./loop-terms";
export type { VerifyTerms, ConsoleLoopTrigger, Refusal } from "./loop-terms";
export type { LoopRecord, LoopDiscardRow } from "./loop-record";
export {
  withBudgetKeys,
  jevBudgetOf,
  loopSpentOf,
  loopBudgetKeys,
  legacyStepCap,
  loopRemainingOf,
  loopBudgetSpent,
  jevRemainingOf,
  JEV_CALL_ESTIMATE_BASE,
  jevBudgetAdmits,
  JEV_BUDGET_SPENT,
  JEV_BUDGET_SPENT_DETAIL,
  JEV_BUDGET_UNREADABLE,
  stepEstimate,
  stepAdmission,
  admitStepSpend,
  admitLoopSpend,
  loopFundedHeadroom,
  jevFundedBudget,
  jevFundedRemaining,
  loopDrainRefusal,
  budgetFromPerStep,
  decisionCostBase,
} from "./loop-budget";
export type { LoopBudgetFields } from "./loop-budget";
export { cancel, stepSlotHolder, withRunSlotWaiting, withRunSlot, isStepping, steppingNow } from "./loop-state";
export {
  readLoops,
  registryRow,
  readLoop,
  recordLoop,
  updateLoop,
  withTransitionActor,
  setLifecycleWriterForTests,
  LIFECYCLE_WAITING_DETAIL,
  payOwedLifecycleUnderSlot,
  lifecycleBeforeStep,
  payOwedLifecycle,
  kickLifecycle,
  kickAgentLifecycle,
  lifecyclePayersSettled,
  oweAgentLifecycle,
  oweAgentDeploy,
  oweAgentMark,
  payOwedAgentUnderSlot,
  payOwedAgentLifecycle,
} from "./loop-registry";
export type { LifecyclePaid } from "./loop-registry";
export { addJevSpent, persistOwnerSpend, jevMeteredTransport, loopNoAnswer, meterJevCall } from "./loop-meter";
export {
  SANDBOX_TOOL_NAMES,
  sandboxToolRefusal,
  loopToolRefusal,
  sandboxToolNames,
  sandboxOf,
  checkSandboxConfig,
  sandboxWorkspace,
  sandboxNarrowed,
  storeSwitchRefusal,
  fetchedSourcesDir,
  discardFetchedSources,
  loopSources,
  zeroclawReadiness,
  zeroclawStepRecord,
} from "./loop-sandbox";
export type { ZeroClawReadiness } from "./loop-sandbox";
export {
  SOURCE_CHECKS_PER_HOUR,
  checkSourcesAction,
  checkLoopSources,
  checkedIndexProblem,
  tellStage,
} from "./loop-sources";
export type {
  RestoredCheck,
  CheckSourcesAnswer,
  ResolvedLoopSources,
  SourcesCell,
  SandboxHooks,
  LoopStartStage,
} from "./loop-sources";
export {
  setSolanaKeySeamsForTests,
  solanaKeyPolicyOf,
  checkReceipt,
  receiptOwed,
  loopReceiptValues,
  publishOwedReceipts,
  loopReceiptView,
  pluginsListFields,
  demoAttestFile,
  attestDemo,
  attestListFields,
} from "./loop-receipt";
export type { SolanaKeySeams, AttestDemo } from "./loop-receipt";
export {
  channelIdleMs,
  loopChannelMark,
  tempoSpentSince,
  openLoopChannels,
  loopChannelSizing,
  channelsCommittedBase,
  loopChannelsCommitted,
  heldChannelShort,
  treasuryHeld,
  treasuryShortfall,
  loopSettling,
} from "./loop-channel-state";
export type { LoopChannel, LoopChannelMark, LoopChannelHooks } from "./loop-channel-state";
export {
  readStoragePayee,
  setLoopKeySeamsForTests,
  LOOP_KEY_LIFETIME_S,
  STORAGE_CHARGES_UNDER_KEY,
  LOOP_KEY_EXPIRY_MARGIN_MS,
  loopKeyLimitBase,
  tempoKeyPolicyOf,
  loopKeyRows,
  KEY_READ_FAILURES_BEFORE_STOP,
  LoopKeyDeferred,
  isSpendingLimitExceeded,
  loopKeyExpiryDetail,
  keySettledOf,
  rememberKeyCharge,
  setRevokeBackoffForTests,
  sweepLoopKeys,
} from "./loop-key";
export type { LoopKeySeams } from "./loop-key";
export { loopStorageTransport } from "./loop-services";
export { toldSourcesNote, stepCeiling, stepMaxCost, loopStepPolicy, stepStorageOf } from "./loop-step-base";
export type { StorageReading } from "./loop-step-base";
export {
  openLoopChannel,
  rememberLoopChannel,
  settleLoopChannel,
  afterLoopStep,
  openThroughLoopKey,
  defaultLoopSettle,
  stopLoop,
} from "./loop-channel";
export type { LoopSettleSeams } from "./loop-channel";
export { stepVerifyView, stepGoalCheckView, runningLoopsFor, publicLoop } from "./loop-views";
export {
  budgetSpentDetail,
  stopForBudget,
  statusAfterStep,
  setPostureUploaderForTests,
  publishStepPostures,
} from "./loop-step";
export { rebuildFromChain, rebuiltLoopRow, rebuildListsFromChain } from "./loop-rebuild";
export type { RebuildDeps } from "./loop-rebuild";
export {
  loopStartTemplate,
  loopStartAgent,
  prepareLoopStart,
  planPreparedStart,
  checkLoopStart,
  loopRunRefusal,
  planLoopStart,
  checkLoopTrigger,
  checkLoopBudget,
  checkLoopRequest,
} from "./loop-request";
export type { StartHooks, LoopStartBody, CheckedLoopStart, LoopRequest } from "./loop-request";
export {
  syncScheduler,
  schedule,
  afterStepFailure,
  startLoop,
  pauseLoop,
  resumeRefusal,
  resumeLoop,
  archiveLoop,
  unarchiveLoop,
} from "./loop-scheduler";
export {
  retryLoopAnchor,
  retryRefusal,
  removedPlanRefusal,
  retryRefusalNow,
  discardLoopAnchor,
  landedOnRetry,
  DISCARD_UNFINISHED_DETAIL,
  discardDetail,
} from "./loop-retry";
export type { LoopAnchorQueue } from "./loop-retry";
