/**
 * The loop's receipt on SAS (`_lib/loops.ts` re-exports it): whether a start may ask for one, when a
 * stopped loop owes it, its values, publishing it after the stop, its view, and the protocol-plugin
 * and demo-issuer fields of the list answer.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type Keypair, PublicKey, type Connection } from "@solana/web3.js";
import {
  LOOP_RECEIPT_SCHEMA_NAME,
  LOOP_RECEIPT_SCHEMA_VERSION,
  SAS_SCHEMA_NAME,
  SAS_SCHEMA_VERSION,
  loopReceiptAddress,
  sasCredentialAddress,
  sasSchemaAddress,
  type LoopReceipt,
  type LoopReceiptPointer,
  validateLoopReceiptPointer,
} from "@lath/sdk";
import { protocolPluginsEnabled, publishLoopReceipt } from "./receipt";
import type { LoopReceiptView } from "../../../types/loop";
import { loadKeypair, rpcFor } from "./runner";
import { errorText, GOAL_REACHED_STOP_REASON, type Refusal } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import { digits, loopSpentOf } from "./loop-budget";
import { readLoop, readLoops, updateLoop } from "./loop-registry";

// ─── The loop's receipt on SAS ─────────────────────────────────────────────────────────────────────

/**
 * The devnet calls the loop receipt makes, behind one object so a suite can stand fakes in: the real
 * ones send devnet transactions, and nothing under `tests/` may. Named for the per-loop Solana keys that
 * protocol-plugin grants use, a roadmap feature; in this build the receipt is its one caller.
 */
export interface SolanaKeySeams {
  /** Whether this console offers protocol plugins — in this build SAS · receipt: `LATH_PROTOCOL_PLUGINS`. */
  enabled: () => boolean;
  /** The console's devnet connection (`rpcFor()`), which every chain read and write here already uses. */
  connection: () => Connection;
  /** The key that pays the console's devnet fees: the runtime keypair. `null` on a console without one. */
  feePayer: () => Keypair | null;
  /** The loop receipt's one devnet write (`_lib/receipt.ts`). */
  publishReceipt: typeof publishLoopReceipt;
}

const DEFAULT_SOLANA_KEY_SEAMS: SolanaKeySeams = {
  enabled: protocolPluginsEnabled,
  connection: () => rpcFor(),
  feePayer: () => loadKeypair(),
  publishReceipt: publishLoopReceipt,
};

let solanaKeySeams: SolanaKeySeams = DEFAULT_SOLANA_KEY_SEAMS;

/** Replaces some of the devnet calls for a suite; `undefined` puts the real ones back. */
export function setSolanaKeySeamsForTests(seams: Partial<SolanaKeySeams> | undefined): void {
  solanaKeySeams = seams ? { ...DEFAULT_SOLANA_KEY_SEAMS, ...seams } : DEFAULT_SOLANA_KEY_SEAMS;
}

/** A base58 address, or `null`: what every address the demo files name is held to before it reaches the wire. */
function base58Address(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return null;
  try {
    return new PublicKey(v).toBase58() === v ? v : null;
  } catch {
    return null;
  }
}

/** The key as a step's policy commits it (`SolanaKeyPolicy`): the address and when it was made, nothing else. */
export function solanaKeyPolicyOf(key: LoopRecord["solanaKey"]): { address: string; createdAt: number } | undefined {
  return key ? { address: key.address, createdAt: key.createdAt } : undefined;
}

/**
 * A start body's `receipt`, checked: the switch is on, the pointer is three base58 keys, and they are this
 * console's own — the demo credential, its `loop-receipt` schema and this console's runtime key — so a loop
 * can never commit a pointer whose receipt this console would not or could not publish. Refused, not dropped,
 * for the reason a grant is: the signature binds it.
 */
