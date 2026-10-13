import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authMessage, type AuthBinding, type AuthPurpose } from "@lath/sdk";
import { agentAction, openAgentMenu, openInfo, openProof } from "./disclose";
import { consoleOrigin } from "./wallet";

/**
 * Template lineage on a deployed agent: the implicit template a wizard deploy writes, a second
 * version of it, and the record following that version.
 *
 * What is driven through the browser is what the browser can drive: the wizard deploys
 * (`/create?kind=agent`) and the owner's *Use version n* control on `/agent/<id>` moves the
 * record, both signed by the E2E wallet. The console has no `/templates` page and no wizard
 * *from a template* step, so the template reads and the version write go to the API —
 * `GET /api/templates`, `PUT /api/templates` — signed here with the same wallet under the same
 * purpose (`"Lath template"`) the browser would sign with.
 *
 * The claims:
 *
 * - the deploy wrote a template, and the `{ id, version, hash }` on the record is the listed
 *   template's — checked both ways: the list's hash equals `GET /api/agents/<id>`'s, and the
 *   listed `config` re-hashes to it in this process;
 * - the agent page says *deployed from ‹template› v‹n›* for exactly that version;
 * - a `PUT` with a changed prompt appends a version rather than overwriting one: v2 with a new
 *   hash, and `GET /api/templates?id=` still serves v1;
 * - *Use version 2* on the agent page moves the record's `template.version` and the lineage line
 *   on the page, and nothing about the chain: the agent's own chain check still verifies.
 *
 * The other half — a session's genesis policy hash differing across the version switch — is the
 * last case: a genesis record's trace drawer prints the `policy_version_hash` those bytes commit
 * to, beside the leaves it can fetch. One session under v1 and one under v2, and the two hashes
 * compared.
 *
 * *Use version n* is an item of the agent page's ⋯ menu, and the event timeline is behind its
 * **Proof**; the lineage line and the chain badge stay in the header.
 */

const id = (name: string) => createHash("sha256").update(name).digest("hex");
/** Fresh names per run; `E2E_RUN=<suffix>` re-targets an agent an earlier run deployed. */
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const AGENT = `e2e-tpl-${RUN}`;
/** The env file the seed writes under `--e2e-wallet`; the browser's wallet is this keypair. */
const E2E_ENV = path.join(process.cwd(), ".env.devnet.e2e");

test.describe.configure({ mode: "serial" });

// ─── The wallet, and the messages it signs ──────────────────────────────────

/**
 * The keypair `frontend/src/lib/e2e-wallet.ts` hands the browser, read from the same file
 * `dev-devnet.sh --e2e` sources: `NEXT_PUBLIC_E2E_WALLET_SECRET='[64 bytes]'`. Signing here is
 * what lets the spec call a write the console has no control for yet; the signature is the one
 * the browser's wallet would have produced for the same message.
 */
function e2eKeypair(): Keypair | null {
  try {
    const line = readFileSync(E2E_ENV, "utf8")
      .split("\n")
      .find((l) => l.startsWith("NEXT_PUBLIC_E2E_WALLET_SECRET="));
    if (!line) return null;
    const raw = line.slice(line.indexOf("=") + 1).trim();
    const json = raw.replace(/^['"]/, "").replace(/['"]$/, "");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json) as number[]));
  } catch {
    return null;
  }
}

/**
 * The SDK's `authMessage` — the function the route and `signAuth` in `lib/console-stream.tsx`
 * both call — signed the way the browser signs it: base64 ed25519 over the utf8 bytes, and a
 * 64-byte web3.js secret key is `seed ‖ pubkey` so ed25519 signs with the first 32. Each nonce is
 * single-use, so every call mints its own; `bound` is the request it is for.
 */
function signAuth(
  purpose: AuthPurpose,
  bound: AuthBinding,
  cluster: string,
  keypair: Keypair
): { message: string; signature: string } {
  const message = authMessage(purpose, {
    ...bound,
    ...consoleOrigin(),
    cluster,
    wallet: keypair.publicKey.toBase58(),
    issued: new Date().toISOString(),
    nonce: randomBytes(16).toString("hex"),
  });
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), keypair.secretKey.slice(0, 32)));
  return { message, signature: signature.toString("base64") };
}

// ─── The hash, re-derived here ──────────────────────────────────────────────

