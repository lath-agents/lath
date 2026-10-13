/**
 * `GET /api/zeroclaw/<loopId>[?step=N][&sandbox=<member>]`: one loop's sandbox — step N's posture as
 * committed, or the last step's, the `zc.*` Actions the sandbox recorded and the replay record, plus
 * every sandbox the step opened and the sources as committed. `sandbox` names a member; without it
 * the fields describe session A.
 *
 * Not the TOML and wrapper profile derived from the posture, to anyone: they name this host's
 * binary, directories and sockets and nothing commits them (`HOST_PATHS_WITHHELD`), as
 * `host` below is read without paths.
 *
 * Read-only and open, and an archived loop still answers, the way `/api/loops?id=` does: a link
 * into a sandbox has to keep working after the run leaves the lists. The page holds what this route
 * says against the chain — the Actions by seq, the posture against the Genesis's
 * `policy_version_hash` — so nothing here has to be believed.
 */
import { NextRequest } from "next/server";
import { CLUSTER } from "../../_lib/runner";
import { readZeroClawHost, readZeroClawSandbox, type ZeroClawSandboxDetailResponse } from "../../_lib/zeroclaw";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const raw = req.nextUrl.searchParams.get("step");
  // Steps are numbered from 1; anything else is refused rather than read as "the last step", which
  // would answer a different question than the one asked.
  const step = raw === null ? undefined : /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : null;
  if (step === null) return Response.json({ error: "step must be a positive integer" }, { status: 400 });
  // A member's name as the step's row has it. Bounded, not validated: a name the step does not carry
  // is answered as a sandbox with no record and says so, which is what a stale link should see.
  // `room` is the parameter's older name, which a stored link or an older client may still send.
  const member = req.nextUrl.searchParams.get("sandbox") ?? req.nextUrl.searchParams.get("room");
  if (member !== null && (member.length === 0 || member.length > 128)) {
    return Response.json({ error: "sandbox must name a member of the step" }, { status: 400 });
  }
  const sandbox = readZeroClawSandbox(id, step, member ?? undefined);
  if (!sandbox) return Response.json({ error: "no loop with that id" }, { status: 404 });
  const body: ZeroClawSandboxDetailResponse = {
    cluster: CLUSTER,
    host: readZeroClawHost(process.env, process.platform, false),
    sandbox,
  };
  return Response.json(body);
}
