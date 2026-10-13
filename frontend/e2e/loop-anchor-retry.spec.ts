import { expect, test, type Page } from "@playwright/test";
import { createRpc } from "@lightprotocol/stateless.js";
import { Keypair } from "@solana/web3.js";
import { EventKind, LathClient, LOOP_SETTLEMENT_TOOL, LOOP_STEP_TOOL, toBytes32 } from "@lath/sdk";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fillLoopGoal, openLoopForm, openStartedLoop } from "./loop-flow";
import { resignStart } from "./wallet";

/**
 * A failed write on a **loop**: a billed step whose writes will not land stops the run on
 * `anchor-failed`, and *Retry the step* lands them in the order a run with nothing failed would
 * have had — the step's records, then its `loop.step` checkpoint, then the `loop.settlement`
 * record — with no `HeadDiverged` on the way.
 *
 * `console.spec.ts` covers the same fault on a chat session. This is the loop's half, and the
 * harder one: if the tick's stopped branch published a locator cell for the step's own unlanded
 * epoch at the seq the journaled genesis was built for, every Retry would answer 409 _head
 * diverged_. Three rules prevent it: `locatorsOwed` returns only landed epochs, `flushAnchors`
 * writes nothing while the chain carries journaled records, and `retryLoopAnchor` pays owed
 * locators after its clean drain.
 *
 * **Two phases, one console restart between them**, because the fault is armed once per process
 * (`_lib/anchor.ts` `faultBudget`) and a Retry in the same process would only prove that the
 * budget ran out. The restart is also the realistic case: `retryLoopAnchor` binds the chain
 * afresh because a retry "may run in a process that never stepped this loop".
 *
 * - **Phase A** — the console started with `LATH_ANCHOR_FAIL=1 --e2e`, and the same variable set
 *   on this process. Deploys a fresh agent (the wizard is the one path that grants the allowance,
 *   so the step is billed on the `tempo` rail), starts a one-step loop, waits for it to stop on
 *   `anchor-failed`, and writes its id to `RETRY_STATE`.
 * - **Phase B** — the console restarted **without** the flag, and this process without it.
 *   Presses *Retry the step* on the run from `RETRY_STATE`, asserts the answer is not a 409, reads
 *   the order off the chain, and runs `npm run audit` over the agent.
 *
 * One step and not three: the claim is about the order *one* step's writes land in, and with
 * `maxSteps: 1` the stop the fault causes is also the run's end, so the settlement the Retry owes
 * is the only one on the chain — a resumed run would open a second channel and write a second
 * settlement after a second checkpoint, which is another claim. It costs one paid step, about
 * 0.003 USDC.e from the treasury.
 *
 * Devnet, and slow: run it with `--timeout=240000 --workers=1`.
 */

const id = (name: string) => createHash("sha256").update(name).digest("hex");
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const AGENT = `e2e-retry-${RUN}`;

/** Where phase A leaves the loop id for phase B. Outside the repo: it is a run's scratch, not a fixture. */
const STATE = process.env.RETRY_STATE ?? path.join(os.tmpdir(), "lath-jev-walk", "retry-state.json");
/** Screenshots go beside the state file, so one directory holds the whole run. */
const SHOTS = process.env.WALK_SHOTS ?? path.dirname(STATE);
/** Repo root from `frontend/`, for `npm run audit`. */
const ROOT = path.resolve(process.cwd(), "..");

const PROMPT =
  "Goal: keep a short note on Solana transaction fees. Plan: 1) state the base fee per signature in lamports; " +
  "2) end with one line: FEE_NOTE=<one sentence>.";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function connectWallet(page: Page) {
  // The header's wallet button is a `dynamic(..., { ssr: false })` import (`components/Nav.tsx`),
  // so until that chunk arrives the header holds an `aria-hidden` placeholder and no button at
  // all. `count()` does not auto-wait, so branching on it against an un-hydrated header reads 0,
  // skips the connect, and lets the `toHaveCount(0)` below pass vacuously.
  // `.wallet-adapter-button-trigger` is the one element the header renders in both states, so
  // waiting for it is what makes the branch below a real either/or.
  await expect(page.locator(".wallet-adapter-button-trigger").first()).toBeVisible({ timeout: 60_000 });
  const select = page.getByRole("button", { name: /select wallet/i });
  if (await select.count()) {
    await select.first().click();
    await page.getByRole("button", { name: /E2E Keypair/i }).click();
  }
  await expect(page.getByRole("button", { name: /select wallet/i })).toHaveCount(0);
}

