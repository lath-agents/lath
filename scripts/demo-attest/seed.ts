/**
 * The demo attestation issuer's seed: the
 * credential `lath-demo` and the schema `upgrade-authority` v1 on it, and the file the console reads.
 *
 * ```bash
 * npm run -s demo-attest:seed -- --dry-run    # builds and simulates; signs nothing, writes nothing
 * npm run -s demo-attest:seed                 # creates what is missing, writes ~/.lath/demo-attest/addresses.json
 * ```
 *
 * - **The issuer** is the key `~/.lath/demo-attest/issuer.json` (on devnet, `B6EmpbCP…`); a first run
 *   on a machine without one makes one. It is the credential's authority and decides
 *   which keys may attest under it (`authorize.ts`). It holds no SOL: the payer pays every rent and fee.
 * - **The credential** `lath-demo`, `["credential", issuer, "lath-demo"]`, with the issuer as its first
 *   authorized signer, made only when it is not on devnet.
 * - **The schema** `upgrade-authority` v1: seven fields, `program`, `authority`, `kind`, `asOfSlot`,
 *   `evidence`, `tempoCost` and `tempoPayer`, with the layout the plugin's encoder writes
 *   (`SAS_SCHEMA_FIELDS`, `SAS_SCHEMA_LAYOUT` from `@lath/sdk`, not restated here). A schema already at
 *   its address is checked field by field and layout byte by byte, and a different one is refused:
 *   every attestation a loop sends is encoded for this one (data that does not fit panics the program).
 * - **The receipt schema** `loop-receipt` v1 on the same credential, checked or made
 *   the same way: what SAS · receipt publishes under.
 * - **The subjects**: one upgradeable program the console's `attestDemo` lists (see _The subject_ below):
 *   `--subject <program id>`, else the ones an earlier seed wrote, else the lath program.
 * - **`addresses.json`**: `{ issuer, credential, credentialName, schema, schemaName, schemaVersion,
 *   subjects }`, which `GET /api/loops` serves as `attestDemo` for the form's grant, beside this
 *   script's own bookkeeping. Public addresses only.
 *
 * Re-runnable: the issuer is reused from its file, and the credential and schema are created only when
 * missing, in one transaction when both are. The payer (`--payer`, else `ANCHOR_WALLET`, else the CLI
 * keypair) pays and is no participant.
 *
 * Flags: `--dry-run`; `--rpc <devnet url>`; `--payer <keypair>`; `--dir <dir>` (default
 * `~/.lath/demo-attest`); `--subject <program id>`.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as path from "path";
import {
  LATH_PROGRAM_ID,
  LOOP_RECEIPT_ACCOUNT_BYTES,
  SAS_SCHEMA_FIELDS,
  SAS_SCHEMA_LAYOUT,
  SAS_SCHEMA_NAME,
  SAS_SCHEMA_VERSION,
  programDataAddress,
  sasKindOf,
} from "@lath/sdk";
import {
  ATTESTATION_ACCOUNT_BYTES,
  DEMO_CREDENTIAL_NAME,
  LOOP_RECEIPT_SCHEMA,
  UPGRADE_AUTHORITY_SCHEMA,
  arg,
  attestDir,
  connectSas,
  createCredentialIx,
  createSchemaIx,
  decodeCredential,
  decodeSchema,
  demoAddresses,
  describeKey,
  ensureAttestDir,
  explorerAddress,
  explorerTx,
  flag,
  issuerKey,
  loadPayer,
  readAttest,
  refusal,
  send,
  simulate,
  sol,
  writeAttest,
  type AttestAddresses,
} from "./common";

async function main(): Promise<number> {
  const dryRun = flag("dry-run");
  const tag = dryRun ? "[dry run] " : "";
  const dir = attestDir();
  const connection = await connectSas(tag);

  // ── The subject ──────────────────────────────────────────────────────────────
  // What an `upgrade-authority` attestation would be about. No loop in this build sends one (`sas.attest`
  // is on the roadmap), and the receipt names no subject, but the console offers `attestDemo`, the receipt
  // pointer with it, only for a file that lists at least one (`_lib/loop-receipt.ts` `attestDemo`). So the seed
  // still writes one, and needs no program of its own deployed for it: `--subject <program id>`, else the
  // subjects a file from an earlier seed run lists (a demo's _target_, so a re-run leaves the
  // file a console already reads as it was), else the lath program, an upgradeable program on devnet.
  const asked = arg("subject");
  const earlier = asked ? undefined : readAttest(dir).subjects;
  const subjects = asked
    ? [{ name: "subject", address: new PublicKey(asked).toBase58() }]
    : earlier?.length
    ? earlier.map((s) => ({ name: s.name, address: new PublicKey(s.address).toBase58() }))
    : [{ name: "lath", address: new PublicKey(LATH_PROGRAM_ID).toBase58() }];

  // ── The keys ─────────────────────────────────────────────────────────────────
  const payer = loadPayer();
  if (!dryRun) ensureAttestDir(dir);
  const issuer = issuerKey(dir, dryRun);
  const { credential, schema, receiptSchema } = demoAddresses(issuer.keypair.publicKey);
  console.log(`${tag}payer              ${payer.keypair.publicKey.toBase58()}  ${payer.file}`);
  console.log(`${tag}${describeKey("issuer", issuer.file, issuer)}`);
  console.log(`${tag}credential         ${credential.toBase58()}  (${DEMO_CREDENTIAL_NAME})`);
  console.log(`${tag}schema             ${schema.toBase58()}  (${SAS_SCHEMA_NAME} v${SAS_SCHEMA_VERSION})`);
  console.log(
    `${tag}receipt schema     ${receiptSchema.toBase58()}  (${LOOP_RECEIPT_SCHEMA.name} v${
      LOOP_RECEIPT_SCHEMA.version
    })`
  );

  // ── What is already there ────────────────────────────────────────────────────
  const [credInfo, schemaInfo, receiptInfo] = await connection.getMultipleAccountsInfo(
    [credential, schema, receiptSchema],
    "confirmed"
  );
  const ixs: TransactionInstruction[] = [];
  if (credInfo) {
    const c = decodeCredential(credInfo.data);
    // A credential at this address is the issuer's by derivation; one that says otherwise is not ours to use.
    if (c.authority !== issuer.keypair.publicKey.toBase58() || c.name !== DEMO_CREDENTIAL_NAME) {
      throw new Error(
        `${credential.toBase58()} is ${c.name} of ${c.authority}, not ${DEMO_CREDENTIAL_NAME} of the issuer`
      );
    }
    console.log(`${tag}the credential is already on devnet; authorized signers [${c.authorizedSigners.join(", ")}]`);
  } else {
    ixs.push(
      createCredentialIx(payer.keypair.publicKey, issuer.keypair.publicKey, DEMO_CREDENTIAL_NAME, [
        issuer.keypair.publicKey,
      ])
    );
    console.log(`${tag}create the credential ${DEMO_CREDENTIAL_NAME}, the issuer its first authorized signer`);
  }
  if (schemaInfo) {
    const s = decodeSchema(schemaInfo.data);
    const same =
      s.credential === credential.toBase58() &&
      s.name === SAS_SCHEMA_NAME &&
      s.version === SAS_SCHEMA_VERSION &&
      JSON.stringify(s.layout) === JSON.stringify(SAS_SCHEMA_LAYOUT) &&
      JSON.stringify(s.fields) === JSON.stringify(SAS_SCHEMA_FIELDS);
    if (!same) {
      throw new Error(
        `${schema.toBase58()} is a schema whose layout [${s.layout.join(", ")}] or fields ` +
          `[${(s.fields ?? ["unreadable"]).join(", ")}] are not ${SAS_SCHEMA_NAME} v${SAS_SCHEMA_VERSION}'s; ` +
          `no loop would attest under it`
      );
    }
    console.log(
      `${tag}the schema is already on devnet${s.isPaused ? ", and PAUSED: SAS refuses every attestation" : ""}`
    );
  } else {
    ixs.push(createSchemaIx(payer.keypair.publicKey, issuer.keypair.publicKey, credential, UPGRADE_AUTHORITY_SCHEMA));
    console.log(
      `${tag}create the schema: fields [${SAS_SCHEMA_FIELDS.join(", ")}], layout [${SAS_SCHEMA_LAYOUT.join(", ")}]`
    );
  }

  // The loop receipt's schema, checked or made the way the first one is.
  if (receiptInfo) {
    const s = decodeSchema(receiptInfo.data);
    const same =
      s.credential === credential.toBase58() &&
      s.name === LOOP_RECEIPT_SCHEMA.name &&
      s.version === LOOP_RECEIPT_SCHEMA.version &&
      JSON.stringify(s.layout) === JSON.stringify(LOOP_RECEIPT_SCHEMA.layout) &&
      JSON.stringify(s.fields) === JSON.stringify(LOOP_RECEIPT_SCHEMA.fields);
    if (!same) {
      throw new Error(
        `${receiptSchema.toBase58()} is a schema whose layout or fields are not ` +
          `${LOOP_RECEIPT_SCHEMA.name} v${LOOP_RECEIPT_SCHEMA.version}'s; no receipt would be published under it`
      );
    }
    console.log(
      `${tag}the receipt schema is already on devnet${s.isPaused ? ", and PAUSED: SAS refuses every receipt" : ""}`
    );
  } else {
    ixs.push(createSchemaIx(payer.keypair.publicKey, issuer.keypair.publicKey, credential, LOOP_RECEIPT_SCHEMA));
    console.log(
      `${tag}create the receipt schema: fields [${LOOP_RECEIPT_SCHEMA.fields.join(
        ", "
      )}], layout [${LOOP_RECEIPT_SCHEMA.layout.join(", ")}]`
    );
  }

  // ── The seed transaction ─────────────────────────────────────────────────────
  // One transaction, so a seed happens whole: SAS reads the credential the first instruction made.
  let signature: string | undefined;
  if (ixs.length) {
    const sim = await simulate(connection, ixs, payer.keypair.publicKey);
    if (!sim.simulated) throw new Error(`the seed transaction does not fit: ${sim.why}`);
    if (sim.err) {
      console.log((sim.logs ?? []).join("\n"));
      throw new Error(`the seed does not simulate: ${refusal(sim.err, sim.logs)}`);
    }
    console.log(
      `${tag}transaction: ${ixs.length} instructions, ${sim.bytes} B, simulated: ${sim.unitsConsumed ?? "?"} CU`
    );
    if (!dryRun) {
      const sent = await send(connection, ixs, payer.keypair, [issuer.keypair]);
      if (sent.err) throw new Error(`the seed failed: ${refusal(sent.err)} (${sent.signature})`);
      signature = sent.signature;
      console.log(`seeded: ${explorerTx(signature)}`);
    }
  } else {
    console.log(`${tag}nothing to create`);
  }

  // ── The subjects as the chain has them now, and what an attestation costs ────
  for (const s of subjects) {
    const info = await connection.getParsedAccountInfo(new PublicKey(programDataAddress(s.address)), "confirmed");
    const parsed = (info.value?.data as { parsed?: { info?: { authority?: string | null } } } | undefined)?.parsed;
    const authority = parsed ? parsed.info?.authority ?? "none" : null;
    console.log(
      `${tag}subject ${s.name.padEnd(10)} ${s.address}: upgrade authority ${
        authority === null ? "unreadable (not an upgradeable program?)" : `${authority} (${sasKindOf(authority)})`
      }`
    );
  }
  const rent = await connection.getMinimumBalanceForRentExemption(ATTESTATION_ACCOUNT_BYTES, "confirmed");
  console.log(
    `${tag}an attestation under this schema is at most ${ATTESTATION_ACCOUNT_BYTES} B: rent ${sol(rent)}, ` +
      `which the loop's key pays and gets back when it closes it`
  );

  const receiptRent = await connection.getMinimumBalanceForRentExemption(LOOP_RECEIPT_ACCOUNT_BYTES, "confirmed");
  console.log(
    `${tag}a loop receipt is at most ${LOOP_RECEIPT_ACCOUNT_BYTES} B: rent ${sol(receiptRent)}, which the ` +
      `console's runtime key pays (Lath pays); authorize that key once with demo-attest:authorize -- --key <its address>`
  );

  // ── addresses.json ───────────────────────────────────────────────────────────
  // The first block is the console's contract (`attestDemo`); the rest is ours.
  const contract: AttestAddresses = {
    issuer: issuer.keypair.publicKey.toBase58(),
    credential: credential.toBase58(),
    credentialName: DEMO_CREDENTIAL_NAME,
    schema: schema.toBase58(),
    schemaName: SAS_SCHEMA_NAME,
    schemaVersion: SAS_SCHEMA_VERSION,
    subjects,
    receiptSchema: receiptSchema.toBase58(),
  };
  if (dryRun) {
    console.log("");
    console.log(`${tag}${path.join(dir, "addresses.json")} would read (the issuer is ${issuer.state}):`);
    console.log(JSON.stringify(contract, null, 2));
    console.log(`${tag}nothing was signed, sent or written`);
    return 0;
  }
  const file = writeAttest(dir, {
    ...contract,
    issuerKeypair: issuer.file,
    ...(signature ? { seedSignature: signature } : {}),
  });
  console.log("");
  console.log(`credential  ${explorerAddress(credential.toBase58())}`);
  console.log(`schema      ${explorerAddress(schema.toBase58())}`);
  console.log(`receipt     ${explorerAddress(receiptSchema.toBase58())}`);
  console.log(`recorded in ${file}`);
  console.log(`            the console reads it (LATH_DEMO_ATTEST, default this path) and serves it as attestDemo`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`demo-attest seed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
);
