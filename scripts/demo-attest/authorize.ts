/**
 * The issuer's say over who may attest under `lath-demo`, and the wall SAS is.
 *
 * ```bash
 * npm run -s demo-attest:authorize -- --loop <id> --dry-run   # read the loop's key, simulate adding it
 * npm run -s demo-attest:authorize -- --loop <id>             # the issuer adds it: the card turns active
 * npm run -s demo-attest:authorize -- --loop <id> --remove    # the issuer takes it back out
 * npm run -s demo-attest:authorize -- --outside               # a key nobody authorized attests: SAS 5
 * npm run -s demo-attest:authorize -- --close <subject>       # the issuer closes its live attestation
 * ```
 *
 * **Authorizing** is one `changeAuthorizedSigners` (3) signed by the issuer, the credential's authority,
 * with the **whole** new list: the signers on devnet now, plus the loop's key (or minus it, with
 * `--remove`). The loop's key is the one its `"Lath loop"` start made (no start in this build makes
 * one — grants are on the roadmap — so `--loop` reads only a stored loop that was granted one, and
 * the loop receipt's signer, the console's runtime key, goes in with `--key`), never a credential
 * authority; the issuer's authorization is the issuer's act, not a Lath prompt. The payer
 * pays the fee and any rent the longer list needs. Re-runnable: a key already on the list, or already off
 * it, sends nothing. The issuer itself is never removed.
 *
 * **`--outside`** has a fresh key that the issuer never authorized attest the first subject's upgrade authority as
 * the chain has it now, in the schema's own encoding, so the only thing wrong is who signs: SAS answers
 * 5 `SignerNotAuthorized`. It is simulated, then — without `--dry-run` — sent with preflight off, so the
 * refusal lands with a signature an explorer shows; the payer pays its fee, and the outsider holds nothing.
 *
 * **`--close <subject name|program id>`** has the issuer close the live attestation about that program
 * under `upgrade-authority` v1 — the loop's output, which outlives the loop, and which a demo
 * rehearsed twice must clear between takes (the issuer can close it). SAS lets any authorized
 * signer close any attestation under the credential, and the issuer is the first of them. The
 * issuer is the instruction's payer, so the account's rent goes back to the issuer; the payer only pays
 * the transaction's fee. With no attestation at that address it refuses and sends nothing.
 *
 * Flags:
 * - `--loop <id>`: the loop's key from the console's `GET <console>/api/loops?id=<id>` (`--console`,
 *   default `http://localhost:3000`); or `--key <address>`.
 * - `--remove`; `--outside`; `--close <subject name|program id>` (a name from `addresses.json`'s subjects).
 * - `--dry-run`, `--rpc`, `--payer`, `--dir` as in `seed.ts`.
 */
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  SAS_NO_AUTHORITY,
  SAS_SCHEMA_NAME,
  decodeSasClaim,
  programDataAddress,
  sasAttestationAddress,
  sasClaimBytes,
  sasKindOf,
} from "@lath/sdk";
import {
  DEMO_CREDENTIAL_NAME,
  SAS,
  arg,
  attestDir,
  changeSignersIx,
  closeAttestationIx,
  connectSas,
  createAttestationIx,
  decodeAttestation,
  decodeCredential,
  demoAddresses,
  explorerAddress,
  explorerTx,
  flag,
  loadPayer,
  readAttest,
  readKeypair,
  readLanded,
  refusal,
  sasCode,
  send,
  simulate,
  sol,
  writeAttest,
  type AuthorizationRecord,
} from "./common";

/** A loop id as `limit.ts` holds it: nothing that walks out of a path or a query. */
const LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * The loop's Solana key from the console: `loop.plugins.solanaKey.address`, which the plugins card
 * carries (`loopPluginsView`); else an SAS item's `signer` on the same card; else a top-level
 * `solanaKey`. A loop started with `LATH_PROTOCOL_PLUGINS` off has none, and this says so rather than
 * guessing.
 */
