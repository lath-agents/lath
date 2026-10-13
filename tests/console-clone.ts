import "./fixtures/trace-dir";
import { assert } from "chai";
import { hex, idFromString } from "@lath/sdk";
import { policyVersionHash, promptHash } from "../runtime/src";
import {
  CopyPlan,
  allowancePolicyHash,
  cloneContext,
  cloneNote,
  copyContext,
  issueCloneTicket,
  peekCloneTicket,
  publicCopyConfig,
  recordCopy,
  spendCloneTicket,
} from "../frontend/src/app/api/_lib/copy";
import {
  CLONES_PER_HOUR,
  DeployedAgent,
  SESSION_CAP_MICRO,
  archiveAgent,
  callerIp,
  isArchived,
  lookupAgent,
  recordAgent,
  unarchiveAgent,
} from "../frontend/src/app/api/_lib/runner";
import {
  AgentTemplateConfig,
  archiveTemplate,
  lookupTemplate,
  recordTemplate,
  templateLink,
  useVersionContext,
} from "../frontend/src/app/api/_lib/templates";

/**
 * What `POST /api/agents/:id` refuses and what it plans, without a chain: the clone action and
 * the version link.
 *
 * `route.ts` imports `next/server`, which does not resolve outside `frontend/`, so the route
 * keeps no decision of its own — every refusal a clone can earn is `cloneContext`, every refusal
 * a *use version n* can earn is `useVersionContext`, and the records a landed clone leaves are
 * `recordCopy`. The halves this file cannot reach are the transaction (`prepareDeployTx`) and the
 * proof that the owner signed it (`deployTxSignedBy`), both of which read a cluster and are
 * exercised on devnet.
 *
 * The thing worth reading first is the allowance. An allowance is per `(user, agent_authority)`
 * and the copy's authority is new, so a clone that registered and funded a new agent on a signed
 * message and granted nothing would see its first session refused, with no way to fix it on its
 * page. A plan carries the allowance the one signature will grant, in the same transaction as the
 * registration.
 *
 * `./fixtures/trace-dir` is imported first: `_lib/copy.ts` reads `TRACE_DIR` from `runner.ts`,
 * which captures it at module evaluation.
 */

/** Base64 of the message bytes a `prepare` would have built; any bytes will do here. */
const MESSAGE = Buffer.from("the message prepare built").toString("base64");

const OWNER = "So11111111111111111111111111111111111111112";
const STRANGER = "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy";

const config: AgentTemplateConfig = {
  prompt: "watch the fee level",
  model: "deepseek/deepseek-v4.1-flash",
  tools: ["solana.slot", "solana.fees"],
  budgetCapUsdc: "1.00",
  expirationDays: 14,
};

/** A deploy, as `POST /api/agents` records one: a policy, an owner, and a template link. */
function deploy(name: string, opts: { owner?: string | null; template?: boolean; cap?: string } = {}): string {
  const id = hex(idFromString(name));
  const owner = opts.owner === undefined ? OWNER : opts.owner;
  const cap = opts.cap ?? config.budgetCapUsdc;
  const template =
    opts.template === false
      ? null
      : recordTemplate({ kind: "agent", owner: owner ?? OWNER, name, config: { ...config, budgetCapUsdc: cap } });
  const record: DeployedAgent = {
    name,
    authority: "AuThOrItY1111111111111111111111111111111111",
    createdAt: Date.now(),
    policy: { model: config.model, tools: config.tools, budgetCapUsdc: cap, expirationDays: config.expirationDays },
    ...(owner ? { owner } : {}),
    ...(template ? { template: templateLink(template) } : {}),
  };
  recordAgent(id, record);
  return id;
}

/** The plan, or an assertion failure — the cases below that expect one say so. */
function planned(v: CopyPlan | { error: string; status: number }): CopyPlan {
  if ("error" in v) throw new Error(`expected a plan, got ${v.status} ${v.error}`);
  return v;
}

/** A fresh rate-limit bucket per case, so one case's charges are not another's. */
let bucket = 0;
const ip = () => `clone-ip-${bucket++}`;

