/**
 * The loop key checks: the `tempoKey` a loop's policy commits, and the verdicts `verifyInference`,
 * `verifyChannels` and the charge verifier hold a channel's authorization, scopes and signer to. Gated
 * on the policy: a chain whose policy commits no key has nothing checked here.
 */
import { EventKind } from "../events";
import { hex } from "../hash";
import type { TraceStore } from "../trace-store";
import {
  type AllowedCallsLog,
  type ChannelKeyVerdict,
  type ChannelOpenedLog,
  type CommittedTempoKey,
  type InferenceRecord,
  type KeyAuthorizedLog,
  type TempoReader,
  type TempoScope,
  blobAt,
  decimal,
  genesisPolicyVersionHash,
  sameHex,
} from "./core";

// ---------------------------------------------------------------------------------------------
// The loop key checks: gated on the policy
// ---------------------------------------------------------------------------------------------

/** What `--key` prints for a chain whose policy commits no key: there was nothing to check. */
export const NO_TEMPO_KEY = "no tempoKey committed: this loop's payments were treasury-signed";

/** What it prints when no Genesis policy could be read, which is a different fact from the above. */
export const TEMPO_KEY_POLICY_UNREAD =
  "no Genesis policy is readable here, so whether a tempoKey was committed is unknown; pass --store or --gateway";

/**
 * The `tempoKey` member of a policy document, or `null` when it has none. Only the address is
 * required for the member to count as committed — every other field is held to Tempo by (a), and a
 * field that is missing or of the wrong type makes its half of (a) `failed` there, by name, rather
 * than making the whole key disappear from the audit.
 */
export function tempoKeyOfPolicy(policy: unknown): CommittedTempoKey | null {
  const k = (policy as { tempoKey?: unknown } | null)?.tempoKey as Record<string, unknown> | undefined;
  if (!k || typeof k !== "object" || typeof k.address !== "string") return null;
  return {
    address: k.address,
    ...(typeof k.token === "string" ? { token: k.token } : {}),
    ...(decimal(k.limitBase) ? { limitBase: k.limitBase as string } : {}),
    ...(typeof k.expiry === "number" && Number.isInteger(k.expiry) ? { expiry: k.expiry } : {}),
    ...(typeof k.authorizeTx === "string" ? { authorizeTx: k.authorizeTx } : {}),
    ...(k.scopes === undefined ? {} : scopesOfPolicy(k.scopes)),
  };
}

/** The `scopes` member of a committed key, normalised, or the flag that it is not a list of scopes. */
function scopesOfPolicy(v: unknown): { scopes: TempoScope[] } | { badScopes: true } {
  if (!Array.isArray(v)) return { badScopes: true };
  for (const s of v) {
    const x = s as Record<string, unknown> | null;
    if (!x || typeof x !== "object" || typeof x.address !== "string") return { badScopes: true };
    if (x.selector !== undefined && typeof x.selector !== "string") return { badScopes: true };
    if (
      x.recipients !== undefined &&
      !(Array.isArray(x.recipients) && x.recipients.every((r) => typeof r === "string"))
    )
      return { badScopes: true };
  }
  return { scopes: normaliseScopes(v as TempoScope[]) };
}

/**
 * Scopes in one canonical order and case: addresses, selectors and recipients lower case,
 * recipients sorted, the list sorted by address then selector. An empty `recipients` is dropped,
 * because Tempo reads an empty allowlist as any recipient (`ox/tempo` `KeyAuthorization.Scope`) —
 * the same permission as none, so it must compare as none. Duplicates collapse: a scope listed twice
 * permits nothing more.
 */
export function normaliseScopes(list: readonly TempoScope[]): TempoScope[] {
  const seen = new Map<string, TempoScope>();
  for (const s of list) {
    const recipients = (s.recipients ?? []).map((r) => r.toLowerCase()).sort();
    const one: TempoScope = {
      address: s.address.toLowerCase(),
      ...(s.selector ? { selector: s.selector.toLowerCase() } : {}),
      ...(recipients.length ? { recipients } : {}),
    };
    seen.set(scopeId(one), one);
  }
  return [...seen.values()].sort((a, b) =>
    a.address !== b.address
      ? a.address < b.address
        ? -1
        : 1
      : (a.selector ?? "") !== (b.selector ?? "")
      ? (a.selector ?? "") < (b.selector ?? "")
        ? -1
        : 1
      : scopeId(a) < scopeId(b)
      ? -1
      : 1
  );
}

/** One normalised scope as a comparable string. */
function scopeId(s: TempoScope): string {
  return `${s.address}|${s.selector ?? "*"}|${s.recipients?.join(",") ?? "*"}`;
}

