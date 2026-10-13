/**
 * The audit engine behind the `lath-audit` CLI: replays an agent's chain from
 * chain data and, when a trace store is given, checks that the material behind the hashes is
 * still retrievable.
 *
 * This module is the *logic*; `cli.ts` is the command line around it. Nothing here reaches for
 * a Node built-in, so it ships in the browser entry too — a web app can render an audit report
 * with the store it happens to have.
 *
 * ## What an auditor can check with only chain data
 *
 * The chain replay is self-contained: records carry `payload_hash`, and `AgentState.head` is
 * the fold over them. Traces are a second step, because `payload_hash` commits to the *encoded
 * payload*, and the sub-hashes (`args_hash`, `input_payload_hash`, …) live inside that
 * preimage — they are not on-chain. So an audit checks traces two ways:
 *
 * - `traceHashes`: hashes the caller already knows, checked directly. This is what
 *   `AgentLogger.audit(traceHashes)` does.
 * - Automatically, when a store is given: for each record — the steps inside every epoch blob
 *   that rebuilds its root and, under `--recover`, the compact logs included — it looks for the
 *   payload preimage under `payload_hash`. A store that keeps preimages (the store an operator
 *   should hand an auditor) lets the audit decode the sub-hashes at their fixed offsets and check every blob
 *   behind the chain. A store that only holds the leaf blobs — the default `AgentLogger`
 *   behaviour — reports those preimages as *unavailable*, which is not a failure unless
 *   `requirePreimages` is set.
 *
 * The second half of this file answers a different question about the same records:
 * `verifyInference` checks the Tempo voucher an Action committed against the channel it was
 * signed on. It is here, and not in `tempo.ts`, because everything it does with the chain and the
 * blobs is pure — the RPC lives behind `TempoReader`, and viem behind that, so this file keeps
 * shipping in the browser entry.
 *
 * `verifyStepDecision` asks the third question of the same records: did the second model a loop
 * asked for actually judge this step, and does the chain agree with what it said? Its bytes are
 * `verify.ts`, which is pure for the same reason.
 *
 * The bodies live in `audit/` and this file is the barrel every importer uses: `core.ts` is the
 * leaf (record decoders, the Tempo record and reader types, the blob readers and `walkChain`) that
 * `loops.ts` imports directly, so there is no `audit ↔ loops` cycle; `chain.ts` is the replay,
 * `keys.ts` the loop key checks, `inference.ts`, `channels.ts` and `charges.ts` the three Tempo
 * verifiers, `debit.ts` the lath-billing debit a transaction carried, `step.ts` the per-checkpoint
 * report that assembles them, `solana.ts` the transaction reader the lifecycle checks use,
 * `lifecycle.ts` the deploy and loop lifecycle checks (browser-safe: WebCrypto's Ed25519), and
 * `shared.ts` the one helper that needs `../loops`. The gate, protocol-plugin and Improve features
 * are on the roadmap, and this build does not verify the records they write. The list below is
 * named rather than `export *` so that nothing a sibling file exports for another (`@internal`)
 * reaches the SDK's public surface.
 */
export {
  subHashes,
  genesisPolicyVersionHash,
  recordFieldsOf,
  TEMPO_CHAIN_ID,
  TEMPO_ESCROW,
  LOOP_SETTLEMENT_TOOL,
  type TempoPaymentRecord,
  type TempoSettlementRecord,
  type TempoChannelState,
  type ChannelClosedLog,
  type TempoCloseReceipt,
  type TempoReader,
  type TempoScope,
  type AllowedCallsLog,
  type ChannelOpenedLog,
  type KeyAuthorizedLog,
  type ChannelKeyVerdict,
  type CommittedTempoKey,
  type TempoLog,
  type TempoTxReceipt,
  type InferenceChain,
  type InferenceEpoch,
  type InferenceRecord,
  type InferenceVerdict,
  type InferenceReport,
  type VerifyInferenceOptions,
  paymentFromBlob,
  settlementFromBlob,
  blobAt,
  openSessionAt,
  encryptedAt,
  walkChain,
  type StepVerifyVerdict,
} from "./audit/core";
export {
  type AuditReport,
  type GoalReachedStep,
  type VerifiedStep,
  type MemoryLink,
  type AuditOptions,
  audit,
  formatReport,
  exitCode,
} from "./audit/chain";
export {
  type LifecycleAuditSummary,
  type LifecycleCheck,
  type LifecycleVerdict,
  type LifecycleVerification,
  type VerifyLifecycleOptions,
  verifyLifecycle,
  lifecycleSummary,
  formatLifecycle,
  registerAgentIdOf,
  isSmallOrderEd25519Key,
} from "./audit/lifecycle";
export { NO_TEMPO_KEY, TEMPO_KEY_POLICY_UNREAD, tempoKeyOfPolicy, normaliseScopes } from "./audit/keys";
export { verifyInference, formatInference, inferenceExitCode } from "./audit/inference";
export {
  type PluginCheckStatus,
  type SolanaTxInstruction,
  type SolanaTxReader,
  type SolanaTxView,
} from "./audit/solana";
export {
  verifyReceiptLoops,
  formatReceipt,
  receiptsStatus,
  receiptsExitCode,
  type ReceiptAccountReader,
  type ReceiptCheck,
  type ReceiptCheckName,
  type ReceiptReads,
  type ReceiptReport,
  type ReceiptStatus,
  type ReceiptsResult,
} from "./audit/receipt";
export { type CommittedModels, committedModelsOf, modelProblem } from "./audit/models";
export {
  type ChannelReport,
  type ChannelsReport,
  type VerifyChannelsOptions,
  type DebitCheck,
  decisionBrackets,
  verifyChannels,
  formatChannels,
  formatKeyLines,
  channelsExitCode,
} from "./audit/channels";
export {
  STORAGE_PUT_TOOL,
  TEMPO_STORAGE_SERVICE,
  TEMPO_USDC_E,
  TIP20_TRANSFER_TOPIC,
  TIP20_TRANSFER_WITH_MEMO_TOPIC,
  type StorageChargePayment,
  type StorageReceiptRecord,
  type CarriedStorageRecord,
  type TempoSnapshotRecord,
  type TempoCarryRecord,
  type TempoServicesRecord,
  storageReceiptFromBlob,
  tempoCarryFromBlob,
  tempoServicesFromBlob,
  tip20Transfers,
  chargeTransferProblem,
  type ChargeVerdict,
  type ChargeReport,
  type ChargeLoop,
  MPP_MEMO_TAG,
  mppClientFingerprint,
  attributionVerdict,
  type VerifyChargeOptions,
  verifyStorageCharge,
  type TempoCarrier,
  type LoopTempoView,
  type TempoPairingNote,
  collectLoopTempo,
  pairTempoCarries,
  type ChargesReport,
  verifyCharges,
  chargeAmountText,
  storageLine,
  storageLines,
  chargesExitCode,
  formatCharges,
} from "./audit/charges";
export { billingChargeDebit } from "./audit/debit";
export {
  type StepTempoReport,
  type StepGoalReport,
  type StepVerifyReport,
  type StepSandboxReport,
  type VerifyStepOptions,
  ROADMAP_STEP_KEYS,
  roadmapKeysOf,
  verifyStepDecision,
  formatStepVerify,
  formatStepTempo,
  formatSandbox,
  goalLine,
  stepVerifyExitCode,
} from "./audit/step";
