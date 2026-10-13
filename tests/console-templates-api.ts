import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  AgentTemplateConfig,
  LoopTemplateConfig,
  TEMPLATES_PER_OWNER,
  TEMPLATE_WRITES_PER_HOUR,
  TEMPLATE_WRITES_PER_HOUR_SERVER,
  Template,
  archiveTemplate,
  chargeTemplateWrite,
  lookupTemplate,
  ownedTemplates,
  recordTemplate,
  templateCapRefusal,
  templateHash,
} from "../frontend/src/app/api/_lib/templates";
import {
  MAX_CONFIG_CHARS,
  MAX_NAME,
  MAX_TOOLS,
  checkAgentConfig,
  checkAgentRef,
  checkClonedFrom,
  checkConfig,
  checkLoopConfig,
  checkName,
  resolveWrite,
} from "../frontend/src/app/api/templates/validate";
import { LOOP_BUDGET_MAX_MICRO, TEAM_REFUSAL, budgetFromPerStep } from "../frontend/src/app/api/_lib/loops";
import { GET as templatesGET } from "../frontend/src/app/api/templates/route";
import { canonicalJson } from "@lath/runtime";

/**
 * The write side of `/api/templates`: what a `POST`, a `PUT`
 * and `{ action: "archive" }` accept, and what they do to the store.
 *
 * `route.ts` itself imports `next/server`, which does not resolve outside `frontend/`, so the
 * route keeps no decision of its own: every refusal a body can earn is a function in
 * `templates/validate.ts`, and the store half is `_lib/templates.ts`. The cases below compose
 * the two in the order the handlers do, which is the whole of each handler minus the wallet
 * signature and the rate limit — those are `verifyAuth` and `rateLimit`, covered where they
 * live, and exercised end to end by the devnet E2E run.
 *
 * `./fixtures/trace-dir` is imported first: `templates.ts` reads `TRACE_DIR` from `runner.ts`,
 * which captures it at module evaluation.
 */

const OWNER = "So11111111111111111111111111111111111111112";
const OTHER = "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy";

const agentBody = (over: Partial<Record<string, unknown>> = {}) => ({
  model: "deepseek/deepseek-v4.1-flash",
  tools: ["solana.slot", "solana.fees"],
  budgetCapUsdc: "1.00",
  expirationDays: 14,
  ...over,
});

const loopBody = (over: Partial<Record<string, unknown>> = {}) => ({
  prompt: "check the slot and report",
  intervalMs: 15_000,
  maxSteps: 3,
  budgetMicroUsdcPerStep: "50000",
  model: "deepseek/deepseek-v4.1-flash",
  coordinator: { agentId: "aa".repeat(32) },
  members: [],
  ...over,
});

/** What `POST` does after the signature: validate, then write version 1. */
function post(
  wallet: string,
  body: { kind: Template["kind"]; name?: unknown; config?: unknown; clonedFrom?: unknown }
): Template | { error: string } {
  const name = checkName(body.name);
  if ("error" in name) return name;
  const config = checkConfig(body.kind, body.config);
  if ("error" in config) return config;
  const clonedFrom = checkClonedFrom(body.clonedFrom);
  if ("error" in clonedFrom) return clonedFrom;
  return recordTemplate({ kind: body.kind, owner: wallet, name: name.name, config: config.config, ...clonedFrom });
}

/** What `PUT` does after the signature: resolve the id, check ownership, then append. */
function put(
  wallet: string,
  body: { id?: string; name?: unknown; config?: unknown }
): Template | { error: string; status?: number } {
  const target = resolveWrite(body.id ? lookupTemplate(body.id) : null, wallet);
  if (!("latest" in target)) return target;
  const latest = target.latest;
  const name = body.name === undefined ? { name: latest.name } : checkName(body.name);
  if ("error" in name) return name;
  const config = checkConfig(latest.kind, body.config);
  if ("error" in config) return config;
  return recordTemplate({
    id: latest.id,
    kind: latest.kind,
    owner: latest.owner,
    name: name.name,
    config: config.config,
  });
}

/** What `POST { id, action: "archive" }` does after the signature. */
function archive(wallet: string, id?: string): Template[] | { error: string; status?: number } {
  const target = resolveWrite(id ? lookupTemplate(id) : null, wallet);
  if (!("latest" in target)) return target;
  return archiveTemplate(target.latest.id) ?? { error: "no template with that id", status: 404 };
}

