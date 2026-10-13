# Lath — Specification

Version 0.5 · revised 2026-10-12 · Program ID `AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz`

Lath records what an autonomous agent does as a hash chain on Solana, and ties each model call it pays
for on Tempo to one of those records. Each agent state transition is
anchored as a small compressed account (Light Protocol ZK compression); verbose material
(prompts, transcripts, tool I/O, outputs) never touches the chain and is committed only by
32-byte SHA-256 hashes.

---

## 1. Goals and non-goals

**Goals**

1. Cryptographic auditability: any party with RPC access can replay an agent's full history
   and verify a single SHA-256 head, and — given the off-chain bytes — verify every
   referenced payload.
2. Cost: no rent lock-up; marginal cost per event in the $0.001–0.002 range on mainnet.
3. Minimal, enforced event vocabulary (four primitives) with fixed-width on-chain records.
4. Privacy by construction: the ABI cannot carry variable-length data.

**Non-goals**

- Storing or serving verbose traces (delegated to a `TraceStore`).
- Cross-agent global ordering (ordering is per agent; cross-agent links are by `reference`).
- Access control beyond "the registered authority signs".
- Proving *correctness* of agent behaviour — Lath proves *what was claimed, when, in what order*.

## 2. Architecture

```
┌──────────────┐   AgentLogger    ┌──────────────┐   LathClient    ┌──────────────────────┐
│ Agent runtime│ ───────────────▶ │  TraceStore  │                    │ Lath program      │
│ (LLM + tools)│  blobs → sha256  │ (off-chain)  │                    │ (Anchor, light-sdk)  │
│              │ ───────────────────────────────────── hashes + ix ──▶│  CPI ▶ Light System  │
└──────────────┘                  └──────────────┘                    └──────────┬───────────┘
                                                                                  │ compressed accounts
                                                          ┌───────────────────────▼──────────────┐
                                                          │ Light v2 state tree + address tree   │
                                                          │ indexed by Photon (getCompressed*)   │
                                                          └──────────────────────────────────────┘
```

Components:

| Path | Role |
|---|---|
| `programs/lath` | Anchor 0.31.1 program; `light-sdk` 0.23 v2 CPI |
| `programs/lath-billing` | USDC escrow, `Allowance`, metered `charge`, capped `sweep` — regular accounts (§13) |
| `sdk/src/client.ts` | `LathClient`: address derivation, validity proofs, account packing, tx submission, reads, chain verification |
| `sdk/src/logger.ts` | `AgentLogger`: the four primitives as typed calls; routes blobs to a `TraceStore` |
| `sdk/src/loops.ts` | Loop steps: the step manifest, the step leaf, `listSteps` / `verifyStep` |
| `sdk/src/handoff.ts` | `verifyPairing` / `verifyHandoff`: cross-owner acknowledgement |
| `sdk/src/billing.ts` | `BillingClient`; `chargeAndLog` composes `charge` + `log_event*` into one transaction |
| `runtime/src` | `@lath/runtime`: the OpenRouter loop over Tempo MPP, voucher-delta metering, `BillingBackend` |
| `sdk/src/events.ts` | Payload canonical encoding, `hashPayload`, `referenceOf`, `computeHead` |
| `sdk/src/trace-store.ts` | `TraceStore` / `BlobBackend` interfaces; memory, file, AES-256-GCM encrypted implementations |
| `sdk/src/signer.ts` | `LathSigner` (pubkey + `signTransaction`); `Keypair`, browser adapters and KMS/HSM signers all satisfy it |
| `sdk/src/idl` | IDL + generated types vendored from `target/` (`npm run sdk:sync`) so the package stands alone |
| `sdk/package.json` | `@lath/sdk`: tsup build to ESM+CJS+d.ts; Anchor / stateless.js / web3.js are peer deps |
| `tests/lath.ts` | Hash-chain vector + trace stores (Node only); the end-to-end run is `tests/devnet.ts` |

## 3. Event vocabulary

`kind` is a `u8` and the program rejects values > 3 (`LathError::InvalidKind`).

| kind | Name | Typed payload (canonical encoding, in order) | `reference` | `status` |
|---|---|---|---|---|
| 0 | Genesis / Intent | `session_id[32] ‖ caller_pubkey[32] ‖ policy_version_hash[32] ‖ input_payload_hash[32]` | `caller_pubkey` | 0 |
| 1 | Action / external mutation | `sha256(tool_id)[32] ‖ args_hash[32] ‖ result_hash[32] ‖ status_code u16le` | `sha256(tool_id)` | `status_code` |
| 2 | Delegation / handshake | `parent_task_id[32] ‖ from_agent[32] ‖ to_agent[32] ‖ scope_hash[32]` | `to_agent` | 0 |
| 3 | Terminal resolution | `task_id[32] ‖ status u8 ‖ final_output_hash[32] ‖ total_step_count u32le` | `task_id` | 0 success · 1 failed · 2 aborted |

- String ids (`session_id`, `task_id`, `parent_task_id`, `tool_id`) are mapped to 32 bytes by
  `sha256(utf8(s))` (`idFromString`); 32-byte inputs are used verbatim.