/** Deploys a blank agent through the wizard — the one path that grants the allowance, so the step is billable. */
async function deploy(page: Page, name: string) {
  await page.goto("/create?kind=agent");
  await connectWallet(page);
  // The wizard is on screen from the start: an agent is created from blank, with no _Start from_.
  await page.getByPlaceholder("e.g. agent-sentinel-v2").fill(name);
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
  await page.getByRole("button", { name: /^Deploy agent$/ }).click();
  await expect(page.getByText("Agent deployed on Solana")).toBeVisible({ timeout: 240_000 });
}

/** The registry's row for one loop, as `GET /api/loops?id=` serves it. */
async function loopById(page: Page, loopId: string): Promise<any> {
  const one = await (await page.request.get(`/api/loops?id=${encodeURIComponent(loopId)}`)).json();
  return one.loop;
}

/** The RPC the chain read and the CLI need: `LATH_DEVNET_RPC`, `LATH_RPC_URL`, or the Solana CLI's own. */
function rpcUrl(): string {
  if (process.env.LATH_DEVNET_RPC) return process.env.LATH_DEVNET_RPC;
  if (process.env.LATH_RPC_URL) return process.env.LATH_RPC_URL;
  const printed = execFileSync("solana", ["config", "get"], { encoding: "utf8" });
  return printed
    .split("\n")
    .find((l) => l.startsWith("RPC URL:"))!
    .split(/\s+/)[2];
}

/**
 * `npm run audit -- …` from the repo root, returning what it printed **and** whether it exited 0.
 * Non-zero is caught rather than thrown, so a FAILED audit leaves its words in the state file
 * before the assertion reads them.
 */
function audit(args: string[], rpc: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync("npm", ["run", "--silent", "audit", "--", ...args, "--rpc", rpc], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 300_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (e: any) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message) };
  }
}

/* ---------------------------------------------------------------------------------------- */

test("A · a billed loop step whose writes will not land stops on anchor-failed", async ({ page, request }) => {
  test.skip(!process.env.LATH_ANCHOR_FAIL, "phase A: start the app with LATH_ANCHOR_FAIL=1 --e2e and set it here too");
  test.skip(!process.env.LATH_TEMPO_TREASURY, "no LATH_TEMPO_TREASURY: the step would run scripted and unbilled");
  test.setTimeout(15 * 60_000);

  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);

  // The fault is spent on the process's *first* journaled submit, whoever makes it. A loop that
  // resumed on this console's start would make it, and this case would then run a clean step and
  // time out waiting for a stop that is never coming — so a console with anything running is
  // refused here, by name, rather than diagnosed afterwards.
  const all = await (await request.get("/api/loops")).json();
  const running = (all.loops ?? []).filter((l: any) => l.status === "running").map((l: any) => l.id);
  expect(running, "nothing may be running on a console armed with LATH_ANCHOR_FAIL").toEqual([]);

  await deploy(page, AGENT);

  // The loop form at `/create?loop=1&agent=<id>`.
  const form = await openLoopForm(page, id(AGENT));
  // The form's one Goal field, the goal check off: the instruction-only loop.
  await fillLoopGoal(page, PROMPT, { goalCheck: false });
  await form.getByRole("button", { name: "1 min", exact: true }).click();
  await form.getByRole("button", { name: "3", exact: true }).click();
  // One step at the shortest interval. The chips offer neither, so the JSON is patched and signed
  // again with the wallet's own key (`resignStart`): a start's signature hashes its body.
  await page.route("**/api/loops", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (body.action && body.action !== "start") return route.fallback();
    await route.continue({
      postData: JSON.stringify(resignStart({ ...body, maxSteps: 1, intervalMs: 15_000 }, route.request().url())),
    });
  });
  await page.getByTestId("loop-start").click();
  const loopId = await openStartedLoop(page);

  // Written as soon as the id is known: if the stop below never comes, phase B still has the run
  // to look at, and a person has the id to open.
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ loopId, agentName: AGENT, agentId: id(AGENT), phase: "A" }, null, 2));

  // The stop, off the registry: `anchor-failed` is the runner's reason when the session resolved
  // and its writes did not (`runtime/src/loop.ts` `stopReasonFor`). The attempt budget is three
  // submits with backoff, and the step itself is a paid model call before it, hence the wait.
  await expect
    .poll(
      async () => {
        const l = await loopById(page, loopId);
        return `${l?.status}/${l?.stopReason}`;
      },
      { timeout: 10 * 60_000, intervals: [5_000] }
    )
    .toBe("stopped/anchor-failed");

  // What the owner reads: the sentence that says which half failed, and the one control offered
  // for it. *Run again* is withheld on this stop — it would pay twice for work already done.
  await expect(page.getByText(/Not anchored: the work of this run/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("loop-retry-step")).toBeVisible();
  await shot(page, "retry-a-stopped");

  const loop = await loopById(page, loopId);
  // The channel closed and its record was deferred behind the journal. Soft: a
  // run whose close had not finished by now reads differently and is still a valid phase A; the
  // state file says which it was.
  expect.soft(loop.tempo?.recordOwed, "the settlement record waits behind the failed writes").toBe(true);
  expect.soft(loop.history?.[0]?.deferredCheckpoint, "the step's checkpoint is owed, not written").toBeTruthy();

  fs.writeFileSync(
    STATE,
    JSON.stringify(
      {
        loopId,
        agentName: AGENT,
        agentId: id(AGENT),
        phase: "A",
        status: loop.status,
        stopReason: loop.stopReason,
        stopDetail: loop.stopDetail,
        steps: loop.steps,
        tempo: loop.tempo,
        history: loop.history,
      },
      null,
      2
    )
  );
});