export function checkReceipt(body: { receipt?: unknown }): { receipt: LoopReceiptPointer | null } | Refusal {
  const raw = body.receipt;
  if (raw === undefined) return { receipt: null };
  const refuse = (why: string): Refusal => ({ error: `receipt: ${why}`, status: 400 });
  if (!solanaKeySeams.enabled()) {
    return refuse(
      "this console has protocol plugins off (LATH_PROTOCOL_PLUGINS), so a start asking for a receipt is refused " +
        "rather than run without the receipt its signature binds; start it without one, or on a console that has them on"
    );
  }
  const checked = validateLoopReceiptPointer(raw);
  if ("reason" in checked) return refuse(checked.reason);
  const demo = attestDemo();
  if (!demo?.receipt) {
    return refuse("this console has no receipt schema (npm run -s demo-attest:seed) or no runtime key to sign with");
  }
  const p = checked.pointer;
  if (p.credential !== demo.credential || p.schema !== demo.receipt.schema || p.signer !== demo.receipt.signer) {
    return refuse("the pointer is not this console's: its credential, its receipt schema and its runtime key");
  }
  return { receipt: p };
}

/**
 * Whether a loop stopped on Jev's `achieved` with a record that says so: the stop reason, the last step's
 * goal check, and that step's checkpoint written on its own clock. A checkpoint a Retry wrote late is at 200
 * whatever the step concluded (`runtime/src/loop.ts`), and the receipt's check holds the record it points at
 * to 201 (`sdk/src/audit/receipt.ts`, `reached`), so a run a Retry ended on its goal owes no receipt: one
 * published for it would be one its own audit refutes.
 */
function stoppedOnAchieved(loop: LoopRecord): boolean {
  const last = loop.history.at(-1);
  return (
    loop.status === "stopped" &&
    loop.stopReason === GOAL_REACHED_STOP_REASON &&
    last?.goalCheck?.outcome === "achieved" &&
    last.landedOnRetryAt === undefined
  );
}

/** Whether a loop's receipt is owed: a pointer, a stop on `achieved`, and no publish that landed. */
export function receiptOwed(loop: LoopRecord): boolean {
  return !!loop.receipt && stoppedOnAchieved(loop) && (!loop.receiptResult || !!loop.receiptResult.error);
}

/**
 * What the receipt says, from the row after the settle: the last checkpoint's seq and head, the steps, the
 * goal's hash, what the owner was charged, and what the channel paid on Tempo with the key that signed its
 * vouchers (the loop's own access key, or the treasury on a loop without one).
 */
export function loopReceiptValues(loop: LoopRecord): LoopReceipt | { error: string } {
  const s = loop.snapshot;
  if (!s.lastSeq || !s.lastHead) return { error: "the loop has no checkpoint for its receipt to point at" };
  if (!loop.goalHash || !/^[0-9a-f]{64}$/.test(loop.goalHash)) return { error: "the loop has no goal hash" };
  const tempo = s.tempo;
  const spent = digits(tempo?.spent)
    ? String(tempo!.spent)
    : loop.history.reduce((n, h) => n + (digits(h.tempoSpent) ? BigInt(h.tempoSpent!) : 0n), 0n).toString();
  const payer = String(loop.tempoKey?.address ?? tempo?.payer ?? "").toLowerCase();
  return {
    agent: loop.agentId.toLowerCase(),
    loop: loop.id,
    seq: String(s.lastSeq),
    head: String(s.lastHead).toLowerCase(),
    steps: s.steps,
    goal: loop.goalHash,
    usdcCharged: loopSpentOf(loop).toString(),
    tempoSpent: spent,
    tempoPayer: payer,
  };
}

const publishingReceipts = new Set<string>();

/**
 * Publishes a stopped loop's receipt when it is owed, and keeps the outcome on the row. Never throws: it runs
 * last in the stop's chain and from the console's first pass. A failure is kept as `receiptResult.error` and
 * tried again at the next console start, not on a timer: a refused receipt (an unauthorized key, an unfunded
 * one) is the operator's to fix first.
 */
