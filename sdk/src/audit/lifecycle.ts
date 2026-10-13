/**
 * The lifecycle audit: an agent's deploy and its loops' starts, pauses, resumes and stops
 * (`../lifecycle.ts`), held to the owner's word they carry.
 *
 * A lifecycle record is signed by the agent's key, which the console holds, so the record alone
 * says only that the console wrote it. What says the owner asked for it is in the document: the
 * `"Lath loop"` message a start or an owner's transition was posted with and the wallet's Ed25519
 * signature over it, or the deploy transaction the wallet signed. Those are what this checks:
 *
 * - **start.** The signature verifies over the exact message bytes for the message's wallet; the
 *   statement is `Lath loop: start <agent id | template id>`; the wallet is the start's `owner`;
 *   the `Request ID` is the start's `startBodyHash`, so the signature binds the terms and not only
 *   the agent. A start carried by its agent's deploy (`deployTx`) is held to that transaction
 *   instead. A start carrying neither is reported as not checked, never as verified.
 * - **transitions.** A pause, resume or stop `by: "owner"` carries an `auth` that verifies, whose
 *   statement is `Lath loop: <verb> <loop id>` — or, for a stop the agent's archive drove, the
 *   archive's own `Lath agent: archive <agent id>` — signed by the loop's owner. A transition the
 *   console made on its own (a budget, a goal, a failure) carries no wallet's word and needs none.
 *   An archive or unarchive mark `by: "owner"` is held to the same rule, against the deploy's owner.
 * - **order.** No transition before its start, no pause of a loop that is not running (the fold's
 *   `outOfOrder`), and no `loop.step` after a stop in the stopped loop's span unless a resume of
 *   that loop comes first. Steps another loop's window covers are that loop's and are not counted.
 * - **deploy.** With a transaction reader, the deploy transaction landed without error, the owner
 *   signed it, and it carries a `register_agent` for this agent id signed by the chain's authority.
 *   The agent's `AgentState` is a compressed account, so its address is in the instruction data
 *   and not among the account keys; `register_agent`'s `agent_id` at its fixed offset is what ties
 *   the transaction to this chain. Without a reader it is reported unchecked.
 * - **private documents.** With a store that holds the trace key, each `privateHash` opens and
 *   re-hashes; a start's prompt hashes to its `promptHash` and its start body to `startBodyHash`.
 *   Without the key they are reported unchecked: the owner withheld them, which is not a failure.
 *
 * A start this reader cannot open is counted (`unkeyedStarts`), never failed — its owner's word is
 * in a document this store does not hold, which is the store's gap and not the chain's. A chain with
 * no lifecycle records at all — an older chain among them — is `none`, and the audit says nothing
 * about it, so its report carries no lifecycle lines.
 *
 * Browser-safe: the signature check is WebCrypto's Ed25519 (`crypto.subtle`, in Node 20 and every
 * current browser), the transaction reader is an interface (`SolanaTxReader`; the CLI's holds the
 * `Connection`), and nothing here imports a Node built-in.
 */
import { PublicKey } from "@solana/web3.js";
import type { LathClient } from "../client";
import { hex, sha256, toBytes32, utf8 } from "../hash";
import {
  AGENT_ARCHIVE_TOOL,
  AGENT_UNARCHIVE_TOOL,
  type AgentOnChain,
  type LifecycleEntry,
  LOOP_PAUSE_TOOL,
  LOOP_RESUME_TOOL,
  LOOP_STOP_TOOL,
  type LoopOnChain,
  parseAgentPrivateDoc,
  parseLoopPrivateDoc,
  parseLoopTransitionDoc,
  parseSignedMessage,
  foldAgent,
  foldLoops,
  readLifecycle,
  unkeyedStarts,
  type SignedMessage,
} from "../lifecycle";
import { LOOP_STEP_TOOL } from "../loops";
import { loopStartBodyHash } from "../signer";
import type { TraceStore } from "../trace-store";
import type { PluginCheckStatus, SolanaTxReader } from "./solana";

/** One named check and what it found. `ok` is false only for `failed`: an unchecked item is not a failure. */
export interface LifecycleCheck {
  name: string;
  status: PluginCheckStatus;
  ok: boolean;
  detail: string;
  /** The record the check is about, when it is about one. */
  seq?: string;
}

