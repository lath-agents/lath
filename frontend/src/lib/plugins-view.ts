/**
 * The words for protocol plugins on screen: what the console answers about plugins, and the loop
 * receipt's pointer and card.
 *
 * `squads.pay` and `sas.attest` are on the roadmap and not in this build: no form field, grant draft,
 * item builder, plugins card or proposal row of theirs is drawn. A loop whose row carries grants says so
 * in one line on its page.
 *
 * Pure and browser-safe, with type-only imports, so the node suite (`tests/plugins-view.ts`) holds
 * the text without React and without the browser bundle of the SDK.
 *
 * Amounts are base units on the wire and in every commitment, decimal strings; they become token
 * units only here, exactly, never through a float, because a figure the owner signs or reads off a
 * card that is a rounding away from the committed one is a figure that lies.
 */
import type { LoopReceiptView } from "../types/loop";

// ---------------------------------------------------------------------------------------------
// What the console answers about plugins (`GET /api/loops`)

/**
 * The demo's SAS credential, as `GET /api/loops` reports it
 * when the switch is on and the console found the seed's `~/.lath/demo-attest/addresses.json`: the issuer,
 * credential `lath-demo`, schema `upgrade-authority` v1, and the programs the demo attests about.
 */
export interface AttestDemo {
  issuer: string;
  credential: string;
  schema: string;
  subjects: { name: string; address: string }[];
  /**
   * The loop receipt's schema (`loop-receipt` v1 under the same credential) and the key that signs
   * receipts — this console's runtime key. Present only
   * when the seed wrote the schema and the console holds a runtime key; the form's receipt pointer is
   * `{ credential, schema: receipt.schema, signer: receipt.signer }`.
   */
  receipt?: { schema: string; signer: string };
}

export interface PluginsConsole {
  /** `LATH_PROTOCOL_PLUGINS` on the console; `off` from one built before plugins. */
  protocolPlugins: "on" | "off";
  /**
   * The demo's SAS credential, only when the switch is on and the console reported a well-formed one.
   * Absent rather than `null` otherwise.
   */
  attestDemo?: AttestDemo;
}

/** `attestDemo` as the console sent it, or `null` for anything not exactly its shape. */
function attestDemoOf(raw: unknown): AttestDemo | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<AttestDemo>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!str(d.issuer) || !str(d.credential) || !str(d.schema) || !Array.isArray(d.subjects)) return null;
  // One malformed subject drops the demo rather than the subject: a list that silently lost a row
  // would prefill a grant that differs from the seed's without saying so.
  const subjects: { name: string; address: string }[] = [];
  for (const s of d.subjects as unknown[]) {
    const row = (s && typeof s === "object" ? s : {}) as { name?: unknown; address?: unknown };
    if (!str(row.name) || !str(row.address)) return null;
    subjects.push({ name: row.name, address: row.address });
  }
  // The receipt half only whole, and dropped alone: the attestation demo stands without it (the seed may
  // predate the `loop-receipt` schema), but a pointer missing its schema or its signer would be refused
  // by the console after the signature. Read nested (`receipt: { schema, signer }`) and flat
  // (`receiptSchema`, `receiptSigner`), so either console answer reads the same.
  const flat = d as { receiptSchema?: unknown; receiptSigner?: unknown };
  const receipt = receiptDemoOf(d.receipt) ?? receiptDemoOf({ schema: flat.receiptSchema, signer: flat.receiptSigner });
  return { issuer: d.issuer, credential: d.credential, schema: d.schema, subjects, ...(receipt ? { receipt } : {}) };
}

/** `attestDemo.receipt` as the console sent it: two base58 addresses, or `null`. */
function receiptDemoOf(raw: unknown): AttestDemo["receipt"] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { schema?: unknown; signer?: unknown };
  const addr = (v: unknown): v is string => typeof v === "string" && BASE58.test(v);
  return addr(r.schema) && addr(r.signer) ? { schema: r.schema, signer: r.signer } : null;
}

/**
 * The plugin half of a `GET /api/loops` answer. Read at the top level, where the console puts it, and under
 * `limits` as well, so a console that nests it there is read the same; anything malformed is `off`,
 * because a section offered on a console that would refuse its body costs the owner a signature.
 */