/** Each case starts from an empty store: the file is the whole state. */
function clearStore(): void {
  fs.rmSync(path.join(traceDir, "templates.json"), { force: true });
}

describe("template writes", () => {
  beforeEach(clearStore);

  it("POST writes version 1 with a hash that re-derives from the stored config", () => {
    const written = post(OWNER, { kind: "agent", name: "  researcher  ", config: agentBody() });
    assert.notProperty(written, "error");
    const t = written as Template;
    assert.equal(t.version, 1);
    assert.equal(t.name, "researcher", "the name is stored trimmed");
    assert.equal(t.owner, OWNER);
    assert.equal(t.hash, templateHash(t.config));
    assert.deepEqual(lookupTemplate(t.id, 1), t);
  });

  it("PUT appends version 2 with a new hash, and version 1 still resolves", () => {
    const v1 = post(OWNER, { kind: "agent", name: "researcher", config: agentBody() }) as Template;
    const v2 = put(OWNER, { id: v1.id, config: agentBody({ budgetCapUsdc: "2.50" }) }) as Template;
    assert.equal(v2.version, 2);
    assert.equal(v2.id, v1.id, "a version is appended to the id, not a new template");
    assert.equal(v2.name, "researcher", "an edit of the config alone keeps the name");
    assert.notEqual(v2.hash, v1.hash);
    assert.equal(v2.hash, templateHash(v2.config));
    const kept = lookupTemplate(v1.id, 1);
    assert.equal(kept?.hash, v1.hash, "the version a run points at is never rewritten");
    assert.equal(lookupTemplate(v1.id)?.version, 2, "no version resolves to the latest");
  });

  it("archive hides every version from the list and leaves them readable by id", () => {
    const v1 = post(OWNER, { kind: "agent", name: "researcher", config: agentBody() }) as Template;
    put(OWNER, { id: v1.id, config: agentBody({ expirationDays: 30 }) });
    assert.lengthOf(ownedTemplates(OWNER), 1);
    const versions = archive(OWNER, v1.id) as Template[];
    assert.lengthOf(versions, 2);
    assert.isNumber(versions[0].archivedAt);
    assert.lengthOf(ownedTemplates(OWNER), 0, "GET no longer lists it");
    assert.equal(lookupTemplate(v1.id, 1)?.hash, v1.hash, "verification still resolves the config a run used");
  });

  it("a write to another wallet's template is refused, and an unknown id is a 404", () => {
    const v1 = post(OWNER, { kind: "agent", name: "researcher", config: agentBody() }) as Template;
    assert.deepEqual(put(OTHER, { id: v1.id, config: agentBody({ expirationDays: 30 }) }), {
      error: "this template belongs to another wallet",
      status: 403,
    });
    assert.deepEqual(archive(OTHER, v1.id), {
      error: "this template belongs to another wallet",
      status: 403,
    });
    assert.equal(lookupTemplate(v1.id)?.version, 1, "the refused write left no version behind");
    assert.deepEqual(put(OWNER, { id: "tpl-0000000000000000", config: agentBody() }), {
      error: "no template with that id",
      status: 404,
    });
    assert.deepEqual(archive(OWNER, undefined), { error: "no template with that id", status: 404 });
  });

  it("a clone records the version it was copied from", () => {
    const v1 = post(OWNER, { kind: "agent", name: "researcher", config: agentBody() }) as Template;
    const clone = post(OWNER, {
      kind: "agent",
      name: "researcher copy",
      config: agentBody({ expirationDays: 30 }),
      clonedFrom: { id: v1.id, version: 1 },
    }) as Template;
    assert.deepEqual(clone.clonedFrom, { id: v1.id, version: 1 });
    assert.notEqual(clone.id, v1.id, "a clone is its own template, not a version of the source");
  });
});

