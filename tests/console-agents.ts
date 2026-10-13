import { traceDir } from "./fixtures/trace-dir";
import { jsonRequest } from "./fixtures/request";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { hex, idFromString } from "@lath/sdk";
import {
  CLONES_PER_HOUR,
  DEPLOYS_PER_HOUR,
  DeployedAgent,
  MAX_DESCRIPTION,
  archiveAgent,
  deployedRoles,
  isArchived,
  lookupAgent,
  normalizeDescription,
  readRegistry,
  recordAgent,
  updateAgent,
} from "../frontend/src/app/api/_lib/runner";
import { LoopRecord, checkLoopRequest, recordLoop, TEAM_REFUSAL } from "../frontend/src/app/api/_lib/loops";
import { GET as agentGET, POST } from "../frontend/src/app/api/agents/[id]/route";
import { GET as agentsGET, POST as agentsPOST } from "../frontend/src/app/api/agents/route";
import type { AgentView } from "../frontend/src/types/agent";
import {
  AgentTemplate,
  AgentTemplateConfig,
  lookupTemplate,
  recordTemplate,
  templateLink,
  useVersionContext,
} from "../frontend/src/app/api/_lib/templates";
import { allowancePolicyHash } from "../frontend/src/app/api/_lib/copy";
import { deployRailFields } from "../frontend/src/app/api/_lib/tempo";

/**
 * The record half of clone, archive and `useVersion`: what
 * `agents.json` holds after each, and what a clone's template copy commits to.
 *
 * File I/O against a throwaway `LATH_TRACE_DIR` — no chain, no validator. The chain half of a
 * clone is a `register_agent` under a new name, which the route does and devnet checks; nothing
 * here can or should register anything.
 *
 * `./fixtures/trace-dir` is imported first for the reason `console-templates.ts` gives: the
 * modules under test capture the directory at evaluation.
 */

const OWNER = "So11111111111111111111111111111111111111112";
const OTHER = "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy";

const config: AgentTemplateConfig = {
  model: "deepseek/deepseek-v4.1-flash",
  tools: ["solana.slot"],
  budgetCapUsdc: "1.00",
  expirationDays: 14,
};

/**
 * The allowance a prepare of `cfg` must carry: its cap, its days from now, and its policy hash over
 * the rail this console gives a deploy — what `POST /api/agents` derives and holds the body to.
 */
function grantFor(cfg: AgentTemplateConfig) {
  const cap = BigInt(Math.round(Number(cfg.budgetCapUsdc) * 1e6));
  const policyHash = allowancePolicyHash({
    model: cfg.model,
    tools: cfg.tools,
    capMicroUsdc: cap,
    payment: deployRailFields(undefined).payment,
    prompt: cfg.prompt,
  });
  return {
    capMicroUsdc: cap.toString(),
    expiresAt: String(Math.floor(Date.now() / 1000) + Number(cfg.expirationDays) * 86400),
    policyVersionHash: hex(policyHash),
  };
}

function clearStores(): void {
  // `loops.json` is in here because one row of the registry — `memberOf` — is read out of it.
  for (const name of ["agents.json", "templates.json", "loops.json"])
    fs.rmSync(path.join(traceDir, name), { force: true });
}

/** A deploy, as `POST /api/agents` records one: a policy, an owner, and a template link. */
function deploy(id: string, name: string, owner = OWNER): DeployedAgent {
  const template = recordTemplate({ kind: "agent", owner, name, config });
  const record: DeployedAgent = {
    name,
    authority: "8".repeat(43),
    owner,
    createdAt: Date.now(),
    policy: { ...config },
    template: templateLink(template),
  };
  recordAgent(id, record);
  return record;
}