export function pluginsConsoleOf(body: unknown): PluginsConsole {
  const top = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const limits = (top.limits && typeof top.limits === "object" ? top.limits : {}) as Record<string, unknown>;
  const flag = top.protocolPlugins ?? limits.protocolPlugins;
  const on = flag === "on" || flag === true;
  // Only on a console with the switch on: a demo the console would refuse a receipt under is not one to
  // offer a form. A console may also send a Squads `pluginsDemo` beside it, which nothing
  // in this build reads.
  const attest = on ? attestDemoOf(top.attestDemo ?? limits.attestDemo) : null;
  return { protocolPlugins: on ? "on" : "off", ...(attest ? { attestDemo: attest } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Units

/**
 * Base units to token units, exact: `120000000` at 6 dp is `120`, `1500000` is `1.5`, `1` is
 * `0.000001`. `null` for anything that is not a whole non-negative number, or decimals the mint
 * did not answer, so a caller says _not readable_ rather than a wrong figure.
 */
export function formatUnits(base: string | null | undefined, decimals: number | null | undefined): string | null {
  if (typeof base !== "string" || !/^\d+$/.test(base)) return null;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) return null;
  const digits = base.replace(/^0+(?=\d)/, "");
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** An amount with its token, or what to say instead of one. */
export function amountText(base: string | null | undefined, decimals: number | null, token: string): string {
  const units = formatUnits(base, decimals);
  if (units !== null) return `${units} ${token}`;
  if (typeof base === "string" && /^\d+$/.test(base)) return `${base} base units`;
  return "not readable";
}

// ---------------------------------------------------------------------------------------------
// Names and links

/** `6ZoaWH…Sx9v`: enough of an address to tell it apart at a glance. */
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * The receipt is on devnet, whatever cluster the page is built for, so its explorer links name devnet
 * themselves rather than borrowing the app's cluster.
 */
export function devnetExplorerUrl(kind: "tx" | "address", value: string): string {
  return `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
}

/** The SAS seed's credential name: `attestDemo` carries addresses only. */
export const SAS_DEMO_CREDENTIAL_NAME = "lath-demo";

// ---------------------------------------------------------------------------------------------
// The form's section

/** Base58, 32 to 44 characters: what an address the console sent is held to before the screens use it. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Said in the section while it is on with no plugin picked; nothing is sent then. */
export const NOTHING_PICKED = "Pick a plugin to grant.";

/** The tone the receipt card's badge is drawn in. */
export type PluginTone = "good" | "warn" | "bad" | "neutral";

// ---------------------------------------------------------------------------------------------
// The loop's receipt on SAS

/**
 * Where a loop's receipt goes and who signs it: the SDK's `LoopReceiptPointer`, spelled here because
 * `@lath/sdk`'s Node index, which the node suite resolves, does not export the browser-only receipt
 * module. Structural, so the start body's type and this one cannot differ in shape.
 */
export interface ReceiptPointer {
  credential: string;
  schema: string;
  signer: string;
}

/** What the seed names the receipt's schema; `attestDemo` carries its address only. */
export const SAS_RECEIPT_SCHEMA_NAME = "loop-receipt v1";

/**
 * The form's one-liner when SAS · receipt is picked, saying _the decision model_ rather than Jev: Jev is
 * named only inside an ⓘ.
 */
export const RECEIPT_SUMMARY =
  "When the decision model says the goal is reached, Lath publishes a receipt of this loop on Solana.";

/** The chips under it: how many, when, and who pays the account's rent. */
export const RECEIPT_CHIPS: readonly string[] = ["1 per loop", "on achieved", "Lath pays rent"];

/**
 * The start body's `receipt` from the console's demo, or `null` when the console has no receipt schema
 * or no key to sign with. Exactly the console's own pointer, the only one it accepts.
 */
export function receiptPointerOf(attest: AttestDemo | null | undefined): ReceiptPointer | null {
  if (!attest?.receipt) return null;
  return { credential: attest.credential, schema: attest.receipt.schema, signer: attest.receipt.signer };
}

/**
 * Whether this console offers the loop receipt: protocol plugins on and a receipt pointer to send.
 * A preset that asks for the receipt picks it only then, so a console
 * without one opens that preset with the section off and says nothing about a receipt it will not
 * publish; `null` (the answer not in yet) offers nothing.
 */
export function receiptOffered(c: PluginsConsole | null | undefined): boolean {
  return !!c && c.protocolPlugins === "on" && receiptPointerOf(c.attestDemo) !== null;
}

/** A 64-hex hash as the card shows it: `abcd…1234`. Anything shorter is shown whole. */
export function hashShort(hex: string): string {
  return hex.length > 12 ? `${hex.slice(0, 4)}…${hex.slice(-4)}` : hex;
}

/**
 * The receipt's state on the loop page, and its badge's tone. Waiting is neutral: nothing is wrong
 * while the loop runs or before its stop's publish has run. A failure says why and that a restart
 * retries. None says why there is none, so a stop by hand is not read as a missing publish.
 */
export function receiptStatusLine(r: Pick<LoopReceiptView, "status" | "error">): {
  tone: PluginTone;
  badge: string;
  text: string | null;
} {
  switch (r.status) {
    case "published":
      return { tone: "good", badge: "published", text: null };
    case "failed":
      return {
        tone: "bad",
        badge: "failed",
        text: `The publish did not land${r.error ? `: ${r.error}` : ""}. The console retries on restart.`,
      };
    case "none":
      // No Jev on screen (above): the decision model's word, and the badge kept short.
      return {
        tone: "neutral",
        badge: "none",
        text: "No receipt: the loop stopped without the decision model's achieved.",
      };
    default:
      return { tone: "neutral", badge: "Waiting for achieved", text: null };
  }
}

/**
 * A published receipt's values as the card's facts: the chain position its last step committed, the
 * step count, the goal's hash, and the two costs in token units, exact (micro-USDC and USDC.e base units
 * are both six decimals). The payer is returned as given, for the card to link; empty when none paid.
 */
export function receiptValueLines(v: NonNullable<LoopReceiptView["values"]>): {
  position: string;
  steps: string;
  goal: string;
  charged: string;
  tempo: string;
  payer: string;
} {
  return {
    position: `seq ${v.seq} · head ${hashShort(v.head)}`,
    steps: String(v.steps),
    goal: hashShort(v.goal),
    charged: amountText(v.usdcCharged, 6, "USDC"),
    tempo: amountText(v.tempoSpent, 6, "USDC.e"),
    payer: v.tempoPayer,
  };
}