describe("template config bounds", () => {
  it("a name is required, trimmed and capped", () => {
    assert.property(checkName(""), "error");
    assert.property(checkName("   "), "error");
    assert.property(checkName(42), "error");
    assert.property(checkName("n".repeat(MAX_NAME + 1)), "error");
    assert.deepEqual(checkName(` ${"n".repeat(MAX_NAME)} `), { name: "n".repeat(MAX_NAME) });
  });

  it("an agent config outside the deploy route's bounds is refused", () => {
    assert.notProperty(checkAgentConfig(agentBody()), "error");
    assert.property(checkAgentConfig(agentBody({ model: "openai/o5" })), "error", "unknown model");
    assert.property(checkAgentConfig(agentBody({ tools: ["solana.slot", "not.a.tool"] })), "error", "unknown tool");
    assert.property(
      checkAgentConfig(agentBody({ tools: new Array(MAX_TOOLS + 1).fill("solana.slot") })),
      "error",
      "over the tool cap"
    );
    assert.property(checkAgentConfig(agentBody({ budgetCapUsdc: "0.10" })), "error", "under the allowance floor");
    assert.property(checkAgentConfig(agentBody({ budgetCapUsdc: "1.0000001" })), "error", "beyond USDC precision");
    assert.property(checkAgentConfig(agentBody({ budgetCapUsdc: "lots" })), "error", "not a number");
    assert.property(checkAgentConfig(agentBody({ expirationDays: 0 })), "error", "expires immediately");
    assert.property(checkAgentConfig(agentBody({ expirationDays: 1.5 })), "error", "not whole days");
    // Nothing here coerces: a boolean, a numeric string or a one-element array is not a number.
    for (const expirationDays of [true, "7", " 7 ", [7]] as unknown[]) {
      assert.property(
        checkAgentConfig(agentBody({ expirationDays } as any)),
        "error",
        `coerced ${JSON.stringify(expirationDays)}`
      );
    }
    assert.property(checkClonedFrom({ id: "tpl-" + "0".repeat(16), version: "1" }), "error", "a string version");
    assert.property(checkAgentConfig(agentBody({ expirationDays: 100_000 })), "error", "past the hundred-year grant");
    assert.property(checkAgentConfig(agentBody({ prompt: "p".repeat(2001) })), "error", "prompt over the cap");
    assert.property(checkAgentConfig("nope"), "error", "not an object");
  });

  it("lists only what a policy is offered when it refuses a tool, and still accepts the retired names", () => {
    // A refusal that printed every accepted name as "the runtime ships …" would put the
    // retired `hire` and the `lattice.verify_chain` alias on screen as things to pick.
    const refused = checkConfig("agent", agentBody({ tools: ["typo"] })) as { error: string };
    assert.include(refused.error, "unknown tools: typo");
    assert.include(refused.error, "web.search");
    assert.include(refused.error, "lath.verify_chain");
    assert.notMatch(refused.error, /hire|lattice\./);
    // Acceptance is unchanged: stored policies name both, and their `policy_version_hash` commits
    // to the names, so clones, `useVersion` and old templates have to keep validating.
    assert.notProperty(checkConfig("agent", agentBody({ tools: ["hire"] })), "error");
    assert.notProperty(checkConfig("agent", agentBody({ tools: ["lattice.verify_chain"] })), "error");
  });

  it("an agent config is stored as written, with an absent prompt absent", () => {
    const checked = checkAgentConfig(agentBody({ prompt: "  watch the slot  " })) as { config: AgentTemplateConfig };
    assert.equal(checked.config.prompt, "watch the slot");
    const none = checkAgentConfig(agentBody({ prompt: "   " })) as { config: AgentTemplateConfig };
    assert.notProperty(none.config, "prompt", "an empty prompt is an absent key, so the hash is unchanged");
    assert.equal(templateHash(none.config), templateHash((checkAgentConfig(agentBody()) as any).config));
  });

  it("a loop config outside checkLoopRequest's bounds is refused", () => {
    assert.notProperty(checkLoopConfig(loopBody()), "error");
    assert.property(checkLoopConfig(loopBody({ prompt: "short" })), "error", "under the instruction floor");
    // The floor is `checkLoopRequest`'s, which is 10. A nine-character prompt that could be stored
    // would describe a run that is permanently unstartable — the bound has to be the run's.
    assert.property(checkLoopConfig(loopBody({ prompt: "do a thing".slice(0, 9) })), "error", "nine characters");
    assert.notProperty(checkLoopConfig(loopBody({ prompt: "do a thing" })), "error", "ten is the floor");
    assert.property(checkLoopConfig(loopBody({ intervalMs: 1000 })), "error", "faster than the interval floor");
    assert.property(checkLoopConfig(loopBody({ intervalMs: 25 * 60 * 60_000 })), "error", "over a day");
    assert.property(checkLoopConfig(loopBody({ maxSteps: 0 })), "error", "no steps");
    assert.property(checkLoopConfig(loopBody({ maxSteps: 4900 })), "error", "over the step ceiling");
    assert.property(checkLoopConfig(loopBody({ budgetMicroUsdcPerStep: "0" })), "error", "no budget");
    assert.property(checkLoopConfig(loopBody({ budgetMicroUsdcPerStep: "9000000" })), "error", "over the session cap");
    assert.property(checkLoopConfig(loopBody({ budgetMicroUsdcPerStep: "1.5" })), "error", "not micro-USDC");
    assert.property(checkLoopConfig(loopBody({ model: "openai/o5" })), "error", "unknown model");
    assert.property(checkLoopConfig(loopBody({ coordinator: {} })), "error", "no coordinator");
  });

  it("a loop config keeps an optional model absent", () => {
    const checked = checkLoopConfig(loopBody({ model: undefined })) as { config: LoopTemplateConfig };
    assert.notProperty(checked.config, "model");
  });

  it("a member slot is refused until teams exist, and an empty one still stores []", () => {
    // The runner has no member phase, so a stored slot would market a team and launch one
    // agent. Absent and `[]` keep storing `[]`, or every stored template would move hash.
    const refused = checkLoopConfig(loopBody({ members: [{ ref: { agentId: "cc".repeat(32) }, mode: "owned" }] })) as {
      error: string;
    };
    assert.equal(refused.error, "Teams are not built yet; a loop runs one agent. Leave `members` empty.");
    const empty = checkLoopConfig(loopBody({ members: [] })) as { config: LoopTemplateConfig };
    const absent = checkLoopConfig(loopBody({ members: undefined })) as { config: LoopTemplateConfig };
    assert.deepEqual(empty.config.members, []);
    assert.equal(templateHash(empty.config), templateHash(absent.config));
  });

  it("an agent reference names exactly one of the three shapes", () => {
    assert.deepEqual(checkAgentRef({ agentId: "DD".repeat(32) }, "ref"), { ref: { agentId: "dd".repeat(32) } });
    assert.deepEqual(checkAgentRef({ template: "tpl-0123456789abcdef", version: 2 }, "ref"), {
      ref: { template: "tpl-0123456789abcdef", version: 2 },
    });
    assert.property(checkAgentRef({ agentId: "dd" }, "ref"), "error", "not 32 bytes");
    assert.property(checkAgentRef({ template: "researcher" }, "ref"), "error", "not a template id");
    // `count` only ever cloned a template into member slots, and there are none.
    assert.property(
      checkAgentRef({ template: "tpl-0123456789abcdef", count: 3 }, "ref"),
      "error",
      "clones fill member slots, which are not built"
    );
    assert.property(checkAgentRef({ agentId: "dd".repeat(32), offer: "offer-1" }, "ref"), "error", "two shapes");
    assert.property(checkAgentRef({}, "ref"), "error", "no shape");
  });

  it("clonedFrom is optional and has to be a version reference", () => {
    assert.deepEqual(checkClonedFrom(undefined), {});
    assert.deepEqual(checkClonedFrom({ id: "tpl-0123456789abcdef", version: 2 }), {
      clonedFrom: { id: "tpl-0123456789abcdef", version: 2 },
    });
    assert.property(checkClonedFrom({ id: "tpl-0123456789abcdef" }), "error", "no version");
    assert.property(checkClonedFrom({ id: "researcher", version: 1 }), "error", "not a template id");
  });
});

