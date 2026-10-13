# Security

Lath records what an autonomous agent does as a hash chain of Light Protocol ZK-compressed accounts on Solana, debits
the agent's owner in USDC against a capped on-chain allowance, and pays for each model call on Tempo over MPP from the
operator's treasury. This file is the security policy, the trust model and the list of what is known not to hold.
[SPEC.md](SPEC.md) is the normative data model; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the system as built.
This is a hackathon release: it runs against Solana devnet (model payments are on Tempo mainnet), no console is
hosted, and the code has had internal reviews but no third-party audit.

## Reporting a vulnerability

Report privately to lath.solana@gmail.com. Please do not open a public issue, pull request or discussion for a
vulnerability. Include the commit, the component, the steps to reproduce and what an attacker gains; a finding that
needs devnet state can name the agent id or the transaction signature.

| Version                                                                 | Supported |
| ----------------------------------------------------------------------- | --------- |
| `main`, against the current devnet deployment (docs/ARCHITECTURE.md §12) | Yes       |

**In scope:** the programs (`programs/lath` and `programs/lath-billing`); the SDK's verifier (`sdk/src/audit`, the
`lath-audit` CLI, the browser verifier); the runtime (`runtime/src`, with the ZeroClaw host and the Lath patches in
`zeroclaw/patches`); the console (`frontend/`, its API routes and middleware). **Out of scope:** third-party services
(the Helius RPC and Photon indexer, Light Protocol's programs and prover, Irys, Tempo and its MPP gateways, the Solana
Attestation Service), upstream ZeroClaw outside the Lath patches, devnet tokens, and the features on the roadmap
(ROADMAP.md), which this build does not contain; the console's and the audit's refusals of them are in scope.

## 1. Trust model

The chain proves which key wrote which record, in what order, committing to which bytes. It does not prove that a
record is true, that its bytes are still available, or who held the key.

| Party                                | Trusted for                                                    | Not trusted for                                                 |
| ------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------- |
| Solana and Light Protocol            | ordering, authorship by the authority key, the SHA-256 digests | anything else; they never see the trace bytes                   |
| The blob store (Irys, a directory)   | availability                                                   | correctness: every reader re-hashes what it is served           |
| The operator                         | running the console and holding its keys, choosing the store   | the `sha256 → locator` map, which is on chain, first write wins |
| The console's pages                  | rendering                                                      | anything: each claim on screen comes with the link to check it  |
| Tempo                                | that a channel's close paid out, and to whom                   | that a price was fair, or that the two ledgers match            |
| The decision model (Jev in the code) | a second model's judgment of each loop step, committed by hash | correctness: its answer is a model's answer, not a proof        |

**What the chain proves.** Each record is a compressed account at `["event", agent_id, seq]`, and every write folds
into `AgentState.head` by the SPEC §4.4 formula, so changing a committed field changes every later head. A record's
`payload_hash` commits to its preimage and the preimage to its blobs (prompt, tool arguments, model answer) by
SHA-256; a blob that does not re-hash is reported unavailable, never shown as the trace. Each paid model call's voucher
sits inside the blob the Action's `result_hash` commits, and the audit holds a loop's vouchers to its channel's close
receipt on Tempo. What the audit cannot check is NOT VERIFIED (exit 4), a different answer from a chain that is wrong.

**What it does not prove.** That the content is true: an agent that lied to its log lied on chain. That the agent
meant what its key signed: for a console-deployed agent the authority is a key the console holds (§2). That the bytes
are still there: devnet Irys deletes uploads after about 60 days, and the console's `/api/traces` answers only while
it runs. Wall-clock time: `timestamp` is the writer's, at most five minutes ahead of the cluster, and may be backdated.
That the Solana debit and the Tempo payment match: no USDC route joins the two ledgers (§6).

**A `sas.receipt` is an index, not a proof.** When the decision model judges a loop's goal achieved and the loop stops
on it, the console publishes one Solana Attestation Service account, signed by its runtime key, naming the agent, the
loop, the last step's seq and head, the step count and the goal's hash. `lath-audit verify-receipt` checks those
against the chain; the receipt's USDC and Tempo figures are the console's report, printed without being re-derived.