/** `canonicalJson` from `runtime/src/policy.ts`: sorted keys, `undefined` dropped. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** `templateHash` from `api/_lib/templates.ts`: the content address of `config` alone. */
const templateHash = (config: unknown) => createHash("sha256").update(canonicalJson(config), "utf8").digest("hex");

// ─── Fixtures the serial cases share ────────────────────────────────────────

interface TemplateRow {
  id: string;
  kind: "agent" | "loop";
  name: string;
  version: number;
  hash: string;
  config: Record<string, unknown>;
}

interface AgentRecord {
  id: string;
  name: string;
  owner: string | null;
  template: { id: string; version: number; hash: string } | null;
  templateName: string | null;
  latestVersion: number | null;
}

let cluster = "";
let wallet: Keypair | null = null;
/** The version the second case writes, read by its own assertions after the page moved. */
let secondVersion = 0;
/** The policy version hash the session under v1 committed, read off the page. */
let v1PolicyHash: string | null = null;

test.beforeEach(async ({ page, request }) => {
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  cluster = runner.cluster;
  wallet = e2eKeypair();
  test.skip(!wallet, `no E2E wallet secret in ${E2E_ENV}; seed with --e2e-wallet`);
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

/**
 * `autoConnect` only reconnects a wallet the browser has already chosen, so the first connection
 * in a fresh context goes through the real modal — the path a person takes anyway.
 */
async function connectWallet(page: Page) {
  // The header's wallet button is a `dynamic(..., { ssr: false })` import (`components/Nav.tsx`),
  // so until that chunk arrives the header holds an `aria-hidden` placeholder and no button at
  // all. `count()` does not auto-wait, so branching on it against an un-hydrated header read 0,
  // skipped the connect, and let the `toHaveCount(0)` below pass vacuously; the deploy then sat
  // on a *Deploy agent* that stays disabled while `publicKey` is null until the case timed out.
  // `.wallet-adapter-button-trigger` is the one element the header renders in both
  // states — *Select Wallet* and the truncated key — so waiting for it is what makes the branch
  // below a real either/or rather than a race the un-hydrated side always wins.
  await expect(page.locator(".wallet-adapter-button-trigger").first()).toBeVisible({ timeout: 60_000 });
  const select = page.getByRole("button", { name: /select wallet/i });
  if (await select.count()) {
    await select.first().click();
    await page.getByRole("button", { name: /E2E Keypair/i }).click();
  }
  await expect(page.getByRole("button", { name: /select wallet/i })).toHaveCount(0);
}

/** The wizard, all three steps, for an agent with the default policy and no loop. */
async function deployAgent(page: Page, name: string) {
  await page.goto("/create?kind=agent");
  await connectWallet(page);
  // The wizard is on screen from the start: an agent is created from blank, with no _Start from_.
  await page.getByPlaceholder("e.g. agent-sentinel-v2").fill(name);
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
  await page.getByRole("button", { name: /^Deploy agent$/ }).click();
  await expect(page.getByText("Agent deployed on Solana")).toBeVisible({ timeout: 120_000 });
}

// ─── A wizard deploy writes a template ──────────────────────────────────────

test("a wizard deploy writes a template the record and the list agree on", async ({ page, request }) => {
  test.setTimeout(4 * 60_000);

  await deployAgent(page, AGENT);

  const record: AgentRecord = (await (await request.get(`/api/agents/${id(AGENT)}`)).json()).agent;
  expect(record.name).toBe(AGENT);
  expect(record.owner).toBe(wallet!.publicKey.toBase58());
  // Every deploy links to a template: this one named none, so the server wrote an implicit one.
  expect(record.template).not.toBeNull();

  const listed: TemplateRow[] = (
    await (await request.get(`/api/templates?owner=${wallet!.publicKey.toBase58()}`)).json()
  ).templates;
  // Matched by id, not by position or by name: `implicitTemplate` links a deploy to the wallet's
  // existing template when the config hashes the same, so the row may carry an earlier agent's
  // name and a version above 1 (`api/_lib/templates.ts`).
  const mine = listed.find((t) => t.id === record.template!.id);
  expect(mine, `no template ${record.template!.id} in the owner's list`).toBeTruthy();
  expect(mine!.kind).toBe("agent");
  expect(mine!.version).toBe(record.template!.version);
  expect(mine!.hash).toBe(record.template!.hash);
  // The hash is the content address of `config` alone, so the config the API serves has to
  // re-hash to the hash the record carries — computed in this process, not read from the server.
  expect(templateHash(mine!.config)).toBe(record.template!.hash);

  // The lineage is the Agent details ⓘ's _Deployed from_ row.
  await page.goto(`/agent/${id(AGENT)}`);
  await openInfo(page.getByTestId("agent-details-toggle"));
  const lineage = page.getByTestId("agent-template");
  await expect(lineage).toContainText(`v${record.template!.version}`, { timeout: 60_000 });
  await expect(lineage).toContainText(record.templateName ?? record.template!.id);
});

/**
 * The `policy_version_hash` of the newest genesis on this agent's chain, read off the page.
 *
 * Not computed here and not asked of an API: the point is that a reader can see
 * what an agent *was* when it ran a session, so the value has to come off the screen. The drawer
 * resolves the payload preimage from the trace store and prints the hash at its fixed offset
 * inside it (`genesisPolicyVersionHash`), so what is read here is what the chain committed.
 */
async function newestGenesisPolicyHash(page: Page, agentId: string, expected: number): Promise<string> {
  await page.goto(`/agent/${agentId}`);
  await connectWallet(page);
  // `.last()`, not `.first()`: `EventTimeline` sorts rows **ascending** by seq, so `.first()` is
  // the *oldest* genesis, and the v2 call would return the v1 row and compare a value to itself.
  // `expected` pins the count, so a session that never ran fails here — loudly, naming what is
  // missing — rather than as a self-comparison two lines later.
  await openProof(page, "proof", 120_000);
  const rows = page.locator('[data-testid="timeline-record"][data-kind="Genesis"]');
  await expect(rows).toHaveCount(expected, { timeout: 120_000 });
  // The commitments are read out of the genesis blob's preimage, which the console writes in the
  // clear, so the drawer opens it with no signature.
  const genesis = rows.last();
  await expect(genesis).toBeVisible({ timeout: 120_000 });
  await genesis.getByRole("button", { name: /^Open$/ }).click();
  const commitment = page.getByTestId("commitment-policy-version");
  await expect(commitment).toBeVisible({ timeout: 60_000 });
  const hash = await commitment.getAttribute("data-hash");
  expect(hash, "the drawer prints the policy version hash the genesis committed").toMatch(/^[0-9a-f]{64}$/);
  return hash!;
}

/**
 * One session on the agent, through the chat the console actually offers.
 *
 * It waits for the console's single run slot first. A file run before this one can leave a loop
 * step in flight — `templates-api.spec.ts` case 5 starts a loop and archives it, and the step
 * already running keeps the slot until it ends — and a session sent then is refused with 429
 * "another run is in progress", which this file would report as a session that never ran.
 */
async function runSession(page: Page, agentId: string, ask: string) {
  await expect
    .poll(async () => (await (await page.request.get("/api/run")).json()).busy ?? null, {
      message: "the console's run slot frees before a session is sent",
      timeout: 120_000,
      intervals: [2_000, 5_000],
    })
    .toBeNull();
  // `#ask` opens the Ask card, which is folded by default.
  await page.goto(`/agent/${agentId}#ask`);
  await connectWallet(page);
  await page.getByTestId("chat-input").fill(ask);
  await page.getByTestId("chat-send").getByRole("button").click();
  // Positive waits only, because a negated matcher passes when the locator resolves to nothing.
  // The answer arrives before the writes, so what says the session is done is the anchor badge
  // beside it reaching `verified`.
  const reply = page.getByTestId("chat-reply");
  await expect(reply).toBeVisible({ timeout: 60_000 });
  await expect(reply).not.toHaveText("thinking…", { timeout: 170_000 });
  await expect(page.getByTestId("anchor-badge").last()).toHaveAttribute("data-state", "verified", { timeout: 240_000 });
  await expect(reply).not.toBeEmpty();
}

test("a session under v1 commits a policy version hash the page shows", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await runSession(page, id(AGENT), "Report the cluster slot.");
  v1PolicyHash = await newestGenesisPolicyHash(page, id(AGENT), 1);
});

// ─── A new version, and the record following it ─────────────────────────────

test("a template edit appends v2 and Use version 2 moves the record", async ({ page, request }) => {
  test.setTimeout(4 * 60_000);

  const before: AgentRecord = (await (await request.get(`/api/agents/${id(AGENT)}`)).json()).agent;
  expect(before.template).not.toBeNull();
  const templateId = before.template!.id;

  const current = await (await request.get(`/api/templates?id=${templateId}`)).json();
  const latest: TemplateRow = current.template;
  const config = { ...latest.config, prompt: `Say what the fee level is and nothing else. (${RUN})` };

  // A template write: a new version of the config, owner-signed under
  // its own purpose. A `PUT` appends; nothing here can overwrite the version the record runs.
  const put = await request.put("/api/templates", {
    data: {
      id: templateId,
      config,
      auth: signAuth("Lath template", { action: "append", target: templateId }, cluster, wallet!),
    },
  });
  const written = await put.json();
  expect(put.ok(), `PUT /api/templates refused: ${written.error}`).toBeTruthy();
  secondVersion = latest.version + 1;
  expect(written.template.version).toBe(secondVersion);
  expect(written.template.hash).not.toBe(latest.hash);
  expect(templateHash(config)).toBe(written.template.hash);

  // Both versions are readable by id: the one the record still runs, and the one just written.
  const history = await (await request.get(`/api/templates?id=${templateId}`)).json();
  const versions: TemplateRow[] = history.versions;
  expect(versions.map((v) => v.version)).toContain(latest.version);
  expect(versions.map((v) => v.version)).toContain(secondVersion);
  expect(versions.find((v) => v.version === latest.version)!.hash).toBe(latest.hash);

  // The page offers the newer version to the wallet that owns the agent. The click signs
  // `"Lath agent"` through the E2E wallet, the way pause and stop are driven. The offer is an item
  // of the ⋯ menu, which lists it only once the record's newer version has been read; choosing it
  // closes the menu.
  await page.goto(`/agent/${id(AGENT)}`);
  await connectWallet(page);
  await expect(async () => {
    await openAgentMenu(page);
    await expect(page.getByTestId("agent-use-version")).toHaveText(new RegExp(`Use version ${secondVersion}`), {
      timeout: 5_000,
    });
  }).toPass({ timeout: 60_000, intervals: [2_000, 5_000] });
  await agentAction(page, "agent-use-version");

  // The _Deployed from_ row (the Agent details ⓘ) is the
  // record read back: it names the version the record now links to, and the control is gone from the
  // menu because there is no newer version to offer.
  await openInfo(page.getByTestId("agent-details-toggle"));
  const lineage = page.getByTestId("agent-template");
  await expect(lineage).toContainText(`v${secondVersion}`, { timeout: 60_000 });
  await openAgentMenu(page);
  await expect(page.getByTestId("agent-use-version")).toHaveCount(0);
  await page.keyboard.press("Escape");

  const after: AgentRecord = (await (await request.get(`/api/agents/${id(AGENT)}`)).json()).agent;
  expect(after.template!.version).toBe(secondVersion);
  expect(after.template!.hash).toBe(written.template.hash);
  expect(after.latestVersion).toBe(secondVersion);

  // Nothing on chain moved: pointing the record at another version changes what the *next*
  // session commits, so the agent's own chain still replays exactly as it did.
  await expect(page.getByTestId("chain-status")).toContainText(/verified on Solana/i, { timeout: 60_000 });
});

test("a session's genesis policy hash changes with the version", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  test.skip(!v1PolicyHash, "no session ran under v1, so there is nothing to compare against");
  test.skip(!secondVersion, "the version switch did not run");

  // `useVersion` changed nothing on chain; it changed what the *next*
  // session commits. v2 moved the prompt, and `policyVersionHash` takes a `promptHash` key, so
  // the hash has to move with it — and this reads both values off the agent page rather than
  // recomputing them, because a value the page does not show is a claim nobody can check.
  await runSession(page, id(AGENT), "Report the cluster slot.");
  const v2PolicyHash = await newestGenesisPolicyHash(page, id(AGENT), 2);
  expect(v2PolicyHash).not.toBe(v1PolicyHash);

  // And the chain is unharmed by any of it: a policy hash moving is a new session's commitment,
  // not a rewrite of an old one.
  await expect(page.getByTestId("chain-status")).toContainText(/verified on Solana/i, { timeout: 60_000 });
});
