# Lath architecture

How the system works, what the chain proves, what it costs and what is deployed. The normative data model is
[SPEC.md](../SPEC.md); keys, the threat model and chains written encrypted are in [SECURITY.md](../SECURITY.md); what is planned
is in [ROADMAP.md](../ROADMAP.md). Where this file and the code disagree, the code wins. §13 lists the invariants a
contributor must not break.

## 1. Overview

Lath gives an autonomous agent an audit trail and a spending bound. Every action the agent takes becomes a record in a
per-agent hash chain of Light Protocol ZK-compressed accounts on Solana. The owner deposits USDC into an escrow vault
and approves a capped, expiring allowance for the agent, and each paid call is debited from it on Solana. The model is
paid over Tempo's Machine Payments Protocol (MPP) from the operator's Tempo treasury, and the voucher delta of each call
is the meter. The record of each model call commits to the voucher that paid for it, which ties the two ledgers
together. The deployment holds no model API key. The two ledgers do not settle against each other yet: no USDC route
joins Solana and Tempo, so the operator moves USDC from the vault's sweepable balance to the Tempo treasury by hand, and
the console's `/billing` operator panel shows both balances beside that sentence.

A **loop** is an agent that keeps running: serial steps, each a session that runs in a Lath-patched ZeroClaw sandbox
and closes with one checkpoint record, under one overall budget. After each step of a goal loop a second model, the
decision model, answers whether the goal is reached. When it says yes, the console can publish one attestation on the
Solana Attestation Service that points at the loop's records.
Verbose material (prompts, tool arguments, model answers, sandbox files) stays off chain, content-addressed, committed on
chain by SHA-256. Records and the USDC debit are on **Solana devnet**; payments are on **Tempo mainnet**. There is no
hosted console: the app runs on the operator's machine with `npm run dev:devnet`. Four layers, each depending only on
the one below it:

| Layer        | Where                                             | What it owns                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Programs** | [`programs/`](../programs) (Rust, Anchor)         | `lath`: agents, records, epochs and cells, every write folded into the agent's head. `lath-billing`: the USDC vault, capped allowances, `charge`.                                                                                 |
| **SDK**      | [`sdk/src`](../sdk/src) (`@lath/sdk`)             | Transactions, proofs and `memcmp` reads; the four event primitives; layouts as pure functions (the browser build); epochs, locators, trace stores; loop manifests; the audit and its CLI.                                      |
| **Runtime**  | [`runtime/src`](../runtime/src) (`@lath/runtime`) | `AgentRuntime` runs and anchors a session; `LoopRunner` runs a loop; the MPP transport pays the model; the anchor queue writes the chain; the host side of the sandbox, whose binary is built from [`zeroclaw/`](../zeroclaw). |
| **App**      | [`frontend/`](../frontend) (Next 15)              | Reads are public chain data, re-hashed in the browser. Wallet writes are transactions the wallet signs. Server routes run sessions and loops with server-held keys and say so on screen.                                       |

**On the roadmap** ([ROADMAP.md](../ROADMAP.md)). Teams of agents in a loop, gated loops, loops woken by an oracle
request or feed, the trace audit, protocol-plugin grants, the marketplace and the Improve loop are not in this build.
Every door that could start one refuses it with a sentence naming the feature, which is on the roadmap; a running loop
whose row carries one is stopped at its next tick before it spends, and its page names the feature in one line. The
audit reports a step one of them wrote as a roadmap step, never as verified (§3). This tree's tools read only the
current `lath` program (§12).

## 2. Programs

### 2.1 `lath`: the hash chain

[`programs/lath/src/lib.rs`](../programs/lath/src/lib.rs). One owner kind, an agent. Every account is compressed: none
locks rent, and Photon serves them.

| Account             | Address seeds                                             | Size  | Holds                                                                                    |
| ------------------- | --------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `AgentState`        | `["agent", agent_id]`                                     | 120 B | `authority` (the only key that may append), `agent_id`, `seq`, `head`, timestamps        |
| `EventRecord`       | `["event", agent_id, seq_le]`                             | 147 B | `agent_id`, `seq`, `timestamp`, `kind`, `status`, `reference`, `payload_hash`, `head`    |
| `StructHeader`      | `["hdr", owner_address, struct_id]`                       | —     | a structure's kind, mode, append policy and count                                        |
| cell (`Log`, `Map`) | `["log" \| "qlog" \| "map", owner_address, struct_id, …]` | 187 B | owner, structure, index or version, `op_seq`, `tag`, `status`, two 32-byte slots, `head` |