- `payload_hash = sha256(kind_u8 ‖ encoding)`.
- `policy_version_hash = sha256(canonicalJson {model, temperature, toolAllowList, maxCost,
  promptHash?})`. `promptHash` is `sha256(system prompt)` in hex and is present only when the
  prompt is a configured one (a template's `config.prompt`); the
  canonical form drops absent keys, so a session with a hardcoded prompt hashes as if the key
  did not exist. The prompt bytes themselves are a trace-store blob under that same
  `sha256`, so the policy document a `PolicyRegistry` publishes grows by one hash rather than
  by a prompt, and the preimage resolves through the trace gateway like any payload hash.
- `toolAllowList` is the list a session was **offered**, so a tool name outlives its
  implementation: a retired tool such as `hire` stays offered to an agent whose policy names it,
  and settles nothing, because dropping the name would change the hash its genesis records
  already commit to.
- Not logged, by policy: read-only queries, internal reasoning, telemetry.

### 3.1 Lifecycle records

An agent's deploy and a loop's start, pause, resume and stop are standalone full-mode Actions on the agent's own chain
([`sdk/src/lifecycle.ts`](sdk/src/lifecycle.ts)), signed by the key that registered the agent, so that a console's
lists can be rebuilt from the chain and its trace store alone. They are new `tool_id`s on kind 1: no new kind, no layout
change, no change to §4.4. Full mode, never inside an epoch, because `listByTool` reads only records an account holds
(§15).

| `tool_id` | Written | `args` document |
|---|---|---|
| `agent.deploy` | once, after `register_agent` | `{v, agentId, name, owner, authority, createdAt, policy, deployTx?, description?, template?, clonedFrom?, privateHash?}` |
| `agent.archive`, `agent.unarchive` | the owner archives or restores the agent | `{v, agentId, at, by, auth?}` |
| `loop.start` | before the loop's first step | `{v, loopId, agentId, owner, createdAt, intervalMs, maxSteps, budgetMicroUsdc, promptHash, goal?, goalHash?, startBodyHash?, auth?, deployTx?, privateHash?, terms}` |
| `loop.pause`, `loop.resume`, `loop.stop` | at each transition; a stop before the loop's `loop.settlement` | `{v, loopId, at, by, auth?, reason?, detail?, steps?, lastStepSeq?}` |

- `args_hash = sha256(canonicalJson(args))`; `result_hash = sha256(canonicalJson({v, id, status, reason?}))`, the state
  the record leaves its subject in; `status` is 200. `v` is 1.
- The documents are public: preimage, args and result are anchored in clear through the agent's `LocatorRegistry`
  (§14.1), so an audit without the trace key reaches every leaf. The owner-only half — a loop's standing prompt and the
  start body that carries it, an agent's configured prompt — is a separate document encrypted under the agent's trace
  key, named by `privateHash`. The goal is public. This console does not write the owner-only half and omits
  `privateHash` (the prompt is committed only by `promptHash`); readers parse it wherever a record carries one, and
  `lath-audit --trace-key` opens it.
- The owner's word is the wallet's own signature, carried in the document: `auth` is the `"Lath loop"` (or
  `"Lath agent"`) message the transition was posted with and its base64 Ed25519 signature; a start's message binds
  `Request ID = startBodyHash`, the hex `sha256` of the start body's canonical JSON less `auth`. A deploy names the
  transaction the wallet signed, `deployTx`. `by` is `owner` for a signed transition and `console` for one the console
  made on its own (a budget, a goal reached, a failure).
- A loop's status is the last transition after its start: `running` after the start, `paused`, `running` again after a
  resume, `stopped` with the stop's `reason`. Its steps are the `loop.step` records between its start and its stop.
- A chain without these records (a console run with `LATH_LIFECYCLE=off` writes none) reads as *not recorded*,
  never as a failure.

## 4. On-chain data model

All structs are Borsh (Anchor) serialized, SHA-256 flat-hashed by `light-sdk`
(`LightAccount` sha variant), owned by the Lath program.

### 4.1 `AgentState` — one per agent, 120 bytes

| Field | Type | Notes |
|---|---|---|
| `authority` | `Pubkey` | Only signer allowed to append |
| `agent_id` | `[u8;32]` | Opaque id (typically `sha256("agent-name")`) |
| `seq` | `u64` | Next sequence number = number of events so far |
| `head` | `[u8;32]` | Hash-chain head; `[0;32]` at genesis |
| `created_at` | `i64` | Client-supplied unix ms |
| `updated_at` | `i64` | Timestamp of the last event |

Address: `derive_address_v2(["agent", agent_id], ADDRESS_TREE_V2, program_id)`.

### 4.2 `EventRecord` — one per event (full mode), 147 bytes

| Field | Type |
|---|---|
| `agent_id` | `[u8;32]` |
| `seq` | `u64` |
| `timestamp` | `i64` (unix ms, client-attested) |
| `kind` | `u8` |
| `status` | `u16` |
| `reference` | `[u8;32]` |
| `payload_hash` | `[u8;32]` |
| `head` | `[u8;32]` — chain head *after* this event |

Address: `derive_address_v2(["event", agent_id, seq_le_u64], ADDRESS_TREE_V2, program_id)`. There
is one owner kind — an agent — so there is one record address space, and no other owner kind
can claim an agent's next record address.

Byte offsets into the record data — **ABI**, exported as `EVENT_OFFSETS`, since Photon `memcmp`
is the only way to query without an index (SPEC §12 #4):

| field | offset | width |
|---|---|---|
| `agent_id` | 0 | 32 |
| `seq` | 32 | 8 |
| `timestamp` | 40 | 8 |
| `kind` | 48 | 1 |
| `status` | 49 | 2 |
| `reference` | 51 | 32 |
| `payload_hash` | 83 | 32 |
| `head` | 115 | 32 |

`memcmp{0, agent_id}` lists one agent's records; `{48, kind}` narrows by kind; `{51, reference}`
answers per-tool / per-caller / per-peer / per-task across all agents.

### 4.3 `EventInput` — instruction argument, 75 bytes

`timestamp i64 ‖ kind u8 ‖ status u16 ‖ reference [32] ‖ payload_hash [32]`.

### 4.4 Hash chain

```
head_0   = 0x00…00
head_n+1 = sha256( head_n ‖ agent_id ‖ seq_le_u64 ‖ timestamp_le_i64 ‖ kind_u8 ‖ status_le_u16 ‖ reference ‖ payload_hash )
```

Implemented identically in Rust (`next_head`) and TypeScript (`computeHead`) and pinned by a
shared test vector (`d7150e18…3ac5`).

## 5. Instructions

All instructions take `authority: Signer (mut)` plus Light system accounts in
`remaining_accounts` (packed by `PackedAccounts.newWithSystemAccountsV2`). One validity proof
per instruction.

All twelve are listed. Nine advance the owner's operation counter by folding into
`AgentState.head`; `register_agent` creates that counter at zero, and `set_authority` and
`close_agent` leave it exactly where it is. The last column says which, because a replay that
assumes every instruction advances `seq` misreads the three that do not. All twelve are in the
deployed program (program-data slot `509697882`, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12).

| Instruction | Args | Proof covers | Effect |
|---|---|---|---|
| `register_agent` | `proof, address_tree_info, output_state_tree_index, agent_id, created_at` | 1 new address | Creates `AgentState{seq:0, head:0}` at `["agent", agent_id]`; emits `AgentRegistered` |
| `log_event` | `proof, current: AgentState, agent_meta, event_tree_info, event_output_state_tree_index, input` | 1 account (agent) + 1 new address (event) | Creates `EventRecord(seq)`, sets `seq+1`, `head`, `updated_at`; emits `EventLogged` |
| `log_events` | `proof, current, agent_meta, event_tree_info, event_output_state_tree_index, inputs: Vec<EventInput>` | 1 account + N new addresses (N ≤ `MAX_EVENTS_PER_TX`) | N sequential `log_event`s in one tx and one proof; records are passed to the CPI first, so event *i* takes `assigned_account_index = i` and the state lands last |
| `log_event_compact` | `proof, current, agent_meta, input` | 1 account | Same state update, no `EventRecord`; emits `EventLogged` |
| `set_authority` | `proof, current, agent_meta, new_authority` | 1 account | Replaces `authority`; **`seq`/`head` untouched** — §4.4 has no slot for a non-event transition; emits `AuthorityChanged` |
| `close_agent` | `proof, current, agent_meta` | 1 account | Closes `AgentState` (`LightAccount::new_close`); **`seq`/`head` untouched**, `EventRecord`s remain; emits `AgentClosed`. Terminal: the address stays in the address tree, so the `agent_id` is spent for good |
| `create_struct` | `proof, current, agent_meta, header_tree_info, header_output_state_tree_index, params: StructParams` | 1 account (agent) + 1 new address (header) | Creates `StructHeader` at `["hdr", agent_address, struct_id]` with `len_or_count = 0`, `created_op_seq = seq`; folds `op = CREATE_STRUCT (0)` over the header preimage; emits `StructCreated` |
| `create_cell` | `proof, current, agent_meta, header_current: StructHeader, header_meta, cell_tree_info, cell_output_state_tree_index, input: CellInput` | 2 accounts (agent, header) + 1 new address (cell) | Appends a `Log` cell at `len_or_count` or `put`s a `Map` cell at `key_slot`; bumps `len_or_count`; folds `op = CREATE (1)`; emits `CellWritten`. Fails on an existing address, which is the non-membership proof a `Set` needs |
| `replace_cell` | `proof, current, agent_meta, cell_current: Cell, cell_meta, input: CellInput` | 2 accounts (agent, cell) | Nullifies and re-creates a `Map` cell at the same address with `index_or_version + 1`; folds `op = REPLACE (2)`; emits `CellWritten`. Takes no header, so `len_or_count` is unchanged. `Log` cells are refused |
| `close_cell` | `proof, current, agent_meta, cell_current: Cell, cell_meta, timestamp` | 2 accounts (agent, cell) | Closes a `Map` cell, or dequeues one from a consumable `Log`; folds `op = CLOSE (3)`; emits `CellWritten`. Takes no header, so a close cannot decrement `len_or_count` |
| `set_append_policy` | `proof, current, agent_meta, header_current: StructHeader, header_meta, new_policy, new_policy_ref, timestamp` | 2 accounts (agent, header) | Spends and re-creates the `StructHeader` at the same address with only `append_policy` and `policy_ref` replaced (`len_or_count`, `created_op_seq`, kind, mode, consumability untouched, so no cell address moves); folds `op = SET_APPEND_POLICY (5)` over the header preimage as it now stands at this write's `op_seq` — `create_struct`'s preimage under its own op byte; emits `AppendPolicySet`. Owner-only whatever the current policy. It takes an open structure (an `ANYONE` mailbox) to `OwnerOnly` in place; closing the header would spend its address for good |
| `commit_epoch` | `proof, current, agent_meta, epoch_root, start_seq, end_seq` | 1 account | Advances `seq` from `start_seq` straight to `end_seq` and folds `epoch_root` (§15); no accounts are created; emits `EpochCommitted` |

Checks: `current.authority == signer`, `input.kind <= 3`, address tree == `ADDRESS_TREE_V2`,
`seq` overflow, and `input.timestamp <= unix_timestamp*1000 + MAX_TIMESTAMP_SKEW_MS` (5 min) on
every appending instruction. Backdating is allowed: the chain guarantees order, not wall time,
and a monotonic bound would let one bad clock brick an agent. Light verifies `current` hashes
to the account being spent, so a stale or tampered `current` fails proof verification.

The cell ops add three checks of their own: a header must sit at the address derived from the
owner's *header address* rather than from its `owner_id` field (an id is a field anyone can
write), a cell must carry the `owner_id` it is spent under, and an append to a structure whose
`append_policy` is not `OwnerOnly` is authorised against that policy instead of against the
owner's key — `Mailbox` is the only abstraction that uses it (§12 #12). `set_append_policy` adds
one more: the header it spends must sit at the address derived from the owner's header address,
the same `HeaderMismatch` check `create_cell` makes, and `new_policy` must be a known policy
(`InvalidAppendPolicy`).

Events: `AgentRegistered{agent_id, authority}`, `EventLogged{agent_id, seq, kind, head}`,
`AuthorityChanged{agent_id, previous, new_authority}`, `AgentClosed{agent_id, final_seq, final_head}`,
`StructCreated{owner_id, struct_id, kind, mode, op_seq, head}`,
`CellWritten{owner_id, struct_id, index_or_version, op_seq, op, head}`,
`AppendPolicySet{owner_id, struct_id, previous_policy, previous_policy_ref, append_policy, policy_ref, op_seq, head}`,
`EpochCommitted{agent_id, epoch_root, start_seq, end_seq, head}`.

`AppendPolicySet` is the one event a verifier cannot do without (§7). The header account keeps only
the policy it has now, so after a rewrite the `CREATE_STRUCT` fold at `created_op_seq` cannot be
recomputed from the account: the replay puts `previous_policy` / `previous_policy_ref` from the
structure's earliest rewrite back first, then folds each rewrite at its own `op_seq` over the
header as that rewrite left it and checks it against the event's `head` (`headerFolds` in
`sdk/src/cells.ts`, shared by `verifyChain`, the verification export and `scripts/verify-bundle.ts`).
A rewrite's seq has no account of its own, so it is always a gap in the account view and always
sends the replay to transaction history; a chain with no rewrite replays as it always did.

