/**
 * The loop's last published report, from Tempo storage. An open read:
 * `_lib/loop-report.ts` holds the rule and says why the console, not the browser, fetches it — only
 * the treasury can read what the treasury stored — and why nothing here has to be believed: the
 * browser re-hashes the bytes against the chain's `storage.put` record before it shows them.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { NextRequest } from "next/server";
import { TRACE_DIR, callerIp, rateLimit } from "../../../_lib/runner";
import { readLoop } from "../../../_lib/loops";
import { answerLoopReport } from "../../../_lib/loop-report";
import { treasuryChargeTransport } from "../../../_lib/tempo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A read that reaches Tempo is a paid GET from the treasury (~$0.0001), so those are counted per caller:
 * thirty an hour is a page reopened every two minutes, and one caller spends at most $0.003 an hour.
 */
const REPORT_READS_PER_HOUR = Number(process.env.LATH_REPORT_READS_PER_HOUR ?? 30);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loop = readLoop(id);
  const { status, body } = await answerLoopReport({
    loop,
    transport: () => treasuryChargeTransport(),
    admit: () => rateLimit("report reads", `report:${callerIp(req)}`, REPORT_READS_PER_HOUR),
    // The step's `storage.put` result blob as this console keeps it, under its hash: the copy
    // `/api/traces` already serves, answered when it is plaintext (`_lib/loop-report.ts`).
    localBlob: async (hashHex) =>
      /^[0-9a-f]{64}$/.test(hashHex) ? new Uint8Array(await fs.readFile(path.join(TRACE_DIR, hashHex))) : null,
  });
  // Never cached: a later step may publish a newer report.
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
