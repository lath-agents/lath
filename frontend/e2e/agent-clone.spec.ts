import { expect, test, type Page } from "@playwright/test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { agentAction, openInfo } from "./disclose";

/**
 * Cloning a deployed agent, driven through the owner's *Clone*, an item of the agent page's ⋯ menu.
 *
 * A clone is a new name and therefore a new chain — `agent_id = sha256(name)` — so the only
 * thing the copy shares is its configuration, and the console is the only place that knows the
 * two are related. This file checks that both halves of that sentence hold: the clone's page reads
 * *cloned from ‹source›* and nothing about the template's name, and its template is a fresh id whose `hash` equals the source's with `clonedFrom`
 * pointing back at the source template's version. Every claim is a read the browser made of
 * `GET /api/agents/:id` and `GET /api/templates?id=`, not a status the button reported.
 *
 * And the copy can spend. A clone is **one transaction and one prompt** — funding, the header and
 * the allowance together (`_lib/copy.ts`, `prepareDeployTx`) — so the copy's page reads a live
 * allowance rather than *No allowance*. A clone that signed only a `"Lath deploy"` message and sent
 * no transaction would leave the copy registered, funded and unpayable with no way to fix it from
 * that page; case 1 asserts the allowance is there and that the wallet was asked once.
 * Case 3 is API-only and cheap.
 *
 * The allowance is the one thing that pays here: the cap and the debit are the buyer's, on Solana,
 * and the model is paid on Tempo from the operator's treasury, beneath them. No case in this file names a rail, and none
 * needs to.
 *
 * Needs the seed run with `--e2e-wallet` and a server with a runtime keypair. One wizard deploy plus one clone registration on devnet is ~1 minute of chain writes.
 */

const id = (name: string) => createHash("sha256").update(name).digest("hex");
/** Fresh names per run; `E2E_RUN=<suffix>` re-targets what an earlier run deployed. */
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const SOURCE = `e2e-src-${RUN}`;
const CLONE = `e2e-clone-${RUN}`;

