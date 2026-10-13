import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { FileTraceStore, SIWS_SUFFIX, toBytes32 } from "@lath/sdk";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { LOOP_PRESETS } from "@/lib/loop-presets";
import { openAdvanced } from "./disclose";
import { deployBlankAgent } from "./loop-flow";
import { resignStart } from "./wallet";

/**
 * A loop's sandbox sources end to end, as one serial case on devnet: the
 * `protocol-audit` preset on a fresh agent, _Check sources_, one signed start, two steps, the sandbox
 * page for each, a read of `sources/…` on the agent's chain, and `lath-audit` VERIFIED.
 *
 * What the case holds, in the order it walks:
 *
 * 1. `/create?loop=1&agent=<id>&preset=protocol-audit` opens the form filled: the goal, verify on, no
 *    team section, and the Files section open on the two sources, read-only (the Squads v4 repo
 *    path, its program on devnet);
 * 2. _Check sources_ resolves both rows before the wallet signs — the repo to a commit, the account
 *    to a slot, each with its file count — and the start that follows is pinned to that commit;
 * 3. the start is **one** `"Lath loop"` message and no transaction, counted on the wire because the
 *    E2E adapter signs without a dialog;
 * 4. for each of the two steps, `/zeroclaw/<loop>?step=N` lists session A and no other sandbox,
 *    shows the Sources card, re-hashes the manifest to the posture's `sources.hash` with no mismatch,
 *    tags that hash `chain`, and _Verify_ re-hashes the posture;
 * 5. across the two steps the agent anchored a `zc.file_read` at status 200 whose `path` is under
 *    `sources/` — read off the blobs the console wrote in the clear (`sourceReads` says how);
 * 6. `npm run audit` from outside the console says VERIFIED for the agent;
 * 7. the texts are every reader's: a read that signed nothing gets the goal and the two inputs back
 *    beside the hashes that commit them.
 *
 * The form's options are all on screen with no _Advanced_ box, and verify is on for every start with
 * no toggle (one line above Start says so). The form offers no team and types no GitHub or Solana
 * source (ROADMAP.md): the preset's sources show read-only. Teams are on the roadmap and not in this
 * build, and the console refuses a start that carries one, so the case is the preset's own loop, one
 * agent a step, as the form sends it, and what it holds is that agent's sandbox: the sources seeded,
 * re-hashed on the tab, read on the chain and audited.
 *
 * **Spends real USDC.e** from the Tempo treasury (a few thousand base units a step: the agent and
 * the decision model's goal check) and skips itself when the console has no treasury — the scripted
 * transport's answer is a fixture, not a model reading the sources — or no Lath-patched binary. Run it
 * as every loop spec runs, against the one console on :3000:
 *
 * ```bash
 * cd frontend && PLAYWRIGHT_BASE_URL=http://localhost:3000 LATH_TRACE_DIR=$PWD/.traces-devnet \
 *   npx playwright test e2e/sandbox-sources.spec.ts --timeout=240000 --workers=1
 * ```
 *
 * (`test.setTimeout` below overrides `--timeout` for this case; the flag is there for habit.)
 */

const id = (name: string) => createHash("sha256").update(name).digest("hex");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const NAME = `e2e-sources-${RUN}`;
/** Repo root from `frontend/`, for `npm run audit`. */
const ROOT = path.resolve(process.cwd(), "..");

const PRESET = LOOP_PRESETS["protocol-audit"];

// The preset's GitHub File, read from it, so the case follows whichever tree the preset names.
const SQUADS_REPO = (PRESET.sandbox.sources ?? []).flatMap((s) => (s.kind === "github" ? [s.url] : []))[0] ?? "";
/** The path after the ref, as the start pins it under `/tree/<commit>/`. */
const SQUADS_PATH = SQUADS_REPO.split("/tree/main/")[1] ?? "";
const SQUADS_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/**
 * Words no ZeroClaw or loop screen may say — `zeroclaw-step.spec.ts`'s list, built from halves for
 * the reason `loop-verify.spec.ts` gives: the repo is swept for these words.
 */