/**
 * `templateHash(checkLoopConfig(loopBody()).config)`, computed before `validate.ts` read `gate`. A
 * loop template that names no gate must keep this hash, or every run started from one written
 * before gates loses its template link.
 */
const PRE_GATE_LOOP_HASH = "c14c2bdd0ef03ab7509964828705e7ef0279eadc3d8c028a43d1f2e6e4b2ba7a";

/**
 * A validated config's hash without the loop budget: `checkLoopConfig` stores the whole budget
 * beside the per-step figure, a key older versions do not carry — stored versions keep their
 * bytes, since nothing re-validates them — so the pins
 * above hold for every *other* byte, and the budget is checked on its own.
 */
function preBudgetHash(config: LoopTemplateConfig): string {
  const { budgetMicroUsdc: _budget, ...rest } = config;
  return templateHash(rest as LoopTemplateConfig);
}

describe("a gated loop template", () => {
  beforeEach(clearStore);

  const watch = [{ kind: "store", keys: ["price", "news"] }];
  const gate = {
    model: "typesafe/jev-1.13",
    barBps: 5_700,
    watch,
    failMode: "closed",
    heartbeatMs: 24 * 60 * 60_000,
  };

  it("a POST or a PUT carrying a gate is refused, never stored without it, and a refused PUT stores nothing", () => {
    // Gated loops are not in this build: a version that stored one would be a version whose
    // *Run again* `checkLoopRequest` refuses, and dropping the key instead would store terms the
    // owner did not write.
    for (const asked of [gate, { watch }, { watch: [] }, "on"]) {
      const refused = checkLoopConfig(loopBody({ gate: asked })) as { error?: string };
      assert.match(refused.error ?? "", /^gated loops are not in this build: leave out gate/, JSON.stringify(asked));
    }
    assert.property(post(OWNER, { kind: "loop", name: "watcher", config: loopBody({ gate }) }), "error");
    const v1 = post(OWNER, { kind: "loop", name: "watcher", config: loopBody() }) as Template;
    assert.property(put(OWNER, { id: v1.id, config: loopBody({ gate }) }), "error");
    assert.equal(lookupTemplate(v1.id)?.version, 1);
  });

  it("a template without a gate stores no key and hashes as it did before gates", () => {
    const absent = checkLoopConfig(loopBody()) as { config: LoopTemplateConfig };
    const nulled = checkLoopConfig(loopBody({ gate: null })) as { config: LoopTemplateConfig };
    assert.notProperty(absent.config, "gate");
    assert.notProperty(nulled.config, "gate");
    // Pinned from before `gate` was read here: `loopBody()`'s config hash has not moved.
    assert.equal(preBudgetHash(absent.config), PRE_GATE_LOOP_HASH);
    assert.equal(preBudgetHash(nulled.config), PRE_GATE_LOOP_HASH);
    assert.equal(absent.config.budgetMicroUsdc, nulled.config.budgetMicroUsdc);
  });
});