/** One scope as a report line names it. */
function scopeText(s: TempoScope): string {
  const on = s.selector ? `${s.address} ${s.selector}` : `${s.address} (any selector)`;
  return s.recipients ? `${on} to ${s.recipients.join(", ")}` : on;
}

/**
 * How what Tempo reports differs from the committed scopes, or `null` when it does not. Set
 * equality, both sides normalised: a scope missing from Tempo is a call the loop committed to and
 * cannot make; one Tempo has beyond the committed set is a call the key may make that nobody
 * committed to — the one that matters if the key leaks.
 */
function scopeDifference(committed: readonly TempoScope[], got: AllowedCallsLog): string | null {
  if (!got.isScoped) return "is unscoped: the key may call any contract";
  const want = normaliseScopes(committed);
  const have = normaliseScopes(got.scopes);
  const haveIds = new Set(have.map(scopeId));
  const wantIds = new Set(want.map(scopeId));
  const missing = want.filter((s) => !haveIds.has(scopeId(s)));
  const extra = have.filter((s) => !wantIds.has(scopeId(s)));
  if (!missing.length && !extra.length) return null;
  const parts: string[] = [];
  if (missing.length) parts.push(`lacks the committed ${missing.map(scopeText).join("; ")}`);
  if (extra.length) parts.push(`allows ${extra.map(scopeText).join("; ")}, which the policy does not commit`);
  return parts.join(", and ");
}