export type LifecycleVerdict = "none" | "verified" | "failed";

export interface LifecycleVerification {
  verdict: LifecycleVerdict;
  agent: AgentOnChain;
  loops: LoopOnChain[];
  /** Starts whose document this reader could not open. */
  unkeyedStarts: number;
  entries: LifecycleEntry[];
  checks: LifecycleCheck[];
}

export interface VerifyLifecycleOptions {
  client: LathClient;
  /** Where the public documents are read: the audit's store (registry, gateways, the trace dir). */
  store: TraceStore | null;
  agentId: Uint8Array;
  /** Reads the deploy transaction. Without one the deploy is reported unchecked. */
  tx?: SolanaTxReader;
  /** A store that opens the agent's encrypted blobs (`--trace-key`). Without one the private halves are unchecked. */
  keyedStore?: TraceStore;
  /** Base58 key that registered the agent (`AgentState.authority`), when the caller has read it. */
  authority?: string;
  /** The program `register_agent` must be addressed to; the client's own when absent. */
  programId?: string;
}

/** `register_agent`'s Anchor discriminator, `sha256("global:register_agent")[..8]`, as the IDL carries it. */
const REGISTER_AGENT_DISCRIMINATOR = [135, 157, 66, 195, 2, 113, 175, 30];

/**
 * `register_agent`'s `agent_id`, read at its fixed offset: the discriminator (8), the
 * `ValidityProof` (`Option<CompressedProof>`: a tag byte, and 32 + 64 + 32 bytes when `Some`), the
 * `PackedAddressTreeInfo` (u8, u8, u16), the output tree index (u8), then the 32 id bytes. Instruction
 * data is ABI like account offsets are, so reading it by position is as stable as the program.
 */
export function registerAgentIdOf(data: Uint8Array): Uint8Array | null {
  if (data.length < 8 + 1 + 4 + 1 + 32) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== REGISTER_AGENT_DISCRIMINATOR[i]) return null;
  const tag = data[8];
  if (tag !== 0 && tag !== 1) return null;
  const at = 8 + 1 + (tag === 1 ? 128 : 0) + 4 + 1;
  return data.length >= at + 32 ? data.slice(at, at + 32) : null;
}

function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The encodings of Ed25519's small-order points with the sign bit cleared — libsodium's
 * `has_small_order` blocklist: 0 and 1, the two of order 8, and p − 1, p and p + 1 (non-canonical
 * spellings of points already listed). A key in it verifies forged signatures.
 */
const SMALL_ORDER = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

/** Whether an Ed25519 public key is one of the small-order points, whose "signatures" OpenSSL accepts forged. */
export function isSmallOrderEd25519Key(publicKey: Uint8Array): boolean {
  return hasSmallOrder(publicKey);
}

function hasSmallOrder(publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32) return true;
  const cleared = publicKey.slice();
  cleared[31] &= 0x7f;
  return SMALL_ORDER.includes(hex(cleared));
}

/**
 * Whether `signature` is `publicKey`'s Ed25519 signature over `message`, through WebCrypto; `null`
 * when this runtime has no Ed25519 to ask, which the caller reports as unchecked rather than guessing.
 *
 * A small-order public key is refused before WebCrypto sees it. OpenSSL's Ed25519 — behind both
 * WebCrypto in Node and `crypto.verify` — accepts the all-zero key with an all-zero signature over
 * any message, and the owner named in a document is the console's word: without this, a console
 * could write `owner: 1111…1111` and "sign" whatever it liked for it.
 */
async function ed25519Verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean | null> {
  if (hasSmallOrder(publicKey)) return false;
  const subtle = (globalThis as { crypto?: { subtle?: typeof crypto.subtle } }).crypto?.subtle;
  if (!subtle) return null;
  let key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    key = await subtle.importKey("raw", publicKey as any, { name: "Ed25519" }, false, ["verify"]);
  } catch (e) {
    // A runtime without Ed25519 is unchecked; a key it will not import is not a signature.
    return (e as { name?: string })?.name === "NotSupportedError" ? null : false;
  }
  try {
    return await subtle.verify({ name: "Ed25519" }, key, signature as any, message as any);
  } catch {
    return false;
  }
}

