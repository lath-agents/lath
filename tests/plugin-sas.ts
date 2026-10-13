/**
 * SAS by hand (`runtime/src/plugins/sas.ts`): the `createAttestation` it builds, the credential, schema
 * and attestation decoders, and SAS's failures in words. The console's loop receipt (`_lib/receipt.ts`,
 * docs/ARCHITECTURE.md §8) publishes with them.
 *
 * Node-only, network-free. The golden bytes (`S1` below) are a probe's `createAttestation` that landed
 * on devnet; the landed instruction, read back, is equal to them. The account layouts are pinned by the
 * live devnet accounts the probe left: the `lath-demo` credential, the `lath-probe` schema and the
 * probe's re-attestation.
 *
 * The `sas.attest` plugin (its snapshot, build, send and read-back, the `closeAttestation` builder and
 * the `ProgramData` decoder only it uses) is on the roadmap and not in this build.
 */
import { assert } from "chai";
import { createHash } from "crypto";
import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { SAS_SCHEMA_FIELDS, SAS_SCHEMA_LAYOUT, sasAttestationAddress } from "../sdk/src/plugins";
import {
  SAS,
  createAttestationInstruction,
  decodeAttestation,
  decodeCredential,
  decodeSchema,
  sasFailure,
} from "../runtime/src/plugins/sas";

const pk = (s: string) => new PublicKey(s);

// ---------------------------------------------------------------------------------------------
// The probe's golden bytes (`S1`) and the live accounts (devnet)

const S1 = {
  probe: "DmGEu4638gvcweB5rZ8y3UTkE414Qsik1dmxUmEXSkXB",
  credential: "BewvqsfA1tFejBKDs6ZGza8Pp5CFmpE2pB81jRamaK9C",
  schema: "4hTjaY3F9XVuq1YTNTyJc3h6NKU6A7KqkMUCY7RbHY1a",
  attestation: "6LnYd2kEa47B3QEyKJ5W7NGvSXXUsMcN2ZVga53vMwdG",
  target: "3UViFkVCxgfiGprWkvBkqTodoorLPh2fqw9nZHaasHqd",
  authority: "C6bYdoJDKApKPoh2sxhZ3Zh4pA1fByz5gYQeErokb63y",
  data:
    "0624c2850792dec4eca6a96d081f79bb32194bfeb63ddcd6e98dc3b5a40383dac48d0000002c00000033555669466b564378676669" +
    "477072576b76426b71546f646f6f724c506832667177396e5a486161734871642c00000043366259646f4a444b41704b506f6832" +
    "7378685a335a68347041316642797a356759516545726f6b623633790067154a1e0000000020000000fc6cc3e0a97e9a8260a081" +
    "7c8ef66d94a146e1e2deb2f5a027ef67657e9ffc4a5f6dce6a00000000",
};

const LIVE_CREDENTIAL =
  "0095ec58a24f8a46dfa43b49d326b6c1681ed803fdc3681f7886b1c435d8281a6f090000006c6174682d64656d6f0100000095ec58a2" +
  "4f8a46dfa43b49d326b6c1681ed803fdc3681f7886b1c435d8281a6f";
const LIVE_SCHEMA =
  "019e4d778381bc34e3fb5603c6d58803b88f779f72645982de541838346abe6aeb0a0000006c6174682d70726f62653e0000004c6174" +
  "682070726f62653a2077686f2063616e207570677261646520612070726f6772616d2c2061732061206c6f6f70207374657020666f" +
  "756e64206974050000000c0c00030d380000000700000070726f6772616d09000000617574686f72697479040000006b696e640800" +
  "000061734f66536c6f740800000065766964656e63650001";
const LIVE_ATTESTATION =
  "0224c2850792dec4eca6a96d081f79bb32194bfeb63ddcd6e98dc3b5a40383dac49e4d778381bc34e3fb5603c6d58803b88f779f7264" +
  "5982de541838346abe6aeb36f085808fc797e4e5e3c5e6a54ec87af4938ab26cf1d9053abc8287d678591d8d0000002c0000003355" +
  "5669466b564378676669477072576b76426b71546f646f6f724c506832667177396e5a486161734871642c00000043366259646f4a" +
  "444b41704b506f68327378685a335a68347041316642797a356759516545726f6b623633790091154a1e000000002000000028182a" +
  "5c5be1e5216f2d26317ea5a21370544c5c28281d614222b164f0c8ddadbda307bb2311481ce97c00c6699ee3b6c3953c27c0eb9f48" +
  "dde8613eda5b284a5f6dce6a000000000000000000000000000000000000000000000000000000000000000000000000";

const account = (data: Buffer, owner: PublicKey = SAS, lamports = 1_000_000): AccountInfo<Buffer> => ({
  data,
  owner,
  lamports,
  executable: false,
  rentEpoch: 0,
});

// ---------------------------------------------------------------------------------------------
// Account data, written as the program lays it out (the live accounts above are the reference)

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const vec = (b: Uint8Array) => Buffer.concat([u32(b.length), Buffer.from(b)]);
const str = (s: string) => vec(Buffer.from(s, "utf8"));

function schemaAccount(o: {
  credential: string;
  layout?: readonly number[];
  fields?: readonly string[];
  paused?: boolean;
}): AccountInfo<Buffer> {
  return account(
    Buffer.concat([
      Buffer.of(1),
      pk(o.credential).toBuffer(),
      str("upgrade-authority"),
      str("who can upgrade a program"),
      vec(Buffer.from(o.layout ?? SAS_SCHEMA_LAYOUT)),
      vec(Buffer.concat((o.fields ?? SAS_SCHEMA_FIELDS).map(str))),
      Buffer.of(o.paused ? 1 : 0),
      Buffer.of(1),
    ])
  );
}