/**
 * The `tempoKey` a Genesis's policy commits: the key, `null` for a policy read and found without
 * one, or `undefined` when the policy is not readable here. The last two must stay apart — the
 * first is a treasury-signed loop, the second is a question this store cannot answer — and both
 * produce no key check, because an unreadable policy cannot gate anything on.
 *
 * The policy is found through the Genesis: its preimage names its `policy_version_hash`, and the
 * runtime stores the policy document under that hash. Cached by that hash, because every step of a
 * loop opens with a Genesis naming the same policy.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function policyKeyAt(
  store: TraceStore | undefined,
  rec: InferenceRecord,
  cache: Map<string, CommittedTempoKey | null | undefined>
): Promise<CommittedTempoKey | null | undefined> {
  if (rec.kind !== EventKind.Genesis || !store) return undefined;
  let preimage: Uint8Array | null = null;
  try {
    preimage = await blobAt(store, rec.payloadHash);
  } catch {
    // An owner-encrypted store raises on a blob it cannot open: unread, not absent.
    return undefined;
  }
  if (!preimage || preimage[0] !== rec.kind) return undefined;
  const pvh = genesisPolicyVersionHash(preimage[0], preimage.slice(1));
  if (!pvh) return undefined;
  const id = hex(pvh);
  if (cache.has(id)) return cache.get(id);
  let found: CommittedTempoKey | null | undefined;
  try {
    const doc = await blobAt(store, pvh);
    found = doc ? tempoKeyOfPolicy(JSON.parse(new TextDecoder().decode(doc))) : undefined;
  } catch {
    found = undefined;
  }
  cache.set(id, found);
  return found;
}

const keyRank = { failed: 2, unchecked: 1, ok: 0 } as const;

/**
 * The worst of several key verdicts, their details joined: one failed half fails the line.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function worstKey(parts: readonly ChannelKeyVerdict[], address?: string): ChannelKeyVerdict {
  const status = parts.reduce<ChannelKeyVerdict["status"]>(
    (w, p) => (keyRank[p.status] > keyRank[w] ? p.status : w),
    "ok"
  );
  return { status, detail: parts.map((p) => p.detail).join("; "), ...(address ? { address } : {}) };
}

/**
 * (a): the committed key was authorized on the chain's payer with the committed terms. Read from
 * the one receipt the policy names (`authorizeTx`), so the audit scans no logs for it.
 *
 * Every mismatch is `failed`, by name: the policy said one thing and Tempo says another, and the
 * loop's cap is then not the cap the chain committed. Every read that does not answer is
 * `unchecked`, never `failed` — a node that is down has said nothing about the key. The limit half
 * is `unchecked` on its own when the receipt and the transaction together did not say what the
 * limit was (`KeyAuthorizedLog.limitsFrom`).
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function authorizeVerdict(
  key: CommittedTempoKey,
  payer: string | undefined,
  reader: TempoReader | undefined
): Promise<ChannelKeyVerdict> {
  const out = (status: ChannelKeyVerdict["status"], detail: string): ChannelKeyVerdict => ({
    status,
    detail,
    address: key.address,
  });
  const tx = key.authorizeTx;
  if (!tx) return out("failed", `the policy commits key ${key.address} with no authorizeTx to read it by`);
  if (!reader?.keyAuthorized) {
    return out("unchecked", `authorize ${tx} not read: no Tempo reader that reads KeyAuthorized was given`);
  }
  let log: KeyAuthorizedLog | null;
  try {
    log = await reader.keyAuthorized(tx, key.address);
  } catch (e) {
    return out("unchecked", `authorize ${tx} could not be read on Tempo: ${(e as any)?.message ?? String(e)}`);
  }
  if (!log) return out("unchecked", `authorize ${tx} could not be read on Tempo`);
  if (log.status !== 1) return out("failed", `authorize ${tx} reverted (status ${log.status}): no key was authorized`);
  if (!log.publicKey) {
    return out("failed", `authorize ${tx} succeeded but carries no KeyAuthorized event from the account keychain`);
  }
  if (!sameHex(log.publicKey, key.address)) {
    return out("failed", `authorize ${tx} authorized key ${log.publicKey}, not the committed ${key.address}`);
  }
  if (!payer) {
    // Nothing on this chain says who paid, so the root cannot be held to anything yet.
    return out("unchecked", `authorize ${tx} names root ${log.account}, and no payer on this chain to hold it to`);
  }
  if (!sameHex(log.account, payer)) {
    return out(
      "failed",
      `authorize ${tx} rooted key ${key.address} on ${log.account}, not on the chain's payer ${payer}`
    );
  }
  if (key.expiry === undefined) return out("failed", `the policy commits key ${key.address} with no integer expiry`);
  if (log.expiry !== key.expiry) {
    return out("failed", `authorize ${tx} set expiry ${log.expiry}, not the committed ${key.expiry}`);
  }
  if (!key.token || !key.limitBase) {
    return out("failed", `the policy commits key ${key.address} with no token or limitBase to hold its limit to`);
  }
  const terms = `root ${log.account}, expiry ${log.expiry}`;
  // The last entry for the token, not the first: `keyAuthorized` lists the receipt's
  // `SpendingLimitUpdated` logs in order, and a later one in the same transaction is an update the
  // keychain enforces over the earlier (`TempoRpcReader.keyAuthorized`, where a log also outranks the
  // signed payload's figure for its token).
  const limit = [...log.limits].reverse().find((l) => sameHex(l.token, key.token));
  if (!limit) {
    if (log.limitsFrom === "authorization") {
      return out("failed", `authorize ${tx} set no limit on ${key.token}: the key may spend it without a cap`);
    }
    return out("unchecked", `authorize ${tx} ok (${terms}); limit unchecked: no log or payload said it`);
  }
  if (limit.amount.toString() !== key.limitBase) {
    return out(
      "failed",
      `authorize ${tx} set a limit of ${limit.amount} on ${key.token}, not the committed ${key.limitBase}`
    );
  }
  return out("ok", `authorize ${tx} ok (${terms}, limit ${limit.amount} of ${key.token})`);
}

/**
 * (d): the calls Tempo lets the key make are exactly the committed `scopes`. Only for a key whose
 * policy commits scopes; an unscoped key has no (d).
 *
 * The keychain's live `getAllowedCalls(payer, key)` first: a scoped answer equal to the committed
 * set is `ok`; a different set, or an unscoped answer, is `failed` — the key Tempo enforces is not
 * the one the chain committed, and a leaked key could make the calls the difference names.
 *
 * A stopped loop's key is revoked by design, and a revoked key's live scopes say nothing. So when the
 * live read is not evidence — revoked, unreadable, or no reader that makes it — the scopes are read
 * from the authorize transaction's signed key authorization instead, as (a) reads the limit there,
 * which survives the revoke. That is what Tempo authorized, not what it holds now: a `setAllowedCalls`
 * between the authorize and the revoke emits no log and would not show, and the line says which of
 * the two was read. Neither readable is `unchecked`, with "key revoked" when that is why.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function scopesVerdict(
  key: CommittedTempoKey,
  payer: string | undefined,
  reader: TempoReader | undefined
): Promise<ChannelKeyVerdict> {
  const out = (status: ChannelKeyVerdict["status"], detail: string): ChannelKeyVerdict => ({
    status,
    detail,
    address: key.address,
  });
  if (key.badScopes || !key.scopes) {
    return out("failed", `the policy commits key ${key.address} with scopes that are not a list of scopes`);
  }
  const want = key.scopes;
  const n = `${want.length} committed scope${want.length === 1 ? "" : "s"}`;
  let notLive: string;
  if (!reader?.allowedCalls) notLive = "getAllowedCalls not read: no Tempo reader that reads it was given";
  else if (!payer) notLive = `getAllowedCalls not read: no payer on this chain to read key ${key.address} on`;
  else {
    let got: AllowedCallsLog | null = null;
    let why = "";
    try {
      got = await reader.allowedCalls(payer, key.address);
    } catch (e) {
      why = `: ${(e as any)?.message ?? String(e)}`;
    }
    if (!got) notLive = `getAllowedCalls(${payer}, ${key.address}) could not be read on Tempo${why}`;
    else if (got.revoked) notLive = `key revoked: the keychain no longer holds ${key.address}'s scopes on ${payer}`;
    else {
      const diff = scopeDifference(want, got);
      if (diff) return out("failed", `getAllowedCalls(${payer}, ${key.address}) ${diff}`);
      return out("ok", `getAllowedCalls answers the ${n}`);
    }
  }
  const tx = key.authorizeTx;
  if (tx && reader?.keyAuthorized) {
    let log: KeyAuthorizedLog | null = null;
    try {
      log = await reader.keyAuthorized(tx, key.address);
    } catch {
      log = null;
    }
    // Only an authorization of this key that succeeded speaks for it; (a) names every other case.
    if (log && log.status === 1 && log.scopes && sameHex(log.publicKey, key.address)) {
      const diff = scopeDifference(want, log.scopes);
      if (diff) return out("failed", `authorize ${tx}'s key authorization ${diff}`);
      return out("ok", `authorize ${tx} authorized the ${n} (${notLive})`);
    }
  }
  return out("unchecked", notLive);
}

/**
 * What (b) needs of one channel: its id, the signers its vouchers name, and where it opened.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export interface ChannelSigners {
  channelId: string;
  /** Every voucher on the channel that names a `signer`, ascending by seq. */
  signers: { seq: bigint; signer: string }[];
  /** How many vouchers on this chain the channel carries, for the line. */
  vouchers: number;
  /** The smallest `openBlock` a voucher on it recorded, decimal. */
  openBlock?: string;
}

