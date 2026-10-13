# Roadmap

This release holds agents and goal loops on Solana devnet, paid over Tempo, with the decision model, the sandbox, the
receipt on SAS and the audit ([README.md](README.md)). Everything below is on the roadmap: the features that extend a
loop, and the work planned for the next quarter.

Each rung of the roadmap gives an agent more authority under the same cap and the same record: **ask** answers a
question from pinned sources (this release), **watch** re-reads what a treasury depends on and reports what changed (a
loop on a timer does this today; gated loops, below, step only on a change), and **act** may only withdraw to the owner
when the watch finds a risk (exit-only DeFi plugins, below).

## At a glance

**Loop features**

- **Teams:** a step hands work to member agents running in parallel, each in its own sandbox.
- **Gated loops:** a loop steps only when the decision model says what it watches has changed.
- **Trace audit:** the decision model scores each step's trace for bad behaviour and can stop the loop.
- **Marketplace:** an agent publishes an on-chain offer that anyone can launch as their own copy.
- **Improve loop:** a loop reruns with a proposed instruction and keeps it only if it scores better.
- **Agent oracle and Pyth:** a Solana program asks a loop a question and proves the answer's record on chain.
- **`squads.pay`:** a loop pays from a Squads treasury within a grant and limit the team voted.
- **`sas.attest`:** a loop attests a program's upgrade authority on SAS, approved by the decision model.
- **Owner privacy:** traces encrypted to the owner, an unlock, and owner-only reads of a run's texts and report.

**Next (Q4 2026)**

- **Hosted private beta:** a console you don't run yourself.
- **Ask about a protocol:** pick a protocol and a question; Lath pins the sources and returns a cited answer with its
  cost and receipt.
- **Pi agent in the sandbox:** more agent runtimes behind the same air-gapped contract.
- **One ledger:** the Solana vault pays the model directly once MPP works on Solana.
- **More protocol plugins:** Pyth prices as committed inputs, then swaps, each a permission the owner signs.
- **Exit-only DeFi plugins:** a risk monitor that may only close or withdraw a position.
- **Decision-model router:** teams routed by the decision model, plus more OpenRouter features over MPP.
- **More rules enforced by Tempo:** each key's cap on the loop page, spend read from Tempo's logs, and a treasury
  root the console never holds.
- **Enforced ordering:** the `lath` program checks a session's record order itself.
- **Off the server seed:** random keys in a sealed keystore replace keys derived from the server seed.
- **Private by default:** owner privacy, on by default in the hosted console.
- **Private billing amounts:** charge amounts hidden through Helius Rings.

The sections below give each item's detail.

## Loop features

None of these is in this build, and no setting turns one on. The console refuses a loop start, a deploy carrying a
loop, _Run again_ or a template that asks for one of them, with a sentence naming the feature, which is on the
roadmap; it refuses a resume or a Retry that would put such a loop back on its schedule, and a Retry of a checkpoint
that carries one's keys; and it stops a running row that carries one at its next tick, before it spends anything. A
start's signature binds its terms, so they are refused rather than dropped. `lath-audit` answers `verify-plugins`,
`verify-improve`, `verify-feed` and `verify-request` with `<command> is not in this build: the feature it audits is on
the roadmap` (exit 3), and `verify-step` ends `NOT VERIFIED (roadmap feature)` (exit 2) for a step whose manifest
carries one of their keys.

- **Teams (multi-agent loops).** A loop step hands work to member agents, which run in parallel, each in its own
  sandbox, and the step's manifest commits every member's seq, head and outcome, so one checkpoint covers the whole
  step's work.
- **Gated loops.** A loop that steps only when a second model says that what it watches has changed enough to need
  a step, so a watcher pays only when something happens.
- **The trace audit.** The decision model scores each step's trace for preset behaviours, and a stop that the loop's
  own model confirms ends the loop, so a loop that misbehaves is stopped by a model other than the agent.
- **The marketplace and launchable blueprints.** An agent publishes an on-chain offer that commits the config a copy
  runs, and anyone launches their own copy in one transaction, knowing from the chain what that copy will run.
- **The Improve loop.** A read-only goal loop is run again with a proposed instruction under the same goal, budget
  and policy, and the new instruction is kept only if it does better by a fixed rule.
- **The agent oracle, and Pyth as a watch source.** A Solana program asks a loop a question through an oracle
  program's `Request`, or reads its `Feed`, and proves the answer's record against the Light state root, so a program
  can act on an agent's answer without trusting the operator; a gated loop can watch Pyth prices.
