/**
 * `sas.receipt` (docs/ARCHITECTURE.md §8): the receipt's bytes, its nonce and address, the
 * pointer a start body carries, the attestation-account decoder, and the policy key that commits the
 * pointer — absent, every policy hashes as before. Node only, no chain.
 */
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  LOOP_RECEIPT_ACCOUNT_BYTES,
  LOOP_RECEIPT_FIELDS,
  LOOP_RECEIPT_LAYOUT,
  LOOP_RECEIPT_MAX_DATA_BYTES,
  SAS_PROGRAM_ID,
  decodeLoopReceipt,
  decodeSasAttestationAccount,
  loopReceiptAddress,
  loopReceiptBytes,
  loopReceiptNonce,
  sasAttestationAddress,
  validateLoopReceiptPointer,
  type LoopReceipt,
} from "@lath/sdk";
import { policyDocument, policyVersionHash, type RuntimePolicy } from "../runtime/src/policy";

const CREDENTIAL = "BewvqsfA1tFejBKDs6ZGza8Pp5CFmpE2pB81jRamaK9C";
const SCHEMA = "9QRYEHn48Qcs7joVdD7UhP7CPop72uQJ6DSp5FP8g7Pk";
const SIGNER = "35ZEEEb2PuHa2QBdCzZBHVbpAw7tcbfnDCPxFVsAG8tu";

const RECEIPT: LoopReceipt = {
  agent: "5f3ef07bdd6c52b37ca8344e98ffc08b9d4dd65047d033d9e35af2ae1d1cc6b2",
  loop: "loop-0292a02b6f3d2780",
  seq: "41",
  head: "ab".repeat(32),
  steps: 2,
  goal: "cd".repeat(32),
  usdcCharged: "23456",
  tempoSpent: "31000",
  tempoPayer: "0x18fbe5e0a83dca440072059f91d1a23babe6e0b0",
};

describe("sas.receipt: the receipt's bytes", () => {
  it("has nine fields whose layout codes are SAS's String, u64 and Vec<u8>", () => {
    assert.lengthOf(LOOP_RECEIPT_FIELDS, 9);
    assert.deepEqual([...LOOP_RECEIPT_LAYOUT], [12, 12, 3, 13, 3, 13, 3, 3, 12]);
  });

  it("round-trips, field for field", () => {
    const bytes = loopReceiptBytes(RECEIPT);
    assert.deepEqual(decodeLoopReceipt(bytes), RECEIPT);
  });

  it("writes Borsh as SAS reads the layout: a length-prefixed agent, then the loop, then seq as u64 LE", () => {
    const bytes = loopReceiptBytes(RECEIPT);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(0, true), 64);
    assert.equal(new TextDecoder().decode(bytes.subarray(4, 68)), RECEIPT.agent);
    assert.equal(view.getUint32(68, true), RECEIPT.loop.length);
    const afterLoop = 72 + RECEIPT.loop.length;
    assert.equal(view.getBigUint64(afterLoop, true), BigInt(41));
    assert.equal(view.getUint32(afterLoop + 8, true), 32, "head is a 32-byte Vec<u8>");
  });

  it("refuses what the schema cannot hold, rather than send data that panics the program", () => {
    assert.throws(() => loopReceiptBytes({ ...RECEIPT, agent: "XYZ" }), /agent/);
    assert.throws(() => loopReceiptBytes({ ...RECEIPT, head: "ab" }), /head/);
    assert.throws(() => loopReceiptBytes({ ...RECEIPT, goal: "zz".repeat(32) }), /goal/);
    assert.throws(() => loopReceiptBytes({ ...RECEIPT, seq: "-1" }), /seq/);
    assert.throws(() => loopReceiptBytes({ ...RECEIPT, usdcCharged: "18446744073709551616" }), /usdcCharged/);
  });

  it("decodes nothing that is not exactly one receipt", () => {
    const bytes = loopReceiptBytes(RECEIPT);
    assert.isNull(decodeLoopReceipt(bytes.subarray(0, bytes.length - 1)));
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    assert.isNull(decodeLoopReceipt(extra));
  });

  it("sizes the account for the widest receipt: 416 B", () => {
    assert.equal(LOOP_RECEIPT_MAX_DATA_BYTES, 243);
    assert.equal(LOOP_RECEIPT_ACCOUNT_BYTES, 416);
  });
});