describe("clone", () => {
  it("plans a copy under the owner, with the allowance its one signature grants", () => {
    const source = deploy("cl-source");
    const plan = planned(
      cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name: "cl-copy", ip: ip() })
    );

    assert.equal(plan.id, hex(idFromString("cl-copy")), "the id is the hash of the owner's name");
    assert.equal(plan.source.agentId, source);
    assert.deepEqual(plan.config, config, "the copy runs the source's config");
    // A clone is registered *and* payable, or it is nothing: a plan with no allowance would see
    // the copy's first session refused.
    assert.equal(plan.allowance.capMicroUsdc, "1000000", "the allowance is the config's budget cap");
    assert.lengthOf(plan.allowance.policyVersionHash, 64);
    assert.isAbove(Number(plan.allowance.expiresAt), Math.floor(Date.now() / 1000));

    // What `confirm` writes once the transaction has landed: the template copied under the owner
    // with the same hash, and `clonedFrom` on both sides.
    const issued = issueCloneTicket(plan, OWNER, MESSAGE);
    const ticket = peekCloneTicket(issued);
    spendCloneTicket(issued);
    assert.isNotNull(ticket);
    assert.equal(ticket!.message, MESSAGE, "the ticket carries the message confirm has to see land");
    const { template, clonedFrom } = recordCopy(ticket!, "NeWaUtHoRiTy11111111111111111111111111111111");
    const sourceTemplate = lookupTemplate(plan.source.template!.id, plan.source.template!.version)!;
    assert.equal(template.hash, sourceTemplate.hash, "a clone is lineage, not a new configuration");
    assert.notEqual(template.id, sourceTemplate.id);
    assert.deepEqual(clonedFrom, { agentId: source, name: "cl-source" });

    const copy = lookupAgent(plan.id)!;
    assert.equal(copy.owner, OWNER);
    // Byte-identical to every `clonedFrom` already in `agents.json`. A marketplace launch marked itself with
    // `via: "market"`; a clone is the owner copying their own agent and writes no such key at all,
    // so the absent key is what the agent page and `/agents` read as *cloned from*. `deepEqual`
    // would fail on an extra key, and the explicit `keys` says the guard is deliberate.
    assert.deepEqual(copy.clonedFrom, { agentId: source, name: "cl-source" });
    assert.hasAllKeys(copy.clonedFrom!, ["agentId", "name"], "a clone records no `via`");
    // A clone is a new name and therefore a new chain; the source is untouched by it.
    assert.isUndefined(lookupAgent(source)!.clonedFrom);
  });

  it("refuses a stranger, an agent with no recorded owner, and an agent that is not here", () => {
    const source = deploy("cl-owned");
    const stranger = cloneContext({
      agentId: source,
      source: lookupAgent(source),
      wallet: STRANGER,
      name: "cl-x",
      ip: ip(),
    });
    assert.include((stranger as any).error, "belongs to another wallet");
    assert.equal((stranger as any).status, 403);

    const orphan = deploy("cl-orphan", { owner: null });
    const noOwner = cloneContext({
      agentId: orphan,
      source: lookupAgent(orphan),
      wallet: OWNER,
      name: "cl-y",
      ip: ip(),
    });
    assert.include((noOwner as any).error, "no recorded owner");
    assert.equal((noOwner as any).status, 403);

    const absent = cloneContext({ agentId: "a".repeat(64), source: null, wallet: OWNER, name: "cl-z", ip: ip() });
    assert.equal((absent as any).status, 404);

    const malformed = cloneContext({ agentId: "not-hex", source: null, wallet: OWNER, name: "cl-z", ip: ip() });
    assert.equal((malformed as any).status, 400);
  });

  it("refuses a name that is taken, the source's own name, and one too short to be a name", () => {
    const source = deploy("cl-taken-src");
    deploy("cl-taken");
    const ask = (name: string) =>
      cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name, ip: ip() });

    assert.equal((ask("--") as any).status, 400, "a name that sanitizes to two characters is not a name");
    assert.include((ask("cl-taken-src") as any).error, "being copied");
    assert.include((ask("cl-taken") as any).error, "already deployed here");
  });

  it("refuses a source with no budget: there would be nothing for the wallet to sign", () => {
    const source = deploy("cl-free", { cap: "0" });
    const refused = cloneContext({
      agentId: source,
      source: lookupAgent(source),
      wallet: OWNER,
      name: "cl-free-2",
      ip: ip(),
    });
    assert.include((refused as any).error, "no allowance to sign for");
    assert.equal((refused as any).status, 409);
  });

  it("copies an agent deployed before templates existed from its policy", () => {
    const source = deploy("cl-legacy", { template: false });
    const plan = planned(
      cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name: "cl-legacy-2", ip: ip() })
    );
    assert.isNull(plan.source.template, "there is no earlier template for the copy to point back at");
    assert.equal(plan.config.model, config.model);
    assert.equal(plan.allowance.capMicroUsdc, "1000000", "the copy still has to run, so it still gets an allowance");

    const issuedOrphan = issueCloneTicket(plan, OWNER, MESSAGE);
    const ticket = peekCloneTicket(issuedOrphan)!;
    spendCloneTicket(issuedOrphan);
    const { template } = recordCopy(ticket, "NeWaUtHoRiTy11111111111111111111111111111111");
    assert.isUndefined(lookupTemplate(template.id, template.version)!.clonedFrom);
  });

  it("says when the agent it was cloned from is archived, and clones it anyway", () => {
    const source = deploy("cl-arch-src");
    archiveAgent(source);
    const plan = planned(
      cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name: "cl-arch-2", ip: ip() })
    );
    assert.match(cloneNote(plan)!, /archived; the clone is not/);
  });

  it("a ticket binds the owner to the message prepare built, and is single-use", () => {
    const source = deploy("cl-ticket-src");
    const plan = planned(
      cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name: "cl-ticket", ip: ip() })
    );
    const id = issueCloneTicket(plan, OWNER, MESSAGE);

    // Peeked, not claimed: the transaction has already landed when `confirm` runs, so a ticket
    // spent on an RPC that had not caught up would burn the name.
    assert.equal(peekCloneTicket(id)!.wallet, OWNER);
    assert.equal(peekCloneTicket(id)!.message, MESSAGE);
    assert.equal(peekCloneTicket(id)!.name, "cl-ticket");
    spendCloneTicket(id);
    assert.isNull(peekCloneTicket(id), "spent once, gone");
    assert.isNull(peekCloneTicket(undefined));
    assert.isNull(peekCloneTicket("nothing"));
  });

  it("charges the hourly counter last, so a refusal that creates nothing costs nothing", () => {
    // A `rateLimit` run before the name-collision check would let a typo, a name someone already
    // took, or a cancelled wallet prompt each spend one of the hour's copies without anything
    // being created. Here a wallet earns every free refusal there is and
    // then still has its full budget.
    const source = deploy("cl-limit-src");
    deploy("cl-limit-taken");
    const here = ip();
    const ask = (name: string) =>
      cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name, ip: here });

    for (let i = 0; i < CLONES_PER_HOUR + 4; i++) {
      assert.isTrue("error" in ask("--"), "too short");
      assert.isTrue("error" in ask("cl-limit-taken"), "taken");
      assert.isTrue("error" in ask("cl-limit-src"), "the source's own name");
    }
    // And the budget is still whole: `CLONES_PER_HOUR` plans go through, and the next one does not.
    for (let i = 0; i < CLONES_PER_HOUR; i++) planned(ask(`cl-limit-${i}`));
    const refused = ask(`cl-limit-${CLONES_PER_HOUR}`);
    assert.equal((refused as any).status, 429);
  });

  it("keys the counter on the caller as well as the wallet, so one caller cannot empty another's", () => {
    const source = deploy("cl-bucket-src");
    const mine = ip();
    for (let i = 0; i < CLONES_PER_HOUR; i++) {
      planned(
        cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name: `cl-b-${i}`, ip: mine })
      );
    }
    assert.equal(
      (cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name: "cl-b-x", ip: mine }) as any)
        .status,
      429
    );
    // The same wallet from somewhere else has its own bucket.
    planned(cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name: "cl-b-x", ip: ip() }));
  });

  it("copyContext names the action's own words nowhere: the callers do that", () => {
    // A caller may re-word these for its own reader; the clone route uses them as they are.
    const source = deploy("cl-words");
    const refused = copyContext({
      sourceAgentId: source,
      source: lookupAgent(source)!,
      wallet: OWNER,
      name: "-",
      limit: { what: "clones", key: `clone:${OWNER}:${ip()}`, perHour: CLONES_PER_HOUR },
    });
    assert.include((refused as any).error, "a copy needs a name of its own");
  });

  /**
   * What the clone prepare answers with. That prepare is unsigned and the owner it checks
   * is public in `GET /api/agents`, so its answer is anyone's who names the owner and a fresh
   * name — so it must not carry the source template's whole config, prompt included. The route's
   * 200 needs a cluster (`prepareDeployTx`), so the wiring at `agents/[id]/route.ts` is checked by
   * reading; the projection it answers through is checked here.
   */
  it("answers a prepare with the copy's config minus its prompt, and the prompt's hash", () => {
    const source = deploy("cl-prompted");
    // A stranger naming the owner's address gets the plan: that is the unsigned prepare's premise.
    const plan = planned(
      cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name: "cl-prompted-x", ip: ip() })
    );
    assert.equal(
      plan.config.prompt,
      config.prompt,
      "the plan keeps it: the ticket and the allowance are built from it"
    );

    const answered = publicCopyConfig(plan.config);
    assert.notProperty(answered, "prompt");
    assert.notInclude(JSON.stringify(answered), config.prompt!);
    // What the copy's genesis commits, so a page can still say which prompt it will run.
    assert.equal(answered.promptHash, promptHash(config.prompt!.trim()));
    for (const key of ["model", "tools", "budgetCapUsdc", "expirationDays"] as const) {
      assert.deepEqual(answered[key], plan.config[key], key);
    }
    assert.equal(publicCopyConfig({ ...config, payment: "tempo" }).payment, "tempo", "the rail rides along");

    // A config with no prompt has no hash to show, and a blank one is no prompt.
    const { prompt: _none, ...bare } = config;
    assert.notProperty(publicCopyConfig(bare), "promptHash");
    assert.notProperty(publicCopyConfig({ ...config, prompt: "   " }), "promptHash");
  });

  /**
   * The hash a grant commits and the hash a session's genesis commits are two claims, and
   * this pins how they relate. The grant's `maxCost` is the whole budget cap; `/api/run` builds its
   * genesis policy from the same config with `maxCost` set to that session's ceiling, at most
   * `SESSION_CAP_MICRO` (`api/run/route.ts`). Nothing on chain or in `lath-audit` compares them, so
   * a test is the only thing that would notice either side moving a field other than `maxCost`.
   */
  it("commits the grant's whole cap as maxCost, and differs from a session's genesis in nothing else", () => {
    const source = deploy("cl-grant");
    const plan = planned(
      cloneContext({ agentId: source, source: lookupAgent(source), wallet: OWNER, name: "cl-grant-x", ip: ip() })
    );
    const cap = BigInt(plan.allowance.capMicroUsdc);
    assert.notEqual(cap, SESSION_CAP_MICRO, "the fixture's budget must differ from a session's cap to test anything");

    // The genesis a session of this agent writes, as `runSession` builds its policy: the config's
    // tools, model and prompt, and the session's own ceiling.
    const genesis = (maxCost: bigint, payment?: "tempo") =>
      hex(
        policyVersionHash({
          model: config.model,
          temperature: 0.2,
          toolAllowList: [...config.tools].sort(),
          maxCost: Number(maxCost),
          promptHash: promptHash(config.prompt!.trim()),
          ...(payment ? { payment } : {}),
        })
      );
    assert.equal(plan.allowance.policyVersionHash, genesis(cap), "the grant is the genesis document at the whole cap");
    assert.notEqual(plan.allowance.policyVersionHash, genesis(SESSION_CAP_MICRO), "and not any session's document");

    // Every server-side deploy path builds the grant here, so the rail enters it the way it enters
    // a genesis: the terminal deploy in `/api/agents` must not leave `payment` out.
    const args = { model: config.model, tools: config.tools, capMicroUsdc: cap, prompt: config.prompt };
    assert.equal(hex(allowancePolicyHash({ ...args, payment: "tempo" })), genesis(cap, "tempo"));
    assert.equal(hex(allowancePolicyHash(args)), genesis(cap));
    // Tool order and prompt whitespace are normalised, as the genesis side normalises them.
    assert.equal(
      hex(allowancePolicyHash({ ...args, tools: [...config.tools].reverse(), prompt: `  ${config.prompt}  ` })),
      genesis(cap)
    );
  });
});

