/**
 * The evidence page's facts, as `evidence.json` carries them and `render.ts` draws them, and the
 * explorer links every fact opens.
 *
 * Kept free of I/O and of the SDK's Node half so the node suite (`tests/evidence-page.ts`) can build
 * a page from a fixture with no RPC, no console and no network: `gather.ts` reads, `build.ts` turns
 * what was read into an `Evidence`, `render.ts` draws it.
 */

/** The cluster every Solana link here names: the programs and the records are on devnet. */
export const SOLANA_CLUSTER = "devnet";
export const SOLANA_EXPLORER = "https://explorer.solana.com";
/** As the app's `TempoLink` builds them (`frontend/src/lib/tempo.ts`), which imports React and so cannot be loaded here. */
export const TEMPO_EXPLORER = "https://explore.tempo.xyz";
/** The gateway the plain audit reads Irys through (`IRYS_GATEWAY` in the SDK) and a judge's browser opens. */
export const IRYS_GATEWAY_URL = "https://gateway.irys.xyz";

export const solanaTxUrl = (signature: string) => `${SOLANA_EXPLORER}/tx/${signature}?cluster=${SOLANA_CLUSTER}`;
export const solanaAddressUrl = (address: string) => `${SOLANA_EXPLORER}/address/${address}?cluster=${SOLANA_CLUSTER}`;
/**
 * A Solana mainnet account, for a source the loop read there. No `cluster` parameter: mainnet is the
 * explorer's default, and naming it would put the bare word in a url the page prints nowhere else.
 */
export const solanaMainnetAddressUrl = (address: string) => `${SOLANA_EXPLORER}/address/${address}`;
export const tempoTxUrl = (hash: string) => `${TEMPO_EXPLORER}/tx/${hash}`;
export const tempoAddressUrl = (address: string) => `${TEMPO_EXPLORER}/address/${address}`;
export const tempoBlockUrl = (block: string) => `${TEMPO_EXPLORER}/block/${block}`;
export const irysUrl = (id: string) => `${IRYS_GATEWAY_URL}/${id}`;
export const githubTreeUrl = (owner: string, repo: string, commit: string, path?: string | null) =>
  `https://github.com/${owner}/${repo}/tree/${commit}${path ? `/${path}` : ""}`;

/** One Solana transaction, with where it sits in time when the RPC said. */
export interface SolanaTx {
  signature: string;
  slot?: number;
  /** Unix seconds. */
  blockTime?: number | null;
}

/** One record the loop wrote, as `readHistory` decoded it from its transaction. */
export interface RecordFact extends SolanaTx {
  seq: string;
  /** `EventKind`: 0 Genesis, 1 Action, 2 Delegation, 3 Resolution; `cell` for a cell write, `epoch` for a commit. */
  kind: "genesis" | "action" | "delegation" | "resolution" | "cell" | "epoch";
  /** What the record is, in words: `loop.step`, `storage.put`, the step's Genesis… */
  label: string;
  /** For an epoch: the last seq it covers, inclusive. */
  endSeq?: string;
  /** The record's status code, where it has one (201 is `GoalReached` on a `loop.step`). */
  status?: number;
}

/** One `Charged` event on the owner's balance, read from its transaction. */
export interface ChargeFact extends SolanaTx {
  /** Micro-USDC, decimal. */
  amountMicroUsdc: string;
  /** The seq of the record logged in the same transaction, when one was. */
  seq?: string;
}

