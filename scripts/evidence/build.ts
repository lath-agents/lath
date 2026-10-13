/**
 * What was read about one loop, turned into the page's facts. Pure: `gather.ts` does every read, and
 * this decides what each read means and which step it belongs to, so the node suite can hold the
 * whole page to a fixture.
 *
 * Every fact keeps where it came from. A figure the chain or Tempo answered is used as read; one only
 * the console knows (a step's Tempo voucher figure, the decision's confidence) is the console's, as
 * the loop page itself shows it, and the page never adds the two currencies together.
 */
import { createHash } from "crypto";
import { IRYS_ENCODING, IRYS_GATEWAY } from "../../sdk/src/locator";
import {
  LATH_AUDIT,
  LATH_AUDIT_WHERE,
  verifyChannelLine,
  type CommandReader,
} from "../../frontend/src/lib/tempo-commands";
import type { LoopView } from "../../frontend/src/types/loop";
import {
  type ChargeFact,
  type CommandEvidence,
  type Evidence,
  type RecordFact,
  type ReceiptEvidence,
  type SolanaTx,
  type SourcesEvidence,
  type StepEvidence,
  type TempoChannelFact,
  type TempoKeyFact,
  githubTreeUrl,
  maskSecrets,
  maskSecretsIn,
  solanaAddressUrl,
  solanaMainnetAddressUrl,
} from "./model";

/** One record `readHistory` recovered, flattened to strings so a fixture can be plain JSON. */
export interface ChainRecord {
  seq: string;
  /** `EventKind`: 0 Genesis, 1 Action, 2 Delegation, 3 Resolution. */
  kind: number;
  status?: number;
  /** The record's `reference`, 64 hex: `sha256(tool_id)` on a tool's Action. */
  reference?: string;
  signature: string;
}

/** What the Solana reads returned. Every field is optional because each read can fail on its own. */
export interface ChainFacts {
  authority?: string | null;
  registration?: SolanaTx | null;
  /** Every signature on the agent's address, with its time: what places a record in the loop's window. */
  times?: Record<string, { slot?: number; blockTime?: number | null }>;
  records?: ChainRecord[];
  epochs?: { startSeq: string; endSeq: string; signature: string }[];
  cells?: { opSeq: string; signature: string }[];
  /** The owner's `Charged` events by this agent's key, in the loop's window. */
  charges?: ChargeFact[];
  balanceAccount?: string | null;
}

/** What the Tempo mainnet reads returned. */
export interface TempoFacts {
  key?: Partial<TempoKeyFact> | null;
  channels?: TempoChannelFact[];
}

/** The receipt account as read on devnet. */
export interface ReceiptAccountFacts {
  owner: string;
  credential: string;
  schema: string;
  signer: string;
  /** Decoded with `decodeLoopReceipt`; `null` when the data does not decode. */
  values: ReceiptEvidence["values"];
  /** The transaction that created it, when the view or the account's history named one. */
  signature?: string;
}

/** The sources index and manifest from Irys, as the runtime writes them (`lath.sources.irys.v1`, `lath.sources.v1`). */
export interface SourcesFacts {
  index: string;
  manifest?: string;
  sourcesHash?: string;
  files?: Record<string, string>;
  entries?: {
    source: Record<string, any>;
    dir?: string;
    files?: { path: string; size: number; sha256: string }[];
  }[];
}

export interface EvidenceInput {
  generatedAt: string;
  loop: LoopView;
  treasury?: { address?: string | null; token?: string | null } | null;
  chain?: ChainFacts | null;
  tempo?: TempoFacts | null;
  receiptAccount?: ReceiptAccountFacts | null;
  sources?: SourcesFacts | null;
  unread?: string[];
}

/** The SAS program, which must own a receipt (`LOOP_RECEIPT_PROGRAM_ID`). */
const SAS_PROGRAM = "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The tools a loop's records name, by the hash their `reference` carries. Only the ones a loop writes
 * outside its epochs: the epoch's own Actions are inside one commit and never reach this list.
 */