describe("the caller an hourly limit is keyed on", () => {
  const req = (headers: Record<string, string>) => ({ headers: { get: (n: string) => headers[n] ?? null } });
  const withProxy = (v: string | undefined, f: () => void) => {
    const before = process.env.LATH_TRUST_PROXY;
    if (v === undefined) delete process.env.LATH_TRUST_PROXY;
    else process.env.LATH_TRUST_PROXY = v;
    try {
      f();
    } finally {
      if (before === undefined) delete process.env.LATH_TRUST_PROXY;
      else process.env.LATH_TRUST_PROXY = before;
    }
  };

  it("reads no header at all unless a proxy was vouched for", () => {
    // A fallback that read `x-real-ip` whatever the flag said would let any client write a
    // fresh value per request, get a fresh bucket every time, and every per-caller limit on this
    // server would bound nothing — including the ones that exist because a prepared transaction,
    // once broadcast, spends the operator's SOL.
    withProxy(undefined, () => {
      assert.equal(callerIp(req({ "x-real-ip": "9.9.9.9" })), "local");
      assert.equal(callerIp(req({ "x-forwarded-for": "9.9.9.9" })), "local");
      assert.equal(callerIp(req({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" })), "local");
      assert.equal(callerIp(req({})), "local");
    });
  });

  it("takes the last hop a trusted proxy appended, and never an earlier one", () => {
    withProxy("1", () => {
      // Earlier entries are the client's to write; the last is the one the proxy added.
      assert.equal(callerIp(req({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 3.3.3.3" })), "3.3.3.3");
      assert.equal(callerIp(req({ "x-real-ip": "4.4.4.4" })), "4.4.4.4");
      assert.equal(callerIp(req({})), "local");
    });
  });
});

describe("archive and unarchive", () => {
  it("unarchive takes the stamp off and leaves a record identical to one never archived", () => {
    const id = deploy("cl-back");
    const before = JSON.stringify(lookupAgent(id));
    assert.isTrue(isArchived(archiveAgent(id)!));
    const after = unarchiveAgent(id)!;
    assert.isFalse(isArchived(after));
    assert.notProperty(after, "archivedAt", "the key is removed, not set to a sentinel");
    assert.equal(JSON.stringify(lookupAgent(id)), before, "a round trip changes nothing else");
  });

  it("unarchiving twice is a no-op, and an unknown id is null rather than a throw", () => {
    const id = deploy("cl-back-twice");
    archiveAgent(id);
    unarchiveAgent(id);
    assert.isFalse(isArchived(unarchiveAgent(id)!));
    assert.isNull(unarchiveAgent("f".repeat(64)));
  });
});

describe("use version n", () => {
  it("moves the link to another version of the same template", () => {
    const id = deploy("cl-ver");
    const link = lookupAgent(id)!.template!;
    const v2 = recordTemplate({
      kind: "agent",
      id: link.id,
      owner: OWNER,
      name: "cl-ver",
      config: { ...config, budgetCapUsdc: "2.50" },
    });
    const resolved = useVersionContext(link, 2);
    assert.equal((resolved as any).template.version, 2);
    assert.equal((resolved as any).template.hash, v2.hash);
  });

  it("refuses an archived version, the same way a deploy and a loop start from one are refused", () => {
    // `POST /api/agents` and `loopStartTemplate` both refuse an archived template, so `useVersion`
    // must too, or the same stamp means three things. The sentence is theirs, and a new version
    // really does bring the id back.
    const id = deploy("cl-ver-arch");
    const link = lookupAgent(id)!.template!;
    archiveTemplate(link.id);
    const refused = useVersionContext(link, 1);
    assert.equal((refused as any).status, 409);
    assert.match((refused as any).error, /archived; write a new version to use it/);

    // And the advice works: a new version un-archives the id, and the link moves to it.
    recordTemplate({
      kind: "agent",
      id: link.id,
      owner: OWNER,
      name: "cl-ver-arch",
      config: { ...config, budgetCapUsdc: "3.00" },
    });
    assert.equal((useVersionContext(link, 2) as any).template.version, 2);
    // The version written before the archive keeps its stamp, so what was put away stays away.
    assert.equal((useVersionContext(link, 1) as any).status, 409);
  });

  it("refuses a version that is not one, a version that is not there, and an agent with no template", () => {
    const id = deploy("cl-ver-bad");
    const link = lookupAgent(id)!.template!;
    assert.equal((useVersionContext(link, 0) as any).status, 400);
    assert.equal((useVersionContext(link, undefined) as any).status, 400);
    assert.equal((useVersionContext(link, 9) as any).status, 404);
    assert.equal((useVersionContext(undefined, 1) as any).status, 409);
  });
});