export interface StepEvidence {
  step: number;
  status: string;
  reason?: string;
  /** Unix ms, the console's clock. */
  startedAt?: number;
  endedAt?: number;
  /** The step's `loop.step` record: its checkpoint leaf commits the step. */
  record: (RecordFact & { leafOk?: boolean }) | null;
  genesis: RecordFact | null;
  /** The step's model calls and tool calls, committed as one epoch per commit. */
  epochs: RecordFact[];
  resolution: RecordFact | null;
  /** Every other transaction of the step (cell writes, other Actions). */
  others: RecordFact[];
  /** Each paid call's charge, in order. */
  calls: ChargeFact[];
  /** Σ calls, micro-USDC: what the owner was debited for this step's model calls. */
  chargedMicroUsdc: string;
  /** What the console says the step cost, micro-USDC: held beside the chain's sum. */
  consoleCostMicroUsdc?: string;
  /** The step's voucher delta on the loop's channel, USDC.e base units: its calls and the decision on it. */
  tempoBase?: string;
  decision: { outcome: string; confidence?: number; bar?: number; hash?: string } | null;
  storage: {
    path: string;
    bytes: number;
    statusCode: number;
    amountBase?: string;
    reference?: string;
    seq?: string;
    /** The `storage.put` record's transaction, which carries its charge. */
    record?: SolanaTx;
    chargeMicroUsdc?: string;
  } | null;
}

export interface TempoChannelFact {
  id: string;
  /** The loop's model channel, or Lath's own RPC session. */
  role: "model" | "rpc";
  openTx?: string;
  openBlock?: string;
  depositBase?: string;
  signer?: string;
  payer?: string;
  closeTx?: string;
  /** What the close paid the payee, USDC.e base units. */
  paidBase?: string;
  refundBase?: string;
  payee?: string;
}

export interface TempoKeyFact {
  address: string;
  limitBase: string;
  /** Unix seconds. */
  expiry?: number;
  authorizeTx?: string;
  authorizeBlock?: string;
  /** As Tempo's keychain answers now: `null` when it did not answer. */
  revoked: boolean | null;
  revokeTx?: string;
}

export interface ReceiptEvidence {
  status: string;
  address: string;
  signature?: string;
  credential: string;
  schema: string;
  signer: string;
  /** Read from the account on devnet, `null` when it was not read or does not decode. */
  values: {
    agent: string;
    loop: string;
    seq: string;
    head: string;
    steps: number;
    goal: string;
    usdcCharged: string;
    tempoSpent: string;
    tempoPayer: string;
  } | null;
  /** Where the values came from: the account itself, or the console's view when the account was not read. */
  valuesFrom: "chain" | "console" | null;
  /** The account's owner is SAS and its credential, schema and signer are the pointer's. */
  accountMatches?: boolean;
}

export interface SourceFileEvidence {
  /** Relative to the source's own directory. */
  path: string;
  size: number;
  sha256: string;
  irys: string | null;
}

export interface SourceEvidence {
  kind: string;
  /** The source in words: `owner/repo`, `Solana devnet account …`, a file's name. */
  label: string;
  /** Its pin in words: `at commit 1a2b3c4`, `at slot 507557829`. */
  pin: string;
  /** Where the pin itself opens: the GitHub tree at the commit, the account on the explorer. */
  pinUrl?: string;
  files: SourceFileEvidence[];
}

export interface SourcesEvidence {
  index: string;
  manifest?: string;
  sourcesHash?: string;
  sources: SourceEvidence[];
}

export interface CommandEvidence {
  title: string;
  command: string;
  checks: string;
}