/** What a signed message must say to count as the owner's word for one record. */
interface Expected {
  /** Acceptable `purpose action target` statements; the first that matches is the one checked. */
  statements: { purpose: string; action: string; target: string }[];
  /** The wallet that must have signed, base58; absent when this reader does not know the owner. */
  wallet?: string;
  /** The `Request ID` the message must carry (a start's body hash). */
  requestId?: string;
}

/**
 * The owner's signature on one record: the message parses, its statement and wallet are the ones
 * the record needs, and the signature verifies over the exact bytes. A failure says which of these
 * it was, because "signature invalid" and "signed by someone else" are different findings.
 */
async function checkAuth(auth: SignedMessage, want: Expected): Promise<{ status: PluginCheckStatus; detail: string }> {
  const parsed = parseSignedMessage(auth.message);
  if (!parsed) return { status: "failed", detail: "the signed message is not a console message" };
  const stmt = want.statements.find(
    (s) => s.purpose === parsed.purpose && s.action === parsed.action && s.target === parsed.target
  );
  if (!stmt) {
    const said = `${parsed.purpose}: ${parsed.action} ${parsed.target}`;
    const asked = want.statements.map((s) => `${s.purpose}: ${s.action} ${s.target}`).join(" or ");
    return { status: "failed", detail: `the message says "${said}", not "${asked}"` };
  }
  if (want.wallet !== undefined && parsed.wallet !== want.wallet) {
    return { status: "failed", detail: `signed by ${parsed.wallet}, not the owner ${want.wallet}` };
  }
  if (want.requestId !== undefined && parsed.field("Request ID") !== want.requestId) {
    return {
      status: "failed",
      detail: `its Request ID ${parsed.field("Request ID") ?? "(none)"} is not the start body hash ${want.requestId}`,
    };
  }
  let pub: Uint8Array;
  try {
    pub = new PublicKey(parsed.wallet).toBytes();
  } catch {
    return { status: "failed", detail: `the message's wallet ${parsed.wallet} is not a Solana address` };
  }
  const sig = fromBase64(auth.signature);
  if (!sig || sig.length !== 64) return { status: "failed", detail: "the signature is not 64 bytes of base64" };
  const ok = await ed25519Verify(utf8(auth.message), sig, pub);
  if (ok === null) return { status: "unchecked", detail: "this runtime has no Ed25519 verifier" };
  if (!ok) return { status: "failed", detail: `the signature does not verify for ${parsed.wallet}` };
  return {
    status: "ok",
    detail: `signed by ${parsed.wallet}: "${stmt.purpose}: ${stmt.action} ${stmt.target}"`,
  };
}

/**
 * The deploy transaction, held to the agent: it landed without error, `owner` signed it, and one of
 * its instructions is the lath program's `register_agent` for this agent id, whose first account
 * (`authority`) is the key that registered the chain and signed too.
 */
async function checkDeployTx(
  tx: SolanaTxReader | undefined,
  signature: string,
  owner: string,
  agentHex: string,
  authority: string | undefined,
  programId: string
): Promise<{ status: PluginCheckStatus; detail: string }> {
  if (!tx) return { status: "unchecked", detail: `deploy tx ${signature} not read (no RPC reader)` };
  let view: Awaited<ReturnType<SolanaTxReader["getTransaction"]>>;
  try {
    view = await tx.getTransaction(signature);
  } catch (e) {
    return {
      status: "unchecked",
      detail: `deploy tx ${signature} could not be read: ${String((e as any)?.message ?? e)}`,
    };
  }
  if (!view) return { status: "failed", detail: `the cluster has no transaction ${signature}` };
  if (view.err !== null && view.err !== undefined) {
    return { status: "failed", detail: `deploy tx ${signature} failed: ${JSON.stringify(view.err)}` };
  }
  if (!view.signers.includes(owner)) {
    return { status: "failed", detail: `deploy tx ${signature} is not signed by the owner ${owner}` };
  }
  const register = view.instructions.find((ix) => {
    if (ix.programId !== programId) return false;
    const data = fromBase64(ix.data);
    const id = data && registerAgentIdOf(data);
    return !!id && hex(id) === agentHex;
  });
  if (!register) {
    return { status: "failed", detail: `deploy tx ${signature} registers no agent ${agentHex} on ${programId}` };
  }
  const registeredBy = register.accounts[0];
  if (authority !== undefined && registeredBy !== authority) {
    return {
      status: "failed",
      detail: `deploy tx ${signature} registers the agent under ${registeredBy}, not ${authority}`,
    };
  }
  if (!view.signers.includes(registeredBy)) {
    return { status: "failed", detail: `deploy tx ${signature}: the registering key ${registeredBy} did not sign` };
  }
  return { status: "ok", detail: `deploy tx ${signature} signed by the owner, registers this agent` };
}

