import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { canonicalJson, hex, sha256, utf8 } from "./hash";

/**
 * Everything Lath needs from a key holder. Deliberately narrower than Anchor's `Wallet`
 * (no `signAllTransactions`, no `payer`) so browser adapters, KMS/HSM services and remote
 * signers satisfy it without exposing a secret key. A raw `Keypair` is accepted anywhere a
 * signer is, and wrapped by `toLathSigner`.
 */
export interface LathSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}

export type SignerLike = LathSigner | Keypair;

function isKeypair(s: SignerLike): s is Keypair {
  return s instanceof Keypair || (typeof (s as any).secretKey !== "undefined" && !(s as any).signTransaction);
}

/** Normalises a `Keypair` or any `LathSigner` into a `LathSigner`. */
export function toLathSigner(s: SignerLike): LathSigner {
  if (!isKeypair(s)) return s as LathSigner;
  const kp = s as Keypair;
  return {
    publicKey: kp.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof VersionedTransaction) tx.sign([kp]);
      else (tx as Transaction).partialSign(kp);
      return tx;
    },
  };
}

/**
 * Adapts a `LathSigner` to Anchor's `Wallet` interface. Only used to construct a provider
 * for transaction *building* — Lath submits through the signer itself, never the provider.
 */
export function toAnchorWallet(signer: LathSigner) {
  return {
    publicKey: signer.publicKey,
    signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => signer.signTransaction(tx),
    signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) =>
      Promise.all(txs.map((tx) => signer.signTransaction(tx))),
  };
}

/**
 * What a signed console message is for.
 *
 * The purpose opens the message's **statement line** (after the domain and the address), which is
 * what stops a signature given for one thing being replayed as another: a wallet that signed "open
 * a session" has not signed "deploy an agent". `"Lath agent"` covers the owner writes that change a
 * console record and nothing on chain (archive, *use version n*); `"Lath template"` covers template
 * writes.
 *
 * The purpose alone is not enough: one `"Lath agent"` signature would be good for archive,
 * unarchive and *use version n* on any agent the wallet owns, for as long as its nonce was unspent.
 * So a signature also names what it is for and on what (`AuthBinding`), and the route refuses one
 * whose pair is not the request's own.
 */
export type AuthPurpose =
  | "Lath console session"
  | "Lath deploy"
  | "Lath loop"
  | "Lath market"
  | "Lath agent"
  | "Lath template";

/**
 * What one signature is good for: the verb and the thing it acts on, e.g. `{ action: "archive",
 * target: <agent id> }`. The route derives the same pair from the request it is handling and
 * compares, so a signature cannot be carried to another verb or another agent. These are what the
 * statement line the wallet shows the person is made of.
 *
 * `body` is the third binding, for the one verb whose request is more than its target: a loop
 * start. Its target names the agent the loop runs on, and nothing else about the start — the
 * instruction, the budget, the trigger — so without it a signature harvested from one start could
 * be posted with any other body on that agent, up to the cap. It is the hex
 * SHA-256 of the canonical start body (`loopStartBodyHash`), and the route refuses a signature
 * whose hash is not the hash of the body it arrived with. Absent for every other verb, whose body
 * is nothing but its action and its target.
 */
export interface AuthBinding {
  action: string;
  target: string;
  body?: string;
}

/**
 * The alphabet an action or target may use. No whitespace, so no newline and no space: the
 * statement line is `<purpose>: <action> <target>`, split on its spaces, and a target of
 * `"x\nwallet: <someone else>"` would put a second line into the signed text that the
 * line-oriented parse on the other end would have to guess about. Agent ids, template ids, loop
 * ids, names `sanitize` produced and the fixed verbs all fit.
 */
const BOUND_FIELD = /^[A-Za-z0-9._:-]{1,96}$/;
/** A bound body is a SHA-256, lowercase hex. */
const BODY_HASH = /^[0-9a-f]{64}$/;
/**
 * A domain is an authority (`host[:port]`), a URI an http(s) origin — the two things the console
 * compares them with. Neither may hold whitespace, for the reason `BOUND_FIELD` may not.
 */
const DOMAIN = /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
const URI = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;

/** The line that makes the message one a wallet recognises as a sign-in request for a site. */
export const SIWS_SUFFIX = " wants you to sign in with your Solana account:";

