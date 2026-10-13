import { expect, test, type APIRequestContext } from "@playwright/test";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createHash, randomBytes } from "crypto";
import { authMessage, loopAuthBinding, type AuthBinding, type AuthPurpose } from "@lath/sdk";
import { consoleOrigin } from "./wallet";
import { readFileSync } from "fs";
import * as path from "path";

/**
 * The template, agent and loop API surface the browser pages do not reach yet, driven through
 * Playwright's `request` fixture with the E2E wallet's own signatures.
 *
 * Every write here is an owner-signed POST or PUT of the kind the console makes — the purposes
 * are `"Lath template"` for a template write, `"Lath deploy"` for a deploy, `"Lath
 * agent"` for `useVersion`, `"Lath loop"` for a loop start or archive — so the spec signs the
 * same `authMessage` the browser signs (`_lib/runner.ts`, `verifyAuth`) with the keypair from
 * `frontend/.env.devnet.e2e`. There is no page: what is checked is what the routes answered.
 *
 * The claims:
 *
 * - a template's `hash` is `sha256(canonicalJson(config))` over the bytes the route stored, so
 *   the spec re-hashes the config it got back and gets the same hex (`_lib/templates.ts`);
 * - a `PUT` appends a version and never rewrites one: v1 is still readable by id after v2;
 * - a config outside the run's bounds is refused rather than coerced (`templates/validate.ts`);
 * - a template belongs to the wallet that wrote it: another keypair's `PUT` is a 403;
 * - archive hides an id from `?owner=` and leaves it resolvable by `?id=`, for templates and for
 *   loop runs alike;
 * - a deploy that names a template links to that version and writes no implicit template;
 * - `useVersion` moves the link and refuses a version the id does not have;
 * - a loop start from a template links to it, and one whose coordinator is not a deployed agent
 *   is refused, which is all `loops/route.ts` resolves today.
 *
 * Budget: one devnet deploy and one loop start, both in the cases that need them. Everything
 * else is file I/O on the server, so the rest of the file is fast.
 */

/** Fresh names per run; `E2E_RUN=<suffix>` re-targets what an earlier run wrote. */
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const AGENT_TPL = `e2e-api-agent-${RUN}`;
const THROWAWAY_TPL = `e2e-api-throwaway-${RUN}`;
const LOOP_TPL = `e2e-api-loop-${RUN}`;
const UNSTARTABLE_TPL = `e2e-api-unstartable-${RUN}`;
const AGENT = `e2e-api-${RUN}`;

test.describe.configure({ mode: "serial" });

// ─── The E2E wallet, and the message the routes verify ──────────────────────

/**
 * The keypair the browser signs with. `dev-devnet.sh --e2e` puts it in the *server's*
 * environment, not the test runner's, so the file the seed wrote is the source either way.
 */
function e2eKeypair(): Keypair {
  const inline = process.env.NEXT_PUBLIC_E2E_WALLET_SECRET;
  const raw = inline ?? readEnvFile("NEXT_PUBLIC_E2E_WALLET_SECRET");
  if (!raw) throw new Error("no NEXT_PUBLIC_E2E_WALLET_SECRET: run the seed with --e2e-wallet");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
}