describe("deployed agent records", () => {
  beforeEach(clearStores);

  it("archiving sets one stamp, and the agent still resolves", () => {
    const id = "a".repeat(64);
    deploy(id, "researcher");

    const archived = archiveAgent(id);
    assert.ok(archived);
    assert.ok(isArchived(archived!));
    const at = archived!.archivedAt!;

    // Archiving is not deletion: `lookupAgent` is what `/api/run` and the trace gateway resolve
    // through, and every trace the agent wrote has to keep verifying after it is hidden.
    const again = lookupAgent(id);
    assert.ok(again);
    assert.equal(again!.name, "researcher");
    assert.equal(again!.authority, archived!.authority);

    // Twice keeps the first stamp: the date the page shows is when the owner archived it.
    assert.equal(archiveAgent(id)?.archivedAt, at);
    assert.isNull(archiveAgent("f".repeat(64)));
  });

  it("useVersion moves the record's link and policy to another version of the same template", () => {
    const id = "b".repeat(64);
    const record = deploy(id, "analyst");
    const first = record.template!;

    const v2 = recordTemplate({
      id: first.id,
      kind: "agent",
      owner: OWNER,
      name: "analyst",
      config: { ...config, budgetCapUsdc: "2.50" },
    });
    assert.equal(v2.version, 2);
    assert.notEqual(v2.hash, first.hash);

    // Through the route's own resolver, not a hand-rolled copy of it. A case that built the new
    // link inline with `updateAgent` would prove that `updateAgent` round-trips and nothing about
    // *use version n*: `useVersionContext` could return an error unconditionally and the case
    // would stay green.
    const resolved = useVersionContext(first, 2);
    assert.notProperty(resolved, "error", "useVersionContext resolves the version the route asks for");
    const wanted = (resolved as { template: AgentTemplate }).template;
    assert.equal(wanted.version, 2);
    assert.equal(wanted.hash, v2.hash);

    const after = updateAgent(id, (a) => ({
      ...a,
      policy: { ...a.policy, budgetCapUsdc: wanted.config.budgetCapUsdc },
      template: templateLink(wanted),
    }));
    assert.equal(after?.template?.version, 2);
    assert.equal(after?.template?.hash, v2.hash);
    assert.equal(after?.policy.budgetCapUsdc, "2.50");
    // The id is stable across versions, so the lineage the page reads does not move.
    assert.equal(after?.template?.id, first.id);
    // Nothing was rewritten: v1 is still there for the sessions that ran under it.
    assert.equal(lookupTemplate(first.id, 1)?.hash, first.hash);

    // And the refusals the button depends on, from the same function.
    assert.equal((useVersionContext(first, 3) as { status: number }).status, 404, "no such version");
    assert.equal((useVersionContext(undefined, 2) as { status: number }).status, 409, "no template link at all");
    assert.equal((useVersionContext(first, 0) as { status: number }).status, 400, "a version is a positive integer");
  });

  it("a clone copies the config under the caller: same hash, new id, clonedFrom both ways", () => {
    const sourceId = "c".repeat(64);
    const source = deploy(sourceId, "watcher");
    const sourceTemplate = lookupTemplate(source.template!.id, source.template!.version)!;

    // What the clone action writes: the same config under the caller, pointing back at the
    // version it was copied from. Same bytes, therefore the same content address.
    const copy = recordTemplate({
      kind: "agent",
      owner: OTHER,
      name: sourceTemplate.name,
      config,
      clonedFrom: { id: sourceTemplate.id, version: sourceTemplate.version },
    });
    assert.equal(copy.hash, sourceTemplate.hash);
    assert.notEqual(copy.id, sourceTemplate.id);
    assert.equal(copy.version, 1);
    assert.deepEqual(copy.clonedFrom, { id: sourceTemplate.id, version: sourceTemplate.version });

    const cloneId = "d".repeat(64);
    recordAgent(cloneId, {
      name: "watcher-2",
      authority: "9".repeat(43),
      owner: OTHER,
      createdAt: Date.now(),
      policy: { ...config },
      template: templateLink(copy),
      clonedFrom: { agentId: sourceId, name: source.name },
    });

    const clone = lookupAgent(cloneId)!;
    assert.equal(clone.clonedFrom?.agentId, sourceId);
    assert.equal(clone.template?.hash, source.template!.hash);
    // A clone is a new name and therefore a new chain; the source is untouched by it.
    assert.isUndefined(lookupAgent(sourceId)!.clonedFrom);
    assert.isFalse(isArchived(lookupAgent(sourceId)!));
  });

  it("rows written before templates, ownership and archiving still load", () => {
    const id = "e".repeat(64);
    fs.writeFileSync(
      path.join(traceDir, "agents.json"),
      JSON.stringify({
        [id]: { name: "legacy", authority: "7".repeat(43), createdAt: 1, policy: { ...config } },
      })
    );
    const record = readRegistry()[id];
    assert.ok(record, "a record with no owner, template or archivedAt is still a record");
    assert.isFalse(isArchived(record));
    assert.isUndefined(record.template);
    // And it can be archived, which is the only edit that does not need a template.
    assert.ok(isArchived(archiveAgent(id)!));
  });
});