describe("sas.receipt: the nonce and the address", () => {
  it("derives one nonce per loop, pinned so a rename of the domain cannot pass unseen", () => {
    assert.equal(loopReceiptNonce("loop-0292a02b6f3d2780"), "93YugrwcbsDmaPkSBPpKD2iJxokcc1xjaituncVwn5n2");
    assert.notEqual(loopReceiptNonce("loop-0292a02b6f3d2780"), loopReceiptNonce("loop-18c49906ecbea7be"));
  });

  it("is SAS's attestation PDA over the credential, the schema and the loop's nonce", () => {
    const pointer = { credential: CREDENTIAL, schema: SCHEMA };
    assert.equal(
      loopReceiptAddress(pointer, RECEIPT.loop),
      sasAttestationAddress(CREDENTIAL, SCHEMA, loopReceiptNonce(RECEIPT.loop))
    );
  });
});

describe("sas.receipt: the pointer", () => {
  it("takes three base58 keys and nothing else", () => {
    const ok = validateLoopReceiptPointer({ credential: CREDENTIAL, schema: SCHEMA, signer: SIGNER });
    assert.isTrue(ok.ok);
    assert.isFalse(validateLoopReceiptPointer({ credential: CREDENTIAL, schema: SCHEMA }).ok);
    assert.isFalse(validateLoopReceiptPointer({ credential: CREDENTIAL, schema: SCHEMA, signer: "0xabc" }).ok);
    const extra = validateLoopReceiptPointer({ credential: CREDENTIAL, schema: SCHEMA, signer: SIGNER, more: 1 });
    assert.isFalse(extra.ok);
    if (!extra.ok) assert.match(extra.reason, /receipt\.more/);
    assert.isFalse(validateLoopReceiptPointer(null).ok);
  });
});

describe("sas.receipt: the attestation account", () => {
  it("decodes discriminator 2, the three keys, the data, the signer, the expiry and the token account", () => {
    const data = loopReceiptBytes(RECEIPT);
    const nonce = new PublicKey(loopReceiptNonce(RECEIPT.loop));
    const parts: Uint8Array[] = [
      Uint8Array.of(2),
      nonce.toBytes(),
      new PublicKey(CREDENTIAL).toBytes(),
      new PublicKey(SCHEMA).toBytes(),
      (() => {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, data.length, true);
        return b;
      })(),
      data,
      new PublicKey(SIGNER).toBytes(),
      new Uint8Array(8),
      new PublicKey(SAS_PROGRAM_ID).toBytes(),
    ];
    const account = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      account.set(p, o);
      o += p.length;
    }
    const decoded = decodeSasAttestationAccount(account);
    assert.isNotNull(decoded);
    assert.equal(decoded!.nonce, nonce.toBase58());
    assert.equal(decoded!.credential, CREDENTIAL);
    assert.equal(decoded!.schema, SCHEMA);
    assert.equal(decoded!.signer, SIGNER);
    assert.equal(decoded!.expiry, BigInt(0));
    assert.deepEqual(decodeLoopReceipt(decoded!.data), RECEIPT);
    account[0] = 1;
    assert.isNull(decodeSasAttestationAccount(account), "another discriminator is not an attestation");
  });
});

describe("sas.receipt: the policy key", () => {
  const base: RuntimePolicy = {
    model: "deepseek/deepseek-v4.1-flash",
    temperature: 0.2,
    toolAllowList: ["solana.slot"],
    maxCost: 1_000_000,
  };

  it("leaves a policy without a receipt byte for byte as it was", () => {
    assert.notInclude(policyDocument(base), "receipt");
    assert.deepEqual(policyVersionHash({ ...base, receipt: undefined }), policyVersionHash(base));
  });

  it("commits the pointer's three keys, extras dropped, and moves the hash", () => {
    const pointer = { credential: CREDENTIAL, schema: SCHEMA, signer: SIGNER };
    const withReceipt = { ...base, receipt: { ...pointer, extra: "dropped" } as typeof pointer };
    const doc = JSON.parse(policyDocument(withReceipt));
    assert.deepEqual(doc.receipt, pointer);
    assert.notDeepEqual(policyVersionHash(withReceipt), policyVersionHash(base));
  });
});