**What the programs enforce.** Every mutating `lath` instruction takes the agent's state as instruction data, the
Light system program checks its hash against the state tree, and the state's authority must sign. The one exception is
`create_cell` into a structure whose append policy is `ANYONE` (§8); `replace_cell`, `close_cell` and
`set_append_policy` stay the owner's under every policy. Whoever registers a name first owns `agent_id = sha256(name)`,
and `close_agent` is terminal. In `lath-billing`, allowances are PDAs bound to their user, `approve_agent` is the
user's signature, and `charge` is signed by the agent authority and checks the expiry, the balance and
`spent + reserved + amount ≤ cap`. The vault is a keyless PDA and deposit-only: USDC leaves it only by `sweep` of
metered spend, under per-call and per-day caps, to a pinned destination.

## 2. Key custody

Only the key that signed `register_agent` may append to an agent's chain, and every write needs a fresh validity proof
over the state the previous write left, so writes cannot be pre-signed: a wallet-owned agent would need a wallet prompt
per record, and a loop could not run unattended. So the console registers each agent it deploys with a key it
derives, and the owner's wallet signs one transaction, the allowance that pays for it. Authority and ownership are
different keys: the owner is on chain in its `Allowance` and in the agent's `agent.deploy` record, which names the
deploy transaction the wallet signed (SPEC §3.1); owner-gated routes read the owner from `agents.json`, which a
console rebuilds from those records.

| Key                                                         | Where it lives                                                                                                                                                                                                                                                  | What it can do                                                                                                                                                                                                                                                                                                                | What it cannot do                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime keypair                                             | `LATH_RUNTIME_KEYPAIR`, a path or an inline JSON array; default `frontend/.runtime-keypair.json`, mode 0600, git-ignored                                                                                                                                        | pay every fee the server pays and top each derived key up with 0.01 SOL; act as the console's own agent; upload to Irys; sign `sas.receipt` attestations (the `lath-demo` issuer authorized it); seed every derived key                                                                                                       | widen an allowance, take escrow beyond the approved caps, rewrite a written record, or act on Tempo                                                                                                                                                                                                          |
| Derived keys                                                | nowhere: `Keypair.fromSeed(sha256("lattice-console:<role>:" ‖ seed))`, rebuilt on demand. Roles: `owner:<name>` (every console-deployed agent), the console's `coordinator`, `sentinel` and `verifier` roles and their per-agent forms, `trace-key:<name>` (§3) | append to that agent's chain; charge allowances approved to that authority, up to each cap; `set_authority`, `set_append_policy`, `close_agent` (which burns the id)                                                                                                                                                          | touch another agent's chain or widen a cap. No new role derives from the seed: every other key is random                                                                                                                                                                                                     |
| Tempo treasury                                              | `LATH_TEMPO_TREASURY`, a secp256k1 key in a file or the variable; mainnet, held at or under $10 USDC.e by operating rule                                                                                                                                        | pay every channel; sign the vouchers of sessions and of loops without an access key; authorize, reset and revoke loop access keys                                                                                                                                                                                             | act on Solana: it holds no Solana authority                                                                                                                                                                                                                                                                  |
| Loop access key (`LATH_TEMPO_LOOP_KEYS` on; off by default) | random, one per loop, `<LATH_TEMPO_KEY_DIR>/<loopId>.json` (default `~/.lath/tempo-keys`), mode 0600, never under `LATH_TRACE_DIR`, never in a row or a log                                                                                                     | sign the loop's channel opens, top-ups, vouchers and close, the treasury paying, up to its USDC.e limit (the loop's budget plus Lath's decision share), until revoked at the stop or 30 days after it was authorized; scoped by default to the escrow's `open` and `topUp` and USDC.e `transferWithMemo` to the storage payee | raise its own limit or, scoped, make another call (`CallNotAllowed`). A scope cannot bind an escrow `open`'s payee, so a leaked key can open a channel to a payee of its choosing, up to its remaining limit. Unscoped (`LATH_TEMPO_KEY_SCOPES=off`, as in the demo), only the limit and the expiry bound it |
| Sandbox session tokens                                      | two per loop-step session, minted fresh, one per socket, removed with the step's directory                                                                                                                                                                      | spend that session's remaining budget on model calls through the metering proxy; call the host tools its policy allows                                                                                                                                                                                                        | reach anything outside that session; the sandbox holds none of the keys above                                                                                                                                                                                                                                |
| Treasury admin, sweeper, upgrade authority                  | one devnet key held by the operator                                                                                                                                                                                                                             | `sweep` metered spend to the pinned destination; repoint it and the sweeper (`set_sweeper`); upgrade both programs                                                                                                                                                                                                             | move unspent escrow: the vault is deposit-only                                                                                                                                                                                                                                                               |
| User wallets                                                | the user's wallet; never sent to a server                                                                                                                                                                                                                       | deposit, `approve_agent`, `revoke_agent`, `release`; sign the console's sign-in messages                                                                                                                                                                                                                                      | write to a console-deployed agent's chain                                                                                                                                                                                                                                                                    |
| E2E test wallet                                             | `NEXT_PUBLIC_E2E_WALLET_SECRET` from git-ignored `frontend/.env.devnet.e2e`, loaded only by `dev:devnet --e2e`; devnet funds only                                                                                                                               | sign as the test wallet in the Playwright suite and the demo recording; its secret is inlined into the JavaScript that console serves                                                                                                                                                                                         | load in a production build or off devnet                                                                                                                                                                                                                                                                     |
| CI `DEVNET_WALLET`                                          | a repository secret, read only by the scheduled or manual devnet job, removed when it ends                                                                                                                                                                      | pay devnet fees and fund Irys for that job                                                                                                                                                                                                                                                                                    | reach other jobs; forks' pull requests get no secrets                                                                                                                                                                                                                                                        |