async function loopKeyFromConsole(loopId: string): Promise<PublicKey> {
  const base = (arg("console") ?? "http://localhost:3000").replace(/\/+$/, "");
  const url = `${base}/api/loops?id=${encodeURIComponent(loopId)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`the console at ${base} did not answer (${e instanceof Error ? e.message : e}); pass --console`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${String(body?.error ?? "")}`.trim());
  const loop = (body?.loop ?? {}) as Record<string, unknown>;
  const plugins = (loop.plugins ?? {}) as Record<string, unknown>;
  const pick = (v: unknown): string | undefined =>
    typeof v === "string"
      ? v
      : typeof (v as { address?: unknown })?.address === "string"
      ? (v as { address: string }).address
      : undefined;
  const items = Array.isArray(plugins.items) ? (plugins.items as Record<string, unknown>[]) : [];
  const sasSigner = items.find((i) => i?.plugin === "sas" && typeof i.signer === "string")?.signer as
    | string
    | undefined;
  const address = pick(plugins.solanaKey) ?? sasSigner ?? pick(loop.solanaKey);
  if (!address) {
    throw new Error(
      `loop ${loopId} has no Solana key in the console's answer (no loop.plugins.solanaKey): it was started with ` +
        `LATH_PROTOCOL_PLUGINS off, or without a grant; pass --key <address> instead`
    );
  }
  return new PublicKey(address);
}

async function main(): Promise<number> {
  const dryRun = flag("dry-run");
  const tag = dryRun ? "[dry run] " : "";
  const dir = attestDir();
  const connection = await connectSas(tag);

  // The issuer must exist: authorizing is its act, and a fresh in-memory one would authorize nothing.
  const issuerFile = path.join(dir, "issuer.json");
  if (!fs.existsSync(issuerFile)) throw new Error(`no issuer key at ${issuerFile}; run npm run demo-attest:seed first`);
  const issuer = readKeypair(issuerFile);
  const { credential, schema } = demoAddresses(issuer.publicKey);
  const credInfo = await connection.getAccountInfo(credential, "confirmed");
  if (!credInfo)
    throw new Error(`the credential ${credential.toBase58()} is not on devnet; run demo-attest:seed first`);
  const cred = decodeCredential(credInfo.data);
  console.log(`${tag}issuer      ${issuer.publicKey.toBase58()}`);
  console.log(`${tag}credential  ${credential.toBase58()} (${DEMO_CREDENTIAL_NAME})`);
  console.log(`${tag}signers now [${cred.authorizedSigners.join(", ")}]`);

  if (flag("outside")) return outside(connection, credential, schema, dryRun);
  if (flag("close")) return close(connection, issuer, cred.authorizedSigners, credential, schema, dryRun);

  // ── Whose key ────────────────────────────────────────────────────────────────
  const loopId = arg("loop");
  if (loopId !== undefined && !LOOP_ID.test(loopId)) throw new Error(`${JSON.stringify(loopId)} is not a loop id`);
  const keyArg = arg("key");
  let key: PublicKey;
  if (keyArg) key = new PublicKey(keyArg);
  else if (loopId) key = await loopKeyFromConsole(loopId);
  else throw new Error("name the key: --loop <id> or --key <address> (or --outside)");
  const remove = flag("remove");
  console.log(`${tag}loop key    ${key.toBase58()}${loopId ? ` (loop ${loopId})` : ""}`);

  // ── The new list ─────────────────────────────────────────────────────────────
  const now = cred.authorizedSigners;
  const has = now.includes(key.toBase58());
  if (remove && key.equals(issuer.publicKey)) throw new Error("the issuer is never taken off its own credential");
  if (remove ? !has : has) {
    console.log(`${tag}${key.toBase58()} is already ${remove ? "off" : "on"} the list; nothing is sent`);
    return 0;
  }
  const next = remove ? now.filter((k) => k !== key.toBase58()) : [...now, key.toBase58()];
  const payer = loadPayer().keypair;
  const ixs = [
    changeSignersIx(
      payer.publicKey,
      issuer.publicKey,
      credential,
      next.map((k) => new PublicKey(k))
    ),
  ];
  console.log(`${tag}signers new [${next.join(", ")}]`);
  const sim = await simulate(connection, ixs, payer.publicKey);
  if (!sim.simulated) throw new Error(`the change does not fit: ${sim.why}`);
  if (sim.err) {
    console.log((sim.logs ?? []).join("\n"));
    throw new Error(`the change does not simulate: ${refusal(sim.err, sim.logs)}`);
  }
  console.log(`${tag}simulated   ok, ${sim.unitsConsumed ?? "?"} CU, ${sim.bytes} B`);
  if (dryRun) {
    console.log(`${tag}nothing was signed or sent`);
    return 0;
  }
  const { signature, err } = await send(connection, ixs, payer, [issuer]);
  if (err) throw new Error(`changeAuthorizedSigners failed: ${refusal(err)} (${signature})`);
  const after = decodeCredential((await connection.getAccountInfo(credential, "confirmed"))!.data);
  console.log(`${remove ? "removed" : "authorized"}: ${explorerTx(signature)}`);
  console.log(`  signers [${after.authorizedSigners.join(", ")}]`);
  if (after.authorizedSigners.includes(key.toBase58()) === remove) {
    throw new Error(`the change landed but ${key.toBase58()} is ${remove ? "still on" : "not on"} the list`);
  }
  // The authorization's own record, kept when it is taken back, so the file shows both signatures.
  const was = readAttest(dir).authorizations?.[key.toBase58()];
  const record: AuthorizationRecord = remove
    ? {
        ...(was ?? { ...(loopId ? { loopId } : {}), at: Date.now(), signature: "" }),
        removed: { at: Date.now(), signature },
      }
    : { ...(loopId ? { loopId } : {}), at: Date.now(), signature };
  console.log(`recorded in ${writeAttest(dir, { authorizations: { [key.toBase58()]: record } })}`);
  return 0;
}