/** What the source page read about itself, so the later cases can compare against it. */
let sourceLineage: string | null = null;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, request }) => {
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

/** The first connection in a fresh context goes through the modal. */
async function connectWallet(page: Page) {
  // The header's wallet button is a `dynamic(..., { ssr: false })` import (`components/Nav.tsx`),
  // so until that chunk arrives the header holds an `aria-hidden` placeholder and no button at
  // all. `count()` does not auto-wait, so branching on it against an un-hydrated header reads 0,
  // skips the connect, and lets the `toHaveCount(0)` below pass vacuously; the deploy then sits
  // on a *Deploy agent* that stays disabled while `publicKey` is null until the case times out.
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
  // The page mounts only once the wallet gate lifts, and the modal's own heading lingers while it
  // fades (`wallet.ts`).
  await expect(page.getByTestId("wallet-gate")).toHaveCount(0);
  await expect(page.locator(".wallet-adapter-modal")).toHaveCount(0, { timeout: 15_000 });
}

/** The wizard, all four steps, for a plain agent. Leaves the page on the deployed step. */
async function wizardDeploy(page: Page, name: string) {
  await page.goto("/create?kind=agent");
  await connectWallet(page);
  // The wizard is on screen from the start: an agent is created from blank, with no _Start from_.
  await page.getByPlaceholder("e.g. agent-sentinel-v2").fill(name);
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
  await page.getByRole("button", { name: /^Deploy agent$/ }).click();
  await expect(page.getByText("Agent deployed on Solana")).toBeVisible({ timeout: 120_000 });
  // The wizard's deploy step is the one flow that grants an allowance: one wallet transaction
  // beside the registration. It is what case 1 contrasts the clone against.
  await expect(page.getByText("allowance", { exact: true })).toBeVisible();
}

/**
 * An agent page whose header and console record have both rendered. The header the server just
 * registered has to reach the indexer before the page has a chain to read at all, so this reloads
 * until it does rather than asserting against a page that is honestly still empty.
 *
 * The owner's ⋯ menu is the sign: it is drawn only once the header has been read and the console's
 * record says this wallet deployed the agent. The lineage line is not a sign: it is drawn only for
 * clones and archives, so an ordinary deploy has none.
 */
async function openAgentPage(page: Page, agentId: string) {
  // Connect first: the page behind the wallet gate is not mounted until a wallet connects, so the
  // menu can never render before it. Each reload below then reconnects through `autoConnect`,
  // inside the 15 s the wait allows.
  await page.goto(`/agent/${agentId}`);
  await connectWallet(page);
  await expect(async () => {
    await page.goto(`/agent/${agentId}`);
    await expect(page.getByTestId("agent-actions-menu")).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 150_000, intervals: [3_000, 5_000, 10_000] });
}

/** The Agent details ⓘ's _Deployed from_ row: the template version the record links to. */
async function deployedFrom(page: Page) {
  await openInfo(page.getByTestId("agent-details-toggle"));
  return page.getByTestId("agent-template");
}

/** The E2E wallet's 64-byte secret, as the seed prints it into `frontend/.env.devnet.e2e`. */
function e2eSecret(): string | null {
  if (process.env.NEXT_PUBLIC_E2E_WALLET_SECRET) return process.env.NEXT_PUBLIC_E2E_WALLET_SECRET;
  const key = "NEXT_PUBLIC_E2E_WALLET_SECRET=";
  try {
    const text = readFileSync(path.join(process.cwd(), ".env.devnet.e2e"), "utf8");
    const line = text.split("\n").find((l) => l.startsWith(key));
    return line
      ? line
          .slice(key.length)
          .trim()
          .replace(/^["']|["']$/g, "")
      : null;
  } catch {
    return null;
  }
}

test("the owner's Clone button copies the config onto a new name and says where it came from", async ({
  page,
  request,
}) => {
  test.setTimeout(6 * 60_000);

  await wizardDeploy(page, SOURCE);
  await openAgentPage(page, id(SOURCE));
  await expect(page.getByTestId("owner-name")).toHaveText(SOURCE);

  // What the source is, from the record: the template its deploy wrote (or reused — an implicit
  // template is shared by every deploy of the same config, so its display name is whichever
  // agent wrote it first) and the version the record links to.
  const source = (await (await request.get(`/api/agents/${id(SOURCE)}`)).json()).agent;
  expect(source.template).not.toBeNull();
  expect(source.clonedFrom).toBeNull();
  const lineage = await deployedFrom(page);
  await expect(lineage).toHaveText(`${source.templateName} v${source.template.version}`);
  sourceLineage = (await lineage.textContent())?.trim() ?? null;
  await page.keyboard.press("Escape");

  // *Clone* asks for the new name in a `window.prompt` — the owner is the only one who knows
  // what the copy is for — and Playwright dismisses a dialog nobody handles, which would read
  // as a cancelled clone. Choosing the item closes the menu before the prompt opens.
  page.once("dialog", (d) => d.accept(CLONE));
  await agentAction(page, "agent-clone");

  // A new id, because the id is the hash of the name: the clone is a different chain.
  await expect(page).toHaveURL(new RegExp(`/agent/${id(CLONE)}$`), { timeout: 120_000 });
  expect(id(CLONE)).not.toBe(id(SOURCE));

  await openAgentPage(page, id(CLONE));
  await expect(page.getByTestId("owner-name")).toHaveText(CLONE);
  await expect(page.getByTestId("chain-status")).toContainText(/verified on Solana/i, { timeout: 60_000 });

  // The lineage line of a copy names only what it was copied from. Implicit templates dedupe by
  // config hash, so the template's display name is whichever agent first wrote those bytes — a
  // third party the owner of this copy has never seen — and printing it here reads as a claim
  // about where the copy came from (`OwnerHeaderCard.Lineage`). The template version the
  // copy links to is checked on the record below instead, where it is a fact and not a name.
  const cloneLine = page.getByTestId("agent-lineage");
  await expect(cloneLine).toContainText(`cloned from ${SOURCE}`);
  await expect(cloneLine).not.toContainText("deployed from");
  await expect(cloneLine.getByRole("link", { name: SOURCE })).toHaveAttribute("href", `/agent/${id(SOURCE)}`);
  // Nor does the Agent details ⓘ name the template, for the same reason: a copy has no _Deployed
  // from_ row.
  await openInfo(page.getByTestId("agent-details-toggle"));
  await expect(page.getByTestId("agent-facts")).toBeVisible();
  await expect(page.getByTestId("agent-template")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The record: same config bytes, its own template id, and a pointer back at the agent.
  const clone = (await (await request.get(`/api/agents/${id(CLONE)}`)).json()).agent;
  expect(clone.template.hash).toBe(source.template.hash);
  expect(clone.template.id).not.toBe(source.template.id);
  expect(clone.template.version).toBe(1);
  expect(clone.clonedFrom).toEqual({ agentId: id(SOURCE), name: SOURCE });
  expect(clone.policy).toEqual(source.policy);

  // And the template the clone wrote names the version it was copied from. `hash` is the
  // console's lineage key, not a chain fact: nothing on chain commits a template id.
  const written = (await (await request.get(`/api/templates?id=${clone.template.id}`)).json()).template;
  expect(written.kind).toBe("agent");
  expect(written.version).toBe(1);
  expect(written.hash).toBe(source.template.hash);
  expect(written.clonedFrom).toEqual({ id: source.template.id, version: source.template.version });

  // An allowance came with it, because it was in the transaction the owner signed. Without it the
  // copy would have none — an allowance is per `(user, agent_authority)` and the new authority has
  // nothing granted to it — so its first session would be refused and this page offers no way to
  // grant one.
  // The header's _Budget_ row reads `spent of cap USDC` with trimmed figures, and
  // `none from this wallet` with no grant.
  const budget = page.locator("#allowance");
  await expect(budget).toContainText(/ of [\d.]+ USDC/, { timeout: 60_000 });
  await expect(budget).not.toContainText("none from this wallet");
  // The cap is the source's own, copied with the config, read inside the row.
  await expect(budget).toContainText(`of ${Number(clone.policy.budgetCapUsdc)} USDC`);
});

test("the source is untouched by the clone and the registry lists both", async ({ page, request }) => {
  test.setTimeout(3 * 60_000);
  test.skip(!sourceLineage, "the clone case did not run, so there is nothing to compare against");

  // Cloning writes a template and an agent record; it does not touch the record it copied.
  await openAgentPage(page, id(SOURCE));
  // An ordinary deploy has no lineage line under its name, and its _Deployed from_ row is what it
  // was before the clone.
  await expect(page.getByTestId("agent-lineage")).toHaveCount(0);
  await expect(await deployedFrom(page)).toHaveText(sourceLineage!);

  const listed = (await (await request.get("/api/agents")).json()).agents.map((a: { id: string }) => a.id);
  expect(listed).toContain(id(SOURCE));
  expect(listed).toContain(id(CLONE));
});

test("a clone request whose name cannot be an agent name is refused", async ({ request }) => {
  const secret = e2eSecret();
  test.skip(!secret, "no NEXT_PUBLIC_E2E_WALLET_SECRET: run the seed with --e2e-wallet");
  test.skip(!sourceLineage, "the clone case did not run, so there is no owned agent to clone");

  // `--` sanitizes to two characters, so the route refuses it before it rate-limits or writes
  // anything: a name is what the id is derived from, and there is no agent behind a name too
  // short to hash into one. A prepared clone is unauthenticated, like a prepared deploy: the
  // wallet is a claim, and the transaction it would produce is inert until that wallet signs it.
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret!) as number[])).publicKey.toBase58();
  const res = await request.post(`/api/agents/${id(SOURCE)}`, {
    data: { action: "clone", name: "--", prepare: true, wallet },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/a name of its own/i);

  // And a stranger's claim is refused on ownership, before anything is prepared.
  const stranger = await request.post(`/api/agents/${id(SOURCE)}`, {
    data: { action: "clone", name: `${CLONE}-x`, prepare: true, wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(stranger.status()).toBe(403);
  expect((await stranger.json()).error).toMatch(/belongs to another wallet/i);
});