/**
 * The agent route hands out no trace key. Encryption is on the roadmap: the console writes every
 * blob in the clear, so there is nothing for an owner to unlock, and an `unlock` body is refused
 * like any other action the route does not know rather than answered with a key that opens
 * nothing new. Chains written encrypted are still opened by `lath-audit --trace-key`, outside the
 * console.
 */
describe("the unlock action, not in this build", () => {
  const id = "1".repeat(64);

  beforeEach(() => {
    clearStores();
    recordAgent(id, {
      name: "plain-one",
      authority: "8".repeat(43),
      owner: OWNER,
      createdAt: Date.now(),
      policy: { ...config },
    });
  });

  it("refuses an unlock as an unknown action and lists the four it does take", async () => {
    const res = await POST(jsonRequest({ action: "unlock" }), { params: Promise.resolve({ id }) });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    const error = String(body.error ?? "");
    for (const action of ["clone", "useVersion", "archive", "unarchive"]) assert.include(error, `"${action}"`);
    assert.notInclude(error, '"unlock"');
    assert.notProperty(body, "traceKey");
    assert.notProperty(body, "readToken");
  });
});

/**
 * `GET /api/agents?owner=`, and the description a deploy may put on a row.
 *
 * The route is open and the filter is a convenience, not a gate — so what these cases pin is that
 * it narrows to exactly the wallet's non-archived rows, that no `owner` leaves the answer byte for
 * byte what it has always been, and that nothing in either shape carries a prompt (a prompt
 * reaching an anonymous reader is a finding, not a feature).
 */