export async function publishReceiptAfterStop(id: string): Promise<void> {
  let loop: LoopRecord | null;
  try {
    loop = readLoop(id);
  } catch (e) {
    console.warn(`[loops] ${id}: the registry could not be read to publish its receipt: ${errorText(e)}`);
    return;
  }
  if (!loop || !receiptOwed(loop) || publishingReceipts.has(id)) return;
  publishingReceipts.add(id);
  const pointer = loop.receipt!;
  const values = loopReceiptValues(loop);
  const keep = (result: NonNullable<LoopRecord["receiptResult"]>) => {
    try {
      updateLoop(id, (l) => ({ ...l, receiptResult: result }));
    } catch (e) {
      console.error(`[loops] ${id}: the receipt is not on the row (${errorText(e)}); ${JSON.stringify(result)}`);
    }
  };
  try {
    if ("error" in values) {
      keep({ at: Date.now(), error: values.error });
      console.warn(`[loops] ${id}: no receipt: ${values.error}`);
      return;
    }
    const keys = solanaKeySeams;
    const signer = keys.feePayer();
    if (!signer) throw new Error("the console has no runtime key to sign the receipt with");
    const published = await keys.publishReceipt({
      connection: keys.connection(),
      signer,
      pointer,
      loopId: id,
      values,
    });
    keep({
      at: Date.now(),
      attestation: published.attestation,
      ...(published.signature ? { signature: published.signature } : {}),
      ...(published.slot !== undefined ? { slot: published.slot } : {}),
      ...(published.found ? { found: true as const } : {}),
      values,
    });
    console.log(
      `[loops] ${id}: published its receipt ${published.attestation}` +
        (published.signature ? ` (${published.signature})` : ", found already there")
    );
  } catch (e) {
    const error = errorText(e);
    console.warn(`[loops] ${id}: the receipt was not published, tried again at the next console start: ${error}`);
    keep({ at: Date.now(), error, ...("error" in values ? {} : { values }) });
  } finally {
    publishingReceipts.delete(id);
  }
}

/** The console start's pass: every receipt owed on a loop whose channel is settled. Never rejects. */
export async function publishOwedReceipts(): Promise<void> {
  let loops: LoopRecord[];
  try {
    loops = Object.values(readLoops());
  } catch (e) {
    console.warn(`[loops] the receipt pass could not read the registry: ${errorText(e)}`);
    return;
  }
  for (const loop of loops) {
    // A loop whose channel is still open is published by its own stop's chain, after the settle.
    if (!receiptOwed(loop) || loop.channel || loop.snapshot.tempo?.closed === false) continue;
    await publishReceiptAfterStop(loop.id);
  }
}

/** The loop page's receipt, from the row alone: no chain read. `null` on a loop without one. */
export function loopReceiptView(loop: LoopRecord): LoopReceiptView | null {
  const p = loop.receipt;
  if (!p) return null;
  const r = loop.receiptResult;
  const status: LoopReceiptView["status"] =
    r && !r.error
      ? "published"
      : r?.error
      ? "failed"
      : loop.status === "stopped" && !stoppedOnAchieved(loop)
      ? "none"
      : "waiting";
  return {
    status,
    credential: p.credential,
    schema: p.schema,
    signer: p.signer,
    address: loopReceiptAddress(p, loop.id),
    ...(r?.signature ? { signature: r.signature } : {}),
    ...(r?.slot !== undefined ? { slot: r.slot } : {}),
    ...(r ? { at: r.at } : {}),
    ...(r?.error ? { error: r.error } : {}),
    ...(r?.values ? { values: r.values } : {}),
  };
}

/**
 * The list answer's protocol-plugin field: the switch SAS · receipt rides on. An older row started with
 * grants has no card on its page and no demo treasury to name its Squads rows by: grants are a roadmap
 * feature this build does not draw.
 */
export function pluginsListFields(): { protocolPlugins: "on" | "off" } {
  return { protocolPlugins: solanaKeySeams.enabled() ? "on" : "off" };
}

/**
 * What `GET /api/loops` tells the form about the demo's attestation issuer: the credential and schema an
 * `sas.attest` grant names and the programs it may attest about. Public addresses only.
 */