// ---------------------------------------------------------------------------------------------

describe("SAS: the instruction, by hand", () => {
  it("builds the probe's createAttestation byte for byte from the probe's inputs", () => {
    // The probe's `lath-probe` claim (five fields: no Tempo side yet), encoded as `probe.ts` encodes it.
    const golden = Buffer.from(S1.data, "hex");
    const n = golden.readUInt32LE(33);
    const asOfSlot = golden.readBigUInt64LE(37 + 4 + 44 + 4 + 44 + 1);
    const expiry = golden.readBigInt64LE(37 + n);
    const evidence = createHash("sha256").update("lath sas probe S1").digest();
    const data = Buffer.concat([
      str(S1.target),
      str(S1.authority),
      Buffer.of(0),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(asOfSlot);
        return b;
      })(),
      vec(evidence),
    ]);
    assert.equal(data.toString("hex"), golden.subarray(37, 37 + n).toString("hex"), "the probe's data, rebuilt");

    const probe = pk(S1.probe);
    const ix = createAttestationInstruction({
      payer: probe,
      signer: probe,
      credential: pk(S1.credential),
      schema: pk(S1.schema),
      nonce: pk(S1.target),
      data,
      expiry,
    });
    assert.equal(ix.data.toString("hex"), S1.data);
    assert.isTrue(ix.programId.equals(SAS));
    assert.deepEqual(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      [
        [S1.probe, true, true],
        [S1.probe, true, false],
        [S1.credential, false, false],
        [S1.schema, false, false],
        [S1.attestation, false, true],
        [SystemProgram.programId.toBase58(), false, false],
      ]
    );
    // And the PDA the contract derives is the account the probe made.
    assert.equal(sasAttestationAddress(S1.credential, S1.schema, S1.target), S1.attestation);
  });
});

describe("SAS: the live accounts' layouts (devnet)", () => {
  it("reads the credential's authorized signers", () => {
    const c = decodeCredential(account(Buffer.from(LIVE_CREDENTIAL, "hex")));
    assert.deepEqual(c, {
      authority: "B6EmpbCPKqRbHujC1wnRR9wH2ikunhDaKRFkqUi7EwJv",
      name: "lath-demo",
      authorizedSigners: ["B6EmpbCPKqRbHujC1wnRR9wH2ikunhDaKRFkqUi7EwJv"],
    });
  });

  it("reads the schema's layout, its field names (a Vec<u8> of length-prefixed names) and its paused flag", () => {
    const s = decodeSchema(account(Buffer.from(LIVE_SCHEMA, "hex")));
    assert.deepEqual(s, {
      credential: S1.credential,
      name: "lath-probe",
      layout: [12, 12, 0, 3, 13],
      fieldNames: ["program", "authority", "kind", "asOfSlot", "evidence"],
      paused: false,
      version: 1,
    });
    // The writer this file uses for `upgrade-authority` v1 lays the same fields out the same way.
    const ours = decodeSchema(schemaAccount({ credential: S1.credential, paused: true }));
    assert.deepEqual(ours?.layout, [...SAS_SCHEMA_LAYOUT]);
    assert.deepEqual(ours?.fieldNames, [...SAS_SCHEMA_FIELDS]);
    assert.isTrue(ours?.paused);
  });

  it("reads the probe's re-attestation: nonce, credential, schema, data, signer, expiry", () => {
    const a = decodeAttestation(account(Buffer.from(LIVE_ATTESTATION, "hex")))!;
    assert.equal(a.nonce, S1.target);
    assert.equal(a.credential, S1.credential);
    assert.equal(a.schema, S1.schema);
    assert.equal(a.signer, S1.probe, "re-attested with the probe key");
    assert.equal(a.expiry, Buffer.from(S1.data, "hex").readBigInt64LE(37 + 141));
    assert.lengthOf(a.data, 141);
    // The whole account, 314 bytes as the probe reported: nothing after the token account.
    assert.lengthOf(Buffer.from(LIVE_ATTESTATION, "hex"), 314);
  });

  it("reads nothing from an account another program owns, or one that is short", () => {
    const bytes = Buffer.from(LIVE_CREDENTIAL, "hex");
    assert.isNull(decodeCredential(account(bytes, SystemProgram.programId)));
    assert.isNull(decodeCredential(account(bytes.subarray(0, 40))));
    assert.isNull(decodeSchema(account(Buffer.from(LIVE_CREDENTIAL, "hex"))), "a credential is not a schema");
    assert.isNull(decodeAttestation(account(Buffer.from(LIVE_SCHEMA, "hex"))), "a schema is not an attestation");
  });
});

describe("SAS: failures in words", () => {
  it("tells the System Program's 0 from SAS's 0 by the logs, and gives it no SAS code", () => {
    const err = { InstructionError: [0, { Custom: 0 }] };
    const system = sasFailure(err, [
      `Program ${SAS.toBase58()} invoke [1]`,
      "Program 11111111111111111111111111111111 invoke [2]",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x0",
      `Program ${SAS.toBase58()} failed: custom program error: 0x0`,
    ]);
    assert.isUndefined(system.code);
    assert.match(system.words, /System Program .*AccountAlreadyInUse/);
    const sas = sasFailure(err, [`Program ${SAS.toBase58()} failed: custom program error: 0x0`]);
    assert.equal(sas.code, 0);
    assert.match(sas.words, /InvalidCredential/);
    assert.match(sasFailure({ InstructionError: [0, { Custom: 11 }] }).words, /SchemaPaused/);
    assert.match(sasFailure({ InstructionError: [0, { Custom: 6 }] }).words, /InvalidAttestationData/);
  });
});