/** A private document's bytes through the keyed store: `null` with the reason when they will not open. */
async function openPrivate(
  store: TraceStore,
  privateHash: string
): Promise<{ bytes: Uint8Array } | { status: PluginCheckStatus; detail: string }> {
  let hash: Uint8Array;
  try {
    hash = toBytes32(privateHash);
  } catch {
    return { status: "failed", detail: `privateHash ${privateHash} is not a sha256` };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await store.get(hash);
  } catch (e) {
    return {
      status: "failed",
      detail: `the private document ${privateHash} does not open with this key: ${String((e as any)?.message ?? e)}`,
    };
  }
  if (!bytes) return { status: "failed", detail: `the private document ${privateHash} is not retrievable here` };
  if (hex(sha256(bytes)) !== privateHash.toLowerCase()) {
    return { status: "failed", detail: `the bytes under ${privateHash} hash to something else` };
  }
  return { bytes };
}

const PRIVATE_UNKEYED = "pass --trace-key <hex|path> to open it";

/**
 * Reads an agent's lifecycle records and checks them. One `listByTool` per lifecycle tool and one
 * for `loop.step` (the reads `readAgentLifecycle` makes), the documents through `store`, and, with `tx`, one
 * `getTransaction` per deploy transaction.
 */
export async function verifyLifecycle(opts: VerifyLifecycleOptions): Promise<LifecycleVerification> {
  const { client, store, agentId } = opts;
  // `readAgentLifecycle`'s reads, unrolled so the `loop.step` seqs it folds with are kept for the
  // order check rather than listed a second time.
  const [entries, stepRecords] = await Promise.all([
    readLifecycle(client, store, agentId),
    client.listByTool(agentId, LOOP_STEP_TOOL),
  ]);
  const agentHex = hex(agentId);
  const read = {
    entries,
    agent: foldAgent(agentHex, entries),
    loops: foldLoops(
      agentHex,
      entries,
      stepRecords.map((r) => ({ seq: r.seq, statusCode: r.status }))
    ),
    unkeyed: unkeyedStarts(entries).length,
  };
  const steps = stepRecords.map((r) => r.seq);
  const programId = opts.programId ?? client.programId.toBase58();
  const checks: LifecycleCheck[] = [];
  const add = (name: string, r: { status: PluginCheckStatus; detail: string }, seq?: bigint) =>
    checks.push({
      name,
      status: r.status,
      ok: r.status !== "failed",
      detail: r.detail,
      ...(seq !== undefined ? { seq: seq.toString() } : {}),
    });

  if (read.entries.length === 0) {
    return { verdict: "none", agent: read.agent, loops: [], unkeyedStarts: 0, entries: [], checks };
  }

  // ── The deploy ──
  const deploy = read.agent.deploy;
  if (deploy) {
    const d = deploy.doc;
    if (d.agentId.toLowerCase() !== agentHex) {
      add(
        "deploy.agent",
        { status: "failed", detail: `the deploy document names agent ${d.agentId}` },
        deploy.entry.seq
      );
    }
    if (opts.authority !== undefined && d.authority !== opts.authority) {
      add(
        "deploy.authority",
        { status: "failed", detail: `the deploy document names authority ${d.authority}, the chain ${opts.authority}` },
        deploy.entry.seq
      );
    }
    if (d.deployTx) {
      add(
        "deploy.tx",
        await checkDeployTx(opts.tx, d.deployTx, d.owner, agentHex, opts.authority ?? d.authority, programId),
        deploy.entry.seq
      );
    } else {
      add("deploy.tx", { status: "unchecked", detail: "the deploy carries no transaction" }, deploy.entry.seq);
    }
    if (d.privateHash) {
      if (!opts.keyedStore) {
        add(
          "deploy.private",
          { status: "unchecked", detail: `the private half is encrypted: ${PRIVATE_UNKEYED}` },
          deploy.entry.seq
        );
      } else {
        const opened = await openPrivate(opts.keyedStore, d.privateHash);
        if (!("bytes" in opened)) add("deploy.private", opened, deploy.entry.seq);
        else {
          const doc = parseAgentPrivateDoc(opened.bytes);
          add(
            "deploy.private",
            !doc
              ? { status: "failed", detail: "the private half is not a document this version reads" }
              : doc.agentId.toLowerCase() !== agentHex
              ? { status: "failed", detail: `the private half names agent ${doc.agentId}` }
              : { status: "ok", detail: "the private half opens and names this agent" },
            deploy.entry.seq
          );
        }
      }
    }
  }
  const owner = deploy?.doc.owner;
  for (const m of read.agent.marks) {
    if (m.doc.by !== "owner") continue;
    const verb =
      m.entry.tool === AGENT_ARCHIVE_TOOL ? "archive" : m.entry.tool === AGENT_UNARCHIVE_TOOL ? "unarchive" : "";
    const name = `agent.${verb}`;
    if (!m.doc.auth) {
      add(name, { status: "failed", detail: `an owner's ${verb} carries no signed message` }, m.entry.seq);
      continue;
    }
    add(
      name,
      await checkAuth(m.doc.auth, {
        statements: [{ purpose: "Lath agent", action: verb, target: agentHex }],
        wallet: owner,
      }),
      m.entry.seq
    );
  }

  // ── Loops ──
  for (const loop of read.loops) {
    const s = loop.start.doc;
    const at = loop.start.entry.seq;
    const label = `loop ${loop.loopId}`;
    if (s.agentId.toLowerCase() !== agentHex) {
      add(`${label} start`, { status: "failed", detail: `the start names agent ${s.agentId}` }, at);
    }
    if (s.auth) {
      const template = (s.terms as { template?: { id?: unknown } }).template;
      const statements = [{ purpose: "Lath loop", action: "start", target: agentHex }];
      if (template && typeof template.id === "string") {
        statements.push({ purpose: "Lath loop", action: "start", target: template.id });
      }
      add(
        `${label} start`,
        s.startBodyHash
          ? await checkAuth(s.auth, { statements, wallet: s.owner, requestId: s.startBodyHash })
          : { status: "failed", detail: "the start carries a signed message but no startBodyHash for it to bind" },
        at
      );
    } else if (s.deployTx) {
      add(
        `${label} start`,
        await checkDeployTx(opts.tx, s.deployTx, s.owner, agentHex, opts.authority ?? deploy?.doc.authority, programId),
        at
      );
    } else {
      add(`${label} start`, { status: "unchecked", detail: "the start carries no owner signature" }, at);
    }

    for (const t of loop.transitions) {
      if (t.doc.by !== "owner") continue;
      const verb = t.entry.tool.slice("loop.".length);
      const name = `${label} ${verb}`;
      if (!t.doc.auth) {
        add(name, { status: "failed", detail: `an owner's ${verb} carries no signed message` }, t.entry.seq);
        continue;
      }
      const statements = [{ purpose: "Lath loop", action: verb, target: loop.loopId }];
      // Archiving an agent stops its loops, and the owner's word for that stop is the archive.
      if (t.entry.tool === LOOP_STOP_TOOL)
        statements.push({ purpose: "Lath agent", action: "archive", target: agentHex });
      add(name, await checkAuth(t.doc.auth, { statements, wallet: s.owner }), t.entry.seq);
    }

    if (loop.outOfOrder > 0) {
      add(
        `${label} order`,
        { status: "failed", detail: `${loop.outOfOrder} transition${loop.outOfOrder === 1 ? "" : "s"} out of order` },
        at
      );
    }
    const late = stepsAfterStop(loop, read.loops, steps);
    if (late.length) {
      add(
        `${label} order`,
        { status: "failed", detail: `loop.step at seq ${late.join(", ")} after the loop stopped, with no resume` },
        at
      );
    }

    if (s.privateHash) {
      if (!opts.keyedStore) {
        add(`${label} private`, { status: "unchecked", detail: `the prompt is encrypted: ${PRIVATE_UNKEYED}` }, at);
      } else {
        const opened = await openPrivate(opts.keyedStore, s.privateHash);
        if (!("bytes" in opened)) add(`${label} private`, opened, at);
        else add(`${label} private`, checkLoopPrivate(opened.bytes, s), at);
      }
    }
  }

  // Transitions for a loop with no start record at all. With every start readable, a transition
  // naming none of them is a record about a loop this chain never started; with a start this
  // reader could not open, it may be that one's, so it is not a finding.
  const started = new Set(read.loops.map((l) => l.loopId));
  for (const e of read.entries) {
    if (e.tool !== LOOP_PAUSE_TOOL && e.tool !== LOOP_RESUME_TOOL && e.tool !== LOOP_STOP_TOOL) continue;
    const doc = parseLoopTransitionDoc(e.argsBytes);
    if (!doc || started.has(doc.loopId)) continue;
    add(
      `loop ${doc.loopId} ${e.tool.slice("loop.".length)}`,
      read.unkeyed > 0
        ? { status: "unchecked", detail: "names a loop whose start is not readable here" }
        : { status: "failed", detail: "names a loop this chain never started" },
      e.seq
    );
  }

  return {
    verdict: checks.some((c) => c.status === "failed") ? "failed" : "verified",
    agent: read.agent,
    loops: read.loops,
    unkeyedStarts: read.unkeyed,
    entries: read.entries,
    checks,
  };
}