export interface AttestDemo {
  issuer: string;
  credential: string;
  schema: string;
  subjects: { name: string; address: string }[];
  /**
   * The loop receipt's schema (`loop-receipt` v1 under the same credential) and the key that signs
   * receipts — this console's runtime key. Present only when the seed wrote the schema and the console
   * holds a runtime key; the form's receipt pointer is
   * `{ credential, schema: receipt.schema, signer: receipt.signer }`.
   */
  receipt?: { schema: string; signer: string };
}

/**
 * `LATH_DEMO_ATTEST`, default `~/.lath/demo-attest/addresses.json`: what `scripts/demo-attest/seed.ts`
 * writes, under the operator's home. The issuer's key file sits in the same directory and is
 * never read here: the console needs the issuer's address, not its say.
 */
export function demoAttestFile(): string {
  return process.env.LATH_DEMO_ATTEST || path.join(os.homedir(), ".lath", "demo-attest", "addresses.json");
}

/**
 * The demo issuer the seed script wrote, reduced to what the form needs, or `null` when the file is absent or
 * is not one. Read field by field: the file is the operator's. The credential must be the issuer's
 * `credentialName` and the schema `upgrade-authority` v1 under it, by derivation — the only schema the plugin
 * attests under — so a file naming any other is not offered to a form whose start would then attest nothing.
 */
export function attestDemo(
  file: string = demoAttestFile(),
  receiptSigner: string | null = runtimeKeyAddress() ?? null
): AttestDemo | null {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const issuer = base58Address(raw.issuer);
  const credential = base58Address(raw.credential);
  const schema = base58Address(raw.schema);
  if (!issuer || !credential || !schema) return null;
  if (typeof raw.credentialName !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(raw.credentialName)) return null;
  try {
    if (sasCredentialAddress(issuer, raw.credentialName) !== credential) return null;
    if (sasSchemaAddress(credential, SAS_SCHEMA_NAME, SAS_SCHEMA_VERSION) !== schema) return null;
  } catch {
    return null;
  }
  if (!Array.isArray(raw.subjects) || raw.subjects.length === 0) return null;
  const subjects: AttestDemo["subjects"] = [];
  for (const s of raw.subjects as any[]) {
    const address = base58Address(s?.address);
    if (!address || typeof s?.name !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(s.name)) return null;
    subjects.push({ name: s.name, address });
  }
  // The loop receipt's schema, offered only when it derives as `loop-receipt` v1 under this credential
  // and the console has a key to sign with; otherwise the answer carries no `receipt`.
  const receiptSchema = base58Address(raw.receiptSchema);
  let receipt: AttestDemo["receipt"];
  if (receiptSchema && receiptSigner) {
    try {
      if (sasSchemaAddress(credential, LOOP_RECEIPT_SCHEMA_NAME, LOOP_RECEIPT_SCHEMA_VERSION) === receiptSchema) {
        receipt = { schema: receiptSchema, signer: receiptSigner };
      }
    } catch {
      /* not offered */
    }
  }
  return { issuer, credential, schema, subjects, ...(receipt ? { receipt } : {}) };
}

/** The console's runtime key, base58, or `undefined` on a console without one: the receipts' signer. */
function runtimeKeyAddress(): string | undefined {
  try {
    return solanaKeySeams.feePayer()?.publicKey.toBase58();
  } catch {
    return undefined;
  }
}

/**
 * The list answer's `attestDemo`, only when protocol plugins are on: the demo issuer once the seed has
 * run, else `null`, so an answer from a console that is on says "no issuer here" rather than leaving the
 * field out. Off, the key is absent (not `attestDemo: null`) and the file is not read at all, as the
 * treasury's is not, so a switch-off answer is the base's bytes.
 */
export function attestListFields(): { attestDemo?: AttestDemo | null } {
  if (!solanaKeySeams.enabled()) return {};
  return { attestDemo: attestDemo() };
}