Errors — all nineteen of `LathError`, every one on devnet, in declaration order, so the codes are
the offsets from 6000 Anchor assigns:

| Code | Name | Raised when |
|---|---|---|
| 6000 | `Unauthorized` | the signer is not `current.authority` (every instruction), or is not allowed by a structure's `append_policy` under `OwnerOnly` |
| 6001 | `InvalidKind` | `input.kind > 3` on `log_event`, `log_events`, `log_event_compact` |
| 6002 | `InvalidAddressTree` | the packed address tree is not `ADDRESS_TREE_V2` |
| 6003 | `Overflow` | `seq`, a `Log` length, a `Map` version or the timestamp bound overflows `u64`/`i64` |
| 6004 | `TimestampTooFarInFuture` | a self-attested timestamp is more than `MAX_TIMESTAMP_SKEW_MS` (5 min) past slot time |
| 6005 | `InvalidBatchSize` | a `log_events` batch is empty or longer than `MAX_EVENTS_PER_TX` |
| 6006 | `InvalidAuthority` | `set_authority` is given `Pubkey::default()`, which would strand the agent |
| 6007 | `InvalidStructKind` | `create_struct` with `kind` outside `Log`/`Map` |
| 6008 | `InvalidStructMode` | `create_struct` with `mode` outside `public`/`private` |
| 6009 | `InvalidAppendPolicy` | `create_struct` with an unknown `append_policy`, or `set_append_policy` with an unknown `new_policy` |
| 6010 | `HeaderMismatch` | the header's `owner_id` is not the owner being spent, or the header account is not at its derived address |
| 6011 | `CellMismatch` | the cell being spent does not belong to the owner (`replace_cell`, `close_cell`) |
| 6012 | `LogNotReplaceable` | `replace_cell` on a cell that is not at a `Map` address — `Log` cells are append-only |
| 6013 | `NotConsumable` | `close_cell` on a `Log` cell whose structure was not created `consumable` |
| 6014 | `AppendNotAllowed` | a cell write under `append_policy = AllowList` whose signer is neither the owner nor a leaf of `policy_ref`'s Merkle root |
| 6015 | `IndexMismatch` | — declared but never raised: a `Log` index is taken from the header rather than from the caller, so there is nothing to disagree with. Kept because removing it would renumber every code above it, and codes are ABI |
| 6016 | `InvalidEpochBounds` | `commit_epoch` with `end_seq <= start_seq` |
| 6017 | `EpochSeqMismatch` | `commit_epoch` whose `start_seq` is not the owner's current `seq` |
| 6018 | `EpochTooLong` | `commit_epoch` with `end_seq - start_seq > MAX_EPOCH_SPAN` (`u32::MAX`) |