const TOOL_LABELS: Record<string, string> = Object.fromEntries(
  [
    ["loop.step", "loop.step: the step's checkpoint"],
    ["loop.settlement", "loop.settlement: the channel's settlement, recorded on Solana"],
    ["storage.put", "storage.put: the report stored on Tempo, and its charge"],
    ["squads.pay", "squads.pay"],
    ["sas.attest", "sas.attest"],
  ].map(([tool, label]) => [sha256Hex(tool), label])
);
const LOOP_STEP_REF = sha256Hex("loop.step");

const KIND_NAMES: Record<number, RecordFact["kind"]> = { 0: "genesis", 1: "action", 2: "delegation", 3: "resolution" };

function recordLabel(r: ChainRecord): string {
  switch (r.kind) {
    case 0:
      return "Genesis: the step's terms, its policy and its sandbox";
    case 3:
      return "Resolution: the session's answer";
    case 2:
      return "Delegation";
    default:
      return (r.reference && TOOL_LABELS[r.reference]) || "Action";
  }
}

const big = (v: string | number | bigint | null | undefined) => {
  try {
    return v === null || v === undefined || v === "" ? BigInt(0) : BigInt(v);
  } catch {
    return BigInt(0);
  }
};
const sum = (xs: (string | undefined)[]) => xs.reduce((n, x) => n + big(x), BigInt(0));
const seqNum = (s: string | undefined | null) => (s ? BigInt(s) : null);

/**
 * The page's facts. `unread` collects, in plain words, every fact a section would show and could not:
 * the page prints them under _What this page could not read_ rather than leaving a gap unexplained.
 */
