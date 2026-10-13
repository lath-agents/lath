/**
 * `GET /api/loops/<id>/report`: the loop's last published report, read
 * from Tempo storage by the console and checked by the browser.
 *
 * The console is the only reader Tempo storage lets in: keys are per payer, so the report's object is
 * the treasury's and a GET from any other wallet is a paid 404. So the console fetches it with
 * the treasury's charge client and hands back the bytes with the hashes the step's `storage.put`
 * Action commits; it is trusted to carry them and for nothing else. The browser re-hashes the bytes
 * and rebuilds the Action against the chain's record (`checkLoopReport`), so a wrong object or a
 * console that lies shows as a refusal, never as the report.
 *
 * The object read is the committed key, `<loopId>-<sha256>` — the one the Action's args name. It is
 * written once per content and never overwritten, so it holds exactly what the record commits. (An
 * object under `<loopId>-latest` that an older step may have written is never read here.)
 *
 * Open to every reader, like the traces it is one of. The step's `storage.put` record keeps the
 * report as its result blob, so this console usually holds it under the committed hash already and
 * `/api/traces` serves it: when that copy re-hashes to the hash it is answered without a Tempo read,
 * so a read costs the treasury nothing. Otherwise the object is read from Tempo storage, a charge
 * (~$0.0001) counted per caller (`admit`).
 *
 * An object that is `LTE1`/`LTE2` ciphertext — an older report published while the agent's traces
 * were written encrypted (owner privacy, on the roadmap) — is refused, never decrypted and never
 * passed on as bytes: this console does not open encrypted objects.
 */
import { TEMPO_STORAGE_URL, errorText, storageArgsBytes, type ChargeFetcher } from "@lath/runtime";
import { hex, isEncryptedTraceBlob, sha256 } from "@lath/sdk";
import type { LoopStepSummary } from "../../../types/loop";
import { lastPublishedReport, type LoopReportAnswer } from "../../../lib/tempo-services";

export interface LoopReportRequest {
  /** The loop's row, or `null` when there is none. */
  loop: { id: string; owner: string; history: Pick<LoopStepSummary, "step" | "tempoStorage">[] } | null;
  /** The treasury's charge client, built only once the request is admitted. */
  transport: () => ChargeFetcher;
  /** A refusal sentence when the caller is over its limit, checked before a Tempo read. */
  admit?: () => string | null;
  /** Tempo's storage gateway; a test passes its own. */
  storageUrl?: string;
  /**
   * This console's own copy of a blob by its hex hash, from its trace directory, or `null`. Asked for
   * the report's hash first: a plaintext copy that re-hashes is answered with no Tempo read.
   */
  localBlob?: (hashHex: string) => Promise<Uint8Array | null>;
}

export interface LoopReportResponse {
  status: number;
  body: LoopReportAnswer | { error: string };
}

function refuse(status: number, error: string): LoopReportResponse {
  return { status, body: { error } };
}

function encryptedRefusal(key: string): string {
  return `${key} was published encrypted, and this console does not open it`;
}

/**
 * The read, answered as a status and a body so a test drives it without a server. Never throws: a
 * transport that cannot be built (no treasury) or a charge refused is an answer with a sentence.
 */
export async function answerLoopReport(req: LoopReportRequest): Promise<LoopReportResponse> {
  const { loop } = req;
  if (!loop) return refuse(404, "no loop with that id");

  const report = lastPublishedReport(loop.history);
  if (!report) return refuse(404, "this loop published no report to Tempo storage");
  // Published and not committed yet: the Action is written at the next quiet point, and the drain
  // before the stop record writes every one still owed, so a finished loop is never in this state.
  if (!report.seq) {
    return refuse(409, `step ${report.step}'s report is published and its storage.put record is not written yet`);
  }
  const storageUrl = (req.storageUrl ?? TEMPO_STORAGE_URL).replace(/\/+$/, "");
  // The args the Action committed, rebuilt the way the runner built them: the service is the gateway
  // the PUT went to (`put.service`, the queue's `storageUrl`) and the key the committed one.
  const argsHash = hex(sha256(storageArgsBytes(storageUrl, report.key)));

  // A plaintext copy this console already serves (see the header): no Tempo read.
  const local = await req.localBlob?.(report.hash).catch(() => null);
  // This console's own copy, written encrypted: Tempo storage holds the same ciphertext, so it is
  // refused here rather than after a paid read (see the header).
  if (local && isEncryptedTraceBlob(local)) return refuse(409, encryptedRefusal(report.key));
  if (local && hex(sha256(local)) === report.hash.toLowerCase()) {
    return {
      status: 200,
      body: {
        step: report.step,
        seq: report.seq,
        key: report.key,
        fetchedKey: report.key,
        resultHash: report.hash,
        argsHash,
        statusCode: report.statusCode,
        path: report.path,
        bytes: Buffer.from(local).toString("base64"),
        size: local.length,
        encoding: "plain",
        from: "store",
      },
    };
  }

  const refused = req.admit?.();
  if (refused) return refuse(429, refused);

  const fetchedKey = report.key;
  let answer: Awaited<ReturnType<ChargeFetcher["fetch"]>>;
  try {
    answer = await req.transport().fetch(`${storageUrl}/${fetchedKey}`, { method: "GET" });
  } catch (e) {
    return refuse(502, `Tempo storage was not read: ${errorText(e, 300)}`);
  }
  if (answer.status === 404) return refuse(404, `Tempo storage holds no object under ${fetchedKey}`);
  if (answer.status < 200 || answer.status >= 300) {
    return refuse(502, `Tempo storage answered ${answer.status} for ${fetchedKey}`);
  }

  // An encrypted report: refused rather than opened (see the header).
  if (isEncryptedTraceBlob(answer.bytes)) return refuse(409, encryptedRefusal(fetchedKey));
  const plain = answer.bytes;

  return {
    status: 200,
    body: {
      step: report.step,
      seq: report.seq,
      key: report.key,
      fetchedKey,
      resultHash: report.hash,
      argsHash,
      statusCode: report.statusCode,
      path: report.path,
      bytes: Buffer.from(plain).toString("base64"),
      size: plain.length,
      encoding: "plain",
      storedSize: answer.bytes.length,
      ...(answer.payment ? { payment: { amount: answer.payment.amount, reference: answer.payment.reference } } : {}),
    },
  };
}