The RPC provider key sits in `LATH_RPC_URL` and never leaves the server. This build makes no per-loop Solana key, and
refuses every start that carries protocol-plugin grants. The loop receipt is signed by the runtime keypair, not by a
loop key.

- **Server compromise** is total for every console-deployed agent, past and future: append arbitrary records, charge
  every live allowance up to its cap, `set_authority` silently, `close_agent` and burn every id, rewrite the owners in
  `agents.json`, spend the Tempo treasury. It cannot widen an allowance or take unspent escrow.
- **The operator** can do the same without breaking in, indistinguishably from normal operation, and sees every prompt
  and answer because it runs the inference. Nothing in this release removes that trust.
- **A compromised RPC or indexer** gets no key, and an escrow it will not report counts as empty. Two places trust it:
  a deploy's confirmation (`deployTxSignedBy` asks it whether the prepared transaction landed and who signed it), and
  `lath-audit`, which takes the record list and the head from the indexer (§8).
- **A compromised user wallet** reaches that user's escrow and allowances only; a sign-in signature cannot be replayed
  for another action, site, body or time window (§5).
- **Key loss.** Without the runtime keypair every console chain is frozen for good, though still readable. Without
  `agents.json` or `loops.json` a console rebuilds its agents and loops, read-only, from their `agent.deploy` and
  `loop.*` records: keys re-derive from names, and owners, goals and terms are on chain. A standing prompt this build
  wrote is on chain only as its hash, so a rebuilt row carries it only when it is the goal's text (the same hash). An
  agent deployed with `LATH_LIFECYCLE=off` has no `agent.deploy`, and its owner is lost with the file.

**Rotation.** `LathClient.setAuthority`, signed by the current authority, hands an agent to another key, the owner's
own wallet included. It has no console surface, it orphans the `Allowance` (keyed by the authority) until the owner
approves the new key, and only transaction logs record it. After a leaked server key, rotate every agent worth keeping,
publish the compromise slot and ask users to revoke; records the leaked key wrote cannot be told from honest ones.

## 3. Traces in the clear, and chains written encrypted

This build writes every trace in the clear: each blob the console writes (a session's, a loop step's, a Tempo storage
report, a lifecycle document) is the plaintext that re-hashes to the SHA-256 the chain commits, so anyone with the
locator reads and verifies it. Encrypting traces to the owner is a [ROADMAP.md](ROADMAP.md) item. What that means
here:

- **No unlock and no read token.** No console route hands out a trace key, and there is no owner-only read: every GET
  (`/api/loops`, `/api/zeroclaw/<id>`, `/api/templates`) answers in full to every reader, the standing instruction,
  the goal, typed sources, the sandbox's manifest and replay record and template texts included. `promptHash` and
  `goalHash` are unsalted SHA-256 on chain, which hides nothing here, since the texts are public.
- **The host's paths are withheld from every reader.** This is host hardening, not privacy: `/api/zeroclaw/<id>` never
  serves a step's derived `config.toml` or wrapper profile (the Seatbelt profile or the `bwrap` arguments), which name
  the ZeroClaw binary's absolute path, the step's work and config directories, both sockets and, on Linux, the
  libraries `ldd` found; nothing commits them, and the posture JSON the chain commits by hash is all a re-hash needs.
  Both `/api/zeroclaw` routes describe the configured binary by its hash, not its location.
- **Reports are public.** `GET /api/loops/<id>/report` answers this console's own copy of the report blob when it has
  one, otherwise it reads the object from Tempo storage with the treasury's charge client (about $0.0001 a read,
  rate-limited per caller IP). A report stored encrypted (`LTE2`) is refused rather than decrypted: the console opens
  no encrypted object.
- **Lifecycle documents** (SPEC §3.1) are public by design, so anyone can rebuild a console's lists: the owner's wallet,
  the goal, the loop's terms, each transition's reason, and the owner's signed messages (domain, nonce, issue time and,
  for a start, the body's hash). This build does not write the owner-only half (the standing prompt and the signed
  start body under the trace key); a record that names one in `privateHash` reads as any other.
- **Not covered:** the operator, who runs the inference and sees every prompt and answer either way.

**Chains written encrypted** still audit, because devnet carries them. The read side:

- **One key per agent,** `derived(server, "trace-key:<name>")` cut to its 32-byte seed, so only the operator holding
  the console's server keypair can re-derive it; no route hands it out, and the browser decrypts nothing. A step or
  record written encrypted shows no private badge and no unlock on the page: its content is simply not shown.
- **Format:** `"LTE2" ‖ plaintext_hash(32) ‖ nonce(12) ‖ ciphertext ‖ tag(16)`, AES-256-GCM, a fresh nonce per write,
  the plaintext hash as additional data so a ciphertext cannot be re-filed under another hash; older `LTE1` blobs are
  still read. Blobs are named by the plaintext's hash, so an encrypting store never replaced a blob its key did not
  open: a later writer of the same bytes used `<hash>.<32 hex>`, the first 16 bytes of
  `sha256("lath.trace-variant.v1" ‖ key ‖ hash)`, and every keyed read tries both names.
- **Off the console:** `lath-audit --trace-key <hex|path>` opens and verifies the blobs. Without it, a preimage counts
  as _encrypted_ only if its LTE2 header names its own hash and its size is exactly `4 + 32 + 12 + L + 16` bytes
  (L = 129, 99, 129, 70 for Genesis, Action, Delegation, Resolution), and `--require-preimages` ends `NOT VERIFIED`.
  The header is a claim; only the key proves bytes.
- **Public whatever was encrypted:** each record's kind, status, timestamp, seq and `reference` (a tool id's hash,
  which a dictionary reverses), the authority, cell tags and counts, write cadence, and epoch blobs (`LEP1`), which are
  fold inputs.

## 4. The loop sandbox

Every loop step runs in the Lath-patched ZeroClaw (upstream `dc372cc` plus `zeroclaw/patches/0001`–`0006`, built with
`--features lath` by `zeroclaw/build.sh`), one process per session. There is no in-process fallback: a console without
a working binary and wrapper refuses to start a loop. Sessions outside a loop run in the console's process, and the
sandbox does not narrow the operator, who assembles each step's prompt, signs every record and holds the treasury.

- **Wrapper:** `sandbox-exec` with a deny-default profile on macOS, `bwrap --unshare-all --clearenv` on Linux. The
  process sees its binary, the loader's libraries, its loop's workspace and its step's directory; not the keypair, the
  trace directory or the key directories. Its environment is explicit, so no `LATH_*` secret reaches it.