/** One `KEY='value'` line out of `frontend/.env.devnet.e2e`, unquoted. */
function readEnvFile(key: string): string | null {
  try {
    const file = readFileSync(path.join(process.cwd(), ".env.devnet.e2e"), "utf8");
    const line = file.split("\n").find((l) => l.trimStart().startsWith(`${key}=`));
    if (!line) return null;
    const value = line.slice(line.indexOf("=") + 1).trim();
    return /^(['"]).*\1$/s.test(value) ? value.slice(1, -1) : value;
  } catch {
    return null;
  }
}

/**
 * The SDK's `authMessage` and the browser's signature, in Node. A 64-byte web3.js secret key
 * is `seed ‖ pubkey` and ed25519 signs with the seed, the way `lib/e2e-wallet.ts` does. Each nonce
 * is single-use server-side, so every call gets a fresh one; `bound` is the request the signature
 * is for, which the route compares against its own.
 */
function auth(purpose: AuthPurpose, keypair: Keypair, bound: AuthBinding): { message: string; signature: string } {
  const message = authMessage(purpose, {
    ...bound,
    ...consoleOrigin(),
    cluster,
    wallet: keypair.publicKey.toBase58(),
    issued: new Date().toISOString(),
    nonce: randomBytes(16).toString("hex"),
  });
  const signature = Buffer.from(ed25519.sign(Buffer.from(message, "utf8"), keypair.secretKey.slice(0, 32)));
  return { message, signature: signature.toString("base64") };
}

/** A `/api/loops` body signed for the pair the route derives from it (`loopAuthBinding`). */
function signedLoop(body: { action: string; id?: string; templateId?: string; agentId?: string }) {
  return { ...body, auth: auth("Lath loop", wallet, loopAuthBinding(body)) };
}

/**
 * `canonicalJson` from `runtime/src/policy.ts`, restated rather than imported: what is being
 * checked is that the hash the route minted is reproducible outside the server, and importing
 * the server's own function would only check that it equals itself.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const templateHash = (config: unknown) => createHash("sha256").update(canonicalJson(config)).digest("hex");

// ─── Fixtures the cases share ───────────────────────────────────────────────

let cluster = "";
let wallet: Keypair;
/** The agent template case 1 writes and the later cases edit, deploy and read. */
let agentTemplateId = "";
/** Set by case 4; the coordinator case 5's loop template points at. */
let agentId = "";
/** The loop template case 5 starts. */
let loopTemplateId = "";
/**
 * The interval floor a loop template has to clear, read from `GET /api/loops` rather than
 * assumed: `LATH_LOOP_MIN_INTERVAL_MS` moves it, and both the template check and the start
 * check apply whatever the server is running with.
 */
let minIntervalMs = 15_000;

const agentConfigV1 = {
  prompt: "Read the cluster and say whether the fee level moved.",
  model: "deepseek/deepseek-v4.1-flash",
  tools: ["solana.slot", "solana.fees"],
  budgetCapUsdc: "1.00",
  expirationDays: 14,
};
const agentConfigV2 = { ...agentConfigV1, tools: ["solana.slot"], expirationDays: 21 };

/** Post a template write and return the parsed body with the status, so a case can assert both. */
async function write(
  request: APIRequestContext,
  method: "post" | "put",
  data: Record<string, unknown>,
  keypair: Keypair = wallet
) {
  const response = await request[method]("/api/templates", {
    // The template route names a write by its method and body: `POST` is `write` (or `archive`),
    // `PUT` is `append`, on the template id or `new`.
    data: {
      ...data,
      auth: auth("Lath template", keypair, {
        action: method === "put" ? "append" : data.action === "archive" ? "archive" : "write",
        target: typeof data.id === "string" ? data.id : "new",
      }),
    },
  });
  return { status: response.status(), body: await response.json() };
}

/** The latest version of every non-archived template this wallet owns, as `?owner=` lists it. */
async function ownedTemplates(request: APIRequestContext) {
  const response = await request.get(`/api/templates?owner=${wallet.publicKey.toBase58()}`);
  expect(response.status()).toBe(200);
  return (await response.json()).templates as { id: string; name: string; version: number; versions: number }[];
}

test.beforeEach(async ({ request }) => {
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  cluster = runner.cluster;
  wallet = e2eKeypair();
  const limits = (await (await request.get("/api/loops")).json()).limits;
  minIntervalMs = Number(limits.minIntervalMs);
});

// ─── 1. A template is version 1 and the hash of its config ──────────────────

test("a POST writes version 1 and a hash that re-hashes outside the server", async ({ request }) => {
  const written = await write(request, "post", { kind: "agent", name: AGENT_TPL, config: agentConfigV1 });
  // The route's own words on a refusal: two different refusals answer 429 here — the hourly write
  // quota and the per-owner cap on template ids (`TEMPLATES_PER_OWNER`), which an E2E wallet
  // reaches after enough runs, since every run mints ids and archived ones still count — and a
  // bare status cannot tell a rate limit that passes in an hour from a cap that never will.
  expect(written.status, `the template route answered ${JSON.stringify(written.body)}`).toBe(200);
  const template = written.body.template;
  agentTemplateId = template.id;

  expect(template.id).toMatch(/^tpl-[0-9a-f]{16}$/);
  expect(template.kind).toBe("agent");
  expect(template.version).toBe(1);
  expect(template.owner).toBe(wallet.publicKey.toBase58());
  // The content address of the bytes stored, computed here from the config the route echoed and
  // again from the config this spec sent: nothing was coerced on the way in.
  expect(template.hash).toBe(templateHash(template.config));
  expect(template.hash).toBe(templateHash(agentConfigV1));
  expect(written.body.versions).toHaveLength(1);

  // `?owner=` lists the latest version of each template plus how many versions it has.
  const listed = (await ownedTemplates(request)).find((t) => t.id === agentTemplateId);
  expect(listed).toBeTruthy();
  expect(listed!.name).toBe(AGENT_TPL);
  expect(listed!.version).toBe(1);
  expect(listed!.versions).toBe(1);

  // `?id=` answers with the latest version and the whole history.
  const byId = await request.get(`/api/templates?id=${agentTemplateId}`);
  expect(byId.status()).toBe(200);
  const resolved = await byId.json();
  expect(resolved.template.version).toBe(1);
  expect(resolved.versions.map((t: { version: number }) => t.version)).toEqual([1]);
});

// ─── 2. A PUT appends; an out-of-bounds config is refused ───────────────────

test("a PUT appends version 2 and leaves version 1 readable", async ({ request }) => {
  test.skip(!agentTemplateId, "no template was written");

  const written = await write(request, "put", { id: agentTemplateId, config: agentConfigV2 });
  expect(written.status).toBe(200);
  expect(written.body.template.version).toBe(2);
  expect(written.body.template.name).toBe(AGENT_TPL); // an edit of the config alone keeps the name
  expect(written.body.template.hash).toBe(templateHash(agentConfigV2));
  expect(written.body.template.hash).not.toBe(templateHash(agentConfigV1));

  // Nothing overwrote v1: a run that points at `{ id, version: 1 }` still resolves its config.
  const versions = written.body.versions as { version: number; hash: string }[];
  expect(versions.map((t) => t.version)).toEqual([1, 2]);
  expect(versions[0].hash).toBe(templateHash(agentConfigV1));

  const v1 = await request.get(`/api/templates?id=${agentTemplateId}`);
  expect((await v1.json()).versions[0].hash).toBe(templateHash(agentConfigV1));
});

test("a config outside the run's bounds is refused, not coerced", async ({ request }) => {
  test.skip(!agentTemplateId, "no template was written");

  // `expirationDays` has a floor of 1: a template that described a zero-day grant would mint a
  // hash over a config no deploy could run.
  const days = await write(request, "put", {
    id: agentTemplateId,
    config: { ...agentConfigV2, expirationDays: 0 },
  });
  expect(days.status).toBe(400);
  expect(days.body.error).toMatch(/expirationDays/);

  // A tool the runtime does not ship would be dropped at session time, so it is refused here.
  const tool = await write(request, "put", {
    id: agentTemplateId,
    config: { ...agentConfigV2, tools: ["solana.slot", "solana.mint_money"] },
  });
  expect(tool.status).toBe(400);
  expect(tool.body.error).toMatch(/unknown tools: solana\.mint_money/);

  // Neither refusal wrote a version.
  const after = await request.get(`/api/templates?id=${agentTemplateId}`);
  expect((await after.json()).versions).toHaveLength(2);
});

test("an archived template leaves the owner list and stays resolvable by id", async ({ request }) => {
  // Its own template, so the cases that deploy from `AGENT_TPL` are not standing on an archive.
  const written = await write(request, "post", { kind: "agent", name: THROWAWAY_TPL, config: agentConfigV1 });
  expect(written.status).toBe(200);
  const id = written.body.template.id;
  expect((await ownedTemplates(request)).some((t) => t.id === id)).toBe(true);

  const archived = await write(request, "post", { id, action: "archive" });
  expect(archived.status).toBe(200);
  expect(archived.body.template.archivedAt).toBeGreaterThan(0);

  expect((await ownedTemplates(request)).some((t) => t.id === id)).toBe(false);

  // Nothing was deleted: the config a run points at has to stay readable after the archive.
  const byId = await request.get(`/api/templates?id=${id}`);
  expect(byId.status()).toBe(200);
  const resolved = await byId.json();
  expect(resolved.template.id).toBe(id);
  expect(resolved.template.hash).toBe(templateHash(agentConfigV1));
});

// ─── 3. A template belongs to the wallet that wrote it ──────────────────────

test("another wallet's PUT on this template is refused", async ({ request }) => {
  test.skip(!agentTemplateId, "no template was written");

  // A keypair generated here and never funded: the point is that the signature verifies and the
  // write is still refused, so what is being checked is ownership and not authentication.
  const stranger = Keypair.generate();
  const written = await write(request, "put", { id: agentTemplateId, config: agentConfigV1 }, stranger);
  expect(written.status).toBe(403);
  expect(written.body.error).toMatch(/belongs to another wallet/);

  const after = await request.get(`/api/templates?id=${agentTemplateId}`);
  expect((await after.json()).versions).toHaveLength(2);
});

// ─── 4. Deploy from a template, then move the link ──────────────────────────

test("a deploy from a template links to that version and useVersion moves the link", async ({ request }) => {
  test.setTimeout(5 * 60_000);
  test.skip(!agentTemplateId, "no template was written");

  const before = await ownedTemplates(request);

  // `version: 1` rather than the latest, so `useVersion` has somewhere to move to. This is the
  // one chain write in the file: the server funds and registers the header.
  const deploy = await request.post("/api/agents", {
    data: {
      name: AGENT,
      templateId: agentTemplateId,
      version: 1,
      auth: auth("Lath deploy", wallet, { action: "deploy", target: AGENT }),
    },
    timeout: 3 * 60_000,
  });
  expect(deploy.status(), await deploy.text()).toBe(200);
  const deployed = await deploy.json();
  expect(deployed.existing, "rerun under the same E2E_RUN; the deploy answered from the registry").toBeFalsy();
  agentId = deployed.id;

  // The deploy response carries the registration, not the link; the record is what links.
  const agent = (await (await request.get(`/api/agents/${agentId}`)).json()).agent;
  expect(agent.template.id).toBe(agentTemplateId);
  expect(agent.template.version).toBe(1);
  expect(agent.template.hash).toBe(templateHash(agentConfigV1));
  expect(agent.policy.expirationDays).toBe(agentConfigV1.expirationDays);
  // A deploy that named a template writes no implicit one: the template is already this run's.
  expect((await ownedTemplates(request)).map((t) => t.id)).toEqual(before.map((t) => t.id));
  // The page can offer *use version 2* because the id has one.
  expect(agent.latestVersion).toBe(2);

  const moved = await request.post(`/api/agents/${agentId}`, {
    data: {
      action: "useVersion",
      version: 2,
      auth: auth("Lath agent", wallet, { action: "useVersion", target: agentId }),
    },
  });
  expect(moved.status()).toBe(200);
  const after = (await moved.json()).agent;
  expect(after.template.version).toBe(2);
  expect(after.template.hash).toBe(templateHash(agentConfigV2));
  // The record's policy is the pointer to the version in use, so it moved too.
  expect(after.policy.tools).toEqual(agentConfigV2.tools);
  expect(after.policy.expirationDays).toBe(agentConfigV2.expirationDays);

  const missing = await request.post(`/api/agents/${agentId}`, {
    data: {
      action: "useVersion",
      version: 99,
      auth: auth("Lath agent", wallet, { action: "useVersion", target: agentId }),
    },
  });
  expect(missing.status()).toBe(404);
  expect((await missing.json()).error).toMatch(/no agent version 99/);
});

// ─── 5. A loop run from a template, and one that cannot be started ─────────

test("a loop template starts a run that links to it, and archiving hides the run", async ({ request }) => {
  test.setTimeout(6 * 60_000);
  test.skip(!agentId, "no agent was deployed");

  // The minimum the server will take: one step at the interval floor. Archiving does not make the
  // run cheap: the first step is already in flight by then and still holds the console's single
  // run slot until it ends (~45 s on devnet) — `stopLoop` cancels the next step, never a write in
  // progress. The case waits that slot out at its end, so the next file does not inherit it.
  const loopConfig = {
    prompt: "Report the slot and stop.",
    intervalMs: minIntervalMs,
    maxSteps: 1,
    // Both keys, as the console's client writes a loop template: the
    // stored config always carries the whole budget, so a config that sent only the per-step one
    // would be stored with a key it never had and hash differently from what was posted.
    budgetMicroUsdc: "20000",
    budgetMicroUsdcPerStep: "20000",
    model: agentConfigV1.model,
    coordinator: { agentId },
    members: [],
  };
  const template = await write(request, "post", { kind: "loop", name: LOOP_TPL, config: loopConfig });
  expect(template.status, JSON.stringify(template.body)).toBe(200);
  loopTemplateId = template.body.template.id;
  expect(template.body.template.kind).toBe("loop");
  expect(template.body.template.hash).toBe(templateHash(template.body.template.config));
  expect(template.body.template.hash).toBe(templateHash(loopConfig));

  const started = await request.post("/api/loops", {
    data: signedLoop({ action: "start", templateId: loopTemplateId }),
    timeout: 60_000,
  });
  expect(started.status(), await started.text()).toBe(200);
  const loop = (await started.json()).loop;
  expect(loop.template.id).toBe(loopTemplateId);
  expect(loop.template.version).toBe(1);
  expect(loop.agentId).toBe(agentId);
  // The run was built from the stored config and put through the start's own checks.
  expect(loop.prompt).toBe(loopConfig.prompt);
  expect(loop.intervalMs).toBe(loopConfig.intervalMs);
  expect(loop.maxSteps).toBe(1);
  expect(loop.status).toBe("running");

  const archived = await request.post("/api/loops", {
    data: signedLoop({ action: "archive", id: loop.id }),
  });
  expect(archived.status()).toBe(200);
  const stopped = (await archived.json()).loop;
  expect(stopped.status).toBe("stopped");
  expect(stopped.archivedAt).toBeGreaterThan(0);

  // Hidden from the list and nowhere else, so a loop page or an audit link into it still works.
  const owner = wallet.publicKey.toBase58();
  const listed = (await (await request.get(`/api/loops?owner=${owner}`)).json()).loops;
  expect(listed.map((l: { id: string }) => l.id)).not.toContain(loop.id);
  const withArchived = (await (await request.get(`/api/loops?owner=${owner}&archived=1`)).json()).loops;
  expect(withArchived.map((l: { id: string }) => l.id)).toContain(loop.id);
  const byId = await request.get(`/api/loops?id=${loop.id}`);
  expect(byId.status()).toBe(200);
  expect((await byId.json()).loop.template.id).toBe(loopTemplateId);

  // The step started above is still running and holds the run slot. Wait for it to free, so the
  // file after this one does not send a session into a busy server and read the 429 as its own
  // failure, as `templates-lineage.spec.ts` would.
  await expect
    .poll(async () => (await (await request.get("/api/run")).json()).busy ?? null, {
      message: "the archived loop's in-flight step releases the run slot",
      timeout: 150_000,
      intervals: [2_000, 5_000],
    })
    .toBeNull();
});

test("a loop template whose coordinator is not a deployed agent is stored but not startable", async ({ request }) => {
  test.skip(!agentTemplateId, "no template was written");

  // `{ template }` is a stored shape only: the console expands it into N deploys and starts the
  // loop with `{ agentId }` members, so the write is accepted and the
  // start is refused. That refusal is the whole reason the expansion lives in the browser.
  const config = {
    prompt: "Report the slot and stop.",
    intervalMs: minIntervalMs,
    maxSteps: 1,
    budgetMicroUsdcPerStep: "20000",
    coordinator: { template: agentTemplateId, version: 1 },
    members: [],
  };
  const written = await write(request, "post", { kind: "loop", name: UNSTARTABLE_TPL, config });
  expect(written.status, JSON.stringify(written.body)).toBe(200);

  const started = await request.post("/api/loops", {
    data: signedLoop({ action: "start", templateId: written.body.template.id }),
  });
  expect(started.status()).toBe(400);
  expect((await started.json()).error).toMatch(/coordinator is not a deployed agent/);
});

// ─── 6. An owner with nothing ───────────────────────────────────────────────

test("an owner with no templates gets an empty list, not an error", async ({ request }) => {
  // A valid base58 key that never wrote anything. `GET` is open, so this is the answer a page
  // gets for a wallet it has just connected.
  const response = await request.get(`/api/templates?owner=${Keypair.generate().publicKey.toBase58()}`);
  expect(response.status()).toBe(200);
  expect((await response.json()).templates).toEqual([]);
});