/** A start's private half: it opens as this loop's, its prompt is `promptHash`'s, its body `startBodyHash`'s. */
function checkLoopPrivate(
  bytes: Uint8Array,
  s: LoopOnChain["start"]["doc"]
): { status: PluginCheckStatus; detail: string } {
  const doc = parseLoopPrivateDoc(bytes);
  if (!doc) return { status: "failed", detail: "the private half is not a document this version reads" };
  if (doc.loopId !== s.loopId) return { status: "failed", detail: `the private half names loop ${doc.loopId}` };
  if (hex(sha256(utf8(doc.prompt))) !== s.promptHash) {
    return { status: "failed", detail: "the private prompt does not hash to the start's promptHash" };
  }
  if (doc.startBody !== undefined && s.startBodyHash !== undefined) {
    if (!doc.startBody || typeof doc.startBody !== "object") {
      return { status: "failed", detail: "the private start body is not an object" };
    }
    if (loopStartBodyHash(doc.startBody as object) !== s.startBodyHash) {
      return { status: "failed", detail: "the private start body does not hash to the start's startBodyHash" };
    }
  }
  return { status: "ok", detail: "the private half opens; its prompt and start body re-hash to the start's" };
}

/**
 * `loop.step` seqs that land after `loop` stopped and before a resume of it, which no other loop's
 * window covers. A loop's window runs from its start to its last stop, or to the tip while it runs;
 * a step inside another loop's window is that loop's and says nothing about this one.
 */
