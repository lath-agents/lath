/**
 * `GET /api/zeroclaw`: every loop's sandbox, and this console's one host status.
 *
 * Two routes rather than the `?id=` that `/api/loops` takes, because the tab's two pages map one to
 * one onto `/api/zeroclaw` and `/api/zeroclaw/<loopId>`.
 * The list takes the same filters `/api/loops` GET does — `?owner=` and `?archived=1` — and leaves
 * archived runs out by default for the same reason: the list is what a wallet is running, and the
 * detail route still resolves an archived loop.
 *
 * Read-only and open, like `/api/loops` GET: hashes, the posture the step's Genesis committed, sizes
 * and seqs — the texts are on the detail route. Unlike that GET it is **not** the scheduler's
 * heartbeat: it does not call `syncScheduler`, because opening the tab must not be what starts a
 * step that writes the chain. The page states this route on screen.
 */
import { NextRequest } from "next/server";
import { CLUSTER } from "../_lib/runner";
import { readZeroClawHost, readZeroClawSandboxes } from "../_lib/zeroclaw";
import type { ZeroClawListResponse } from "../../../types/zeroclaw";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  const archived = req.nextUrl.searchParams.get("archived") === "1";
  const body: ZeroClawListResponse = {
    cluster: CLUSTER,
    host: readZeroClawHost(process.env, process.platform, false),
    sandboxes: readZeroClawSandboxes({ owner, archived }),
  };
  return Response.json(body);
}
