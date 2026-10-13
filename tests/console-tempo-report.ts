/**
 * `GET /api/loops/<id>/report` (docs/ARCHITECTURE.md §7.4), the browser's check on what it
 * answers, and the loop page's reading of a loop's Tempo services (the storage chip, the Costs
 * card's lines).
 *
 * Node-only, network-free, key-free: the treasury's charge client is a stub that answers from a map,
 * so no Tempo call is made and nothing is paid.
 */
import { expect } from "chai";
import { EventKind, hashPayload, hex, isEncryptedTraceBlob, sha256, toBytes32, utf8 } from "../sdk/src";
import { sealTrace } from "./fixtures/sealed-traces";
import { ChargeRefused, storageArgsBytes, storageKey, type ChargeFetcher, type MppChargeResult } from "../runtime/src";
import { answerLoopReport, type LoopReportRequest } from "../frontend/src/app/api/_lib/loop-report";
import {
  STORAGE_PENDING_MS,
  baseOf,
  checkLoopReport,
  dollarsOfBase,
  lastPublishedReport,
  reportFirstParagraph,
  reportHashOf,
  storageChipOf,
  tempoServiceLines,
  type LoopReportAnswer,
} from "../frontend/src/lib/tempo-services";
import type { LoopStepSummary, LoopView } from "../frontend/src/types/loop";

const STORAGE = "https://storage.mpp.tempo.xyz";
const OWNER = "Owner1111111111111111111111111111111111111";
const LOOP_ID = "loop-abc";
const REPORT = utf8("# Final report\n\nThe goal was reached at step 3.\n");
const HASH = hex(sha256(REPORT));
const KEY = storageKey(LOOP_ID, HASH);
const TX = "0x" + "ab".repeat(32);

/** A step row with only what these functions read; the rest of a summary is irrelevant here. */
function row(step: number, over: Partial<LoopStepSummary> = {}): LoopStepSummary {
  return {
    step,
    status: "success",
    steps: 1,
    batchedSteps: 1,
    costMicroUsdc: "0",
    startedAt: 0,
    endedAt: 0,
    ...over,
  } as LoopStepSummary;
}

function published(step: number, over: Partial<NonNullable<LoopStepSummary["tempoStorage"]>> = {}) {
  return row(step, {
    tempoStorage: {
      key: KEY,
      path: "report/final.md",
      bytes: REPORT.length,
      statusCode: 200,
      amount: "200",
      reference: TX,
      seq: "41",
      ...over,
    },
  });
}

/** The treasury's charge client, answering GETs from `objects` and counting its calls. */
function stubTransport(objects: Record<string, Uint8Array>, over: Partial<MppChargeResult> = {}) {
  const calls: string[] = [];
  const fetcher: ChargeFetcher = {
    payer: "0x18fB0000000000000000000000000000000000B0",
    async fetch(url) {
      calls.push(url);
      const key = url.slice(STORAGE.length + 1);
      const bytes = objects[key];
      if (!bytes) return { status: 404, bytes: utf8("NoSuchKey") };
      return {
        status: 200,
        bytes,
        payment: {
          intent: "charge",
          chainId: 4217,
          payer: "0x18fB0000000000000000000000000000000000B0",
          amount: "100",
          currency: "0x20c000000000000000000000b9537d11c60e8b50",
          reference: "0x" + "cd".repeat(32),
        },
        ...over,
      };
    },
  };
  return { fetcher, calls };
}

function request(over: Partial<LoopReportRequest> & { objects?: Record<string, Uint8Array> } = {}) {
  const stub = stubTransport(over.objects ?? { [KEY]: REPORT });
  let built = 0;
  const req: LoopReportRequest = {
    loop: { id: LOOP_ID, owner: OWNER, history: [row(1), published(2), row(3)] },
    transport: () => {
      built++;
      return stub.fetcher;
    },
    storageUrl: STORAGE,
    ...over,
  };
  return { req, calls: stub.calls, built: () => built };
}

/** The chain's record of the `storage.put`, built the way the runner builds its payload. */
function chainRecord(report: Uint8Array = REPORT, statusCode = 200): { payloadHash: string } {
  return {
    payloadHash: hex(
      hashPayload({
        kind: EventKind.Action,
        toolId: "storage.put",
        argsHash: sha256(storageArgsBytes(STORAGE, KEY)),
        resultHash: sha256(report),
        statusCode,
      })
    ),
  };
}

const deps = (record: { payloadHash: string } | null) => ({
  digest: (b: Uint8Array) => hex(sha256(b)),
  payloadHashOf: (p: { toolId: string; argsHash: string; resultHash: string; statusCode: number }) =>
    hex(
      hashPayload({
        kind: EventKind.Action,
        toolId: p.toolId,
        argsHash: toBytes32(p.argsHash),
        resultHash: toBytes32(p.resultHash),
        statusCode: p.statusCode,
      })
    ),
  record,
});