describe("the agent registry over HTTP", () => {
  beforeEach(clearStores);

  const get = (query = "") => agentsGET({ nextUrl: new URL(`http://console.test/api/agents${query}`) } as any);
  const listed = async (query = "") =>
    (await (await get(query)).json()) as { agents: (DeployedAgent & { id: string })[]; archived: string[] };

  it("?owner= lists that wallet's live rows, and no wallet lists everything", async () => {
    const mine = "a".repeat(64);
    const theirs = "b".repeat(64);
    const gone = "c".repeat(64);
    deploy(mine, "mine-one", OWNER);
    deploy(theirs, "theirs-one", OTHER);
    deploy(gone, "mine-archived", OWNER);
    archiveAgent(gone);

    const filtered = await listed(`?owner=${OWNER}`);
    assert.deepEqual(
      filtered.agents.map((a) => a.id),
      [mine]
    );
    // Archived rows are still reported, because the home list is built from the chain and needs to
    // know which headers it found are hidden — but only this wallet's.
    assert.deepEqual(filtered.archived, [gone]);

    // A wallet with nothing here gets an empty list, not everyone else's.
    const stranger = await listed(`?owner=${"Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSz"}`);
    assert.isEmpty(stranger.agents);
    assert.isEmpty(stranger.archived);

    // And no `owner` is today's answer, unchanged.
    const all = await listed();
    assert.sameMembers(
      all.agents.map((a) => a.id),
      [mine, theirs]
    );
    assert.deepEqual(all.archived, [gone]);
  });

  it("hands nobody a prompt, filtered or not", async () => {
    const id = "d".repeat(64);
    const record = deploy(id, "prompted", OWNER);
    // The prompt lives in the template's config, which is where the runtime reads it from
    // (`templateSystemPrompt`); the registry row holds a link to that template and no bytes of it.
    recordTemplate({
      id: record.template!.id,
      kind: "agent",
      owner: OWNER,
      name: "prompted",
      config: { ...config, prompt: "watch the fee market and say when it moves" },
    });

    for (const query of ["", `?owner=${OWNER}`]) {
      const body = JSON.stringify(await listed(query));
      assert.notInclude(body, "watch the fee market", `GET /api/agents${query} leaked a prompt`);
      assert.notInclude(body, '"prompt"');
    }
  });

  /**
   * Teams are not in this build, and neither are the two fields the routes would build for a team
   * member (`billedBy`, `memberOf`). A member a team registration wrote still lists and opens on both
   * routes, with neither field computed: the record's own `billedBy` rides the list as a key it has,
   * and no route says which run has it on its roster.
   *
   * With no team field to compute, the list reads `loops.json` not at all, however many rows it lists
   * and however many old team rows the registry holds.
   */
  it("lists and opens a stored team member with no team fields, and the list reads no loops.json", async () => {
    const orchestrator = "5".repeat(64);
    deploy(orchestrator, "watcher");
    const blueprint = recordTemplate({ kind: "agent", owner: OWNER, name: "analyst", config });
    const memberName = "watcher-analyst-1";
    const member = hex(idFromString(memberName));
    recordAgent(member, {
      name: memberName,
      authority: `authority-${memberName}`,
      owner: OWNER,
      createdAt: Date.now(),
      policy: { ...config },
      template: templateLink(blueprint),
      billedBy: orchestrator,
    } as DeployedAgent);
    const loopId = "loop-f0155e15";
    const loop = {
      id: loopId,
      agentId: orchestrator,
      agentName: "watcher",
      owner: OWNER,
      prompt: "watch the fee market",
      promptHash: "cd".repeat(32),
      intervalMs: 60_000,
      maxSteps: 4,
      budgetMicroUsdcPerStep: "50000",
      model: config.model,
      createdAt: Date.now(),
      status: "stopped",
      stopReason: "stopped",
      snapshot: { loopId, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
      history: [],
      workers: { agentIds: [member], model: config.model, budgetMicroUsdcPerTask: "20000" },
    } as LoopRecord;
    recordLoop(loop);

    const page = (
      (await (await agentGET({} as any, { params: Promise.resolve({ id: member }) })).json()) as {
        agent: AgentView & Record<string, unknown>;
      }
    ).agent;
    assert.equal(page.name, memberName);
    assert.notProperty(page, "billedBy", "the page answer computes no payer");
    assert.notProperty(page, "memberOf", "nor which run has it on its roster");

    const nodeFs: typeof fs = require("fs");
    const real = nodeFs.readFileSync;
    let loopReads = 0;
    (nodeFs as any).readFileSync = function (this: unknown, file: fs.PathOrFileDescriptor, ...rest: unknown[]) {
      if (String(file).endsWith("loops.json")) loopReads++;
      return (real as any).call(this, file, ...rest);
    };
    let rows: (DeployedAgent & { id: string })[];
    try {
      rows = ((await (await get()).json()) as { agents: typeof rows }).agents;
    } finally {
      nodeFs.readFileSync = real;
    }
    assert.equal(loopReads, 0, "the list reads loops.json not at all");
    const listedMember = rows.find((r) => r.id === member) as unknown as Record<string, unknown> | undefined;
    assert.isDefined(listedMember, "the member still lists");
    assert.notProperty(listedMember!, "memberOf");
  });
  it("keeps a description on a row, trimmed and clamped, and drops an empty one", () => {
    // The route's half of this is `normalizeDescription`, applied to the deploy body; the write
    // itself happens in `confirmDeploy`, which needs a landed transaction and so is devnet's to
    // check. What is testable here is the rule the record is written under.
    assert.equal(normalizeDescription("  watches the fee market  "), "watches the fee market");
    assert.isUndefined(normalizeDescription("   "), "a blank description is absent, not empty");
    assert.isUndefined(normalizeDescription(undefined));
    assert.isUndefined(normalizeDescription(42), "a non-string is not a description");
    const long = normalizeDescription("x".repeat(MAX_DESCRIPTION + 50))!;
    assert.lengthOf(long, MAX_DESCRIPTION, "clamped rather than refused: a deploy is not failed over a label");

    const id = "e".repeat(64);
    const record = deploy(id, "described");
    recordAgent(id, { ...record, description: "watches the fee market" });
    assert.equal(readRegistry()[id].description, "watches the fee market");

    // Old rows have none, and a reader must not require one.
    const bare = "f".repeat(64);
    deploy(bare, "undescribed");
    assert.isUndefined(lookupAgent(bare)!.description);
  });
});

/**
 * Which hourly bucket a deploy spends.
 *
 * The builder makes deploying a two-click act, and `DEPLOYS_PER_HOUR = 5` is sized for hand-typed
 * ones. Copies get a separate allowance rather than a raised deploy cap, because the cap is what
 * bounds the operator's SOL against a stranger. Every builder
 * deploy from *Your assets* carries a `templateId`, so this verifies the branch already in the
 * route rather than building anything.
 *
 * Driven through `POST` itself, which is the only place the branch exists. Nothing reaches a
 * cluster. A `prepare` with no allowance is refused 400 *before* the counter — refused after it,
 * it would be a free way to spend the server's ceiling. The allowance is parsed first, so a
 * malformed one costs nothing, and a counted call is a well-formed
 * prepare whose wallet is a key this server holds: `prepareDeployTx` refuses that with 409 before
 * it asks the chain anything, so each call moves exactly its buckets and stops.
 */
describe("the deploy and clone rate limits", () => {
  const post = (body: unknown) => agentsPOST(jsonRequest(body));
  const statusOf = async (body: unknown) => (await post(body)).status;
  const errorIn = async (res: Response) => ((await res.json()) as { error?: string }).error ?? "";
  const server = Keypair.generate();
  /**
   * `config`'s own grant, so the parse and the policy check pass and the counters are what decide.
   * Built in `before`, because the policy hash covers the rail and the rail is read from the env.
   */
  let allowance: { capMicroUsdc: string; expiresAt: string; policyVersionHash: string };

  before(() => {
    // Read at call time by `loadKeypair`; the route refuses 503 without one and signs nothing here.
    process.env.LATH_RUNTIME_KEYPAIR = JSON.stringify(Array.from(server.secretKey));
    // The deploy route asks `tempoTreasury()` which rail a row gets, and that answer is cached for
    // the process: an empty treasury here would pin the rail off for every suite mocha loads after
    // this one (`console-loops.ts` "loop channel" sets the same literal and expects `tempo`).
    process.env.LATH_TEMPO_TREASURY ??= `0x${"11".repeat(32)}`;
    allowance = grantFor(config);
  });
  beforeEach(clearStores);

  /** A fresh wallet per case, because the buckets are keyed on it and never reset in-process. */
  const freshWallet = () => Keypair.generate().publicKey.toBase58();

  it("counts a POST carrying a templateId against the clones bucket", async () => {
    // The key this server derives for the name: a wallet it holds, which `prepareDeployTx` refuses.
    const wallet = deployedRoles(server, "clone-of-it").agent.key.publicKey.toBase58();
    const template = recordTemplate({ kind: "agent", owner: wallet, name: "cloned-from", config });
    const body = { name: "clone-of-it", templateId: template.id, prepare: true, wallet, allowance };

    // A malformed allowance is refused before any bucket is asked, however often it comes.
    for (let i = 0; i < CLONES_PER_HOUR + 3; i++) {
      assert.equal(await statusOf({ ...body, allowance: { ...allowance, capMicroUsdc: "1.5" } }), 400);
    }
    for (let i = 0; i < CLONES_PER_HOUR; i++) {
      assert.equal(await statusOf(body), 409, `clone ${i + 1} was not allowed through to the transaction`);
    }
    const refused = await post(body);
    assert.equal(refused.status, 429);
    assert.include(await errorIn(refused), `${CLONES_PER_HOUR} clones per hour`);
  });

  it("refuses a deploy's team before the wallet signs", async () => {
    // A team is not in this build (`checkWorkersRequest`): a deploy carrying a loop that asks for one
    // is refused at `prepare`, with no chain and no signature.
    const wallet = freshWallet();
    const loop = {
      prompt: "Read the slot and say how far it moved since last step.",
      intervalMs: 5 * 60_000,
      maxSteps: 4,
      budgetMicroUsdcPerStep: "20000",
    };
    const body = (workers: unknown) => ({
      name: "team-lead",
      policy: { ...config },
      prepare: true,
      wallet,
      // An allowance, because the cap is parsed before the loop is looked at: a deploy signs one
      // transaction and the loop spends against what is inside it.
      allowance: {
        capMicroUsdc: "1000000",
        expiresAt: String(Math.floor(Date.now() / 1000) + 86_400),
        policyVersionHash: "ab".repeat(32),
      },
      loop: { ...loop, workers },
    });
    const terms = { model: "deepseek/deepseek-v4.1-flash" };
    const registryBefore = Object.keys(readRegistry()).length;
    for (const workers of [
      { agentIds: ["ab".repeat(32)], ...terms },
      { blueprint: { offerId: "ef".repeat(32), count: 2 }, ...terms },
      { scratch: { policy: { prompt: "help" }, count: 1 }, ...terms },
    ]) {
      const refused = await post(body(workers));
      assert.equal(refused.status, 400);
      assert.equal(await errorIn(refused), TEAM_REFUSAL);
    }
    assert.equal(Object.keys(readRegistry()).length, registryBefore, "and nothing was registered to say so");
    // No team is no team: `null` and `false` ask for none, as they always did.
    const none = checkLoopRequest({ ...loop, agentId: "cd".repeat(32), workers: null }, config.model, wallet);
    assert.notProperty(none, "error");
  });

  it("refuses at prepare a deploy's loop whose tools its confirm would refuse", async () => {
    // Refused only at confirm — `checkLoopStart`'s tool refusal — the wallet would have signed, the
    // deploy landed, and the loop been a `loopError`.
    const wallet = freshWallet();
    const loop = {
      prompt: "Read the slot and say how far it moved since last step.",
      intervalMs: 5 * 60_000,
      maxSteps: 4,
      budgetMicroUsdc: "80000",
    };
    const body = (policy: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      name: "loop-deploy-checked",
      policy: { ...config, ...policy },
      prepare: true,
      wallet,
      allowance: {
        capMicroUsdc: "1000000",
        expiresAt: String(Math.floor(Date.now() / 1000) + 86_400),
        policyVersionHash: "ab".repeat(32),
      },
      loop: { ...loop, ...extra },
    });
    const web = await post(body({ tools: ["solana.slot", "web.search"] }));
    assert.equal(web.status, 400);
    const said = await errorIn(web);
    assert.include(said, "web.search");
    assert.include(said, "loop-deploy-checked", "naming whose policy it is");
  });

  /**
   * `existing` means *your* agent is already here. Answered to anyone who posted a taken name, it
   * would make the wizard show *Agent deployed* over a deploy that had dropped the person's policy,
   * prompt and cap. It is reached when the wizard's own name check errored (common
   * on devnet), on a race, or by a direct call — so the server is where it has to be refused.
   */
  it("refuses another wallet's name with a 409 that names no agent, and charges nothing for it", async () => {
    const owner = freshWallet();
    const other = freshWallet();
    const taken = "taken-name";
    recordAgent(hex(idFromString(taken)), {
      name: taken,
      authority: "8".repeat(43),
      owner,
      createdAt: Date.now(),
      policy: { ...config },
    });

    const refused = await post({ name: taken, policy: { ...config }, prepare: true, wallet: other });
    assert.equal(refused.status, 409);
    const answer = (await refused.json()) as Record<string, unknown>;
    assert.include(String(answer.error), "already deployed here by another wallet");
    // A refusal, not a deploy: nothing the wizard could render as a success card.
    for (const key of ["existing", "id", "authority", "owner"]) assert.notProperty(answer, key);

    // A row written before owners were recorded matches no wallet, which is what it is.
    const ownerless = "ownerless-name";
    recordAgent(hex(idFromString(ownerless)), {
      name: ownerless,
      authority: "8".repeat(43),
      createdAt: Date.now(),
      policy: { ...config },
    });
    const orphan = await post({ name: ownerless, policy: { ...config }, prepare: true, wallet: other });
    assert.equal(orphan.status, 409);
    assert.include(await errorIn(orphan), "before ownership was recorded");

    // Both refusals come before the counters, so the caller's hour is untouched.
    const body = { name: "typed-after-refusal", policy: { ...config }, prepare: true, wallet: other };
    for (let i = 0; i < DEPLOYS_PER_HOUR; i++) {
      assert.equal(await statusOf(body), 400, `deploy ${i + 1} was refused by a counter a 409 had spent`);
    }

    // The owner's own re-deploy is still the idempotent `existing`, now saying whose it is — so
    // the wizard can tell the person whether the agent is theirs. On a `prepare` this answer makes
    // no chain write: the name is not re-published for a caller whose wallet is unsigned.
    const mine = await post({ name: taken, policy: { ...config }, prepare: true, wallet: owner });
    assert.equal(mine.status, 200);
    assert.deepInclude((await mine.json()) as Record<string, unknown>, {
      id: hex(idFromString(taken)),
      owner,
      existing: true,
      signature: null,
    });
  });

  it("lists only the offered tools when it refuses an unknown one", async () => {
    // The deploy route's own copy of the sentence `templates/validate.ts` gives: neither may name
    // the retired `hire` or the `lattice.verify_chain` alias as tools "the runtime ships".
    const refused = await post({
      name: "tool-typo",
      policy: { ...config, tools: ["typo"] },
      prepare: true,
      wallet: freshWallet(),
    });
    assert.equal(refused.status, 400);
    const error = await errorIn(refused);
    assert.include(error, "unknown tools: typo");
    assert.include(error, "web.search");
    assert.notMatch(error, /hire|lattice\./);
  });

  it("counts a POST carrying none against the deploys bucket, and the two do not share", async () => {
    // The server's own key, which `prepareDeployTx` refuses for every name, so the clone below can
    // be the same wallet's.
    const wallet = server.publicKey.toBase58();
    const body = { name: "typed-by-hand", policy: { ...config }, prepare: true, wallet, allowance };

    // No allowance at all: a 400 that spends neither a deploy nor one of the server's 200.
    for (let i = 0; i < DEPLOYS_PER_HOUR + 3; i++) {
      assert.equal(await statusOf({ ...body, allowance: undefined }), 400);
    }
    for (let i = 0; i < DEPLOYS_PER_HOUR; i++) {
      assert.equal(await statusOf(body), 409, `deploy ${i + 1} was not allowed through to the transaction`);
    }
    const refused = await post(body);
    assert.equal(refused.status, 429);
    assert.include(await errorIn(refused), `${DEPLOYS_PER_HOUR} deploys per hour`);

    // The point of the split: with the hour's hand-typed deploys spent, a clone still goes
    // through. A builder that raised `DEPLOYS_PER_HOUR` instead would have raised the operator's
    // exposure to a stranger to get here.
    const template = recordTemplate({ kind: "agent", owner: wallet, name: "still-cloneable", config });
    assert.equal(
      await statusOf({ name: "clone-after", templateId: template.id, prepare: true, wallet, allowance }),
      409
    );
  });

  it("refuses a prepare whose allowance is not its policy's, before any bucket is asked", async () => {
    // The wallet signs the cap, expiry and hash in the body; the record the ticket writes claims
    // the policy's. Taken as sent, a body could have the one say 1 USDC for 14 days and the other a
    // hundred-year grant of any size under any hash. A wallet this server does not hold, so a body
    // that got past the check would reach the chain; none of these does.
    const wallet = freshWallet();
    const body = { name: "grant-held-to-policy", policy: { ...config }, prepare: true, wallet };
    const day = 86_400;
    const cases: [Record<string, string>, string][] = [
      [{ capMicroUsdc: "2000000" }, "budgetCapUsdc is 1000000"],
      [{ policyVersionHash: "ab".repeat(32) }, "not this policy's hash"],
      [{ expiresAt: String(Number(allowance.expiresAt) + 100 * 365 * day) }, "14 days from now"],
      [{ expiresAt: String(Math.floor(Date.now() / 1000) + day) }, "14 days from now"],
    ];
    for (const [change, said] of cases) {
      for (let i = 0; i < DEPLOYS_PER_HOUR + 1; i++) {
        const res = await post({ ...body, allowance: { ...allowance, ...change } });
        assert.equal(res.status, 400, JSON.stringify(change));
        if (i === 0) assert.include(await errorIn(res), said);
      }
    }
    // A browser clock a few minutes out is not a different grant.
    const skewed = { ...allowance, expiresAt: String(Number(allowance.expiresAt) - 300) };
    const own = deployedRoles(server, "grant-held-to-policy").agent.key.publicKey.toBase58();
    assert.equal(await statusOf({ ...body, wallet: own, allowance: skewed }), 409, "reached the transaction");
  });
});