/** `--outside`: a key the issuer never authorized attests a true claim, and SAS alone says no (5). */
async function outside(connection: Connection, credential: PublicKey, schema: PublicKey, dryRun: boolean) {
  const tag = dryRun ? "[dry run] " : "";
  const attest = readAttest(attestDir());
  const subject = attest.subjects?.[0];
  if (!subject) throw new Error(`no subjects in ${attestDir()}/addresses.json; run npm run demo-attest:seed first`);
  const intruder = Keypair.generate();
  const payer = loadPayer().keypair;
  // The claim as a loop would publish it — the chain's own read of the authority — so the signer is the
  // only thing wrong with it.
  const info = await connection.getParsedAccountInfo(new PublicKey(programDataAddress(subject.address)), "confirmed");
  const parsed = (info.value?.data as { parsed?: { info?: { authority?: string | null } } } | undefined)?.parsed;
  const authority = parsed?.info?.authority ?? SAS_NO_AUTHORITY;
  const data = sasClaimBytes({
    program: subject.address,
    authority,
    kind: sasKindOf(authority) ?? "immutable",
    asOfSlot: await connection.getSlot("confirmed"),
    evidence: createHash("sha256").update("lath sas outside").digest("hex"),
    tempoCost: "0",
    tempoPayer: "",
  });
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  const ixs = [
    createAttestationIx(
      payer.publicKey,
      intruder.publicKey,
      credential,
      schema,
      new PublicKey(subject.address),
      data,
      expiry
    ),
  ];
  console.log(`${tag}outsider    ${intruder.publicKey.toBase58()} (fresh; never authorized)`);
  console.log(`${tag}claim       ${subject.name} ${subject.address} → ${authority}`);
  console.log(`${tag}attestation ${sasAttestationAddress(credential.toBase58(), schema.toBase58(), subject.address)}`);
  const sim = await simulate(connection, ixs, payer.publicKey);
  if (!sim.simulated) throw new Error(`the attestation does not fit: ${sim.why}`);
  const code = sasCode(sim.err, sim.logs);
  console.log(`${tag}simulated   refused: ${refusal(sim.err, sim.logs)}`);
  if (code !== 5) {
    console.log(
      `${tag}            (expected SAS 5 SignerNotAuthorized${
        sim.err ? "" : "; it would SUCCEED, so the outsider is somehow authorized"
      })`
    );
  }
  if (dryRun) {
    console.log(`${tag}nothing was signed or sent`);
    return 0;
  }
  // Preflight off: the refusal lands, pays its fee and has a signature the explorer shows.
  const { signature, err } = await send(connection, ixs, payer, [intruder], true);
  // The landed transaction's logs name whose failure it was, as the simulation's did.
  const logs = err ? (await readLanded(connection, signature).catch(() => null))?.meta?.logMessages ?? [] : [];
  console.log(err ? `SAS refused it: ${refusal(err, logs)}` : `it landed: the outsider attested, which it must not`);
  console.log(`  ${explorerTx(signature)}`);
  console.log(`  credential ${explorerAddress(credential.toBase58())}`);
  return err ? 0 : 1;
}