describe("console: the loop's Tempo report", () => {
  describe("GET /api/loops/<id>/report", () => {
    it("answers with the committed key's bytes and the hashes the storage.put commits", async () => {
      const { req, calls } = request();
      const res = await answerLoopReport(req);
      expect(res.status).to.equal(200);
      const body = res.body as LoopReportAnswer;
      expect(calls).to.deep.equal([`${STORAGE}/${KEY}`]);
      expect(body.step).to.equal(2);
      expect(body.seq).to.equal("41");
      expect(body.key).to.equal(KEY);
      expect(body.fetchedKey).to.equal(KEY);
      expect(body.resultHash).to.equal(HASH);
      expect(body.argsHash).to.equal(hex(sha256(storageArgsBytes(STORAGE, KEY))));
      expect(Buffer.from(body.bytes, "base64").equals(Buffer.from(REPORT))).to.equal(true);
      expect(body.payment?.amount).to.equal("100");
    });

    it("and the browser's check passes: the bytes hash to the result and the record rebuilds", async () => {
      const res = await answerLoopReport(request().req);
      const check = await checkLoopReport(res.body as LoopReportAnswer, deps(chainRecord()));
      expect(check.verdict).to.equal("ok");
      if (check.verdict === "ok") expect(check.text).to.equal(new TextDecoder().decode(REPORT));
    });

    it("the committed key holding other bytes is refused by the browser, not shown", async () => {
      const stale = utf8("# An older report\n");
      const res = await answerLoopReport(request({ objects: { [KEY]: stale } }).req);
      expect(res.status).to.equal(200);
      const check = await checkLoopReport(res.body as LoopReportAnswer, deps(chainRecord()));
      expect(check.verdict).to.equal("bytes-mismatch");
      expect(check).to.not.have.property("text");
    });

    it("a record that is not this storage.put, or no record at all, is refused too", async () => {
      const res = await answerLoopReport(request().req);
      const body = res.body as LoopReportAnswer;
      expect((await checkLoopReport(body, deps(chainRecord(REPORT, 502)))).verdict).to.equal("record-mismatch");
      expect((await checkLoopReport(body, deps(null))).verdict).to.equal("no-record");
      // A console that names another hash for the same bytes fails the first check, whatever the record says.
      const lied = { ...body, resultHash: hex(sha256(utf8("something else"))) };
      expect((await checkLoopReport(lied, deps(chainRecord()))).verdict).to.equal("bytes-mismatch");
    });

    it("an LTE1/LTE2 object is refused with a 409, never decrypted or passed on", async () => {
      // This console writes no encrypted report. A report published sealed to the owner stays
      // sealed: this console holds no key for it, and handing the ciphertext on as the
      // report would only fail the browser's hash check with a less honest sentence.
      const { blob: stored } = sealTrace(new Uint8Array(32).fill(7), REPORT);
      expect(isEncryptedTraceBlob(stored)).to.equal(true);
      const tampered = new Uint8Array(stored);
      tampered[tampered.length - 20] ^= 0x01;
      for (const [name, object] of [
        ["sealed", stored],
        ["tampered", tampered],
      ] as const) {
        const { req, calls } = request({ objects: { [KEY]: object } });
        const res = await answerLoopReport(req);
        expect(res.status, name).to.equal(409);
        const error = (res.body as { error: string }).error;
        expect(error, name).to.contain(KEY);
        expect(error, name).to.contain("was published encrypted, and this console does not open it");
        expect(res.body, name).to.not.have.property("bytes");
        expect(calls, name).to.deep.equal([`${STORAGE}/${KEY}`]);
      }

      // A plaintext object is handed on as it was.
      const plain = await answerLoopReport(request().req);
      expect(plain.status).to.equal(200);
      expect((plain.body as LoopReportAnswer).encoding).to.equal("plain");
      expect((plain.body as LoopReportAnswer).storedSize).to.equal(REPORT.length);
    });

    it("a missing object is a 404 that says which key", async () => {
      const res = await answerLoopReport(request({ objects: {} }).req);
      expect(res.status).to.equal(404);
      expect((res.body as { error: string }).error).to.contain(KEY);
    });

    it("a loop that published no report is a 404, and nothing is fetched or paid", async () => {
      const failed = row(2, {
        tempoStorage: { key: KEY, path: "report/final.md", bytes: 10, statusCode: 502, error: "no answer", seq: "9" },
      });
      for (const history of [
        [row(1), row(2)],
        [row(1), failed],
      ]) {
        const { req, calls, built } = request({ loop: { id: LOOP_ID, owner: OWNER, history } });
        const res = await answerLoopReport(req);
        expect(res.status).to.equal(404);
        expect((res.body as { error: string }).error).to.contain("published no report");
        expect(calls).to.have.length(0);
        expect(built()).to.equal(0);
      }
    });

    it("a loop this console does not hold is a 404, and nothing is fetched or paid", async () => {
      const { req, built } = request({ loop: null });
      const none = await answerLoopReport(req);
      expect(none.status).to.equal(404);
      expect(built()).to.equal(0);
    });

    it("a plaintext copy the console keeps is answered with no Tempo read; a sealed one is refused unread", async () => {
      // The step's storage.put keeps the report as its result blob, which
      // `/api/traces` already serves, so a plaintext copy is answered before the rate limit and the
      // treasury pays for nothing.
      const asked: string[] = [];
      const { req, built, calls } = request({
        admit: () => "the limit is never asked for a local copy",
        localBlob: async (h) => (asked.push(h), h === HASH ? REPORT : null),
      });
      const res = await answerLoopReport(req);
      expect(res.status).to.equal(200);
      const body = res.body as LoopReportAnswer;
      expect(body.from).to.equal("store");
      expect(body.encoding).to.equal("plain");
      expect(body.payment).to.equal(undefined);
      expect(Buffer.from(body.bytes, "base64").equals(Buffer.from(REPORT))).to.equal(true);
      expect(built()).to.equal(0);
      expect(calls).to.deep.equal([]);
      expect((await checkLoopReport(body, deps(chainRecord()))).verdict).to.equal("ok");
      expect(asked).to.deep.equal([HASH]);

      // A sealed copy is refused before the rate limit and before any Tempo read:
      // Tempo storage holds the same ciphertext, so reading it would only pay to refuse it there.
      const { blob: stored } = sealTrace(new Uint8Array(32).fill(7), REPORT);
      let sealedAdmitted = 0;
      const sealed = request({ admit: () => (sealedAdmitted++, null), localBlob: async () => stored });
      const refused = await answerLoopReport(sealed.req);
      expect(refused.status).to.equal(409);
      expect((refused.body as { error: string }).error).to.contain(
        "was published encrypted, and this console does not open it"
      );
      expect(sealedAdmitted).to.equal(0);
      expect(sealed.built()).to.equal(0);
      expect(sealed.calls).to.deep.equal([]);

      // Other bytes under the hash are not answered from the store: the read goes to Tempo storage,
      // through the rate limit, and pays.
      let admitted = 0;
      const fallthrough = request({ admit: () => (admitted++, null), localBlob: async () => utf8("not the report") });
      const answered = await answerLoopReport(fallthrough.req);
      expect(answered.status).to.equal(200);
      expect((answered.body as LoopReportAnswer).from).to.not.equal("store");
      expect(admitted).to.equal(1);
      expect(fallthrough.built()).to.equal(1);
      expect(fallthrough.calls).to.deep.equal([`${STORAGE}/${KEY}`]);
    });

    it("a report whose storage.put is not written yet is a 409, not an uncommitted read", async () => {
      const { req, calls } = request({
        loop: { id: LOOP_ID, owner: OWNER, history: [published(2, { seq: undefined })] },
      });
      const res = await answerLoopReport(req);
      expect(res.status).to.equal(409);
      expect(calls).to.have.length(0);
    });

    it("the rate limit refuses before the charge, and a refused charge is a 502 with its reason", async () => {
      const limited = request({ admit: () => "rate limit: 30 report reads per hour" });
      const res = await answerLoopReport(limited.req);
      expect(res.status).to.equal(429);
      expect(limited.calls).to.have.length(0);

      const refusing: ChargeFetcher = {
        payer: "0x0",
        async fetch() {
          throw new ChargeRefused("the price 20000 is over the ceiling 10000");
        },
      };
      const refused = await answerLoopReport({ ...request().req, transport: () => refusing });
      expect(refused.status).to.equal(502);
      expect((refused.body as { error: string }).error).to.contain("over the ceiling");
    });
  });

  describe("the loop page's reading of the services", () => {
    it("picks the last 2xx PUT whose key ends in its hash", () => {
      const later = published(5, { key: storageKey(LOOP_ID, "f".repeat(64)), seq: "77" });
      const report = lastPublishedReport([published(2), later, row(6)]);
      expect(report?.step).to.equal(5);
      expect(report?.hash).to.equal("f".repeat(64));
      expect(lastPublishedReport([row(1), published(2, { key: `${LOOP_ID}-latest` })])).to.equal(null);
    });

    it("a step card's _report_: the hash its key commits, and the report's first paragraph as plain text", () => {
      expect(reportHashOf(KEY)).to.equal(HASH);
      expect(reportHashOf(`${LOOP_ID}-latest`)).to.equal(null);
      // Headings, rules and fences are passed over; the first block of prose is the paragraph, its line
      // breaks folded and its Markdown marks out.
      expect(reportFirstParagraph(new TextDecoder().decode(REPORT))).to.equal("The goal was reached at step 3.");
      expect(
        reportFirstParagraph(
          "# Squads v4\n---\n\nThe **Squads v4** program holds\nfunds behind a `threshold`.\n\n## Next\n\nMore."
        )
      ).to.equal("The Squads v4 program holds funds behind a threshold.");
      // A heading with its text right under it, no blank line between: the text is the paragraph.
      expect(reportFirstParagraph("# Title\nFirst line\nsecond line\n\nNext")).to.equal("First line second line");
      expect(reportFirstParagraph("")).to.equal("");
    });

    it("the chip: pending on a fresh paid tempo step, then published or failed, nothing otherwise", () => {
      const tempo = { rail: "tempo" as const };
      const paid = row(3, { tempoSpent: "1500", endedAt: 1_000 });
      expect(storageChipOf(paid, tempo, 2_000)).to.deep.equal({ state: "pending" });
      expect(storageChipOf(paid, tempo, 1_000 + STORAGE_PENDING_MS)).to.equal(null);
      expect(storageChipOf(paid, { rail: "vault" }, 2_000)).to.equal(null);
      // Once the report job says the step wrote no report, the row
      // stops waiting on a PUT that is not coming, rather than reading pending for the whole minute.
      expect(storageChipOf({ ...paid, tempoReport: "none" }, tempo, 2_000)).to.equal(null);
      expect(storageChipOf(row(3, { endedAt: 1_000 }), tempo, 2_000)).to.equal(null);
      expect(storageChipOf(undefined, tempo, 2_000)).to.equal(null);

      const ok = storageChipOf(published(2), tempo, 2_000);
      expect(ok).to.deep.include({ state: "published", amount: "200", reference: TX, seq: "41" });
      const failed = storageChipOf(
        row(2, { tempoStorage: { key: KEY, path: "r.md", bytes: 1, statusCode: 402, error: "over the ceiling" } }),
        tempo,
        2_000
      );
      expect(failed).to.deep.include({ state: "failed", error: "over the ceiling" });
    });

    it("the Costs lines: nothing on an old loop; owner storage, Lath's RPC and both blocks on a new one", () => {
      const old = { history: [row(1, { tempoSpent: "5000" })], tempo: null } as unknown as LoopView;
      expect(tempoServiceLines(old)).to.equal(null);

      const snap = (ofStep: number, block: string, rpc: string) => ({
        ofStep,
        takenAt: 0,
        block,
        rpc: { channelId: "0xrpc", cumulative: rpc },
      });
      const loop = {
        history: [
          { ...published(1), tempoSpent: "3000", tempoSnapshot: snap(1, "100", "3000") },
          // A PUT whose receipt names no transaction moved nothing, and is not the owner's cost.
          row(2, {
            tempoSpent: "2000",
            tempoStorage: { key: KEY, path: "r.md", bytes: 1, statusCode: 502, amount: "200" },
            tempoSnapshot: snap(2, "140", "6000"),
          }),
        ],
        tempo: { payer: "0x1", closed: true, txHash: TX, services: { closeBlock: "150" } },
      } as unknown as LoopView;
      const lines = tempoServiceLines(loop)!;
      expect(lines.model).to.equal(BigInt(5000));
      expect(lines.storage).to.equal(BigInt(200));
      expect(lines.storageCount).to.equal(1);
      expect(lines.rpc).to.equal(BigInt(6000));
      expect(lines.rpcFinal).to.equal(false);
      expect(lines.readBlock).to.deep.equal({ block: "140", ofStep: 2 });
      expect(lines.closeBlock).to.equal("150");
      expect(lines.closeTx).to.equal(TX);

      const settled = {
        ...loop,
        tempo: { ...loop.tempo, services: { closeBlock: "150", rpc: { closed: true, spent: "0.007" } } },
      } as unknown as LoopView;
      const after = tempoServiceLines(settled)!;
      expect(after.rpc).to.equal(BigInt(7000));
      expect(after.rpcFinal).to.equal(true);
    });

    it("reads amounts as dollars a person can read", () => {
      expect(dollarsOfBase("200")).to.equal("$0.0002");
      expect(dollarsOfBase(BigInt(1_500_000))).to.equal("$1.50");
      expect(dollarsOfBase("0")).to.equal("$0.00");
      expect(dollarsOfBase(undefined)).to.equal(null);
      expect(baseOf("0.005")).to.equal(BigInt(5000));
      expect(baseOf("nope")).to.equal(null);
    });
  });
});