describe("a loop template with a sandbox", () => {
  beforeEach(clearStore);

  const sandbox = {
    tools: { chain: false },
    maxFiles: 250,
    sources: [{ kind: "url" as const, url: "https://docs.example.org/spec.md" }],
  };

  it("a PUT carries the sandbox byte for byte, so the version hashes as the one it was PUT from", () => {
    const v1 = post(OWNER, { kind: "loop", name: "reader", config: loopBody({ sandbox }) }) as Template;
    assert.deepEqual((v1.config as LoopTemplateConfig).sandbox, sandbox, "POST stores the sandbox");
    // What would have dropped it: `checkLoopConfig` returning a config without `sandbox`, so a PUT of
    // the stored config stored version 2 with none and _Run again_ from it opened the host's sandbox.
    const v2 = put(OWNER, { id: v1.id, config: v1.config }) as Template;
    assert.equal(v2.version, 2);
    assert.deepEqual((v2.config as LoopTemplateConfig).sandbox, sandbox);
    assert.equal(v2.hash, v1.hash, "the same sandbox is the same bytes");
  });

  it("a sandbox of only the host's defaults stores no key and hashes as it did before sandboxes", () => {
    for (const defaults of [undefined, null, {}, { tools: { chain: true } }, { sources: [] }, { maxFiles: 1000 }]) {
      const checked = checkLoopConfig(loopBody({ sandbox: defaults })) as { config: LoopTemplateConfig };
      assert.notProperty(checked.config, "sandbox", JSON.stringify(defaults));
      assert.equal(preBudgetHash(checked.config), PRE_GATE_LOOP_HASH, JSON.stringify(defaults));
    }
  });

  it("a bad sandbox is refused with the start body's sentence, and a refused PUT stores nothing", () => {
    const refused = (r: unknown) => (checkLoopConfig(loopBody({ sandbox: r })) as { error: string }).error;
    assert.match(refused({ maxBytes: 9 * 1024 * 1024 }), /never raise it/);
    assert.match(refused({ network: true }), /sandbox has no network/);
    const v1 = post(OWNER, { kind: "loop", name: "reader", config: loopBody({ sandbox }) }) as Template;
    assert.property(put(OWNER, { id: v1.id, config: loopBody({ sandbox: { tools: { files: false } } }) }), "error");
    assert.equal(lookupTemplate(v1.id)?.version, 1);
  });
});

/**
 * The read side: `GET /api/templates` answers with the stored versions as they are. Privacy is a
 * roadmap item, and a reader who is not the owner gets the same bytes the owner does — the
 * texts, the sources as typed and the `hash` they are addressed by.
 */