/**
 * `--close`: the issuer closes the live attestation about one subject, rent back to the issuer. The
 * subject is a name from `addresses.json` or a program id as written; the attestation is the one
 * `upgrade-authority` v1 keeps for it (`sasAttestationAddress`), and it is read and shown before
 * anything is signed.
 */
async function close(
  connection: Connection,
  issuer: Keypair,
  signers: string[],
  credential: PublicKey,
  schema: PublicKey,
  dryRun: boolean
): Promise<number> {
  const tag = dryRun ? "[dry run] " : "";
  const asked = arg("close");
  if (!asked || asked.startsWith("--"))
    throw new Error("--close names a subject: a name from addresses.json or a program id");
  const named = readAttest(attestDir()).subjects?.find((s) => s.name.toLowerCase() === asked.toLowerCase());
  let program: PublicKey;
  try {
    program = new PublicKey(named?.address ?? asked);
  } catch {
    throw new Error(`${JSON.stringify(asked)} is neither a subject in ${attestDir()}/addresses.json nor a program id`);
  }
  // SAS checks the closer is an authorized signer; the issuer is the first, unless someone took it off.
  if (!signers.includes(issuer.publicKey.toBase58())) {
    throw new Error(
      `the issuer ${issuer.publicKey.toBase58()} is not an authorized signer of its credential; SAS would refuse (5)`
    );
  }
  const attestation = new PublicKey(
    sasAttestationAddress(credential.toBase58(), schema.toBase58(), program.toBase58())
  );
  console.log(`${tag}subject     ${named ? `${named.name} ` : ""}${program.toBase58()}`);
  console.log(`${tag}attestation ${attestation.toBase58()}`);
  const info = await connection.getAccountInfo(attestation, "confirmed");
  if (!info) {
    console.log(
      `${tag}there is no live attestation about ${program.toBase58()} under ${SAS_SCHEMA_NAME} v1; nothing to close`
    );
    return 1;
  }
  if (!info.owner.equals(SAS)) throw new Error(`${attestation.toBase58()} is not an SAS account; refusing to touch it`);
  const live = decodeAttestation(info.data);
  const claim = decodeSasClaim(live.data);
  console.log(`${tag}signed by   ${live.signer}${live.signer === issuer.publicKey.toBase58() ? " (the issuer)" : ""}`);
  console.log(
    `${tag}says        ${
      claim
        ? `${claim.authority} (${claim.kind}) as of slot ${claim.asOfSlot}; Tempo cost ${claim.tempoCost} paid by ${
            claim.tempoPayer || "nobody"
          }`
        : "data that does not decode under the schema"
    }`
  );
  console.log(`${tag}rent        ${sol(info.lamports)}, back to the issuer`);
  // The issuer is the instruction's payer, so the rent comes back to it; the payer pays only the fee.
  const payer = loadPayer().keypair;
  const ixs = [closeAttestationIx(issuer.publicKey, issuer.publicKey, credential, attestation)];
  const sim = await simulate(connection, ixs, payer.publicKey);
  if (!sim.simulated) throw new Error(`the close does not fit: ${sim.why}`);
  if (sim.err) {
    console.log((sim.logs ?? []).join("\n"));
    throw new Error(`the close does not simulate: ${refusal(sim.err, sim.logs)}`);
  }
  console.log(`${tag}simulated   ok, ${sim.unitsConsumed ?? "?"} CU, ${sim.bytes} B`);
  if (dryRun) {
    console.log(`${tag}nothing was signed or sent`);
    return 0;
  }
  const { signature, err } = await send(connection, ixs, payer, [issuer]);
  if (err) throw new Error(`closeAttestation failed: ${refusal(err)} (${signature})`);
  if (await connection.getAccountInfo(attestation, "confirmed")) {
    throw new Error(`the close landed but ${attestation.toBase58()} is still there`);
  }
  console.log(`closed: ${explorerTx(signature)}`);
  console.log(`  ${explorerAddress(attestation.toBase58())}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`demo-attest authorize: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
);