export function buildEvidence(input: EvidenceInput): Evidence {
  const loop = input.loop;
  const chain = input.chain ?? null;
  const unread = [...(input.unread ?? [])].map(maskSecrets);
  const times = chain?.times ?? {};
  const timeOf = (sig: string): Pick<SolanaTx, "slot" | "blockTime"> => {
    const t = times[sig];
    return t ? { slot: t.slot, blockTime: t.blockTime ?? null } : {};
  };

  // ── Every record of the loop, from the chain. A loop owns the seqs from its first write to its last
  // step's checkpoint, and what it writes straight after the stop (the settlement, the last report's
  // PUT, its cells); another session of the same agent would start with a Genesis past that, which is
  // where "after the stop" ends.
  const history = loop.history ?? [];
  const fromSec = Math.floor(loop.createdAt / 1000) - 120;
  const lastEnd = Math.max(loop.lastStepAt ?? 0, ...history.map((h: any) => h.endedAt ?? 0));
  const toSec = Math.floor(lastEnd / 1000) + 900;
  const inWindow = (sig: string) => {
    const t = times[sig]?.blockTime;
    return typeof t === "number" ? t >= fromSec && t <= toSec : false;
  };

  const all: RecordFact[] = [];
  for (const r of chain?.records ?? []) {
    if (!inWindow(r.signature)) continue;
    all.push({
      seq: r.seq,
      kind: KIND_NAMES[r.kind] ?? "action",
      label: recordLabel(r),
      status: r.status,
      signature: r.signature,
      ...timeOf(r.signature),
      ...(r.reference === LOOP_STEP_REF ? { label: TOOL_LABELS[LOOP_STEP_REF] } : {}),
    });
  }
  for (const e of chain?.epochs ?? []) {
    if (!inWindow(e.signature)) continue;
    // `endSeq` is one past the last seq the epoch covers (`EpochRecord`).
    const last = (BigInt(e.endSeq) - BigInt(1)).toString();
    all.push({
      seq: e.startSeq,
      endSeq: last,
      kind: "epoch",
      label: `the step's calls, seqs ${e.startSeq}–${last}, committed as one epoch`,
      signature: e.signature,
      ...timeOf(e.signature),
    });
  }
  for (const c of chain?.cells ?? []) {
    if (!inWindow(c.signature)) continue;
    all.push({ seq: c.opSeq, kind: "cell", label: "a cell write", signature: c.signature, ...timeOf(c.signature) });
  }
  all.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));

  // ── The charges: by the record logged in their transaction when there is one (a storage PUT), else by
  // when they landed against each step's clock. A model call's charge is its own transaction, because
  // the call's record is batched into the step's epoch and cannot share one.
  const charges = [...(chain?.charges ?? [])].sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  const claimed = new Set<string>();

  const steps: StepEvidence[] = [];
  let floor: bigint | null = null;
  for (const [i, h] of history.entries()) {
    const seq = seqNum(h.seq);
    const prev = i === 0 ? null : seqNum(history[i - 1].seq);
    const mine = all.filter((r) => {
      const s = BigInt(r.seq);
      if (seq === null) return false;
      if (s > seq) return false;
      return prev === null ? true : s > prev;
    });
    if (i === 0 && mine.length) floor = BigInt(mine[0].seq);
    const record = mine.find((r) => r.seq === h.seq && r.kind === "action") ?? null;
    const startSec = h.startedAt ? Math.floor(h.startedAt / 1000) - 5 : null;
    const endSec = h.endedAt ? Math.floor(h.endedAt / 1000) + 5 : null;
    const calls = charges.filter(
      (c) =>
        !c.seq &&
        !claimed.has(c.signature) &&
        startSec !== null &&
        endSec !== null &&
        (c.blockTime ?? 0) >= startSec &&
        (c.blockTime ?? 0) <= endSec
    );
    calls.forEach((c) => claimed.add(c.signature));

    const put = h.tempoStorage;
    let storage: StepEvidence["storage"] = null;
    if (put) {
      const putRecord = put.seq ? all.find((r) => r.seq === put.seq && r.kind === "action") : undefined;
      const putCharge = putRecord ? charges.find((c) => c.signature === putRecord.signature) : undefined;
      if (putCharge) claimed.add(putCharge.signature);
      storage = {
        path: put.path,
        bytes: put.bytes,
        statusCode: put.statusCode,
        ...(put.amount ? { amountBase: put.amount } : {}),
        ...(put.reference ? { reference: put.reference } : {}),
        ...(put.seq ? { seq: put.seq } : {}),
        ...(putRecord
          ? { record: { signature: putRecord.signature, slot: putRecord.slot, blockTime: putRecord.blockTime } }
          : {}),
        ...(putCharge ? { chargeMicroUsdc: putCharge.amountMicroUsdc } : {}),
      };
    }

    const g = h.goalCheck;
    steps.push({
      step: h.step,
      status: h.status,
      ...(h.reason ? { reason: h.reason } : {}),
      ...(h.startedAt ? { startedAt: h.startedAt } : {}),
      ...(h.endedAt ? { endedAt: h.endedAt } : {}),
      record: record
        ? { ...record, leafOk: h.leafOk }
        : h.signature
        ? // The console's row keeps each checkpoint's signature, so the step's record links even when
          // the history read did not answer.
          {
            seq: h.seq ?? "",
            kind: "action",
            label: TOOL_LABELS[LOOP_STEP_REF],
            signature: h.signature,
            leafOk: h.leafOk,
          }
        : null,
      genesis: mine.find((r) => r.kind === "genesis") ?? null,
      epochs: mine.filter((r) => r.kind === "epoch"),
      resolution: mine.find((r) => r.kind === "resolution") ?? null,
      others: mine.filter((r) => r !== record && r.kind !== "genesis" && r.kind !== "epoch" && r.kind !== "resolution"),
      calls,
      chargedMicroUsdc: sum(calls.map((c) => c.amountMicroUsdc)).toString(),
      consoleCostMicroUsdc: h.costMicroUsdc,
      ...(h.tempoSpent ? { tempoBase: h.tempoSpent } : {}),
      decision: g
        ? {
            outcome: g.outcome,
            ...(typeof g.confidence === "number" ? { confidence: g.confidence } : {}),
            ...(typeof g.bar === "number" ? { bar: g.bar } : {}),
            ...(g.goalCheckHash ? { hash: g.goalCheckHash } : {}),
          }
        : null,
      storage,
    });
  }

  // Records before the first step's (the sources index's cell, written at the start) join step 1's
  // others; records after the last checkpoint are the stop's, up to the next session's Genesis.
  const lastSeq = seqNum(history.at(-1)?.seq);
  if (steps.length && floor !== null) {
    const before = all.filter((r) => BigInt(r.seq) < floor!);
    steps[0].others.unshift(...before);
  }
  const afterStop: RecordFact[] = [];
  if (lastSeq !== null) {
    for (const r of all) {
      if (BigInt(r.seq) <= lastSeq) continue;
      if (r.kind === "genesis") break;
      afterStop.push(r);
    }
  }
  // A charge in the same transaction as an after-stop record (the last report's PUT, claimed above
  // when its step names it) is that record's; anything still unclaimed is listed on its own.
  const otherCharges = charges.filter((c) => !claimed.has(c.signature));

  // ── Tempo.
  const tempo = input.tempo ?? null;
  const viewKey = loop.tempoKey ?? null;
  const key: TempoKeyFact | null = viewKey
    ? {
        address: viewKey.address,
        limitBase: tempo?.key?.limitBase ?? viewKey.limitBase,
        ...(viewKey.expiry ? { expiry: viewKey.expiry } : {}),
        ...(viewKey.authorizeTx ? { authorizeTx: viewKey.authorizeTx } : {}),
        ...(tempo?.key?.authorizeBlock ? { authorizeBlock: tempo.key.authorizeBlock } : {}),
        revoked: tempo?.key?.revoked ?? (typeof viewKey.isRevoked === "boolean" ? viewKey.isRevoked : null),
        ...(tempo?.key?.revokeTx ? { revokeTx: tempo.key.revokeTx } : {}),
      }
    : null;
  const channels = tempo?.channels ?? [];
  const model = channels.filter((c) => c.role === "model");
  const storagePaid = sum(steps.map((s) => (s.storage?.reference ? s.storage.amountBase : undefined)));
  const channelPaid = model.some((c) => c.paidBase !== undefined)
    ? sum(model.map((c) => c.paidBase))
    : loop.tempo?.closed && loop.tempo.spent
    ? big(loop.tempo.spent)
    : null;
  if (channelPaid === null && loop.tempo?.channelId) {
    unread.push("The model channel's settlement was not read from Tempo, so the Tempo total is left out.");
  }

  // ── The receipt.
  const receipt = buildReceipt(loop, input.receiptAccount ?? null, unread);

  // ── The cost line.
  const chargedOnChain = chain?.charges ? sum(chain.charges.map((c) => c.amountMicroUsdc)) : null;
  const consoleCharged = loop.spentMicroUsdc ?? "0";
  if (chargedOnChain !== null && chargedOnChain.toString() !== big(consoleCharged).toString()) {
    unread.push(
      `The charges read on Solana add up to ${chargedOnChain} micro-USDC and the console reports ${consoleCharged}; ` +
        "the page shows the chain's figure."
    );
  }

  const lastStep = steps.at(-1);
  const reached = loop.stopReason === "goal-reached";

  // Masked whole, on the way out: both the page and evidence.json are made from this, and a loop's
  // own data — a URL source's address above all — can carry a key the operator never meant to publish.
  return maskSecretsIn({
    v: 1,
    generatedAt: input.generatedAt,
    agent: {
      name: loop.agentName ?? "",
      id: loop.agentId,
      owner: loop.owner,
      authority: chain?.authority ?? null,
      registration: chain?.registration ?? null,
    },
    loop: {
      id: loop.id,
      createdAt: loop.createdAt,
      status: loop.status,
      stopReason: loop.stopReason ?? null,
      steps: loop.steps,
      maxSteps: loop.maxSteps,
      intervalMs: loop.intervalMs,
      budgetMicroUsdc: loop.budgetMicroUsdc ?? "0",
      goalHash: loop.goalHash ?? null,
      lastSeq: loop.lastSeq ?? null,
      lastHead: loop.lastHead ?? null,
      plainTraces: loop.plainTraces === true,
    },
    outcome: {
      reached,
      step: reached ? lastStep?.step ?? loop.steps : null,
      confidence: reached ? lastStep?.decision?.confidence ?? null : null,
      stopReason: loop.stopReason ?? null,
    },
    cost: {
      chargedMicroUsdc: chargedOnChain === null ? null : chargedOnChain.toString(),
      consoleChargedMicroUsdc: consoleCharged,
      balanceAccount: chain?.balanceAccount ?? null,
      tempoPaidBase: channelPaid === null ? null : (channelPaid + storagePaid).toString(),
      decisionBase: loop.jevSpentBase && big(loop.jevSpentBase) > BigInt(0) ? loop.jevSpentBase : null,
    },
    steps,
    afterStop,
    otherCharges,
    tempo: {
      treasury: loop.tempo?.payer ?? input.treasury?.address ?? null,
      token: viewKey?.token ?? input.treasury?.token ?? null,
      key,
      channels,
    },
    receipt,
    sources: buildSources(input.sources ?? null),
    commands: buildCommands(loop, !!viewKey, !!loop.receipt),
    unread,
  });
}