- **`squads.pay`.** A loop pays from a team's Squads treasury, within a grant the owner signs and a spending limit the
  team votes, and the decision model approves or holds each payment after a rule check.
- **`sas.attest`.** A loop publishes an attestation on SAS of a program's upgrade authority, checked against the
  chain and approved by the decision model, carrying what the reasoning behind it cost on Tempo.
- **Owner privacy.** Trace blobs encrypted to the agent's owner (AES-256-GCM, `LTE2`, under a per-agent trace key);
  the owner's one-signature unlock in the console; owner-only reads, behind a read token, of a loop's standing
  instruction and typed sources, the sandbox's sources manifest and replay record, and the stored report; and the
  owner-only half of each lifecycle record (the prompt and the signed start body under the trace key). This build
  writes every run in the clear, so every run reads in full without signing. Its read side is in this build: chains
  written encrypted audit with `lath-audit --trace-key`, and the SDK opens `LTE1` and `LTE2` blobs
  ([SECURITY.md §3](SECURITY.md#3-traces-in-the-clear-and-chains-written-encrypted)).

## Next (Q4 2026)

- **A hosted private beta.** Planned, not open. Today the console runs on the operator's machine.
- **Ask about a protocol.** One question instead of the loop form, from question presets: each holds a question, the
  bar the decision model holds the answer to, and the sources it needs. The first two are _before I approve a multisig
  transaction_ and _before I deposit_, and presets that need a loop come first: ones that cover every instruction that
  moves funds, follow who controls a program through its multisig, or compare what the code allows with what is
  deployed. A reviewed entry for each protocol fills the sources: its repository path, its program ids and the
  accounts worth decoding. The sources, the cost and the receipt stay one click away. Then decoders for accounts without an on-chain IDL, token mints first (who can mint, who can
  freeze), and a source that pins a program's transactions over a range of slots, so usage questions have data to
  cite.
- **The Pi agent inside the sandbox.** More than one agent runtime behind the same sandbox contract, Pi among them,
  each passing the air-gap probe, and each sandbox posture stating who vouches for it.
- **One ledger: the vault pays the model on Solana.** With MPP on Solana, the `charge` that debits the user would pay
  the model gateway in the same transaction, and the operator's treasury and the hand-moved USDC would go. Blocked
  outside Lath: OpenRouter's MPP gateway offers only the Tempo method today.
- **More protocol plugins**, each a permission the owner signs: Pyth prices as a committed input, swaps on devnet
  first, lending, and an envelope program that holds funds and checks each instruction against the grant.
- **Exit-only DeFi plugins.** A risk monitor: a model reads signals a rule cannot (incidents, parameter changes,
  post-mortems) and may only close a position or withdraw it to the owner, with a public record of each decision
  and its cost. Designed, not built.
- **Teams with a decision-model router**, then more of OpenRouter over MPP, each field probed through the gateway
  first: fallback models with price and latency settings, typed plans, prompt caching, and zero-data-retention
  routing.
- **More rules enforced by Tempo.** The loop page states each loop key's Tempo-enforced cap on its own line, not
  only behind the key's link; the audit reads each loop key's spend from Tempo's own logs; the key's authorization
  names the Solana loop; receive policies on the treasury; and a treasury root the console never holds, such as a
  multisig or passkey.
- **From attested to enforced.** The `lath` program checks a session's ordering itself (a Genesis before any
  Action, one Resolution per session, a checkpoint that names its predecessor), and a loop's charge rides in the
  same transaction as its epoch. A program change.
- **Off the server seed.** New agents get random signing and trace keys in a sealed keystore, older agents move by
  rotating their authority, and the seed is retired.
- **Private by default.** Owner privacy (above), on by default in a hosted console once keys are off the server seed
  (above), with an unlock that shows the owner their run without exposing the key and one owner-only read path for a
  run's report and instruction. [SECURITY.md §3](SECURITY.md#3-traces-in-the-clear-and-chains-written-encrypted)
  covers the chains already written encrypted.
- **Private billing amounts**, through Helius Rings, after the move to Anchor 1.x and `light-sdk` 0.24.

## Not planned

- A hardware-attested (TEE) trust tier for the sandbox.
- User-held Tempo wallets or user-opened Tempo channels: the user's side stays a Solana wallet and an allowance.
- Hiring or a labour market. The marketplace (above) sells launchable blueprints.