/** The SIWS parameters every console message carries beside its binding. */
export interface AuthParams {
  /** Where the signer is: `window.location.host`, which the console checks against its own. */
  domain: string;
  /** `window.location.origin`, checked the same way. */
  uri: string;
  cluster: string;
  wallet: string;
  issued: string;
  nonce: string;
}

/**
 * The exact text a wallet signs, for the six routes that take a signed message instead of a
 * transaction.
 *
 * It lives in the SDK because it is a wire contract with two ends and no schema: the browser
 * builds these bytes and the wallet signs them, the route rebuilds them and checks the signature
 * against them. A whitespace change here invalidates every signature in flight — so both ends
 * call one function rather than each holding a copy of the template and hoping.
 *
 * The shape is Sign-In-With-Solana's (Phantom's SIWS, the Solana reading of EIP-4361): the domain
 * first, the address, a one-line statement, then the `URI`, `Version`, `Chain ID`, `Nonce`,
 * `Issued At` and, for a loop start, `Request ID` fields in that order. Two reasons. A message that
 * names the site asking for it can be refused by the console when that site is not the console —
 * otherwise a lookalike page could get the owner to sign byte-identical text and post it to the
 * real console — and a wallet that recognises
 * the shape shows the person the domain and warns when it is not the page they are on, which
 * wallets do for this shape and for no other. The Lath lines are the statement — the purpose, the
 * action and the target — on one line, because the shape allows the statement one.
 *
 * Throws when a field is outside its alphabet, rather than producing text whose lines the server
 * would then have to disambiguate.
 */
export function authMessage(purpose: AuthPurpose, p: AuthBinding & AuthParams): string {
  for (const name of ["action", "target"] as const) {
    if (!BOUND_FIELD.test(p[name]))
      throw new Error(`a signed ${name} must match ${BOUND_FIELD}: ${JSON.stringify(p[name])}`);
  }
  if (p.body !== undefined && !BODY_HASH.test(p.body)) {
    throw new Error(`a signed body must be a hex sha256: ${JSON.stringify(p.body)}`);
  }
  if (!DOMAIN.test(p.domain)) throw new Error(`a signed domain must match ${DOMAIN}: ${JSON.stringify(p.domain)}`);
  if (!URI.test(p.uri)) throw new Error(`a signed uri must be an http(s) origin: ${JSON.stringify(p.uri)}`);
  return (
    `${p.domain}${SIWS_SUFFIX}\n${p.wallet}\n\n` +
    `${purpose}: ${p.action} ${p.target}\n\n` +
    `URI: ${p.uri}\nVersion: 1\nChain ID: ${p.cluster}\nNonce: ${p.nonce}\nIssued At: ${p.issued}` +
    (p.body === undefined ? "" : `\nRequest ID: ${p.body}`)
  );
}

/**
 * The hash a loop start's signature binds: the hex SHA-256 of the body's canonical JSON, less the
 * `auth` it is posted with (which cannot be inside what it signs). The body is first passed through
 * JSON — `JSON.parse(JSON.stringify(...))` — so the browser hashing the object it is about to send
 * and the route hashing the object it parsed agree on what `undefined`, a `Date` or a `toJSON`
 * became on the wire.
 */
export function loopStartBodyHash(body: object): string {
  const { auth: _auth, ...rest } = body as Record<string, unknown>;
  return hex(sha256(utf8(canonicalJson(JSON.parse(JSON.stringify(rest))))));
}

/**
 * The binding a `"Lath loop"` signature names, from the body it is posted with. One definition for
 * the browser's `postLoop`, the scripts and `POST /api/loops`, because the loop body is the one
 * where the binding is derived rather than read off a single field, and two copies of a derivation
 * drift.
 *
 * A start names the agent it runs (lowercased, as the route compares ids), or the template when
 * the start is a stored template alone, and the hash of the whole body it asks for; every other
 * verb names the loop it acts on.
 */
export function loopAuthBinding(body: {
  action?: string;
  id?: string;
  agentId?: string;
  templateId?: string;
}): AuthBinding {
  const action = body.action ?? "start";
  if (action !== "start") return { action, target: String(body.id ?? "") };
  return {
    action,
    target: String(body.agentId ?? "").toLowerCase() || String(body.templateId ?? ""),
    body: loopStartBodyHash(body),
  };
}