- **Network:** none but two Unix sockets in the step's directory, the metering model proxy and the host-tool listener,
  each taking only its own session token.
- **Tools:** `file_read`, `file_write` and six host tools (`store.get`, `store.set`, `solana.slot`, `solana.fees`,
  `solana.balance`, `lath.verify_chain`). Shell, web, MCP, skills and every other upstream tool are compiled out or
  refused at startup. The binary's SHA-256 and patch set are committed under each step's policy hash, and a spawn
  whose binary changed since it was hashed is refused.
- **The host writes every record.** A call to a name nobody declared is recorded as `unknown:<name>`, so neither the
  model nor the sandbox can make the host write a reserved id such as `loop.step` or `storage.put`.

## 5. The console surface

No console is hosted; it runs on the operator's machine, and `npm run dev:devnet` binds 127.0.0.1 unless `--lan`. With
`--e2e` (the Playwright suite and the demo recording) the JavaScript it serves carries the E2E wallet's devnet secret,
readable by anyone who can reach the port; that mode is never exposed past the local network. Writes go through
`/api/run`, `/api/agents[/<id>]`, `/api/loops`, `/api/templates` and `/api/store/<id>`; `/api/rpc` relays RPC calls;
the rest only read.

- **A wallet is believed only when it signs.** Messages are Sign-In-With-Solana shaped, with purpose, action and
  target on the statement line. `verifyAuth` rebuilds the text byte for byte and checks the domain and URI against
  `LATH_CONSOLE_ORIGIN` (the request's `Host` when unset, right only on localhost), the cluster, a five-minute window
  with 30 s of skew, issuance after the process started, and a single-use nonce; a loop start binds its body's hash.
- **A signature is not a payment.** Real inference is paid only for a signing wallet with a live allowance to the
  agent's authority whose headroom (`cap − spent − reserved`) and escrow each cover the largest first charge. An
  unsigned request to one of the console's own agents runs scripted and unbilled; a deployed agent answers its owner.
- **Cross-site writes:** `frontend/src/middleware.ts` refuses writes to `/api/*` marked `Sec-Fetch-Site: cross-site`,
  carrying a foreign `Origin`, or `same-site` without one; a script that sends no `Origin` meets the routes' own limits.
  Every response carries `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff` and a strict referrer policy.
- **Sizes:** write bodies are read through a counted reader capped at 256 KiB (16 KiB for a store write) before
  parsing; a prompt is at most 2,000 characters, a session's history eight turns of 2,000.
- **Rate buckets:** six sessions an hour per wallet, or per address when anonymous; 120 pre-decision chain reads an
  hour per address and 1,200 per server; 60 unbilled sessions an hour per server; 200 prepared transactions an hour per
  server and 40 per address, all asked before any is stamped; three running loops per wallet; 1,200 RPC units a
  minute per address. Addresses come from `X-Forwarded-For` only with `LATH_TRUST_PROXY=1`; otherwise every caller is
  `local`, one bucket of `LATH_LOCAL_CALLERS` (10) callers' worth. Nonces, buckets and the single run slot live in
  process memory, so the console must run as one process.
- **The RPC proxy** keeps the provider key on the server: POST only, an allowlist of the app's methods, batches of at
  most 100 (none on Photon), a 64 KiB request, a 30 s deadline, an 8 MiB answer, `getProgramAccounts` only on the
  billing program and only filtered, and no upstream headers or error bodies passed back.
- **Tools:** every call is held to the tool's declared schema (a plain JSON object, declared types, required keys,
  strings up to 16 Ki characters, depth up to 32), or refused with a 400 Action. The web tools refuse special-purpose
  IPv4 and IPv6 ranges, connect to the address they checked, re-check redirects, parse at most 512 KiB in linear time
  and end at 20 s; any other tool read ends at two minutes.
- **Blobs:** `/api/traces/<id>` serves bytes by name and is trusted for nothing, since the browser re-hashes every
  blob; it cannot reach `agents.json`, `loops.json`, `pending/` or `unsealed/`.
