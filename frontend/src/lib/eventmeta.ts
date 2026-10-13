import { PublicKey } from "@solana/web3.js";
import {
  EventKind,
  EventRecord,
  hex,
  HIRE_RELEASED_TOOL,
  HIRE_SETTLED_TOOL,
  idFromString,
  LOOP_SETTLEMENT_TOOL,
  LOOP_STEP_TOOL,
  OFFER_TOOL,
  ResolutionStatus,
} from "@lath/sdk/browser";
import { LIFECYCLE_LABELS, LIFECYCLE_TOOL_IDS } from "@/lib/chain-records";

export const KIND_LABEL: Record<EventKind, string> = {
  [EventKind.Genesis]: "Genesis",
  [EventKind.Action]: "Action",
  [EventKind.Delegation]: "Delegation",
  [EventKind.Resolution]: "Resolution",
};

/**
 * What `reference` means changes with `kind` — it is one indexable slot reused four ways, which
 * is what makes a single `memcmp` answer four different questions (SPEC §4.2). Rendering it
 * without the kind in hand would print a pubkey as a hash half the time.
 */
export const KIND_REFERENCE: Record<EventKind, string> = {
  [EventKind.Genesis]: "caller",
  [EventKind.Action]: "tool",
  [EventKind.Delegation]: "delegate",
  [EventKind.Resolution]: "task",
};

/**
 * Tool ids are `sha256(name)`, so a name can only be recovered from a table of known names. The
 * console's own tools are listed as literals: their source of truth (`api/_lib/tools.ts`,
 * `api/_lib/web-tools.ts`) imports `dns` and `net` and cannot ship to the browser. A tool
 * missing here shows as its hash, which is still correct — just not friendly.
 */
const CONSOLE_TOOLS = [
  "solana.slot",
  "solana.fees",
  "solana.balance",
  "lath.verify_chain",
  "web.search",
  "web.fetch_page",
  "market.prices",
  "store.get",
  "store.set",
  // The host's own Actions on a loop's chain, which no session calls: the report a step publishes to
  // Tempo storage (`STORAGE_PUT_TOOL`, runtime/src/loop-tempo.ts), and a payment a protocol plugin
  // made (`SQUADS_PAY_TOOL`) or an attestation it published (`SAS_ATTEST_TOOL`, sdk/src/plugins.ts).
  // Literals for the reason above: the first's source is the runtime, which this file does not import.
  "storage.put",
  "squads.pay",
  "sas.attest",
  // Kept so older records stay readable: Actions an agent wrote when it paid another agent carry
  // these ids, and a name is only recoverable from a table.
  "hire",
  // Same reason: older Actions of the chain-verify tool committed `sha256("lattice.verify_chain")`,
  // and those chains still verify, so this frozen name stays in the table or their rows go back to
  // showing a bare hash.
  "lattice.verify_chain",
];

/**
 * The loop's own records beside its steps: the settlement a closed channel writes, and the lifecycle
 * records (`agent.deploy`, `loop.start`, `loop.pause`, …, `sdk/src/lifecycle.ts`) that let a list be
 * rebuilt from the chain. The lifecycle ids come from `lib/chain-records.ts`, whose test pins them to
 * the SDK's list.
 */
const KNOWN_TOOLS = [
  ...CONSOLE_TOOLS,
  LOOP_STEP_TOOL,
  LOOP_SETTLEMENT_TOOL,
  ...LIFECYCLE_TOOL_IDS,
  OFFER_TOOL,
  HIRE_SETTLED_TOOL,
  HIRE_RELEASED_TOOL,
];

const TOOL_BY_HASH = new Map(KNOWN_TOOLS.map((t) => [hex(idFromString(t)), t]));

export function toolName(reference: Uint8Array): string | undefined {
  return TOOL_BY_HASH.get(hex(reference));
}

/**
 * The words a tool is shown under where its id would read as code: a plugin's tool, `<plugin>.<action>`
 * reads as _Squads · pay_, and a lifecycle record as
 * _Loop started_. Every other tool is shown as its id. `toolName` stays the id itself, because the
 * sandbox's table and the rows built from it compare names, not labels.
 */
const TOOL_LABELS: Record<string, string> = {
  "squads.pay": "Squads · pay",
  "sas.attest": "SAS · attest",
  // A lifecycle record reads as what happened (_Loop paused_), not as its id: it is the one Action
  // on the chain a person, rather than a model, caused, and the loop page lists it under that name.
  ...LIFECYCLE_LABELS,
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** The `reference` field, rendered the way its kind means it. */
export function describeReference(record: EventRecord): { label: string; value: string; isKey: boolean } {
  const label = KIND_REFERENCE[record.kind];
  if (record.kind === EventKind.Genesis || record.kind === EventKind.Delegation) {
    return { label, value: new PublicKey(record.reference).toBase58(), isKey: true };
  }
  if (record.kind === EventKind.Action) {
    const name = toolName(record.reference);
    return { label, value: name ? toolLabel(name) : hex(record.reference), isKey: false };
  }
  return { label, value: hex(record.reference), isKey: false };
}

/** `status` is a u16 whose meaning is also per-kind: an HTTP-ish code, or a resolution. */
export function describeStatus(record: EventRecord): { text: string; tone: "good" | "bad" | "neutral" } {
  if (record.kind === EventKind.Action) {
    if (record.status === 0) return { text: "—", tone: "neutral" };
    return { text: String(record.status), tone: record.status >= 400 ? "bad" : "good" };
  }
  if (record.kind === EventKind.Resolution) {
    const names: Record<number, string> = {
      [ResolutionStatus.Success]: "success",
      [ResolutionStatus.Failed]: "failed",
      [ResolutionStatus.Aborted]: "aborted",
    };
    const text = names[record.status] ?? String(record.status);
    return { text, tone: record.status === ResolutionStatus.Success ? "good" : "bad" };
  }
  return { text: "—", tone: "neutral" };
}