describe("template reads, the same for every reader", () => {
  beforeEach(clearStore);

  const PROMPT = "PROMPT-the-owner-typed";
  const GOAL = "GOAL-the-owner-typed";
  const SYSTEM = "SYSTEM-PROMPT-of-a-member";
  const SCRATCH = "SCRATCH-POLICY-PROMPT";
  const TASK = "RETIRED-MEMBER-TASK";
  const TYPED = "https://example.com/OWNER-TYPED-SOURCE";

  function loopTemplate(): Template {
    const config = {
      ...loopBody({ prompt: PROMPT }),
      goal: GOAL,
      members: [{ ref: { agentId: "bb".repeat(32) }, mode: "owned", task: TASK }],
      sandbox: { tools: { chain: true }, sources: [{ kind: "url", url: TYPED }] },
      workers: {
        scratch: { policy: { prompt: SCRATCH, tools: ["solana.slot"] }, count: 2 },
        model: "m",
        budgetMicroUsdcPerTask: "1000",
        slots: [{ name: "a", model: "m", policy: { systemPrompt: SYSTEM, tools: ["solana.slot"] } }, { model: "m" }],
      },
    } as unknown as LoopTemplateConfig;
    return recordTemplate({ kind: "loop", owner: OWNER, name: "watch", config });
  }

  const get = async (query: string) =>
    (await (await templatesGET({ nextUrl: new URL(`http://console.test/api/templates${query}`) } as any)).json()) as {
      template?: Template;
      templates?: (Template & { versions: unknown })[];
    };

  it("answers a loop template by id exactly as stored, texts included", async () => {
    const t = loopTemplate();
    const { template } = await get(`?id=${t.id}`);
    assert.deepEqual(template, JSON.parse(JSON.stringify(t)));
    assert.notProperty(template!, "ownerView");
    const json = JSON.stringify(template);
    for (const text of [PROMPT, GOAL, SYSTEM, SCRATCH, TASK, TYPED]) assert.include(json, text);
  });

  it("lists an agent template with its prompt, whoever asks", async () => {
    const t = recordTemplate({
      kind: "agent",
      owner: OWNER,
      name: "researcher",
      config: agentBody({ prompt: PROMPT }) as AgentTemplateConfig,
    });
    for (const query of ["", `?owner=${OWNER}`]) {
      const listed = (await get(query)).templates!.find((x) => x.id === t.id)!;
      assert.equal((listed.config as AgentTemplateConfig).prompt, PROMPT, query || "no owner");
      assert.equal(listed.hash, t.hash);
    }
  });
});

describe("a loop template's budget", () => {
  it("stores the whole budget and the derived per-step figure, from either shape", () => {
    const whole = checkLoopConfig(loopBody({ budgetMicroUsdc: "1000000", budgetMicroUsdcPerStep: undefined })) as {
      config: LoopTemplateConfig;
    };
    assert.equal(whole.config.budgetMicroUsdc, "1000000");
    assert.equal(whole.config.budgetMicroUsdcPerStep, "333333", "floor(budget / maxSteps)");
    // An older client sends the per-step budget; the version stores what it implies.
    const old = checkLoopConfig(loopBody()) as { config: LoopTemplateConfig };
    assert.equal(old.config.budgetMicroUsdc, "150000");
    assert.equal(old.config.budgetMicroUsdcPerStep, "50000");
  });

  it("refuses rather than clamps: a template is bytes with a hash", () => {
    const refused = (over: Record<string, unknown>) => (checkLoopConfig(loopBody(over)) as { error?: string }).error;
    assert.include(refused({ budgetMicroUsdc: String(LOOP_BUDGET_MAX_MICRO + 1n) }), "must not exceed");
    assert.include(refused({ budgetMicroUsdc: "2" }), "at least one micro-USDC per step");
    assert.include(refused({ budgetMicroUsdc: "1.5" }), "integer number of micro-USDC");
    assert.include(refused({ budgetMicroUsdcPerStep: "0" }), "must be positive");
    // The session cap does not bound a loop's step.
    assert.notProperty(checkLoopConfig(loopBody({ budgetMicroUsdcPerStep: "400000" })), "error");
  });

  it("reads an old team's per-task budget into the loop budget, and refuses to store a team", () => {
    // A blueprint source, as an older stored version holds it: its per-task figure is part of the
    // budget its terms bounded the run to — what `budgetFromPerStep` reads an old row, body or
    // version as. A write that asks for a team is refused, whatever it names.
    const workers = {
      blueprint: { templateId: "tpl-0123456789abcdef", count: 1 },
      model: "deepseek/deepseek-v4.1-flash",
      budgetMicroUsdcPerTask: "1000",
    };
    assert.equal(budgetFromPerStep(50_000n, 3, workers), BigInt((50_000 + 1_000) * 3));
    assert.deepEqual(checkLoopConfig(loopBody({ workers })), { error: TEAM_REFUSAL });
    const { budgetMicroUsdcPerTask: _none, ...fresh } = workers;
    assert.deepEqual(checkLoopConfig(loopBody({ workers: fresh, budgetMicroUsdc: "300000" })), { error: TEAM_REFUSAL });
  });
});