- **Closed-beta gate:** with `LATH_BETA_WALLETS` or `LATH_BETA_FILE` set, only a listed wallet may take an action the
  treasury or the server's SOL pays for, refused before anything is signed; reads and an owner's stop, pause, archive
  and discard stay open, and a named file that cannot be read refuses everyone. Unset, as under `dev:devnet`, it is off.
- **Roadmap features:** a loop start, a deploy carrying a loop, _Run again_ or a template write that asks for a team,
  a gate, a request or feed trigger, the trace audit or protocol-plugin grants is refused with a sentence naming the
  feature, which is on the roadmap, and no setting allows one; a paused loop that runs one is not resumed, a _Retry_
  lands what a stopped one owed without putting it back on its schedule, unless the checkpoint it owes carries one of
  their keys, which is refused before anything is drained, and a running row that carries one is stopped at its next
  tick before anything is funded. A start's signature binds its terms, so they are refused rather than dropped.

## 6. Spend limits

| Layer                  | Enforced by                           | What it bounds                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The allowance          | `lath-billing`, on Solana             | the owner's debit: a `charge` past the cap, past the expiry or beyond the spendable escrow fails in the program; a short allowance makes a step run scripted and unbilled                                                            |
| The loop budget        | the console and `LoopRunner`          | one budget per loop, at most `LATH_LOOP_BUDGET_MAX_USDC` (25 USDC), checked after each call, so the call that crosses it is paid; a step runs billed only when the allowance covers an estimate of it; a spent budget stops the loop |
| The access key's limit | Tempo, with `LATH_TEMPO_LOOP_KEYS` on | a deposit or top-up past the loop's budget plus Lath's decision share is refused (`SpendingLimitExceeded`), whatever the console does                                                                                                |

- A session outside a loop is capped at `LATH_SESSION_CAP_USDC` (0.25 USDC) and `LATH_MAX_STEPS` (six turns).
- Lath, not the owner, pays the decision model, at most `LATH_JEV_BUDGET_PERCENT` (15 %) of the loop's budget, fixed
  at the start; once spent, the goal check is recorded unavailable and the loop goes on. A loop's channel deposit is its
  remaining budget plus that share; the treasury is held at or under $10 USDC.e. The owner pays the metered cost plus
  `LATH_MARGIN` (0.10); in a loop, a chat attempt that got no answer is Lath's.
- **The two ledgers do not settle against each other.** The allowance caps the Solana side and the access key, when
  there is one, the Tempo side, bounding one loop's channels but not the treasury, whose own key can sign anything. The
  operator moves USDC from the vault's sweepable balance to the treasury by hand; `/billing` shows both balances.
- **Where the debit rides.** A record written on its own (a model call in a session without epochs, a `storage.put`)
  carries its charge in the same transaction. With epochs, which every console session and every loop step uses on
  devnet, each model call's charge is its own transaction, journaled ahead of the epoch it pays for.

## 7. Reviews

Every review was internal, run with AI review agents; none is a third-party audit. They covered the programs, custody
and spend authorization, the loop path, the API layer, the verifier, the browser, the payment path and the sandbox;
one pass handed each high or medium finding to a second reviewer to refute. The findings still open are in §8.

- **Secret scan:** gitleaks 8.30.1 over this tree flags only lines in `tests/`: test vectors, public addresses and
  placeholders. No key file is committed.
- **CI** runs with a read-only token and actions pinned by commit; secrets reach only the devnet job, by environment.

## 8. Known limits

**Deployment**

- `lath` is deployed at `AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz` (program-data slot `509697882`) from this
  tree's `programs/lath`, and `lath-billing`'s deploy at slot `502707779` matches its source. One devnet key is the
  upgrade authority of both, the treasury admin and the sweeper.