const RETIRED = new RegExp(
  `\\b(${["hi" + "re", "wor" + "ker", "provi" + "der", "pro" + "ven", "verified " + "correct"].join("|")})\\b`,
  "i"
);

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

/** The header's wallet connect, waited for the way `loop-verify.spec.ts` explains. */
async function connectWallet(page: Page) {
  await expect(page.locator(".wallet-adapter-button-trigger").first()).toBeVisible({ timeout: 60_000 });
  const select = page.getByRole("button", { name: /select wallet/i });
  if (await select.count()) {
    await select.first().click();
    await page.getByRole("button", { name: /E2E Keypair/i }).click();
  }
  await expect(page.getByRole("button", { name: /select wallet/i })).toHaveCount(0);
}

/** The trace directory the server writes to, as the server reports it — never guessed. */
async function traceDir(request: APIRequestContext): Promise<string> {
  const run = await (await request.get("/api/run")).json();
  return run.traceBackend?.dir ?? process.env.LATH_TRACE_DIR ?? path.join(ROOT, "frontend/.traces-devnet");
}

/** The RPC the CLI needs: the devnet one, never `api.devnet.solana.com`, which has no compression index. */
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
 * What the wallet was asked for while `fn` ran, counted rather than seen (the E2E adapter draws no
 * prompt): raw transactions sent to an RPC, and distinct signed console messages in POST bodies.
 *
 * A console message is Sign-In-With-Solana-shaped (`sdk/src/signer.ts` `authMessage`): its first
 * line is the site and `SIWS_SUFFIX`, and the purpose — `Lath loop: start <agent>` — is its fourth,
 * so a match on a message that *begins* `Lath ` would count none. The JSON string is matched whole,
 * escapes and all, and decoded, so the message is held as the wallet signed it.
 */
async function countPrompts(page: Page, fn: () => Promise<void>) {
  let transactions = 0;
  const messages = new Set<string>();
  const onRequest = (req: { method(): string; postData(): string | null }) => {
    if (req.method() !== "POST") return;
    const body = req.postData();
    if (!body) return;
    if (/"method"\s*:\s*"sendTransaction"/.test(body)) transactions++;
    const m = body.match(/"message"\s*:\s*("(?:[^"\\]|\\.)*")/);
    const message = m ? (JSON.parse(m[1]) as string) : null;
    if (message?.split("\n")[0].endsWith(SIWS_SUFFIX)) messages.add(message);
  };
  page.on("request", onRequest);
  try {
    await fn();
  } finally {
    page.off("request", onRequest);
  }
  return { transactions, messages: [...messages] };
}

/**
 * Every `zc.file_read` at status 200 whose args name a path, found in the blob directory among blobs
 * written since `sinceMs`.
 *
 * How, and why this way. The sandbox page's Actions table shows seq, tool and status but not the path
 * — the path is inside the Action's `args` blob — and neither
 * the sandbox record nor `lath-audit` prints args. What the runtime does store (`storePayloads: true`
 * for every loop session) is each Action's payload preimage, `kind ‖ sha256(tool_id) ‖ args_hash ‖
 * result_hash ‖ status u16le` (99 bytes, `encodePayload` in `sdk/src/events.ts`), content-addressed
 * by the `payload_hash` the chain carries. The console writes every blob in the clear, so each blob
 * this run wrote is read as it is and kept only when its bytes re-hash to its name — a blob that does
 * not is ciphertext from a chain written encrypted into the same directory — and a preimage that is
 * an Action of `zc.file_read` at 200 leads to its args blob, whose `path` is read. The agent is fresh
 * — its name is new per run — and only blobs written since the start are read, so every such
 * preimage is this run's or another case's running beside it on the same console.
 */