/**
 * (b): the channel was opened with the committed key as its `authorizedSigner`, and every voucher
 * that names a signer names that key. The second half is the chain against itself and needs no
 * reader; the first is Tempo's word and is `unchecked` whenever Tempo does not answer.
 *
 * A voucher with no `signer` is not held against the key: absence is what an older record, whose
 * transport did not carry the field, looks like, and the channel's `authorizedSigner` already decides
 * who could sign anything on it — the escrow accepts no voucher from anyone else.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function signerVerdict(
  ch: ChannelSigners,
  key: CommittedTempoKey,
  reader: TempoReader | undefined
): Promise<ChannelKeyVerdict> {
  const out = (status: ChannelKeyVerdict["status"], detail: string): ChannelKeyVerdict => ({
    status,
    detail,
    address: key.address,
  });
  const other = ch.signers.find((s) => !sameHex(s.signer, key.address));
  if (other) {
    return out(
      "failed",
      `seq ${other.seq}'s voucher on channel ${ch.channelId} was signed by ${other.signer}, not the committed key ${key.address}`
    );
  }
  const named = `${ch.signers.length} of ${ch.vouchers} vouchers name the key as signer`;
  if (!reader?.channelOpened) {
    return out("unchecked", `authorizedSigner not read: no Tempo reader that reads ChannelOpened was given; ${named}`);
  }
  const from = ch.openBlock ? ` from block ${ch.openBlock}` : "";
  let log: ChannelOpenedLog | null;
  try {
    log = await reader.channelOpened(ch.channelId, ch.openBlock);
  } catch (e) {
    return out(
      "unchecked",
      `the ChannelOpened log of ${ch.channelId} could not be read${from}: ${(e as any)?.message ?? String(e)}; ${named}`
    );
  }
  if (!log) return out("unchecked", `the ChannelOpened log of ${ch.channelId} could not be read${from}; ${named}`);
  if (!sameHex(log.channelId, ch.channelId)) {
    // A reader that answered for another id has not answered for this one.
    return out("unchecked", `asked for ${ch.channelId}'s ChannelOpened, the reader answered for ${log.channelId}`);
  }
  if (!sameHex(log.authorizedSigner, key.address)) {
    return out(
      "failed",
      `channel ${ch.channelId} was opened with authorizedSigner ${log.authorizedSigner}, not the committed key ${key.address}`
    );
  }
  const at = log.blockNumber ? ` at block ${log.blockNumber}` : "";
  return out("ok", `channel ${ch.channelId} opened${at} with the key as authorizedSigner; ${named}`);
}

/**
 * The smaller of two decimal block numbers, either possibly absent.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function lowerBlock(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return BigInt(a) <= BigInt(b) ? a : b;
}