- **Open mailboxes.** A structure whose append policy is `ANYONE` (the SDK's `Mailbox` unless it is given senders)
  lets any funded key append a cell, which advances the owner's `seq` and head, breaks writes in flight and, repeated,
  stalls the owner's writes; the cells carry no signer and read as the owner's history. Griefing, not forgery. The
  runtime creates its `runtime-inbox` owner-only, and `set_append_policy` lets an owner rewrite an open header to
  `OwnerOnly` in place.
- **Few negative cases run against a deployed program:** devnet runs an over-cap charge and a flipped epoch-blob byte;
  expired or revoked grants, holds, sweep caps, rotation and the program's own signer check run nowhere on chain.
- Anyone can register a name first and burn it with `close_agent`.

**Money**

- **A `charge` is not bound to a record.** The program does not check that a `charge` shares a transaction with a `lath`
  write, and in epoch mode it never does, so an agent authority's holder can charge up to the cap with no record.
  `verify-channel --refetch` holds a debit to its voucher only where the two share a transaction; an epoch-batched
  call's charge is a transaction no record names, so no check ties it to its voucher, and the receipt's `usdcCharged` is
  the console's report.
- **A refused charge that rides in its record's transaction still halts that chain's queue,** as any failed write
  does (an owner's own chain, or a deployment without epochs). A refused standalone charge is parked against its payer
  and halts nothing, but **parked debt has no operator panel**: a log line, `anchorSummary.parked`, the journal.
- A crash between a charge landing and the journal's update can send that charge again, a bounded loss the queue
  accepts. Holds can drift between two grants of one user after a user-signed `release` (the runtime places none).
- **The payee.** Without `--payee`, the audit fails a close paid back to its own payer and `verify-channel` holds each
  close to the first one's payee, but neither proves that payee is the model gateway; the console's command omits it.
- **Loop access keys.** The console's limit resets are not yet audited (`limit reconciles: unchecked`). A key file
  left by a crash between the key's authorization and the loop's row stays live until the operator revokes it by hand,
  bounded by its limit and 30-day expiry; a run stopped on a failed write keeps its key so that _Retry_ can pay.

**Verification**

- **Checkpoints are found by reference.** The audit counts any Action whose reference is `loop.step` as a checkpoint
  without checking its status or leaf. The host never records a model or tool call under that id (§4), but the
  authority key can write one, which then fails `--require-preimages`.
- **The indexer.** `lath-audit` takes the record list and the head from Photon. A withheld record shows as a gap
  (exit 4), and `--recover` refills what transaction history still holds; compact records live only in that history.
  Rotation history is in transaction logs only; the audit reports the current authority.
- **Lifecycle records are the console's to write.** The agent's key signs them, so a console that does not write a
  `loop.stop` leaves the chain saying _running_; only the owner's signed messages inside them are the owner's word. A
  console that rebuilt a loop from the chain keeps it read-only, and a rebuilt row still _running_ holds that agent's
  run slot on this console until a stop is recorded. A console run with `LATH_LIFECYCLE=off` writes none.
- **The goal check's outage rule.** When the decision model does not answer, answers outside `continue` and
  `achieved`, or its share is spent, the agent's own `GOAL REACHED` claim decides whether the loop stops, and the row
  says the check was unavailable. A `sas.receipt` is published only on the decision model's `achieved`.

**Sandbox**

- **Workspace bootstrap files.** ZeroClaw loads `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`,
  `BOOTSTRAP.md` and `MEMORY.md` from the workspace root into its system prompt every turn, and a step can write them,
  so text a step was steered into writing shapes every later step of its loop. The workspace tree is committed to the
  replay record, so this stays auditable, but nothing on screen flags it.
- `sandbox-exec` is deprecated by Apple, and Ubuntu 24.04 restricts the user namespaces `bwrap` needs (the console
  then refuses loops). The release's binary is the macOS build; Linux under `bwrap` has run in CI and a container, not
  on a deployed host. The patches have not been re-read line by line against upstream, and the console runs
  `<binary> --version` outside the sandbox when it resolves the binary.

**Console**

- **Server-wide buckets** are a lever a handful of addresses can pull for an hour: five addresses empty the hour's
  prepared transactions, and unproxied every caller shares `local`. `LATH_TRUST_PROXY=1` is safe only behind an edge
  that sets `X-Forwarded-For` itself. One process and one run slot serialise every session and loop step. There is no
  `script-src` policy, and `/billing` shows every billing event in a transaction that touched a wallet as its own.

Limits that concern only roadmap features are not listed here ([ROADMAP.md](ROADMAP.md) lists those features).