async function sourceReads(dir: string, sinceMs: number): Promise<string[]> {
  const store = new FileTraceStore(dir);
  const open = async (hash: Uint8Array): Promise<Uint8Array | null> => {
    const bytes = await store.get(hash).catch(() => null);
    if (!bytes || !sha256(bytes).equals(Buffer.from(hash))) return null;
    return bytes;
  };
  const readTool = sha256("zc.file_read");
  const paths: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    let mtime: number;
    try {
      mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < sinceMs) continue;
    const pre = await open(toBytes32(name));
    if (!pre || pre.length !== 99 || pre[0] !== 1) continue;
    if (!Buffer.from(pre.subarray(1, 33)).equals(readTool)) continue;
    if (Buffer.from(pre.subarray(97, 99)).readUInt16LE(0) !== 200) continue;
    const args = await open(pre.subarray(33, 65));
    if (!args) continue;
    try {
      const parsed = JSON.parse(Buffer.from(args).toString("utf8")) as { path?: unknown };
      if (typeof parsed.path === "string") paths.push(parsed.path);
    } catch {
      // args that are not JSON name no path
    }
  }
  return paths;
}

interface SandboxRowView {
  kind: "session" | "member" | "synthesis";
  label: string;
  sandbox: string | null;
  agentId: string;
}