function buildReceipt(loop: LoopView, account: ReceiptAccountFacts | null, unread: string[]): ReceiptEvidence | null {
  const r = loop.receipt;
  if (!r) return null;
  if (r.status === "published" && !account) {
    unread.push("The receipt account was not read from devnet, so its fields are the console's report.");
  }
  const fromChain = account?.values ?? null;
  return {
    status: r.status,
    address: r.address,
    ...(account?.signature || r.signature ? { signature: account?.signature ?? r.signature } : {}),
    credential: r.credential,
    schema: r.schema,
    signer: r.signer,
    values: fromChain ?? r.values ?? null,
    valuesFrom: fromChain ? "chain" : r.values ? "console" : null,
    ...(account
      ? {
          accountMatches:
            account.owner === SAS_PROGRAM &&
            account.credential === r.credential &&
            account.schema === r.schema &&
            account.signer === r.signer,
        }
      : {}),
  };
}

/**
 * The sources as a judge reads them: each with its pin in words and a link to where the pin opens,
 * each file with its Irys link. Paths drop the source's own directory (`solana/<cluster>/<address>/`),
 * which only repeats the line above them.
 */
function buildSources(s: SourcesFacts | null): SourcesEvidence | null {
  if (!s) return null;
  const sources = (s.entries ?? []).map((e) => {
    const src = e.source ?? {};
    const dir = e.dir ? `${e.dir.replace(/\/+$/, "")}/` : "";
    const files = (e.files ?? []).map((f) => ({
      path: dir && f.path.startsWith(dir) ? f.path.slice(dir.length) : f.path,
      size: f.size,
      sha256: f.sha256,
      irys: s.files?.[f.sha256] ?? null,
    }));
    if (src.kind === "github") {
      return {
        kind: "github",
        label: `GitHub ${src.owner}/${src.repo}${src.path ? `/${src.path}` : ""}`,
        pin: `at commit ${String(src.commit).slice(0, 7)}`,
        pinUrl: githubTreeUrl(src.owner, src.repo, src.commit, src.path),
        files,
      };
    }
    if (src.kind === "solana") {
      const net = src.cluster === "mainnet" ? "Solana mainnet" : "Solana devnet";
      return {
        kind: "solana",
        label: `${net} account ${src.address}`,
        pin: `at slot ${src.slot}`,
        pinUrl: src.cluster === "mainnet" ? solanaMainnetAddressUrl(src.address) : solanaAddressUrl(src.address),
        files,
      };
    }
    if (src.kind === "url") {
      return { kind: "url", label: String(src.finalUrl ?? src.input ?? "a web page"), pin: "as fetched", files };
    }
    if (src.kind === "text") {
      return { kind: "text", label: `${src.name}, a file the owner attached`, pin: "as attached", files };
    }
    return { kind: String(src.kind ?? "source"), label: String(src.input ?? "a source"), pin: "", files };
  });
  return {
    index: s.index,
    ...(s.manifest ? { manifest: s.manifest } : {}),
    ...(s.sourcesHash ? { sourcesHash: s.sourcesHash } : {}),
    sources,
  };
}