/**
 * What a failed read of a store does to the next write.
 *
 * `recordAgent` writes the whole map back, so a `readRegistry` that answered `{}` to *any* read
 * error would let one `EMFILE` on `readFileSync` — a process out of descriptors, which a long devnet
 * loop can produce — plus one deploy confirm save a registry holding only that deploy's agent.
 * The rule lives in `_lib/json-store.ts` and is one line long: only `ENOENT` is an empty
 * store; everything else throws, so the write that would have followed never happens. The three
 * stores share the helper, so the registry's case stands for `templates.json` and `market.json`.
 *
 * `fs.readFileSync` is stubbed, not the file: the failure under test is the read, not the bytes.
 * Stubbed on the module object `require` returns — the `import * as fs` namespace is getters over
 * it, in this file and in `json-store.ts`, so a stub there is what the helper calls.
 */
describe("a store that cannot be read is not a store to write over", () => {
  const fsModule = require("fs") as typeof fs;
  const registry = () => path.join(traceDir, "agents.json");
  const realRead = fsModule.readFileSync;
  beforeEach(clearStores);
  afterEach(() => {
    fsModule.readFileSync = realRead;
    // The not-JSON case leaves a file no later suite's reads may meet: a corrupt store now throws.
    fs.rmSync(registry(), { force: true });
  });

  /** Every read of `agents.json` throws `code` until the stub is put back; other files read as usual. */
  function failReadsWith(code: string): void {
    fsModule.readFileSync = function (this: unknown, p: unknown, ...rest: unknown[]) {
      if (String(p).endsWith("agents.json")) {
        const e = new Error(`${code}: injected`) as NodeJS.ErrnoException;
        e.code = code;
        throw e;
      }
      return (realRead as any).call(this, p, ...rest);
    } as typeof fs.readFileSync;
  }

  it("a missing file is an empty registry, and the first write creates it", () => {
    assert.deepEqual(readRegistry(), {});
    deploy("1".repeat(64), "first");
    assert.lengthOf(Object.keys(readRegistry()), 1);
  });

  it("EMFILE on the read refuses the write and leaves the file as it was", () => {
    for (let i = 0; i < 3; i++) deploy(String(i).repeat(64), `victim-${i}`);
    const before = fs.readFileSync(registry(), "utf8");
    failReadsWith("EMFILE");
    assert.throws(() => readRegistry(), /EMFILE/);
    assert.throws(
      () =>
        recordAgent("f".repeat(64), {
          name: "attacker",
          authority: "B",
          owner: "ATT",
          createdAt: 2,
          policy: { ...config },
        }),
      /EMFILE/,
      "the write is refused, not applied to an empty map"
    );
    fsModule.readFileSync = realRead;
    assert.equal(fs.readFileSync(registry(), "utf8"), before, "byte for byte what was there");
    assert.sameMembers(
      Object.values(readRegistry()).map((a) => a.name),
      ["victim-0", "victim-1", "victim-2"]
    );
    assert.isNull(lookupAgent("f".repeat(64)));
  });

  it("a file that is not JSON throws with its path, and is not overwritten", () => {
    deploy("2".repeat(64), "kept");
    fs.writeFileSync(registry(), "{ not json");
    assert.throws(() => readRegistry(), /agents\.json is not JSON/);
    assert.throws(() => deploy("3".repeat(64), "over-the-top"));
    assert.equal(fs.readFileSync(registry(), "utf8"), "{ not json");
  });
});