**Instructions.** `register_agent`, `log_event`, `log_events` (at most `MAX_EVENTS_PER_TX = 2`, set by the pinned
prover's circuits), `log_event_compact` (emits `EventLogged` with no record account), `commit_epoch`, `set_authority`,
`close_agent` (terminal: the `agent_id` is spent for good) and the cell operations `create_struct`, `create_cell`,
`replace_cell`, `close_cell`, and `set_append_policy`, the owner's in-place rewrite of a structure's append policy.

**The fold.** Every write advances `AgentState.seq` (an epoch by its length) and folds into `AgentState.head` in the same
transaction. For an event, normatively in SPEC §4.4:

```text
head_0   = 0x00…00
head_n+1 = sha256(head_n ‖ agent_id ‖ seq_le_u64 ‖ timestamp_le_i64 ‖ kind_u8 ‖ status_le_u16 ‖ reference ‖ payload_hash)
```

`next_head` in Rust and `computeHead` in TypeScript are pinned by a shared test vector. Epochs and cells fold with their
own domain-separated formulas (SPEC §12, §15). A timestamp more than five minutes ahead of the cluster's clock is
refused; backdating is allowed, so the chain orders events but does not date them. The program accepts four event
kinds: Genesis (0), Action (1), Delegation (2) and Resolution (3). Each kind's payload is four fixed fields hashed into
`payload_hash` (an Action's are `tool_id`, `args_hash`, `result_hash`, `status_code`), and `reference` is the field
`memcmp` filters on (an Action's is `sha256(tool_id)`); SPEC §3 has the table.

**Epochs.** `commit_epoch(epoch_root, start_seq, end_seq)` replaces N per-step records with one header rewrite. The
root is a SHA-256 Merkle tree with one leaf per step (its 75-byte `EventInput` and its seq), and the blob that rebuilds
it lives off chain (§9). Genesis, Delegation and Resolution stay records because other chains pair against them; model
and tool steps go into epochs, where they are auditable but not queryable by `memcmp`.

**Cells.** Two base structures, `Log` (append-only) and `Map` (key-addressed `put` / `replace` / `close`), public or
private, fixed at creation. The mailbox, the task graph, the policy registry, published names, the agent store and the
locator registry (§9) are built on them with no further program code. A structure is owner-only unless its header names
another append policy. Light sets the limits (SPEC §12): a cell is fixed-width, at most about 211 B; a transaction holds
at most about eight compressed accounts; an update is nullify-and-recreate under a validity proof; there is no on-chain
iteration, so every enumeration is a Photon `memcmp` at a fixed offset.

### 2.2 `lath-billing`: the vault and the allowance

[`programs/lath-billing/src/lib.rs`](../programs/lath-billing/src/lib.rs). Regular accounts, rewritten on every charge:
a `Treasury` at `["treasury", admin]` (mint, sweeper, sweep destination, totals, caps), its USDC vault at
`["vault", treasury]`, a `UserBalance` at `["balance", treasury, user]` (`deposited`, `spent`, `reserved`), and an
`Allowance` at `["allow", treasury, user, agent_authority]` (`cap`, `spent`, `expires_at`, `policy_version_hash`,
`reserved`). `deposit` moves USDC into the vault. `approve_agent` creates or replaces a grant; `revoke_agent` releases
any hold and closes it. `charge`, signed by the agent's authority, needs a live grant with
`spent + reserved + amount ≤ cap` and a balance that covers it. `sweep`, signed by the sweeper, sends at most
`total_spent − total_swept` to the destination fixed at creation. The vault is **deposit-only**: the deployed program
has no `withdraw` and no `settle` (their events stay in the IDL so older history decodes), so unspent deposits stay in
it. `lath` never calls `lath-billing`; the SDK and the runtime compose their instructions into transactions (§7.5).

## 3. SDK

`@lath/sdk` ([`sdk/src`](../sdk/src)) bundles the IDL, so using it needs no Anchor workspace.

| File                                                                | What it does                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `client.ts`                                                         | `LathClient`: addresses, validity proofs, packing, sends with retries, `memcmp` queries, `verifyChain`, `listEpochs`   |
| `logger.ts`                                                         | `AgentLogger`: `genesis`, `action`, `delegate`, `resolve`, `audit()`                                                   |
| `layout.ts`, `browser.ts`                                           | every offset, address and decoder as pure functions; CI fails if a Node built-in or `viem` reaches `@lath/sdk/browser` |
| `cells.ts`, `structures.ts`, `abstractions.ts`                      | `LathLog`, `LathMap`, `LathSet`; `Mailbox`, `TaskGraph`, `PolicyRegistry`, `NameRecord`                                |
| `rollup.ts`, `locator.ts`, `irys.ts`, `bundle.ts`, `trace-store.ts` | epoch batching; the `sha256 → locator` map; the Irys backend; session bundles; `TraceStore` and the encrypted stores   |
| `loops.ts`, `goal.ts`, `verify.ts`                                  | loop manifests, leaves and `verifyStep`; the goal plan parser; the decision model's frozen questions and blobs         |
| `tempo.ts`, `receipt.ts`                                            | the Tempo reader behind the payment checks (Node only); the `loop-receipt` schema (§8)                                 |
| `audit.ts`, `audit/`, `cli.ts`                                      | the audit engine and the `lath-audit` binary                                                                           |

**`lath-audit`** is the bin of `@lath/sdk`. The package is not published to npm, so it runs from a clone as
`npm run -s audit -- …`. This build writes every blob in the clear, so no check needs a key. On a chain written
encrypted, every check that reads an owner-encrypted blob (a manifest, a voucher, a decision) needs the agent's
`--trace-key`; without it only the chain and the epochs are verified.

| Command                                 | What it checks                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<agent id>` or `--name <n>`            | every record and epoch re-folded to `AgentState.head`; with `--store` or `--gateway`, every blob re-hashed; `--recover` refills gaps from transaction history; `--key` checks a loop's Tempo key (§7.3) |
| `… --require-preimages [--trace-key k]` | also each record's payload preimage and every blob a loop manifest names, from the session bundles                                                                                                      |
| `verify-step <agent> <seq>`             | one loop step: leaf, manifest, decision blob, sandbox records                                                                                                                                           |
| `verify-inference <agent> <seq>`        | one model call's voucher against the channel it was signed on                                                                                                                                           |
| `verify-channel <agent>`                | a whole channel: the vouchers against what the escrow paid out at close                                                                                                                                 |
| `verify-charge <agent>`                 | each Tempo storage payment against its transfer, each stored report against its record                                                                                                                  |
| `verify-receipt --name <n>`             | a loop's SAS receipt against the records it points at (§8)                                                                                                                                              |
| `binary <agent> <seq>`                  | the sandbox build a step committed, against the published builds and this checkout's patches                                                                                                            |
| `reanchor <agent>`                      | an operator's repair: uploads blobs that fell back to disk and repoints their locator cells                                                                                                             |

The audit exits `0` verified, `1` the chain does not replay, `2` blobs missing or edited, `3` bad arguments or no such
agent, `4` not checked (the head was never reached, a gap is unaccounted for, or epochs or encrypted preimages were not
opened). The payment checks exit `0` verified, `4` pending, `2` failed. `verify-plugins`, `verify-improve`,
`verify-feed` and `verify-request` audit roadmap features and are refused by name: `<command> is not in this build:
the feature it audits is on the roadmap` (exit 3). A step whose manifest carries a roadmap feature's key (a team, a
gate, a trace audit, a protocol plugin) still has its leaf and manifest checked, but `verify-step` names the feature
and ends `NOT VERIFIED (roadmap feature)` (exit 2): this build does not verify what those keys commit.

## 4. Runtime

### 4.1 A session

`AgentRuntime.start()` ([`runtime.ts`](../runtime/src/runtime.ts)) alternates one model turn with the tool calls it
asked for, until the model answers without a tool call or the turn ceiling, the cost ceiling or a failed charge ends it.
It writes a Genesis (`caller` = the user's wallet, `policy_version_hash` = SHA-256 of the policy document); an Action
`llm.<model>` per model call (`args_hash` over the request, `result_hash` over the body with its payment beside it); an
Action per tool call (status 200, 400 for arguments the schema refuses, 404 or 500); a Delegation per `delegate` call,
whose child opens with a Genesis naming the parent; and always one Resolution (0 success, 1 failed, 2 aborted).

**The policy document** ([`policy.ts`](../runtime/src/policy.ts)) is canonical JSON of the model, temperature, sorted
tool allow-list and `maxCost`, plus keys present only when set: `verify`, `goalCheck`, `sandbox` (§5), `tempoKey`
(§7.3), `fallbackModel`, `receipt` (§8), and keys reserved for roadmap features. An absent key drops out of the bytes,
so a new key moves no hash already on devnet. The document is published in the agent's `PolicyRegistry`.

**Failure rules.** A voucher the gateway refuses throws before any blob or charge, so no event names an unpaid call,
and it is never retried. A paid call whose body is lost is still recorded, as a failed `llm.*` Action with
`{ error, payment }`, so the chain's vouchers stay contiguous. The ceiling is checked after each call: the call that
crosses it is paid and the next is refused.

**Epochs and anchoring.** With `rollup` on (every console session, on a program with `commit_epoch`), model and tool
Actions are committed as one epoch, and Genesis, Delegation and Resolution flush it first so seqs stay dense; the
batcher refuses, before the model is called, to open an epoch the payer cannot fund. A console session answers before
its records land: each record is built with its seq and head, journaled, and sent by one writer queue per agent
([`anchor.ts`](../runtime/src/anchor.ts)). Three failed attempts mark an entry `FAILED` and halt that agent's queue
until a Retry; nothing is lost. Before each resend the queue reads the chain's head, so a record that landed and only
lost its confirmation is marked verified, never written twice. A model call's charge is its own journal entry, ahead of
the epoch it pays for (§7.5); one the billing program refuses is parked against its payer instead of halting the chain.

### 4.2 A loop

`LoopRunner` ([`loop.ts`](../runtime/src/loop.ts)) runs a session again and again on a schedule, with a standing
instruction, a step ceiling and one budget, and requires `rollup`. One step writes:

```text
seq        write
n          Genesis        session_id = "<loopId>:step-<k>", caller = the owner's wallet
n+1 … m    (an epoch)     every model call and tool call of the step, one commit_epoch
m+1        (locator cell) the epoch's root → its blob
m+2        Resolution     the step's outcome, cost and call count
m+3        Action         tool_id = "loop.step", the checkpoint
```

plus the session bundle's locator cell (§9) and, when the host pays Tempo storage, one `storage.put` Action (§7.4).
When the loop stops, its Tempo channel settles and one `Action{tool_id: "loop.settlement"}` records the settlement.

**Lifecycle records** (SPEC §3.1, [`lifecycle.ts`](../sdk/src/lifecycle.ts)) frame the steps: a `loop.start` before the
first step, a `loop.pause` / `loop.resume` at each transition and a `loop.stop` before the settlement, each a full-mode
Action whose public document is anchored in clear (§9). This build writes no owner-only half: the prompt and the signed
start body are committed by their hashes in the public document. The console owes a record at the moment it decides — `updateLoop` compares the
row before and after, so every stop path owes its `loop.stop` with the reason — and writes it later, in order, under
the run slot, after the agent's journal has drained and never between a step's Resolution and its `loop.step`
(`_lib/lifecycle.ts`). The first step waits for its `loop.start`; a write that fails stays owed, is retried, and the
page says _recording on Solana_ until it lands. `agent.deploy` names the deploy transaction the wallet signed;
`agent.archive` and `agent.unarchive` carry the owner's signed message. `LATH_LIFECYCLE=off` writes none of them.

**The checkpoint** is a full record, so `listByTool(agentId, "loop.step")` is the loop's history: `reference` =
`sha256("loop.step")`; `status` 200 success, 201 goal reached, 499 aborted, 500 failed; `args_hash` =
`sha256(manifest)`; `result_hash` = the step leaf `sha256(agent_id ‖ seq_le ‖ head)`, over the seq the checkpoint
occupies and the head before it, which a verifier rebuilds from the chain alone.

**The manifest** ([`loopManifestBytes`](../sdk/src/loops.ts)) is JSON with keys in a fixed order: `loopId`, `step`,
`intervalMs`, `maxSteps`, `promptHash` (`sha256` of the standing instruction), `startedAt`, then, each only when set,
`memoryHash` (7th), `verifyHash` (9th, §6), `goalHash` (10th, `sha256(goal)`), `replayHash` (13th, §5), `goalCheckHash`
(14th, only when the verify seat is off) and `tempoHash` (15th, the `storage.put` Actions since the last leaf with their
receipts). Keys 8, 11, 12, 16 and 18 belong to roadmap features (an oracle request, a team, a gate, the trace audit,
protocol plugins) and are absent from every step this build writes; 17 is reserved. Because an absent key writes no
bytes, a manifest without them re-hashes the same, and its leaf re-derives; what keys 11, 12, 16 and 18 commit, this
build does not verify (§3).

**Memory** is one piece of text: the answer the last kept step ended with. The runner stores it, commits its hash as
`memoryHash`, and before the next step fetches and re-hashes the bytes; missing or mismatched bytes fail the step as
`no-memory` rather than start it fresh, and the audit checks each step resumed from what its loop last committed.

**Goals.** A goal is optional text that says what done looks like. Each step is asked to end its answer with a
`DONE:` / `NEXT:` / `OPEN:` plan and, when the goal is met, a last line `GOAL REACHED`; that answer is the memory, so the
plan needs no new record. A step whose goal is judged reached (§6) is checkpointed at 201 and the loop stops
`goal-reached`; a goal never reached runs to `maxSteps`.

**Stops.** `max-steps`, `goal-reached`, `budget`, `escalated` (§6), `charge-failed`, `stopped` by the owner,
`anchor-failed`, repeated failures, and the key stops of §7.3. A step in flight is never interrupted. `anchor-failed`
writes no checkpoint, since there is no settled head to commit to; the Retry lands the journal, then the deferred
checkpoint and the settlement record it still has to write. A Retry of a checkpoint whose plan carries a roadmap
feature's key (a team's members, a gate log, an oracle request, a trace audit, a plugin record) is refused before
anything is drained: its records stay journaled rather than land under a checkpoint other than the one its step
planned.

**Budget.** One budget, `budgetMicroUsdc`, with no per-step ceiling (`LATH_LOOP_BUDGET_MAX_USDC`, default 25, caps it).
The policy commits `maxCost` = the whole budget, and every session is handed the remaining budget as a live ceiling. A
step runs billed only when the owner's allowance covers an estimate of it from recent steps; otherwise it runs scripted
and unbilled.

### 4.3 The console

The server ([`frontend/src/app/api`](../frontend/src/app/api); environment documented atop
[`_lib/runner.ts`](../frontend/src/app/api/_lib/runner.ts)) runs sessions and loops with server-held keys and says so on
screen. `/api/agents` deploys: the server registers the agent with a key derived from its name (only the key that signed
`register_agent` may append), and the owner's wallet signs one transaction approving the capped allowance. `/api/run`
runs a chat session in-process and streams every chain write. `/api/loops` starts and steps loops; a start is one
off-chain `"Lath loop"` message whose `Request ID` binds the hash of the start body. `/api/traces/<id>` serves blobs the
browser re-hashes; `/api/zeroclaw` is a read-only view of each loop's sandbox, which serves no reader the step's derived
`config.toml` or wrapper profile, since they name the host's paths and nothing commits them. The scheduler takes a process-wide single-flight slot per step, so one
chain writer runs at a time, and the console runs as one instance. Every deploy and loop start mints or reuses a
**template**, a versioned off-chain config addressed by the SHA-256 of its canonical form, which _Run again_ and _Clone_
start from; the chain names one only as `{id, version, hash}` inside a lifecycle document.

**Its lists are a cache of the chain.** `agents.json` and `loops.json` (in `LATH_TRACE_DIR`) still hold what a step
needs between ticks, but what they show is on chain (§4.2). On its first scheduler pass, and when `/api/agents` finds an
empty registry, a console lists every `agent.deploy` on the program, keeps the agents whose name derives the id and
whose header names this console's derived key, and adds the agents and loops it is missing from their lifecycle records
(the goal and terms from the public document, status from the fold; a prompt is on chain only as its hash, and comes
back only when it is the goal's text). A rebuilt row is read-only: nothing schedules it, and its controls refuse,
since another console may still be the chain's writer.

## 5. Loops in the sandbox

Every loop step runs in a one-shot, Lath-patched ZeroClaw process, with no switch that runs it in-process: a Genesis
would then commit a posture that was never applied. Without a working binary, `POST /api/loops` refuses with the
reason. Chat sessions outside a loop run in-process.

```text
host (the Next process): server keypair, Tempo treasury, LoopRunner, anchor queue
 ├─ <step>/m.sock  meter proxy: /v1/chat/completions only, model and temperature pinned to the policy,
 │                 each request paid over MPP and recorded as an llm.* Action
 ├─ <step>/t.sock  host tools: store.get, store.set, solana.slot, solana.fees, solana.balance,
 │                 lath.verify_chain, each call an Action
 └─ sandbox: zeroclaw --config-dir <cfg> agent -a lath -m "<step message>"
     no key, no treasury; network: the two sockets only; files: the loop's workspace and <cfg>
     macOS: sandbox-exec with a generated deny-default profile · Linux: bwrap --unshare-all
```

**The air gap, four layers.** (1) The `lath` cargo feature compiles out every tool that opens a connection and refuses
every provider but one `custom` provider. (2) That provider speaks only to a Unix socket, with no proxy and no DNS. (3)
The six host tools are compiled in as clients of the tools socket. (4) The host's wrapper denies every other socket,
route and path at the OS. A probe (`zeroclaw/probe/airgap.sh`) tries outbound TCP, a loopback listener, UDP, DNS, the
Solana keypair, the trace directory, a third socket and `/bin/sh` from inside the wrapper; every one must be denied on
macOS and on Linux, and an unwrapped control run must reach them.

**The contract between host and binary.**

- **Config.** One `config.toml` per step in a fresh `--config-dir`, rendered from the posture: one `custom.lath`
  provider whose `unix_socket` is `m.sock` and whose bearer is the step's token; risk level `full`, `workspace_only`, an
  explicit `allowed_tools`; ZeroClaw's own memory and cost ledger off; provider retries 0; a `[lath]` section naming
  `t.sock`. Any other provider, tool, MCP server, skill or channel, an empty `allowed_tools`, a TCP `uri` or retries
  make the binary exit non-zero.
- **Sockets.** The model socket takes `POST /v1/chat/completions` with `stream: false` and answers one completion body
  with no payment in it, 401 for a wrong token, 400 for another model before anything is paid. The tools socket takes
  `POST /tools/<tool id>` and answers 200 `{"result": …}` or 404 / 500 `{"error": …}`. The model sees wire names
  (`store_get`); the chain records the dotted ids.
- **Process.** Stdin closed, under the wrapper, with exactly `HOME` (the step's directory), `TZ=UTC`, `LANG=C`,
  `ZEROCLAW_NOW` and `ZEROCLAW_OMIT_HOST=1`; nothing is inherited, so no `LATH_*` secret reaches it. Stdout is the output.
- **Sources.** Files the host fetched once at the loop's start (a public GitHub commit, an `https://` text URL, a Solana
  account at a slot, an attached file; SSRF-guarded and capped) sit read-only under `workspace/sources/`. Before each
  step the host re-reads each Solana source and tells the sandbox in its message what changed.

**What is committed.** The posture is the policy's `sandbox` key, so every step's Genesis commits it: the binary's
SHA-256 and patch set, the rendered config minus per-step values, the workspace caps (8 MiB, 1 000 entries), argv, the
environment, the wrapper profile and the sources manifest's hash. ZeroClaw's file tools are recorded by the host from
the model traffic as `zc.file_read` and `zc.file_write` Actions. Each step writes a replay record (binary and posture
hashes, the message's hash, the canonical workspace tree before and after, the seqs of its calls), committed as
`replayHash`. The host reads the workspace back without following links or blocking on a FIFO.

**What it does not prove.** `verify-step` checks that the replay record re-hashes, that its posture and binary match the
Genesis's policy, and that the binary is a published build; `lath-audit binary` checks that the build reproduces from
`zeroclaw/UPSTREAM` plus this repository's patches. That shows what a step committed to, not that it ran inside that
posture, which remains the host's word. Re-running a step against its recorded replies is designed and not built. The
full contract is [`zeroclaw/CONTRACT.md`](../zeroclaw/CONTRACT.md).
ZeroClaw is a trademark of ZeroClaw Labs; Lath runs a Lath-patched build of it.

## 6. The decision model

The decision model is TypeSafe's Jev, a typed decision model: it emits no text, and answers each of a fixed set of
questions with a probability or one of N words, with a confidence. Lath asks it over the same Tempo MPP gateway
(`/alpha/decisions`) on the loop's own channel, pinned to `typesafe/jev-1.13`; a moving alias is refused and the build
that answered is recorded. The questions' wording is frozen in [`sdk/src/verify.ts`](../sdk/src/verify.ts), so the
runtime and an auditor hash the same bytes. In every seat the model proposes a typed answer, and a bar the loop's policy
commits turns it into an action in code.

**The goal check.** After each successful step of a goal loop: _Judged from the step output, has the loop reached its
GOAL?_ `continue` or `achieved`, read against the standing instruction, the goal, the previous memory and the output. The
bar is the verify seat's `minConfidence` when that seat is on, else 0.5; the policy commits
`goalCheck: { model, minConfidence }`. A step the verify seat did not keep ends no loop.

| Answer                                           | Step status       | The loop                                          |
| ------------------------------------------------ | ----------------- | ------------------------------------------------- |
| `achieved` at or above the bar                   | 201               | stops `goal-reached`, whatever the agent wrote    |
| `continue`, or `achieved` below the bar          | 200               | continues; an agent's `GOAL REACHED` is overruled |
| no answer, an outage, or a spent decision budget | the claim decides | the agent's own `GOAL REACHED` decides            |

**The verify seat.** Every loop started from the console's form has it (the server still accepts a start without it).
Before the step's memory is committed, the model answers `followed_plan` (did the output carry out what the prompt
asked, given the previous memory) and `verdict` (`accept`, `retry` or `escalate`). With the seat on, the goal question
rides the same call: one request, one voucher, one blob.

| Verdict                              | Memory                                  | The loop                         |
| ------------------------------------ | --------------------------------------- | -------------------------------- |
| `accept` at or above `minConfidence` | committed                               | continues                        |
| `retry`, or `accept` below the bar   | not committed; the previous one carried | continues; the step still counts |
| `escalate`                           | not committed                           | stops `escalated`                |
| no answer (20 s, one attempt)        | committed                               | continues, and the row says so   |

**The outage rule.** An outage never stalls a loop or silently changes what it does: the check is recorded unavailable,
no decision hash is written, and the loop goes on as it would without the seat. A decision paid for and never answered
is stored as an `unanswered` blob and named on the step. **What is committed:** a decision is not a record. Its blob
(the request with its state and questions, the answers, the model build, the voucher that paid) goes to the trace store,
and its hash is a manifest key (`verifyHash`, or `goalCheckHash`), so the checkpoint's `args_hash` covers it.
`verify-step` re-hashes the blob, checks the questions are the frozen ones, re-applies the committed bar, checks the
voucher rode the loop's channel, and fails a 201 the answer does not back.

**Who pays: Lath.** A decision costs 40 to 75 USDC.e base units on the loop's channel, and nothing is debited from the
owner. What Lath spends on a loop's decisions, and on chat attempts that got no answer (§7.2), is capped at 15 % of the
owner's loop budget (`LATH_JEV_BUDGET_PERCENT`, frozen at start); the call that crosses the cap is paid, and past it the
seats take the outage path while the loop goes on. A decision shows which model said what, with what confidence, about
exactly which state, and that the loop acted on it by its own committed rule. It is a second opinion the chain
remembers, not a proof that the agent was right.

## 7. Payment

### 7.1 Two ledgers

On **Solana devnet** the owner pays the operator in USDC: `charge` against the owner's `Allowance`, bounded by its cap
and expiry, which `lath-billing` enforces. On **Tempo mainnet** the operator's treasury pays OpenRouter, the decision
model and Tempo's own services in USDC.e over MPP, bounded by the treasury's balance, each channel's deposit and, with
per-loop keys, a limit Tempo enforces. Nothing enforces that the two match beyond the record and a public formula: the
owner is charged `ceil(delta × (1 + margin))` micro-USDC for a call whose voucher delta was `delta` base units (both
have six decimals), with `LATH_MARGIN` 0.10 by default.

### 7.2 Tempo MPP

`MppOpenRouterTransport` ([`transport/mpp.ts`](../runtime/src/transport/mpp.ts)) sends each model call to
`openrouter.mpp.tempo.xyz` with no API key. The credential is a TIP-1034 payment channel on Tempo mainnet (chain 4217),
opened on the gateway's first 402 and with gas the gateway sponsors, from which `mppx` signs one cumulative voucher per
request. The gateway's flat price per request is the meter; OpenRouter's `usage.cost` is recorded beside it as
`usageCost`, never reconciled. With no treasury configured a session runs scripted and unbilled, and is labelled so. The
result blob of each model call, which `result_hash` commits, carries the payment beside the body:
`payment: { rail: "tempo", chainId: 4217, payer, channelId, cumulativeBefore, cumulativeAfter, usageCost }` (amounts in
USDC.e base units as decimal strings), plus `signer` when a loop key signed it (§7.3) and `paidBy: "lath"` on an attempt
Lath absorbed. One Action is one call, so the two cumulatives bracket exactly that call.

**One channel per loop.** Opened on the loop's first paid call and carried across steps, it is settled once: when the
loop stops, fails out, reaches `max-steps`, or idles for `min(2 × interval, 1 h)`; the `loop.settlement` Action records
the close (a chat session puts it in its Resolution's blob). `maxDeposit` is the owner's remaining budget plus Lath's
remaining decision share; a treasury too small for it refuses the start. A failed close is reported, not thrown, and the
next start-up settles it from the console's channel ledger. A second console process on the same treasury is refused.

**A call that got no answer** is retried within one call's time (110 s), on the loop's model and then on the
`fallbackModel` every step's policy commits when the operator set one. Every attempt is its own paid `llm.*` Action; one
that got no answer says `paidBy: "lath"`, debits the owner nothing and counts against Lath's decision share. The audit
fails a call whose request names a model the session's policy does not commit.

### 7.3 Per-loop access keys

Behind `LATH_TEMPO_LOOP_KEYS` (on for `1|on|true|yes`, off by default in the code; the demo's console runs with it on,
and with `LATH_TEMPO_KEY_SCOPES=off`, so the demo's loop key is unscoped). At a loop's start, after the owner's
signature and before the first Genesis, the console makes a random key (file mode 0600 in `LATH_TEMPO_KEY_DIR`) and
authorizes it on the treasury's keychain with a USDC.e limit of the loop's budget plus Lath's 15 % decision share and a
30-day expiry, scoped (unless `LATH_TEMPO_KEY_SCOPES` is off) to the escrow's `open` and `topUp` and USDC.e
`transferWithMemo` to the storage payee. The key signs every open, top-up and voucher of the loop's channel; the
treasury stays the payer. Tempo refuses a deposit past the limit at submission (`SpendingLimitExceeded`) whatever the
console does, a refusal shown on Tempo mainnet. Before each reopen the console resets the limit to what the loop has not
used, since a refund does not restore it; at the stop it closes the channel with the key, then revokes the key. A start
whose key cannot be authorized is refused rather than run treasury-signed, since its Genesis would commit the key.

The policy commits `tempoKey: { address, token, limitBase, expiry, authorizeTx, scopes? }`. `lath-audit --key` checks
that the authorize transaction gave that key exactly that limit and expiry, that every channel the loop paid through
names the key as its signer, that the key's scopes on Tempo are the committed ones, and that each storage charge's
attribution memo names the loop. It does not yet hold each limit reset to the formula (`limit reconciles: unchecked`),
and a compromised treasury key could still authorize a bigger key.

### 7.4 Tempo storage and RPC

The host also pays two services Tempo runs, after the step's leaf lands. **Storage** (`storage.mpp.tempo.xyz`, one MPP
charge per call, paid by the owner and metered into the USDC debit): each step's report is stored under
`<loopId>-<sha256>` and recorded as a `storage.put` Action whose `result_hash` is the SHA-256 of the plaintext, which
is what is stored. Only the treasury can read it back from Tempo; it is the owner's copy of the deliverable, not
evidence. The report is also the `storage.put`'s result blob in the console's trace store, so
`GET /api/loops/<id>/report` answers anyone from that copy; without one it reads Tempo storage with the treasury's
charge client (about $0.0001 a read, rate-limited per caller IP). A report stored encrypted (`LTE2`) is refused
rather than decrypted. **RPC** (`rpc.mpp.tempo.xyz`, a session, paid by Lath): the runtime's reads of the
channel and the treasury, carried as a snapshot in the next leaf's bundle. Paid RPC buys nothing the free endpoint does
not. A stop drains pending writes and reads, for at most 90 s, before it closes the channels.

### 7.5 The USDC allowance on Solana

The owner deposits USDC into the vault on `/billing` and approves one capped, expiring `Allowance` per agent at deploy;
no run asks for another signature. Where a charged write is its own record (a `storage.put` Action, or a model call in a
session without epochs), `charge` and `log_event` share one transaction (`chargeAndLog`, or the anchor queue composing
the same instruction), so they land together or not at all. A model call inside an epoch has no record to share a
transaction with, so its charge is journaled and sent on its own, ahead of its epoch, once the gateway has been paid;
every console session and every loop step uses epochs, so their model calls are charged this way. Nothing ties such a
charge to its record: the program checks the cap, and `verify-channel --refetch` holds a debit to
`ceil(delta × (1 + margin))` only for a record with a transaction of its own. Sent directly, a refused charge aborts the
step before any event is written; journaled, a refused standalone charge is parked against its payer, and one that rides
with its record halts that chain's queue until a _Retry_. A loop's spend has three bounds: the runtime's ceiling (the
remaining budget), the Solana allowance (a short one runs the step unbilled) and, with per-loop keys, the key's limit,
the only one that does not trust the console.

## 8. `sas.receipt`

A wallet or another program cannot read a compressed hash chain in one call. So when the decision model answers
`achieved` and the loop stops on it, the console publishes **one attestation on the Solana Attestation Service**
(program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`) that points at the loop's records. A loop stopped by hand, by
its budget or by an error gets none.

| Field                      | What it holds                                                                    |
| -------------------------- | -------------------------------------------------------------------------------- |
| `agent`, `loop`            | the agent id and the loop id                                                     |
| `seq`, `head`              | the seq of the loop's last `loop.step` record and the head its leaf committed to |
| `steps`, `goal`            | how many steps the loop took; `sha256(goal)` as the manifests commit it          |
| `usdcCharged`              | what the owner was charged on Solana, micro-USDC, as the console reports it      |
| `tempoSpent`, `tempoPayer` | what the loop's channel paid on Tempo, and the key or treasury that signed       |

The schema is `loop-receipt` v1 under the credential `lath-demo` ([`sdk/src/receipt.ts`](../sdk/src/receipt.ts)). The
nonce is `idFromString("lath.loop-receipt:" + loopId)`, so a loop has one receipt address and a receipt is never
replaced; the domain string is a frozen derivation input. The console's runtime key, authorized once by the issuer,
signs it and pays its rent. The policy commits the pointer `receipt: { credential, schema, signer }`, which rides in the
start body the one `"Lath loop"` message binds. The console accepts a receipt only with `LATH_PROTOCOL_PLUGINS` on (off
by default in the code, on in the demo's console), and only for its own credential and schema, which
`npm run -s demo-attest:seed` creates and `npm run -s demo-attest:authorize` lets its runtime key sign under.

`lath-audit verify-receipt --name <agent>` derives the address for each loop whose policy commits a receipt, reads the
account and checks: owned by SAS; credential, schema, nonce and signer as committed; `agent` and `loop` equal the
chain's; a `loop.step` of that loop at `seq` that is its last, records the goal reached and whose leaf commits `head`;
`steps` and `goal` as the manifests commit them. A goal-reached loop with no account yet is `unchecked`; the money fields
are printed as reported, not re-derived. The receipt is an index into the chain, not a proof of it: the console's key or
the issuer could write a false one, and the audit catches that against the records.

## 9. Traces and data availability

On chain: accounts of 120–187 B and the events in transaction logs (`EventLogged`, `EpochCommitted`, `CellWritten`).
Off chain, each committed by a hash the chain holds: every record's payload preimage (70–130 B), and the prompts, tool
arguments and results, answers, memory, decisions and sandbox files (KB to MB). The off-chain layer is a `TraceStore`
with two methods, `put` and `get`, trusted for availability only: every reader re-hashes what it is served.

Each agent owns a public **`LocatorRegistry`**, a `Map` from `sha256` to a 32-byte locator with the scheme in the cell's
tag ([`locator.ts`](../sdk/src/locator.ts), SPEC §14.1). The first publication of a hash binds by address
non-inclusion, and a repoint is visible in the fold. `AnchoredTraceStore.get` resolves the locator from the chain,
fetches the bytes and returns them only if they re-hash. Scheme `0` is a raw directory served by `/api/traces`, for
development; scheme `4` is an Irys transaction id read through `https://gateway.irys.xyz`, a default in code. The chain
carries an id and a scheme, never a URL.

- **Epoch blobs** (`"LEP1" ‖ count ‖ start_seq ‖ EventInput…`) are located by root, directly or through a `"LEM1"`
  manifest that amortises one cell over K epochs (`LATH_ANCHOR_EVERY`). The order is upload, `commit_epoch`, then the
  cell, so the chain never points at bytes nobody kept.
- **Session bundles** (`"LPB1" ‖ count ‖ (len ‖ bytes)…`) hold every preimage and sub-blob of one session, one cell per
  session keyed by `sha256("lattice.preimages" ‖ genesis payload_hash)`; any reader holding a record holds its session's
  Genesis, so the key is derivable. A loop step seals its bundle after its memory and checkpoint. Each entry is checked
  by re-hashing to the hash the chain committed.
- **Lifecycle documents** (SPEC §3.1) open no session, so each blob gets its own cell, as a settlement's do: the
  record's preimage, `args` and `result` in clear, written after the record one cell at a time. This build writes no
  owner-only half; in a record that names one (`privateHash`), it is anchored, encrypted, before the record, so the
  hash never names bytes nobody kept. About 15 000 lamports a cell.

**Irys.** `npm run dev:devnet` uploads to Irys (`LATH_TRACE_BACKEND=irys`), paid from the runtime key's balance at Irys,
on Irys devnet unless `LATH_IRYS_NETWORK` says otherwise; the demo's blobs are there. Irys devnet deletes uploads after
about sixty days, after which a chain anchored there fails `--require-preimages`; a devnet chain can anchor to mainnet
Irys (`LATH_IRYS_NETWORK=mainnet`), which keeps bytes for one payment. A failed upload is retried, then falls back to
the local directory (`anchored: false` on the commit) until `lath-audit reanchor` uploads it and repoints the cell. A
loop's sources are published on Irys in clear at its start, indexed from its chain.

**Encryption.** The console writes every blob in the clear: every blob re-hashes for anyone, and the audits need no
key. Encrypting traces to the owner is a [ROADMAP.md](../ROADMAP.md) item. Devnet carries chains written encrypted
(AES-256-GCM, `LTE2`, the plaintext hash bound as associated data; the chain commits to the plaintext). The console
does not decrypt them, so a step or record written that way is not shown on the page, and `--require-preimages` ends
`NOT VERIFIED` until `lath-audit --trace-key` opens them. Keys and the format are in [SECURITY.md](../SECURITY.md).

## 10. What the chain proves

The chain does not store the interesting bytes, but it names them, and a SHA-256 cannot be satisfied twice. Every check
here can be repeated with tools that are not Lath's. Solana and Light are trusted for ordering, authorship and the
digests; the blob store only for availability, since every reader re-hashes; the console only for rendering. The table
party by party is in [SECURITY.md](../SECURITY.md) §1.

**Three hops.** The record's `payload_hash` is folded into the agent's head; the owner's `LocatorRegistry` says where
the bytes are; the gateway serves them and the reader re-hashes. A trace blob is checked with `sha256`. An epoch blob is
checked by rebuilding its Merkle root, since hashing the file proves nothing; one epoch step proves itself with a
sibling path to the root. The outcomes are distinct words, and none is rendered as a trace: `ok`, `not-anchored`,
`unavailable` (the chain named a locator and the bytes came back wrong or not at all), `encrypted`, and `mismatch` (an
epoch blob rebuilt another root). Bytes served under a record's hash that do not re-hash fail the audit as edited.

A record the queue has not landed has a seq and a head, because a head is arithmetic, and proves nothing: no indexer
has it, and an audit mid-session stops at the last confirmed seq.

**In the console and off it.** Every claim on screen is computed in the browser from chain data, beside a _Check it
without this page_ block (the committed hash with an explorer link, the URL fetched, a `curl` + `shasum` line).
_Verify offline_ prints the whole-chain audit; _Export verification_ writes a JSON file that `npm run verify:bundle`
replays with no network, ending `VERIFIED`, `VERIFIED WITH GAPS` (naming the seqs it cannot carry) or `FAILED`.
[`scripts/evidence`](../scripts/evidence) builds a static page for a finished loop that links every record, debit,
Tempo payment, receipt and pinned file to its public explorer, beside the commands that check them.

```bash
R="https://devnet.helius-rpc.com/?api-key=…"   # any ZK-compression RPC
# the chain and its epochs; traces written encrypted report as encrypted
npm run -s audit -- <agent id> --rpc "$R" --gateway https://gateway.irys.xyz --scheme 4 --encoding base64url
# every preimage and trace blob too; an agent written encrypted also needs --trace-key <key file>
npm run -s audit -- <agent id> --rpc "$R" --gateway https://gateway.irys.xyz --scheme 4 --encoding base64url \
  --require-preimages
```

**What Tempo proves about a payment.** From the chain alone: one payer across an agent's records (one switch, from a
pre-treasury derived address to the treasury, is accepted), and cumulatives that never go backwards. With Tempo: a call
is `VERIFIED` when the close transaction the chain names succeeded, closed this channel at the escrow against this
payer, paid a payee other than the payer in USDC.e, and paid out at least this call's cumulative; while the channel is
open the answer is `PENDING`. A loop's deltas must sum to the channel's `finalAmount` when the chain holds the channel
whole, and stay under it otherwise.

**What the lifecycle records prove.** On a chain that has them, the audit prints a `deploy` and a `loops` line and
holds each record to the owner's word: a start's or an owner transition's signed message verifies for the owner's
wallet (small-order keys refused), names this agent or loop and the verb, and a start's `Request ID` is its
`startBodyHash`; no `loop.step` lands in a stopped loop's span before a `loop.resume`; the deploy transaction succeeded,
was signed by the owner and registered this `agent_id` under the chain's authority; with `--trace-key`, each private
half a record names opens and re-hashes to the `promptHash` and `startBodyHash` the public document commits. A failed
check fails the audit; a chain without these records prints neither line.

A loop step's commitments prove that its verdict, goal, memory, posture and replay record existed before the checkpoint
landed, and that no later edit of them can be the one the step ran under. **What none of this proves:**

- **Availability.** The chain proves the bytes it names; it cannot make a store keep them.
- **Truthfulness.** A trace is what the operator's process recorded, unaltered since; not that the world matched it, nor
  that the model said it, since no signed receipt binds the model's reply.
- **That a sandboxed step ran inside its posture** (§5), or that a decision was right (§6).
- **Wall-clock time.** Timestamps are the writer's.
- **That the two ledgers match**, or that a price was fair: the gateway's flat quote and the model's token cost are
  different prices.
- **Atomicity of the model's payment.** The model is paid on Tempo before its record is anchored, so that payment is
  committed by the record and verifiable, not atomic with it.
- **Gaps.** A compact write or a closed cell leaves no account. The audit accounts for them from transaction history; a
  seq it cannot account for ends `NOT VERIFIED (gaps not accounted for)` until `--recover` refills it.

## 11. Cost

Measured on devnet with `scripts/bench.ts` from the payer's balance, at SOL = $180, with no
priority fee.

| Write                               | Lamports | USD     | CU per transaction |
| ----------------------------------- | -------- | ------- | ------------------ |
| `log_event` (a record)              | 15 007   | $0.0027 | 171 940            |
| `log_event_compact`                 | 10 003   | $0.0018 | 52 658             |
| `log_events`, batch of 2, per event | 10 006   | $0.0018 | 185 587            |
| `register_agent`                    | 15 004   | $0.0027 | 147 832            |
| `create_struct`, `create_cell`      | 15 010   | $0.0027 | 172 070–189 211    |
| `replace_cell`, `close_cell`        | 10 006   | $0.0018 | ~69 500            |
| `commit_epoch`                      | ~10 000  | $0.0018 | —                  |

Every row fits one model to within about ten lamports: 5 000 base fee, plus 5 000 for writing the state tree, plus
5 000 per new address; none of it is rent. **A loop step** (Genesis, epoch, locator cell, Resolution, checkpoint) costs
about 70 000 lamports, $0.0126, whatever the number of calls inside it, because they are leaves of one epoch; the
session bundle's cell and a `storage.put` record add one write each at the prices above.

**Tempo**, in USDC.e base units (10⁻⁶ USDC.e), measured from the treasury:

| Item                                           | Cost                                    | Paid by            |
| ---------------------------------------------- | --------------------------------------- | ------------------ |
| one model call, `openai/gpt-4o-mini`           | 750, flat per request                   | the owner, metered |
| one model call, `deepseek/deepseek-v4.1-flash` | 750 to 1 500, flat per request          | the owner, metered |
| channel open and close                         | no gas (sponsored); the deposit returns | —                  |
| one decision                                   | 40 to 75                                | Lath               |
| one storage PUT of a ~1.5 KB report            | about 200 ($0.0002)                     | the owner, metered |
| one paid RPC read                              | 1 000 ($0.001)                          | Lath               |

A step of two calls at 1 500 is 3 000 base units, charged to the owner as `⌈3 000 × 1.10⌉ = 3 300` micro-USDC. The
per-loop key's authorize, limit resets and revoke are treasury transactions whose gas Lath pays; their cost has not been
measured, and neither has the cost of publishing a `sas.receipt`. **Irys** charges bytes from the uploader's balance at
Irys: on devnet, uploads under the free tier (every epoch blob and manifest the console writes) cost nothing and 160 KiB
cost 78 800 lamports; on mainnet, 4 KiB was quoted at 3 208 lamports.

## 12. Deployments

Solana devnet. One upgrade authority for both programs: `Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy`. The
**program-data slot** (_Last Deployed In Slot_ in `solana program show`) identifies the build a chain was written
against; quote it rather than a version.

| Program        | Program id                                     | Program-data slot | Deploy transaction | IDL account                                    |
| -------------- | ---------------------------------------------- | ----------------- | ------------------ | ---------------------------------------------- |
| `lath`         | [`AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz`](https://explorer.solana.com/address/AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz?cluster=devnet) | `509697882` | [`4MUVZ6pf…MobJgW`](https://explorer.solana.com/tx/4MUVZ6pfKMowBqaiqex6uY6Qo3HaZzqwr3Htx9692bqXrraHpmbQ8Aq499V1mK4wtYTUYNB6ojiWE2K48jMobJgW?cluster=devnet) | `4aS8ejyyf5REzDhW9aBEhw8CrZoSwHrWAr3vvUuMzgQS` |
| `lath-billing` | [`CkZfjbgWBDu4q9YVuxDVnSxnKLukaGkwZuQG7LenKDSA`](https://explorer.solana.com/address/CkZfjbgWBDu4q9YVuxDVnSxnKLukaGkwZuQG7LenKDSA?cluster=devnet) | `502707779` | [`2w9eDjNm…v6tGWcd`](https://explorer.solana.com/tx/2w9eDjNmgETAuLLJNiWK6UBLbzjfFTcwxLRxiSH9z1cAex3XaTq8ReVd4HDD1tzMjSiAcV3WYSufmQf3Rv6tGWcd?cluster=devnet) | `2PDUGFiVuFmfGwcpWVFYbR7ctevnFoewaEkcFXR6h1D7` |

`lath` is deployed from this tree's `programs/lath`; `tests/devnet.ts`, the deployment's acceptance test (below), runs
against both programs. `lath-billing` is deposit-only: no `withdraw` and no `settle` (§2.2). Upgrades go out with
`solana program deploy target/deploy/<program>.so --program-id <id> --use-rpc --max-sign-attempts 30`, never
`anchor deploy`, whose local keypairs are not the deployed programs'.

`lath-billing`'s devnet treasury: admin and sweeper `Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy`, treasury PDA
`FZiRsRdwm8U2P4GR5K3NRwwsBQ36LU54EbfqQcFQ3ra3`, vault `3szYGwbcXjpC8Z5RyQ5pKToB7qyNnPfvUge2cDTpA47o`, USDC mint
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, sweep destination `6gMB3y9s9Xu8LJ9Hgi8HSPsUqC9YUAoQe2ujiZuthCTw` (the
admin's USDC account), sweeps capped at 1 000 USDC each and 5 000 a day.

**Tempo mainnet** (chain 4217, `https://rpc.tempo.xyz`): the operator's treasury
`0x18fBE5E0A83DCA440072059F91D1a23BaBE6e0B0`, kept at or under about $10 USDC.e; USDC.e
`0x20c000000000000000000000b9537d11c60e8b50`; the TIP-1034 escrow `0x4d50500000000000000000000000000000000000`.

**The Lath-patched ZeroClaw** is built from source, never downloaded: upstream
`https://github.com/zeroclaw-labs/zeroclaw` at `dc372cc7a269241a7f7877e04b82dc9d7b4aebb8` (`zeroclaw/UPSTREAM`),
patches `0001`–`0006` (patch set `11c267ec1b55b09c6f03ecb3f3dfd74cdfa5b551ee813fa4ac8d7183c6f5bbc7`; older postures
name `b1d8206f…`, the same patches under another author line), Rust 1.98.0, `--no-default-features --features lath`.
The published builds
([`sdk/src/zeroclaw-builds.ts`](../sdk/src/zeroclaw-builds.ts)) are `aarch64-apple-darwin`
`42789b08a2c285689aaf2ef7991d9dcdb276038e50751e644cf93f748c850fe3`, under `sandbox-exec`, and `x86_64-unknown-linux-gnu`
`1d374282a9540567b3f2d0ec62bedd7a8d9d714ae63d42e5ff71cb94db5902d1`, under `bwrap`. `zeroclaw/build.sh --expect <sha256>`
clones, applies, builds and checks the hash. `bwrap` needs unprivileged user namespaces, which Ubuntu 24.04's AppArmor
default restricts; where the wrapper cannot start, the console refuses every loop.

**The RPC** must serve Solana JSON-RPC, the Photon compression index and validity proofs behind one endpoint (Helius
does); `api.devnet.solana.com` has no compression index and returns nothing for an agent. State trees are found at call
time. `LATH_DEVNET_RPC="$R" npm run test:devnet` is the deployment's acceptance test.

## 13. Invariants for contributors

- **The toolchain is pinned and load-bearing:** anchor-cli and anchor-lang 0.31.1, `light-sdk` 0.23 (0.24 needs
  anchor-lang 1.x), `@lightprotocol/stateless.js` 0.23.3, zk-compression-cli 0.28.4, solana-cli 3.1.12.
- **Account offsets are ABI**, because reads are Photon `memcmp` at fixed offsets; moving a field breaks every reader,
  including chains already on devnet. **The §4.4 formula and the event layout are frozen**, and so are the epoch, cell
  and checkpoint folds. Cells are fixed-width and `MAX_EVENTS_PER_TX = 2`. Extensions are additive.
- **Chains already on devnet must keep verifying.** A change that invalidates an existing chain's audit is a breaking
  change. New policy and manifest keys are written only when set, so older bytes re-hash as before.
- **Some literals say `lattice`**, because they are hash and key-derivation inputs, frozen: the epoch tags
  `lattice.epoch` and `lattice.epoch.leaf`, the bundle domain `lattice.preimages`, the console authority domain
  `lattice-console:`, the seed domains `lattice-seed-devnet:` and `lattice-seed-localnet:`, the Tempo treasury domain
  `lattice-tempo:v1:`, and the trace-decryption message, salt and info in `sdk/src/trace-store.ts`. Renaming one breaks
  existing audits, orphans agents' authorities, moves the treasury address or makes encrypted traces unopenable.
  `lattice.verify_chain` is read for policies that commit it; `lath.loop-receipt:` is frozen too.
- **`close_agent` is terminal.** **No new role derives from the server seed**: a new key is random and lives in a
  keystore. **Every loop step runs in the sandbox**, with no in-process fallback. **One wallet prompt per user action**:
  deploy is one transaction, a loop start is one message.
- **`sdk/src/idl` is generated.** Run `npm run sdk:sync` after `anchor build`; CI runs `npm run sdk:sync:check`.