/**
 * What bounds the store. A `"Lath template"` signature needs only a fresh keypair, and a fresh
 * keypair is a fresh per-wallet bucket, so a per-wallet quota alone bounds nothing: 5 000 writes
 * from 5 000 minted wallets would be 5 000 writes, 0 refused.
 * Two things close it: a server-wide bucket every signed write charges before its wallet's, and a
 * cap on template ids one wallet may own. Both are functions in `_lib/templates.ts` so this file
 * can exercise them without `next/server`; `route.ts` calls them in the order `POST` does — the
 * cap, then the charge.
 *
 * The rate-limit map is process-wide, so the keys these cases stamp are removed after
 * each, or a later suite in the same process would start with a server bucket already spent.
 */
describe("what bounds the template store", () => {
  const limits = () => (globalThis as any)[Symbol.for("lath.rateLimits")] as Map<string, number[]>;
  const stamps = (key: string) => limits().get(key)?.length ?? 0;
  const fresh = () => `W${Math.random().toString(36).slice(2)}${"1".repeat(32)}`.slice(0, 44);

  beforeEach(clearStore);
  afterEach(() => {
    for (const key of [...limits().keys()])
      if (key === "templates:server" || key.startsWith("template:W")) limits().delete(key);
  });

  it("charges a server-wide bucket before the wallet's, so fresh wallets share one ceiling", () => {
    assert.isBelow(
      TEMPLATE_WRITES_PER_HOUR,
      TEMPLATE_WRITES_PER_HOUR_SERVER,
      "a wallet's quota is inside the server's"
    );
    for (let i = 0; i < TEMPLATE_WRITES_PER_HOUR_SERVER; i++) {
      assert.isNull(chargeTemplateWrite(fresh(), "local"), `write ${i + 1} from its own fresh wallet`);
    }
    assert.equal(stamps("templates:server"), TEMPLATE_WRITES_PER_HOUR_SERVER);
    const late = fresh();
    const refused = chargeTemplateWrite(late, "local");
    assert.isString(refused);
    assert.include(refused!, "template writes on this server");
    // Asked before anything is stamped: the refused wallet has spent nothing of its own, and the
    // server's bucket did not grow for a write that did not land.
    assert.equal(stamps(`template:${late}:local`), 0);
    assert.equal(stamps("templates:server"), TEMPLATE_WRITES_PER_HOUR_SERVER);
  });

  it("a wallet at its own quota is refused without spending the server's", () => {
    const wallet = fresh();
    for (let i = 0; i < TEMPLATE_WRITES_PER_HOUR; i++) assert.isNull(chargeTemplateWrite(wallet, "local"));
    const before = stamps("templates:server");
    const refused = chargeTemplateWrite(wallet, "local");
    assert.include(refused!, `${TEMPLATE_WRITES_PER_HOUR} template writes per hour`);
    assert.notInclude(refused!, "on this server");
    assert.equal(stamps("templates:server"), before, "the server's bucket was asked, not stamped");
    // Another wallet is still served: the per-wallet refusal is that wallet's alone.
    assert.isNull(chargeTemplateWrite(fresh(), "local"));
  });

  it("caps the template ids one wallet owns, archived ones included, and counts no versions", () => {
    const config = (checkConfig("agent", agentBody()) as { config: AgentTemplateConfig }).config;
    const owned: Template[] = [];
    for (let i = 0; i < TEMPLATES_PER_OWNER; i++) {
      assert.isNull(templateCapRefusal(OWNER), `id ${i + 1} may still be minted`);
      owned.push(recordTemplate({ kind: "agent", owner: OWNER, name: `cap-${i}`, config }));
    }
    const refused = templateCapRefusal(OWNER);
    assert.include(refused!, `already has ${TEMPLATES_PER_OWNER} templates`);
    // Archiving frees nothing: an archive is a free write, and the versions stay in the file.
    archiveTemplate(owned[0].id);
    assert.isString(templateCapRefusal(OWNER));
    // Versions are not ids: a PUT appends and is still allowed, which is what the refusal advises.
    const appended = recordTemplate({ id: owned[1].id, kind: "agent", owner: OWNER, name: "cap-1", config });
    assert.equal(appended.version, 2);
    assert.lengthOf(Object.keys(ownedTemplates(OWNER)), TEMPLATES_PER_OWNER - 1, "the list after one archive");
    // Another wallet's count is its own.
    assert.isNull(templateCapRefusal(OTHER));
  });
});