/**
 * _Check it yourself_ as the app prints it: the Tempo line from `lib/tempo-commands.ts` itself, and
 * the step, receipt and plain-audit lines in the same shape (an `R=` line the reader fills with their
 * own ZK-compression RPC, a `T=` line for Tempo's public one, the Irys reader flags). No trace key:
 * the page never holds one, and the lines say what each checks without it.
 */
function buildCommands(loop: LoopView, keyed: boolean, withReceipt: boolean): CommandEvidence[] {
  const name = loop.agentName ?? loop.agentId;
  const reader: CommandReader = {
    rpcLine: `R="…"   # your ZK-compression RPC for Solana devnet`,
    flags: [`  --gateway ${IRYS_GATEWAY} --scheme 4 --encoding ${IRYS_ENCODING}`],
    tempoRpc: "https://rpc.tempo.xyz",
  };
  const word = (v: string) => (/^[A-Za-z0-9._:/@%+=,-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  const audit = LATH_AUDIT;
  const block = (lines: string[], tempo: boolean) =>
    [LATH_AUDIT_WHERE, reader.rpcLine, ...(tempo ? [`T="${reader.tempoRpc}"`] : []), lines.join(" \\\n")].join("\n");
  const out: CommandEvidence[] = [];

  const channel = verifyChannelLine(name, { key: keyed }, reader);
  out.push({ title: keyed ? "verify-channel --key" : "verify-channel", ...channel });

  const seq = loop.history?.at(-1)?.seq ?? loop.lastSeq;
  if (seq) {
    out.push({
      title: `verify-step ${seq}`,
      command: block(
        [`${audit} verify-step --name ${word(name)} ${seq}`, `  --rpc "$R" --tempo-rpc "$T"`, ...reader.flags],
        true
      ),
      checks:
        "Re-reads the last step's loop.step record from Solana, rebuilds its checkpoint leaf, and shows the decision " +
        "model's answer that stopped the loop, with the step's storage payment held to its Tempo transaction.",
    });
  }
  if (withReceipt) {
    out.push({
      title: "verify-receipt",
      command: block(
        [`${audit} verify-receipt --name ${word(name)} --loop ${loop.id}`, `  --rpc "$R"`, ...reader.flags],
        false
      ),
      checks:
        "Reads the receipt on the Solana Attestation Service at the address the loop's policy derives and checks its " +
        "agent, loop, seq, head, steps and goal against the loop's records; the money fields are the console's report.",
    });
  }
  out.push({
    title: "the plain audit, from Irys",
    command: block([`${audit} --name ${word(name)}`, `  --rpc "$R"`, ...reader.flags], false),
    checks: loop.plainTraces
      ? "Replays the agent's whole hash chain from Solana to its head, reading every epoch it committed from Irys. The " +
        "traces are public, so --require-preimages opens and re-hashes each one with no key."
      : "Replays the agent's whole hash chain from Solana to its head, reading every epoch it committed from Irys. The " +
        "traces stay encrypted to the owner, whose --require-preimages --trace-key opens and re-hashes each one.",
  });
  return out;
}