`MAX_EVENTS_PER_TX = 2`. The cap comes from the prover, not the program or the 1 232-byte
transaction: the pinned Light stack only has combined circuits for 1–2 new addresses per
validity proof (`v2_combined_32_40_1_{1,2}`). Measured cost of a full batch: ~195 000 CU.

## 6. SDK contract

```ts
class LathClient(rpc: Rpc, program: Program<Lath>, authority: LathSigner | Keypair, opts?)
  static fromIdl(rpc, authority, opts?) → LathClient   // bundled IDL; no Anchor workspace
  agentAddress(agentId) / eventAddress(agentId, seq)
  registerAgent(agentId, createdAt?) → {signature, address}
  logEvent(agentId, payload: EventPayload, {timestamp?, compact?}) → LogResult
  logEvents(agentId, payloads: EventPayload[], {timestamps?, timestamp?}) → LogResult[]  // ≤ MAX_EVENTS_PER_TX
  setAuthority(agentId, newAuthority) → {signature}
  closeAgent(agentId) → {signature, finalSeq, finalHead}
  getAgentState(agentId) → {account, state} | null
  getEvent(agentId, seq) → EventRecord | null
  listEvents(agentId) → EventRecord[] (ascending seq; full-mode only)
  listRecords(filters: {offset, bytes}[]) → EventRecord[]        // raw memcmp at EVENT_OFFSETS
  listByKind(agentId, kind) / listByTool(agentId, toolId)
  listByReference(reference, kind?) / listDelegationsTo(peer)    // cross-agent
  recoverEventsFromHistory(agentId) → RecoveredEventRecord[] (rebuilt from tx history)
  recoverCompactEvents(agentId) → RecoveredEventRecord[] (only the seqs with no account)
  verifyChain(agentId, {recover?}) → {ok, records, seq, head, firstBadSeq?, missingSeqs, recoveredSeqs}

class AgentLogger(client, agentId, {store?, compact?, now?})
  ensureRegistered()
  genesis({sessionId, caller, policyVersionHash, input})
  action({toolId, args, result, statusCode})
  delegate({parentTaskId, to, from?, scope})
  resolve({taskId, status, output, totalStepCount})
  audit(traceHashes?, {recover?}) → verifyChain + trace availability

interface LathSigner { publicKey: PublicKey; signTransaction(tx) → Promise<tx> }
toLathSigner(Keypair | LathSigner) → LathSigner

interface TraceStore { put(bytes) → sha256(plaintext); get(hash) → bytes | null }

PlainTraceStore, EncryptedTraceStore (AES-256-GCM, hash as AAD), MemoryBackend, FileBackend
MemoryTraceStore, FileTraceStore (a directory of hash-named blobs), EncryptedTraceStore over either.
The console writes through plain stores only. The encrypted stores only read (their `put` refuses):
they open blobs written encrypted (LTE1/LTE2) and verify them under the agent's trace key.
Remote buckets are deliberately absent: a remote store is reached through the on-chain locator
map (§14.1), Irys today
```