/**
 * A template write needs a size bound. The coordinator is stored as written, so one signed write
 * of a five-megabyte `{ offer }` would be a five-megabyte `templates.json` — which every anonymous
 * `GET /api/templates`, deploy and loop start reads and parses whole. An offer is an id, and a
 * config is held to `MAX_CONFIG_CHARS` of the
 * bytes it would store, for the fields that have no cap of their own.
 */
describe("a template write is bounded in size", () => {
  beforeEach(clearStore);
  const stored = () => fs.existsSync(path.join(traceDir, "templates.json"));

  it("takes an offer reference that is an id, and refuses one that is a document", () => {
    assert.deepEqual(checkAgentRef({ offer: "ab".repeat(32) }, "ref"), { ref: { offer: "ab".repeat(32) } });
    assert.deepEqual(checkAgentRef({ offer: "  offer-1  " }, "ref"), { ref: { offer: "offer-1" } }, "trimmed");
    assert.deepEqual(checkAgentRef({ offer: "x".repeat(128) }, "ref"), { ref: { offer: "x".repeat(128) } });
    for (const offer of ["x".repeat(129), "x".repeat(5_000_000), "has space", "<script>", "a/b"]) {
      const refused = checkAgentRef({ offer }, "coordinator");
      assert.match((refused as { error: string }).error, /coordinator\.offer must be a listing id/, offer.slice(0, 20));
    }
  });

  it("refuses the finding's write: a loop whose coordinator is a five-megabyte offer stores nothing", () => {
    const written = post(OWNER, {
      kind: "loop",
      name: "filler",
      config: loopBody({ coordinator: { offer: "x".repeat(5_000_000) } }),
    });
    assert.match((written as { error: string }).error, /coordinator\.offer must be a listing id/);
    assert.isFalse(stored(), "templates.json was written for a refused config");
  });

  it("refuses a config past the bound through a field with no cap of its own, on POST and on PUT", () => {
    // A source's URL has no length: it passes its own check and only the size bound stops it. (A
    // team's tools, which could repeat a known name, were the other such field; a team is refused now.)
    const heavy = [
      loopBody({ sandbox: { sources: [{ kind: "url", url: `https://example.com/${"p".repeat(40_000)}` }] } }),
      loopBody({ sandbox: { sources: [{ kind: "url", url: `https://example.com/${"q".repeat(40_000)}` }] } }),
    ];
    for (const config of heavy) {
      const refused = checkConfig("loop", config);
      assert.match((refused as { error: string }).error, /config is too large to store/);
      assert.include((refused as { error: string }).error, `${MAX_CONFIG_CHARS} at most`);
    }
    assert.property(post(OWNER, { kind: "loop", name: "heavy", config: heavy[0] }), "error");
    assert.isFalse(stored());
    const v1 = post(OWNER, { kind: "loop", name: "light", config: loopBody() }) as Template;
    assert.property(put(OWNER, { id: v1.id, config: heavy[1] }), "error");
    assert.lengthOf(Object.values(ownedTemplates(OWNER)), 1);
    assert.equal(lookupTemplate(v1.id)!.version, 1, "a refused PUT appended a version");
  });

  it("takes a config with every capped text field at its cap, and it is well inside the bound", () => {
    const at = (n: number, c: string) => c.repeat(n);
    const config = loopBody({
      prompt: at(2000, "p"),
      goal: at(2000, "g"),
      sandbox: {
        sources: Array.from({ length: 8 }, (_, i) => ({
          kind: "url",
          url: `https://example.com/${i}/${at(200, "u")}`,
        })),
      },
    });
    const checked = checkConfig("loop", config) as { config: LoopTemplateConfig };
    assert.notProperty(checked, "error", (checked as unknown as { error?: string }).error);
    const size = canonicalJson(checked.config).length;
    assert.isBelow(size, MAX_CONFIG_CHARS * 0.6, "the bound would refuse an ordinary full config");
    assert.equal((post(OWNER, { kind: "loop", name: "full", config }) as Template).version, 1);
  });
});