function stepsAfterStop(loop: LoopOnChain, loops: LoopOnChain[], steps: bigint[]): string[] {
  const stops = loop.transitions.filter((t) => t.entry.tool === LOOP_STOP_TOOL && t.entry.seq > loop.start.entry.seq);
  if (!stops.length) return [];
  const resumes = loop.transitions.filter((t) => t.entry.tool === LOOP_RESUME_TOOL).map((t) => t.entry.seq);
  const windowOf = (l: LoopOnChain): [bigint, bigint | null] => {
    const last = [...l.transitions].reverse().find((t) => t.entry.tool === LOOP_STOP_TOOL);
    return [l.start.entry.seq, l.status === "stopped" && last ? last.entry.seq : null];
  };
  const others = loops.filter((o) => o !== loop).map(windowOf);
  const late = new Set<string>();
  for (const stop of stops) {
    const resume = resumes.filter((r) => r > stop.entry.seq).sort((a, b) => (a < b ? -1 : 1))[0];
    for (const seq of steps) {
      if (seq <= stop.entry.seq || (resume !== undefined && seq >= resume)) continue;
      if (others.some(([lo, hi]) => seq > lo && (hi === null || seq < hi))) continue;
      late.add(seq.toString());
    }
  }
  return [...late];
}

/** A loop id short enough for one line: the first twelve characters and an ellipsis. */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 12)}…` : id;
}

/** A base58 key as `7HtX…BQHD`. */
function shortKey(k: string): string {
  return k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k;
}

/**
 * The JSON-safe summary an `AuditReport` carries (`lifecycle`), only for a chain with lifecycle
 * records: the folded documents hold record bytes and bigints, which the report's JSON cannot.
 */
export interface LifecycleAuditSummary {
  verdict: Exclude<LifecycleVerdict, "none">;
  records: number;
  deploy?: { seq: string; owner?: string; deployTx?: string; archived: boolean; readable: boolean };
  loops: {
    loopId: string;
    startSeq: string;
    owner: string;
    status: string;
    stopReason?: string;
    steps: number | null;
  }[];
  unkeyedStarts: number;
  checks: LifecycleCheck[];
}

export function lifecycleSummary(v: LifecycleVerification): LifecycleAuditSummary | undefined {
  if (v.verdict === "none") return undefined;
  const deployEntry = v.entries.find((e) => e.tool === "agent.deploy");
  const d = v.agent.deploy;
  return {
    verdict: v.verdict,
    records: v.entries.length,
    ...(deployEntry
      ? {
          deploy: {
            seq: (d?.entry.seq ?? deployEntry.seq).toString(),
            ...(d ? { owner: d.doc.owner } : {}),
            ...(d?.doc.deployTx ? { deployTx: d.doc.deployTx } : {}),
            archived: v.agent.archived,
            readable: !!d,
          },
        }
      : {}),
    loops: v.loops.map((l) => ({
      loopId: l.loopId,
      startSeq: l.start.entry.seq.toString(),
      owner: l.start.doc.owner,
      status: l.status,
      ...(l.stopReason ? { stopReason: l.stopReason } : {}),
      steps: l.steps,
    })),
    unkeyedStarts: v.unkeyedStarts,
    checks: v.checks,
  };
}

/**
 * The report's lifecycle lines, in the audit's eleven-column label style: the deploy, the loops,
 * then each failure indented, then one line for what was not checked here. Nothing for a chain
 * without lifecycle records — the caller does not call this then.
 */
export function formatLifecycle(s: LifecycleAuditSummary): string[] {
  const out: string[] = [];
  const failed = s.checks.filter((c) => c.status === "failed");
  const unchecked = s.checks.filter((c) => c.status === "unchecked");
  if (s.deploy) {
    const tx = s.checks.find((c) => c.name === "deploy.tx");
    const txState = !tx
      ? ""
      : tx.status === "ok"
      ? " · deploy tx verified"
      : tx.status === "failed"
      ? " · deploy tx FAILED"
      : s.deploy.deployTx
      ? " · deploy tx not checked"
      : " · no deploy tx";
    const who =
      s.deploy.readable && s.deploy.owner ? `owner ${shortKey(s.deploy.owner)}` : "recorded, not readable here";
    out.push(`deploy     ${who}${txState}${s.deploy.archived ? " · archived" : ""}`);
  }
  const recorded = s.loops.length + s.unkeyedStarts;
  if (recorded > 0) {
    const rows = s.loops.map((l) => {
      const steps = l.steps === null ? "" : `${l.steps} step${l.steps === 1 ? "" : "s"}`;
      const inner = l.status === "stopped" ? [l.stopReason, steps].filter(Boolean).join(", ") : "";
      return `${shortId(l.loopId)} ${l.status}${inner ? ` (${inner})` : ""}`;
    });
    const unread = s.unkeyedStarts
      ? ` (${s.unkeyedStarts} start${s.unkeyedStarts === 1 ? "" : "s"} not readable here)`
      : "";
    out.push(`loops      ${recorded} recorded${unread}${rows.length ? `: ${rows.join(" · ")}` : ""}`);
  }
  for (const c of failed.slice(0, 20))
    out.push(`  ${c.name}${c.seq !== undefined ? ` (seq ${c.seq})` : ""}: ${c.detail}`);
  if (unchecked.length) {
    out.push(`  not checked here: ${unchecked.map((c) => `${c.name} (${c.detail})`).join("; ")}`);
  }
  return out;
}