test("the protocol-audit preset reads its sources in its sandbox, on chain and on the tab", async ({
  page,
  request,
}) => {
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  const zeroclaw = await (await request.get("/api/zeroclaw")).json();
  test.skip(
    !zeroclaw.host?.configured,
    `no Lath-patched binary on the server (${
      zeroclaw.host?.note ?? "GET /api/zeroclaw did not answer"
    }): loop steps cannot run in a sandbox`
  );
  const treasury = await (await request.get("/api/tempo/treasury")).json();
  test.skip(
    !treasury?.enabled,
    "this console has no Tempo treasury: the scripted transport's answer is a fixture, not a model reading the sources"
  );
  // A deploy, two steps and their goal checks, the sandbox pages and the audit. Devnet's
  // worst day, not its median.
  test.setTimeout(60 * 60_000);

  await deployBlankAgent(page, NAME, connectWallet, { timeout: 240_000 });
  const agentId = id(NAME);
  console.log(`sandbox-sources: agent ${NAME} ${agentId}`);

  // 1. The preset link. `LoopEntry` falls back to the wallet's first agent while the registry has
  // not listed a fresh deploy yet, so the select is held to this agent — a form on another agent
  // would carry the preset just as happily — and the page reloads until the list has caught up.
  const presetUrl = `/create?loop=1&agent=${agentId}&preset=protocol-audit`;
  await page.goto(presetUrl);
  await connectWallet(page);
  await expect(async () => {
    if (!(await page.getByTestId("loop-agent-select").count())) await page.goto(presetUrl);
    await expect(page.getByTestId("loop-agent-select")).toHaveValue(agentId, { timeout: 15_000 });
  }).toPass({ timeout: 180_000, intervals: [3_000, 5_000, 10_000] });
  const form = page.getByTestId("loop-start-form");
  await expect(form).toBeVisible({ timeout: 60_000 });
  await expect(form).toHaveAttribute("data-preset", PRESET.id);

  // The goal, as the preset wrote it.
  await expect(page.getByTestId("loop-goal-input")).toHaveValue(PRESET.loop.goal!);
  // Every option is on screen; `openAdvanced` only waits for the section.
  await openAdvanced(form);
  // No team section, and none is added to the start below: the console refuses a start that
  // carries one (`_lib/roadmap.ts`).
  await expect(page.getByTestId("loop-team-field")).toHaveCount(0);
  // Verify on: no toggle, one line at the preset's bar (its `verify: {}` is the default).
  await expect(page.getByTestId("loop-verify-toggle")).toHaveCount(0);
  await expect(page.getByTestId("loop-verify-always")).toContainText("minimum confidence of 0.5");
  // The Files section open on the two sources, read-only: the repo path as a GitHub row, the program
  // on devnet, neither editable, with the one line under the attach control.
  await expect(page.getByTestId("loop-sandbox-toggle")).toHaveAttribute("aria-pressed", "true");
  const sources = page.getByTestId("loop-sandbox-source");
  await expect(sources).toHaveCount(2);
  await expect(sources.nth(0).getByTestId("loop-sandbox-source-frozen")).toContainText("GitHub");
  await expect(sources.nth(0).getByTestId("loop-sandbox-source-frozen")).toContainText(SQUADS_REPO);
  await expect(sources.nth(1).getByTestId("loop-sandbox-source-frozen")).toContainText("Solana · devnet");
  await expect(sources.nth(1).getByTestId("loop-sandbox-source-frozen")).toContainText(SQUADS_PROGRAM);
  await expect(page.getByTestId("loop-sandbox-source-url")).toHaveCount(0);
  await expect(page.getByTestId("loop-sandbox-source-address")).toHaveCount(0);
  // The Files section's one sentence, word for word.
  await expect(page.getByTestId("loop-sandbox-files-line")).toHaveText("Each step reads these files from Irys.");
  await expect(page.locator("body")).not.toHaveText(RETIRED);

  // 2. Check sources: each row's pin and size, before anything is signed. The GitHub row shows the
  // commit's first seven hex characters (`ResolvedLine`), the account its slot.
  await page.getByTestId("loop-sandbox-check-sources").click();
  await expect(page.getByTestId("loop-sandbox-check-ok")).toBeVisible({ timeout: 180_000 });
  const resolved = page.getByTestId("loop-sandbox-source-resolved");
  await expect(resolved).toHaveCount(2);
  await expect(resolved.nth(0)).toContainText(/Squads-Protocol\/v4 @ main → [0-9a-f]{7}/);
  await expect(resolved.nth(0)).toContainText(/[1-9][\d,]* files?/);
  // `Solana devnet`, not a bare cluster.
  await expect(resolved.nth(1)).toContainText(/Solana devnet · slot \d+/);
  await expect(resolved.nth(1)).toContainText(/[1-9][\d,]* files?/);
  // A resolved row is ticked, and stays read-only and removable.
  await expect(sources.nth(0).getByTestId("loop-sandbox-source-ok")).toBeVisible();
  await expect(sources.nth(0).getByTestId("loop-sandbox-source-frozen")).toContainText(
    SQUADS_REPO.replace(/^https:\/\//, "")
  );
  await expect(sources.nth(0).getByTestId("loop-sandbox-source-url")).toHaveCount(0);
  await expect(sources.nth(1).getByTestId("loop-sandbox-source-address")).toHaveCount(0);
  const shortCommit = (await resolved.nth(0).innerText()).match(/→ ([0-9a-f]{7})/)![1];

  // 3. Two steps fifteen seconds apart, terms the chips do not offer: the chips are set, and the
  // start's JSON is patched on its way out and signed again with the wallet's own key
  // (`resignStart`; a start's signature hashes its body, `loopAuthBinding`). Only the start is patched; the
  // unsigned `check-sources` POST shares the route and passes through. The body is kept and asserted
  // after, rather than inside the handler, so a wrong body fails the case instead of the request.
  await form.getByRole("button", { name: "1 min", exact: true }).click();
  await form.getByRole("button", { name: "3", exact: true }).click();
  let startBody: Record<string, any> | null = null;
  await page.route("**/api/loops", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (body.action !== "start") return route.fallback();
    startBody = body;
    // The preset asks for the receipt on SAS (it is the demo's loop), so on a console that offers one
    // the form sends the console's pointer under `receipt`; it is dropped here, because this case is
    // about the sources, two steps cannot be the demo's run, and a receipt it
    // happened to earn would spend the console's runtime key's SOL on rent for a loop nobody films.
    const { receipt: _receipt, ...unreceipted } = body;
    const twoSteps = { ...unreceipted, maxSteps: 2, intervalMs: 15_000 };
    await route.continue({ postData: JSON.stringify(resignStart(twoSteps, route.request().url())) });
  });

  // The blobs this run writes are the ones newer than this; a minute of slack for clock skew
  // between this process and the server's filesystem (the same machine, but not the same clock read).
  const startedAt = Date.now() - 60_000;
  await expect(page.getByTestId("loop-start")).toBeEnabled({ timeout: 15_000 });
  const prompts = await countPrompts(page, async () => {
    const started = page.waitForResponse(
      (r) =>
        r.url().includes("/api/loops") &&
        r.request().method() === "POST" &&
        /"action"\s*:\s*"start"/.test(r.request().postData() ?? ""),
      { timeout: 180_000 }
    );
    await page.getByTestId("loop-start").click();
    const res = await started;
    // The form asks for the streamed start, whose HTTP status is 200 before the start is
    // decided: the answer is the last event's.
    const answer = await res.text();
    expect(res.ok() && /event: result\ndata: \{"status":200,/.test(answer), `the start was refused: ${answer}`).toBe(
      true
    );
    // A start from _New loop_ goes to the loop's page itself rather than stopping on a link.
    await expect(page).toHaveURL(/\/loop\/loop-/, { timeout: 60_000 });
  });
  // One prompt: one `"Lath loop"` message and no transaction (one wallet prompt per action).
  expect(prompts.transactions, "the start sent no transaction").toBe(0);
  expect(prompts.messages, "the start signed exactly one message").toHaveLength(1);
  expect(prompts.messages[0].split("\n")[3], "the message is a Lath loop start for this agent").toBe(
    `Lath loop: start ${agentId}`
  );

  // The body the form built: the preset's terms, and the GitHub source pinned to the commit the
  // check showed (`pinnedInputs`), so the tree fetched at start is the one on screen before signing.
  const body = startBody as Record<string, any> | null;
  expect(body, "the form posted a start").not.toBeNull();
  expect(body!.agentId).toBe(agentId);
  expect(body!.goal).toBe(PRESET.loop.goal);
  // The loop's one budget, the preset's figure on a chip.
  expect(body!.budgetMicroUsdc).toBe(PRESET.loop.budgetMicroUsdc);
  expect(body!.verify, "verify on").toBeTruthy();
  expect(body!.workers, "the form sends no team").toBeUndefined();
  expect(body!.sandbox?.sources).toHaveLength(2);
  expect(body!.sandbox.sources[0].kind).toBe("github");
  expect(body!.sandbox.sources[0].url).toMatch(
    new RegExp(`^https://github\\.com/Squads-Protocol/v4/tree/${shortCommit}[0-9a-f]{33}/${SQUADS_PATH}$`)
  );
  expect(body!.sandbox.sources[1]).toEqual({ kind: "solana", cluster: "devnet", address: SQUADS_PROGRAM });

  await expect(page).toHaveURL(/\/loop\/loop-/, { timeout: 60_000 });
  const loopId = page.url().split("/loop/")[1].split(/[?#]/)[0];
  console.log(`sandbox-sources: loop ${loopId} on agent ${NAME} ${agentId}`);

  // Two history rows, one a step.
  const rows = page.getByTestId("loop-steps").locator(".step-row");
  await expect(rows).toHaveCount(2, { timeout: 40 * 60_000 });
  await expect(page.locator("body")).not.toHaveText(RETIRED);

  // 4. Each step's sandbox page. By its own URL, not the bare one, which follows the newest step.
  const fileReads: { step: number; label: string; agentId: string; seq: string }[] = [];
  for (const step of [1, 2]) {
    await page.goto(`/zeroclaw/${loopId}?step=${step}`);
    await expect(page.getByText(`step ${step}`, { exact: true })).toBeVisible({ timeout: 60_000 });

    // Sandboxes in this step: session A, and nothing else — one agent, no members and no synthesis.
    await expect(page.getByTestId("zeroclaw-sandboxes")).toBeVisible({ timeout: 120_000 });
    const session = page.locator('[data-testid="zeroclaw-sandbox-row"][data-kind="session"]');
    await expect(session).toHaveCount(1);
    await expect(session).toContainText("session A");
    await expect(session).toContainText(/bwrap|sandbox-exec/);
    await expect(page.getByTestId("zeroclaw-sandbox-row")).toHaveCount(1);

    // Sources: the card, the manifest re-hashed in this browser to the posture's `sources.hash`, and
    // that hash tagged `chain` — it is read from the posture, which Verify holds to the Genesis.
    const card = page.getByTestId("zeroclaw-sources");
    await expect(card).toBeVisible({ timeout: 60_000 });
    const checks = page.getByTestId("zeroclaw-sources-checks");
    await expect(checks).toContainText(/match\s*manifest → posture sources\.hash/);
    await expect(checks).not.toContainText("mismatch");
    await expect(card.locator('[data-testid="source-tag"][data-source="chain"]')).toHaveCount(1);
    const entries = page.getByTestId("zeroclaw-source");
    await expect(entries).toHaveCount(2);
    // The commit the sandbox was seeded from is the one _Check sources_ showed before the signature.
    await expect(entries.nth(0).locator(`a[title^="${shortCommit}"]`)).toHaveCount(1);
    await expect(entries.nth(1)).toContainText(/slot \d+/);

    // Verify: the posture's bytes re-hash to the hash the sandbox recorded, and nothing is a mismatch.
    await page.getByTestId("zeroclaw-posture-verify").click();
    const posture = page.getByTestId("zeroclaw-posture-checks");
    await expect(posture).toContainText(/match\s*posture bytes → posture hash/, { timeout: 120_000 });
    await expect(posture).not.toContainText("mismatch");
    await expect(page.locator("body")).not.toHaveText(RETIRED);

    // The sandbox as the route reports it, and its recorded `zc.*` calls: which files it read at 200,
    // on which chain and at which seq.
    const detail = await (await request.get(`/api/zeroclaw/${encodeURIComponent(loopId)}?step=${step}`)).json();
    const sandboxes = (detail.sandbox?.sandboxes ?? []) as SandboxRowView[];
    expect(
      sandboxes.map((r) => r.kind),
      `step ${step}'s sandboxes`
    ).toEqual(["session"]);
    for (const r of sandboxes) {
      const q = r.sandbox ? `?step=${step}&sandbox=${encodeURIComponent(r.sandbox)}` : `?step=${step}`;
      const one = await (await request.get(`/api/zeroclaw/${encodeURIComponent(loopId)}${q}`)).json();
      for (const a of (one.sandbox?.actions?.value ?? []) as { seq: string; tool: string; status: number }[]) {
        if (a.tool === "zc.file_read" && a.status === 200)
          fileReads.push({ step, label: r.label, agentId: one.sandbox.selected.agentId, seq: a.seq });
      }
    }
  }
  console.log(`sandbox-sources: zc.file_read 200 ${JSON.stringify(fileReads)}`);

  // 7. Whose texts they are: every reader's. A read that signed nothing and sends no header gets the
  // goal and the inputs as typed, beside the hashes that commit them.
  const loop = (await (await request.get(`/api/loops?id=${encodeURIComponent(loopId)}`)).json()).loop;
  expect(loop.goal).toBe(PRESET.loop.goal);
  expect(loop.goalHash).toBe(sha256(PRESET.loop.goal!).toString("hex"));
  expect(loop.sandbox?.config?.sources).toHaveLength(2);
  expect(loop.sandbox?.sourcesHash).toMatch(/^[0-9a-f]{64}$/);

  // 5. A read of `sources/…` at 200, on the agent's chain. The sandbox record names the reads (above);
  // the path is only in the args blob, read here from the store (`sourceReads`).
  expect(fileReads.length, "the sandbox called file_read and got a 200").toBeGreaterThan(0);
  const dir = await traceDir(request);
  const paths = await sourceReads(dir, startedAt);
  console.log(`sandbox-sources: file_read paths ${JSON.stringify(paths)}`);
  expect(
    paths.some((p) => /(^|\/)sources\//.test(p)),
    `a zc.file_read at 200 under sources/ (read: ${paths.join(", ") || "none"})`
  ).toBe(true);

  // 6. And from outside the console: the audit replays the agent's chain and re-hashes the blobs the
  // console wrote in the clear, with no key; it exits 0 on VERIFIED, and anything else throws here.
  const printed = execFileSync(
    "npm",
    ["run", "--silent", "audit", "--", agentId, "--rpc", rpcUrl(), "--store", dir, "--epochs", dir],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000 }
  );
  expect(printed).toContain("VERIFIED");
  console.log(`sandbox-sources: done — loop ${loopId}, agent ${NAME} ${agentId}, audit VERIFIED`);
});