Client invariants: always re-fetch `AgentState` before building a tx (leaf index / tree change
on every update); `proveByIndex` taken from the proof response; compute units 1,000,000.

Writes retry transient failures (`maxRetries`, default 3, exponential backoff from
`retryDelayMs`). A retry is a full rebuild — fresh `AgentState`, fresh validity proof, fresh
blockhash — because those three go stale together; program errors (`Unauthorized`,
`InvalidKind`, …), which a retry would only repeat, are rethrown without a retry. Priority fees:
`priorityFeeMicroLamports`, or `priorityFeeLamports` converted per-CU with
`calculateComputeUnitPrice`; both default to none.

## 7. Verification procedure (auditor)

1. Fetch `AgentState` by derived address → `(seq, head)`.
2. Fetch records (`listEvents` or by address for `0..seq`).
3. Replay `computeHead` from `0x00…` across records; every `record.head` must match; final
   must equal `AgentState.head`. Seqs without records were compact; treat the next record's
   head as a checkpoint, or pass `{recover: true}` — `recoverEventsFromHistory` pairs each
   `EventLogged` (seq, kind, head) with the `EventInput` in the same transaction's instruction
   data, reconstructing the full record so the replay is unbroken. Cell writes and structure
   headers share the counter (§12 #6) and are folded in the same stream; a header whose policy
   was rewritten (`set_append_policy`) is folded from the policy its earliest `AppendPolicySet`
   says it was created with, and each rewrite is folded at its own seq (§5).
4. For each payload: obtain the typed fields, recompute `payload_hash`; for each sub-hash
   fetch bytes from the `TraceStore` and re-hash. The walk covers every record the chain has:
   the record accounts, the compact logs refilled from history under `--recover`, and every
   step inside an epoch blob that rebuilds its root (§15). An epoch step is held to exactly the
   record rules: a missing leaf always fails; an unavailable preimage fails only under
   `--require-preimages`. Wherever the preimage is held, the record's `reference` and `status`
   must equal the fields the preimage encodes (Genesis: caller, 0; Action: `tool_id`, status
   u16; Delegation: `to`, 0; Resolution: `task_id`, status u8). The program folds both into the
   head but does not bind them to `payload_hash`, so a disagreement always fails the audit, like
   a kind mismatch.

Step 4 has a precondition worth stating plainly, because it is the difference between an audit
and a partial one: **the sub-hashes live inside the payload preimage and nowhere on chain.** An
auditor holding only the chain cannot enumerate what to fetch unless the operator stored that
preimage — `kind ‖ encodePayload(payload)`, keyed by `payload_hash` — which `AgentLogger` and
`AgentRuntime` do only under `storePayloads` (§14). Without it, `payload_hash` resolves to
nothing and `lath-audit --require-preimages` cannot pass. With it, the auditor needs no
catalogue from anybody: the chain names each preimage, and each preimage names its leaves.

## 8. Cost model (Light v2)

Measured on devnet over 200 events per mode (`scripts/bench.ts`), as the
payer's balance delta, with no priority fee:

| Item | lamports |
|---|---|
| Base tx fee | 5 000 |
| A transaction that writes the state tree | ~5 000 |
| Address-tree insert (v2), per new address | ~5 000 |
| `log_event` total | **15 007** (≈ $0.0027 @ $180/SOL) |
| `log_event_compact` total | **10 003** (≈ $0.0018) |
| `log_events` (batch of 2) | **10 006** per event |
| `register_agent`, once per agent | **15 004** |

The state-tree write is a flat ~5 000 lamports per transaction that touches the state tree, not
a charge per output account. These are protocol fees rather than congestion pricing, so mainnet
should match.

No rent; records persist as long as the ledger/indexer does.

## 9. Security and privacy properties

- **Integrity**: records are hashed into Merkle trees; spending `AgentState` requires a ZK
  validity proof, so concurrent or replayed appends fail.
- **Authenticity**: only `authority` can append; timestamps are self-attested but bounded —
  a write may not claim to be more than `MAX_TIMESTAMP_SKEW_MS` (5 min) ahead of slot time,
  so `timestamp` is an upper bound on the real time of the write. Backdating is unconstrained;
  the enclosing block's slot time is the lower bound if disputed.
- **Confidentiality**: the ABI has no variable-length fields; only hashes and coarse codes
  (`kind`, `status`) are public. Tool ids are hashed. `reference` may reveal peer pubkeys and
  caller pubkeys — acceptable by design (delegation is meant to be public).
- **Non-repudiation of omission**: `seq` is dense; a missing seq is detectable.

## 10. Known limitations

1. `log_event_compact` records are recoverable only from transaction history
   (`verifyChain({recover: true})`), so they depend on an RPC that has not pruned it.
2. Batches are capped at `MAX_EVENTS_PER_TX = 2` by the prover's non-inclusion circuits, not
   by the program (`log_events` accepts any bounded `Vec<EventInput>`).
3. Authority is a single keypair (rotatable via `set_authority`); no multisig. A rotation
   does not fold into the hash chain — the formula is frozen — so events on either side of one
   are indistinguishable in the chain; the ledger's `AuthorityChanged` is the only marker.
4. `close_agent` is **terminal**: it nullifies the `AgentState` leaf but its address stays in
   the address tree, so a later `register_agent` for the same `agent_id` fails non-inclusion.
   `EventRecord`s are never deleted, so the history stays replayable, and
   `AgentClosed{final_seq, final_head}` marks the end. An `agent_id` is spent for good — nobody,
   the original authority included, can register it again.
5. Indexer dependency for reads (`getCompressedAccount*`); the ledger is the fallback.
6. Reads need a hosted ZK-compression RPC (Helius devnet serves Photon and the prover at one url).

## 11. Toolchain

anchor-cli 0.31.1 · anchor-lang 0.31.1 · light-sdk 0.23.0 (`anchor`, `keccak`) ·
@lightprotocol/stateless.js 0.23.3 · @lightprotocol/zk-compression-cli 0.28.4 ·
solana-cli 3.1.12 / platform-tools 1.52 · Photon 0.51.2 @ `52ca110c`.

## 12. Data structures

The five cell ops (`create_struct`, `create_cell`, `replace_cell`, `close_cell`,
`set_append_policy`) are deployed and listed in §5. What is fixed by this spec for any
structure:

- Two **base structures**: `Log` (index-addressed, append-only, hash-chained) and `Map`
  (key-addressed cells with `put` / `replace` / `close`; `Set` = `Map<K, ()>`). Everything
  else (events, task graph, mailbox, roster, grants, memory snapshots, artifact registry) is an
  abstraction over these with no new on-chain code.
- Each structure has a **mode**, `public` or `private`, fixed at creation. Private mode
  replaces inline values with salted commitments `sha256(salt ‖ value)` and derives Map
  addresses from `sha256(map_secret ‖ key)`. Existence, count, timing and authority remain
  public in both modes.
- The event log (§3–§4) is the `Log` instance `log_id = sha256("events")` in private mode;
  its layouts and the §4.4 chain formula are frozen. New structures use the same `Cell`
  account the cell ops (§5) write; the chain formula is extended additively.

**Hard constraints** (normative; any proposed structure must satisfy all):

| # | Constraint | Consequence |
|---|---|---|
| 1 | Cells are fixed-width, ≤ ~211 B, no variable-length fields | large values → hash commitment + `TraceStore` |
| 2 | Update = nullify + re-create under a validity proof | hot keys are a `Log`, not a `Map`; ~5 000 lamports per replaced cell |
| 3 | ≤ ~8 compressed accounts per tx (proof size, 1 232 B tx) | batch ops are 1–4 items |
| 4 | No on-chain iteration/traversal | enumeration, adjacency, ranges = Photon `memcmp` at fixed offsets; offsets are ABI |
| 5 | Addresses are globally unique and derivable from `(owner_id, struct_id, key/index)` | `put` fails on existing address; upsert = `put` or `replace`, never one op; a `close` retires the key: neither `put` nor `replace` can write it again (the SDK refuses with `MapKeyRetiredError`) |
| 6 | One hash chain per owner; every write folds into `AgentState.head` in the same tx | structures never get their own chain |
| 7 | Reads depend on an indexer | every write emits a `CellWritten`-style event sufficient to reconstruct the cell from the ledger |
| 8 | Privacy is content-only; commitments must be salted | `map_secret` loss = unreadable private Map |
| 9 | Timestamps are self-attested; slot time arbitrates | the five-minute skew bound (§5) applies to all writes |
| 10 | `ADDRESS_TREE_V2`, v2 state trees, pinned toolchain (§11) | no `light-sdk` 0.24 until anchor-lang 1.x |
| 11 | Closed cells leave an empty account at their address plus the chain head | auditors replay from chain + events, not the indexer's current view |
| 12 | Cross-owner writes need an explicit authority rule in the structure header | owner-only by default; the header's `append_policy` is the explicit rule, and any structure may opt into `ALLOW_LIST`/`ANYONE` (the SDK's `Mailbox` is `ANYONE` unless given senders; the runtime's inbox is owner-only); `replace`/`close` stay owner-only regardless, and so does rewriting the rule itself — `set_append_policy` (§5) takes a header to another policy in place, folding `SET_APPEND_POLICY (5)` and emitting the policy it replaced, which a replay needs to recompute the creation fold |

On an open Map a stranger's `put` can be repointed by the owner with `replace`, never removed without
retiring the key (#5). Every non-owner append advances the owner's `seq`/`head`, so an agent whose writes
go through a journal (the runtime anchor queue) must not open structures.

## 13. Billing and runtime

Additive to §1–§12. The operator sweeps by hand; no cron sweeps. Implementation notes:

- Billing treasuries are namespaced by admin (`["treasury", admin]`), and `UserBalance`,
  `Allowance` and the vault are scoped to a treasury.
- One operator margin, `LATH_MARGIN`, defaulting to the measured
  0.10; a failed `charge` sent directly aborts the step before any event is written and resolves
  the session `failed` (journaled by the console's anchor queue, a standalone charge the program
  refuses is parked against its payer instead); cost rounds **up** to micro-USDC; one `Allowance`
  per member authority.

- **Billing** (separate program, regular accounts — not compressed, per §12 #2): USDC escrow
  vault + `UserBalance` + per-agent `Allowance` (cap, expiry, policy hash). `charge` is composed
  in the same tx as `log_event*` when the record it pays for is written on its own; a model call
  batched into an epoch (§15) has no record of its own, so its `charge` is a transaction of its
  own, journaled ahead of the epoch. `sweep` moves only `total_spent − total_swept` out of the vault,
  and is the operator's withdrawal of what users have actually been charged.
- **Runtime**: OpenRouter, reached over Tempo's MPP gateway and paid per call from the operator's
  treasury, the voucher delta as the meter; `policy_version_hash` commits to
  `{model, temperature, tool allow-list, maxCost, promptHash?}` (§3).
- **What each chain proves**: Solana proves what the agent
  did and debits the user in USDC against the capped `Allowance` they approved, in the Action's
  own transaction or, for a call batched into an epoch, in a charge transaction journaled ahead
  of it; Tempo pays the model over MPP from the operator's treasury; the
  Action record ties the two. The deployment holds no model API key. The two ledgers do not settle
  against each other — the operator moves USDC from the vault's sweepable balance to the treasury
  by hand until a route exists, and `/billing`'s operator panel shows both balances beside that
  sentence.

## 14. Locators, published names, and what an auditor needs

Additive to §1–§13, with no instruction, account layout or seed of its own. All three are naming
conventions over cells that §12 already defines, which is the point — each replaces a service
someone would otherwise have had to run.

### 14.1 `sha256 → locator`

Lath commits `sha256(bytes)`; every candidate blob store addresses content by an identifier of
its own. Adopting one therefore buys `hash → ??? → bytes`, and the middle arrow is a lookup
somebody serves — the operator trust the whole design removes.

The arrow goes on chain. A **locator registry** is a public `Map` at
`struct_id = sha256("locator-registry")` in the owner's namespace, keyed by the payload hash:

| cell field | carries |
|---|---|
| `key_slot` | `sha256(payload_hash)` — the map's own key hashing |
| `value_slot` | the locator, zero-padded to 32 bytes |
| `tag` (u8) | the scheme: 0 raw · 4 Irys. Every other value is unassigned: a reader that meets one has no gateway for it and reports the bytes unavailable |
| `status` (u16) | the locator's true length, since `value_slot` pads |

A locator is capped at **32 bytes and must be**: longer and the value would be committed by hash
with the bytes off-chain, which reinstates the lookup. Every natural identifier fits; an HTTP URL
does not, and refusing it is the correct verdict. The registry is public-mode only, for the same
reason. First publication is binding (address non-inclusion); `repoint` versions a mapping, and
the superseded one stays in the chain fold.

Reading is `AnchoredTraceStore`: resolve the locator on chain, fetch it from any gateway,
**re-hash**. A store is therefore trusted for availability only — never for correctness — which
is why no durability argument decides which backend to use. None is adopted.

The gateway is chosen by the `tag` the chain answered with and never by a setting, because one
chain can carry both schemes — locators into a raw store and Irys ids. Scheme 4 has a gateway
in code, so a reader with nothing configured still resolves it; scheme 0 has one only where the deployment names a raw store. A hash the registry does not
map may be asked for **by the hash itself**, which only a content-addressed (scheme 0) gateway
can answer; under any other scheme the identifier is the store's own and no hash predicts it. A
locator whose scheme a reader has no gateway for is reported unavailable **with the locator**: it
is anchored, just not fetchable here, and that is a different fact from a hash the chain never
mapped.

### 14.2 Published names

`agent_id = sha256(name)` is one-way, so the chain can confirm a name and never hand you one. The
usual answer is a registry with a signature check on who may claim what. Unnecessary: the owner
publishes the **preimage of its own id** — a public `Map` at `sha256("profile")`, key `"name"` —
and a reader re-hashes it. A wrong name is arithmetically wrong, so nothing about the publication
is trusted and there is no authority to squat or take offline. The name is ≤ 32 bytes so it rides
inline; a longer name is still a valid id, it just cannot be published this way. A name that does
not hash to the owner is reported as *absent*, not as unverified — an unverifiable name is not a
name.

### 14.3 Preimage storage

`AgentLoggerOptions.storePayloads` / `AgentRuntimeOptions.storePayloads` (both **off** by default,
one extra store write per event) put `payloadPreimage(p) = kind ‖ encodePayload(p)` under its
`payload_hash`. Turn it on for any chain a third party will audit — see §7. Note that a runtime's
per-step LLM actions are written by the runtime itself (through `chargeAndLog`, or into an epoch)
rather than the logger, so the preimage for those is stored on that path explicitly; a chain
missing them would be walkable everywhere except its most common event, and `lath-audit` reports
that gap: epoch steps are walked like records (§7 step 4), so their missing preimages are named
and fail `--require-preimages`.

### 14.4 CLI surface

`lath-audit … [--gateway <url> [--registry <name>] [--scheme n] [--encoding hex|base64url]]
[--require-preimages] [--name-check]`. With `--gateway`, an auditor needs an RPC and a URL: no
bucket credentials, no operator-run index, and no reason to trust either. `--store` and
`--gateway` are mutually exclusive.

## 15. Epochs

- `commit_epoch(epoch_root, start_seq, end_seq)` requires `start_seq == AgentState.seq`, sets
  `seq = end_seq`, folds `head = sha256(prev ‖ agent_id ‖ "lattice.epoch" ‖ start_seq_le ‖
  end_seq_le ‖ epoch_root)`, creates no records, emits `EpochCommitted`.
- The root is a SHA-256 Merkle tree (odd node paired with itself) over
  `leaf_i = sha256("lattice.epoch.leaf" ‖ seq_le ‖ EventInput_i)`, `seq = start_seq + i`.
- Both tags say `lattice`. They are hash inputs, not names: every epoch committed on devnet
  folded these exact bytes into its head, so changing them would invalidate the audit of every
  chain written with them. Frozen.
- The blob is `"LEP1" ‖ count u32 ‖ start_seq u64 ‖ count × EventInput`; a reader rebuilds the
  root from it. Where it lives is the owner's business; `AnchoredEpochStore` publishes
  `root → locator` in the `LocatorRegistry` (§14.1) after the commit.
- An epoch spans at most `MAX_EPOCH_SPAN = u32::MAX` steps, the most a LEP1 `count` can hold;
  `commit_epoch` refuses a longer one with `EpochTooLong` (6018), and the SDK's `assertEpochSpan`
  refuses it before anything is uploaded or sent.
- Verification (§7) extends: an epoch is one write occupying `[start_seq, end_seq)`. The audit
  walks every epoch step's `payload_hash` and its leaves, like a record. An epoch no reader was
  given for leaves the audit NOT VERIFIED (exit 4), because its steps' fields live only in the
  blob. A blob that is missing or does not re-derive its root fails the audit (exit 2).
- Epoch steps are not indexable by Photon. Genesis, Delegation and Resolution stay records.
- Checkpoint leaves are `sha256(agent_id ‖ seq_le ‖ head)`: a head that advances by epochs needs
  its seq beside it to say which boundary it stands on. This is an SDK convention over an
  Action's `args_hash` or `result_hash`, not a change to §4.4. A loop step's `result_hash` is
  this leaf (`loopStepLeaf`).
- Batching may read the chain: a `RollupBatcher` given `ChainSignals` commits a half-full epoch
  when the priority-fee market is at its floor, and refuses to open one the payer cannot fund.