test("B · Retry lands the records, then the checkpoint, then the settlement, and the chain audits", async ({
  page,
}) => {
  test.skip(!!process.env.LATH_ANCHOR_FAIL, "phase B: restart the app and this process without LATH_ANCHOR_FAIL");
  test.skip(!fs.existsSync(STATE), `phase B: no ${STATE}; run phase A first`);
  test.skip(
    !process.env.LATH_TEMPO_TREASURY,
    "no LATH_TEMPO_TREASURY: the settlement the Retry owes cannot be replayed"
  );
  test.setTimeout(15 * 60_000);

  const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const loopId: string = state.loopId;
  const agentId: string = state.agentId;
  const before = await loopById(page, loopId);
  expect(before, `the registry still knows ${loopId}`).toBeTruthy();
  expect(`${before.status}/${before.stopReason}`, "phase A left it stopped on anchor-failed").toBe(
    "stopped/anchor-failed"
  );

  await page.goto(`/loop/${loopId}`);
  await connectWallet(page);
  const retry = page.getByTestId("loop-retry-step");
  await expect(retry).toBeVisible({ timeout: 60_000 });
  await shot(page, "retry-b-before");

  // The button signs a `"Lath loop"` message and posts `{action: "retry"}` (`RetryStepButton`);
  // the route answers 409 with the loop as it stands when the drain rejects, and that 409 is
  // exactly the failure this case exists to catch. The drain and the late writes are several devnet
  // confirmations, so the response is waited for on the clock the work needs.
  const answered = page.waitForResponse(
    (r) =>
      r.url().includes("/api/loops") &&
      r.request().method() === "POST" &&
      (r.request().postData() ?? "").includes('"retry"'),
    { timeout: 8 * 60_000 }
  );
  await retry.click();
  const response = await answered;
  const body = await response.json().catch(() => ({}));
  fs.writeFileSync(
    STATE,
    JSON.stringify({ ...state, phase: "B", retryStatus: response.status(), retry: body }, null, 2)
  );
  expect(body.error ?? "", "the Retry's answer").not.toMatch(/head diverged/i);
  expect(response.status(), `the Retry's answer: ${body.error ?? ""}`).toBe(200);

  // The run the page now shows: stopped on `max-steps` rather than `anchor-failed` — one step of
  // one is a finished run (`retryLoopAnchor`'s own rule) — and no retry offered.
  await expect
    .poll(async () => (await loopById(page, loopId))?.stopReason, { timeout: 120_000, intervals: [5_000] })
    .toBe("max-steps");
  await page.reload();
  await expect(page.getByTestId("loop-retry-step")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText(/Not anchored: the work of this run/)).toHaveCount(0);
  await expect(page.getByTestId("loop-channel-record-owed")).toHaveCount(0);
  await expect(page.getByTitle("1/1 checkpoint leaves re-derived in this browser from the chain")).toHaveText(
    "verified on chain",
    { timeout: 180_000 }
  );
  await shot(page, "retry-b-after");

  const after = await loopById(page, loopId);
  const checkpointSeq = after.history?.[0]?.seq;
  expect(checkpointSeq, "the late checkpoint wrote its seq onto the step").toBeTruthy();
  expect(after.history[0].deferredCheckpoint, "and cleared the plan it was owed from").toBeFalsy();

  // The order, off the chain rather than off the registry: the full-mode records of this agent,
  // ascending by seq, and the two Actions the claim is about picked out by tool id. Locator
  // cells take seqs too but are cells, not event records, so they are not in this list — which
  // is right, because the claim is about what folds into the head *as a record*, and the audit
  // below is what holds the cells and the gaps they leave to account.
  const rpc = rpcUrl();
  const client = LathClient.fromIdl(createRpc(rpc, rpc, rpc, { commitment: "confirmed" }), Keypair.generate());
  const idBytes = toBytes32(agentId);
  const records = await client.listEvents(idBytes);
  const steps = await client.listByTool(idBytes, LOOP_STEP_TOOL);
  const settlements = await client.listByTool(idBytes, LOOP_SETTLEMENT_TOOL);
  const order = records.map((r) => ({ seq: r.seq.toString(), kind: EventKind[r.kind], status: r.status }));

  const stepRec = steps.find((r) => r.seq.toString() === String(checkpointSeq));
  const resolution = records.filter((r) => r.kind === EventKind.Resolution && stepRec && r.seq < stepRec.seq).at(-1);
  const genesis = records.filter((r) => r.kind === EventKind.Genesis && resolution && r.seq < resolution.seq).at(-1);
  fs.writeFileSync(
    STATE,
    JSON.stringify(
      {
        ...state,
        phase: "B",
        retryStatus: response.status(),
        retry: body,
        checkpointSeq,
        order,
        loopSteps: steps.map((r) => r.seq.toString()),
        settlements: settlements.map((r) => r.seq.toString()),
        after: { status: after.status, stopReason: after.stopReason, tempo: after.tempo, history: after.history },
      },
      null,
      2
    )
  );

  expect(stepRec, `a loop.step record at the checkpoint's seq ${checkpointSeq}`).toBeTruthy();
  expect(genesis, "the step's session opened with a Genesis before it").toBeTruthy();
  expect(resolution, "and closed with a Resolution before the checkpoint").toBeTruthy();
  expect(steps, "one step, one checkpoint").toHaveLength(1);
  expect(settlements, "one run, one settlement record").toHaveLength(1);
  expect(settlements[0].seq > stepRec!.seq, "the settlement comes after the checkpoint").toBe(true);
  // Nothing of the step after its checkpoint: the records are *all* behind the leaf, which is the
  // order a run with nothing failed would have had.
  const lateStepRecords = records.filter(
    (r) => r.seq > stepRec!.seq && r.seq < settlements[0].seq && r.kind !== EventKind.Action
  );
  expect(lateStepRecords, "no Genesis or Resolution lands between the checkpoint and the settlement").toEqual([]);

  // And the whole chain, from outside the console. No key: the console writes every blob in the
  // clear, so the audit re-hashes every preimage it finds as it is.
  const run = await (await page.request.get("/api/run")).json();
  const dir: string = run.traceBackend?.dir ?? process.env.LATH_TRACE_DIR ?? path.join(ROOT, "frontend/.traces-devnet");
  const printed = audit([agentId, "--store", dir, "--epochs", dir], rpc);
  fs.writeFileSync(
    STATE,
    JSON.stringify(
      {
        ...JSON.parse(fs.readFileSync(STATE, "utf8")),
        auditOk: printed.ok,
        audit: printed.out.trim().split("\n").slice(-12),
      },
      null,
      2
    )
  );
  expect(printed.ok, printed.out.trim().split("\n").slice(-12).join("\n")).toBe(true);
  expect(printed.out).toContain("VERIFIED");
});