export interface Evidence {
  v: 1;
  generatedAt: string;
  agent: {
    name: string;
    id: string;
    owner: string;
    /** The agent's signing key on Solana, base58. */
    authority: string | null;
    registration: SolanaTx | null;
  };
  loop: {
    id: string;
    createdAt: number;
    status: string;
    stopReason: string | null;
    steps: number;
    maxSteps: number;
    intervalMs: number;
    budgetMicroUsdc: string;
    goalHash: string | null;
    lastSeq: string | null;
    lastHead: string | null;
    /**
     * The run's traces were written in the clear (`LoopView.plainTraces`, every run this console
     * starts): the page then says anyone can read them, not only check them.
     */
    plainTraces?: boolean;
  };
  outcome: { reached: boolean; step: number | null; confidence: number | null; stopReason: string | null };
  cost: {
    /** Σ every `Charged` of the loop read on Solana; `null` when the history was not read. */
    chargedMicroUsdc: string | null;
    /** What the console says it charged. */
    consoleChargedMicroUsdc: string;
    /** The owner's balance on lath-billing, whose history lists every charge. */
    balanceAccount: string | null;
    /** The model channel's settlement plus the storage PUTs, USDC.e base units. */
    tempoPaidBase: string | null;
    /** Of the channel: what the decision model's answers cost, paid by Lath. */
    decisionBase: string | null;
  };
  steps: StepEvidence[];
  /** What the loop wrote after its last step: the settlement's record, the storage PUT, cells. */
  afterStop: RecordFact[];
  /** Charges no step claimed. */
  otherCharges: ChargeFact[];
  tempo: {
    treasury: string | null;
    token: string | null;
    key: TempoKeyFact | null;
    channels: TempoChannelFact[];
  };
  receipt: ReceiptEvidence | null;
  sources: SourcesEvidence | null;
  commands: CommandEvidence[];
  /** Every fact the page wanted and could not read without a write, or at all, and why. */
  unread: string[];
}

// ─── Formatting, shared by the page and the test ────────────────────────────────────────────────

/** Base units of a six-decimal token (micro-USDC, USDC.e) as the app shows them: exact, six places. */
export function units6(value: string | bigint | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  let v: bigint;
  try {
    v = BigInt(value);
  } catch {
    return "—";
  }
  const neg = v < BigInt(0);
  const abs = neg ? -v : v;
  const unit = BigInt(1_000_000);
  return `${neg ? "-" : ""}${abs / unit}.${(abs % unit).toString().padStart(6, "0")}`;
}

/** A long id as its head and tail, the whole of it in the link's title. */
export function short(value: string, head = 6, tail = 4): string {
  if (!value) return "";
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Unix ms as `2026-10-04 12:25 UTC`. */
export function utc(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Masks an RPC key wherever it could ride into a log, an error or the page: Helius carries it as
 * `api-key=`, other hosts as a userinfo or another query parameter. The page is made to be shared,
 * so a key in it is a published key. The parameter's name goes too, so a reader of the page (and
 * the suite, which looks for it) never sees where one was.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/[?&]?api-key=[^&\s"'<>]*/gi, " [key withheld]")
    .replace(/(https?:\/\/)[^/\s@"'<>]+@/gi, "$1…@")
    .replace(/([?&](?:key|token|apikey|access_token)=)[^&\s"'<>]*/gi, "$1…");
}

/**
 * `maskSecrets` over every string in a value the page or its json is made from. Masking the
 * rendered html instead would miss a key after an escaped `&amp;`, and masking the facts one field
 * at a time missed a sandbox source's own URL, which is whatever the owner typed.
 */
export function maskSecretsIn<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  if (Array.isArray(value)) return value.map(maskSecretsIn) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSecretsIn(v)])) as T;
  }
  return value;
}

/**
 * The words the page must not carry, checked on what was rendered because a
 * loop's own data — a failure reason, a file name — reaches the page too. A hit is printed, not
 * fixed: the operator decides whether the line is fair before the page goes up.
 */
export function wordProblems(html: string): string[] {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  const out: string[] = [];
  for (const w of [
    "deterministic",
    "hire",
    "hired",
    "hiring",
    "worker",
    "workers",
    "provider",
    "providers",
    "proves",
    "proven",
    "prove",
  ]) {
    if (new RegExp(`\\b${w}\\b`, "i").test(text)) out.push(`the page says "${w}"`);
  }
  if (/api-key/i.test(html)) out.push("the page carries an api-key");
  const bare = text.match(/(?<!Tempo |Solana )\bmainnet\b/gi);
  if (bare) out.push(`the page says "mainnet" ${bare.length}× without Tempo or Solana before it`);
  return out;
}
