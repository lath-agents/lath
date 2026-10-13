import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  AgentTemplateConfig,
  LoopTemplateConfig,
  Template,
  appendOrMint,
  archiveTemplate,
  implicitTemplate,
  lookupTemplate,
  ownedTemplates,
  readTemplates,
  recordTemplate,
  templateForAppend,
  templateHash,
  templateLink,
  templateVersions,
} from "../frontend/src/app/api/_lib/templates";
import { checkLoopConfig } from "../frontend/src/app/api/templates/validate";
import { TEAM_REFUSAL } from "../frontend/src/app/api/_lib/loops";

/**
 * The template registry: what a version is, what its hash commits to,
 * and what a run links to. Pure file I/O against a throwaway `LATH_TRACE_DIR` — no chain, no
 * validator — because the registry is off-chain by construction: the chain never referenced a
 * template, only the hashes of what a session committed.
 *
 * `templates.ts` reads `TRACE_DIR` from `runner.ts`, which captures it at module evaluation, so
 * `./fixtures/trace-dir` is imported first: it makes the directory and sets the variable before
 * anything that reads it is loaded.
 */

const OWNER = "So11111111111111111111111111111111111111112";
const OTHER = "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy";

const agentConfig: AgentTemplateConfig = {
  model: "deepseek/deepseek-v4.1-flash",
  tools: ["solana.slot", "solana.fees"],
  budgetCapUsdc: "1.00",
  expirationDays: 14,
};

const loopConfig: LoopTemplateConfig = {
  prompt: "check the slot and report",
  intervalMs: 15_000,
  maxSteps: 3,
  budgetMicroUsdcPerStep: "50000",
  model: "deepseek/deepseek-v4.1-flash",
  coordinator: { agentId: "aa".repeat(32) },
  members: [],
};

/** Each case starts from an empty store: the file is the whole state. */
function clearStore(): void {
  fs.rmSync(path.join(traceDir, "templates.json"), { force: true });
}

describe("template registry", () => {
  beforeEach(clearStore);

  it("a write round-trips, and the hash re-derives from the stored config", () => {
    const written = recordTemplate({ kind: "agent", owner: OWNER, name: "researcher", config: agentConfig });
    assert.match(written.id, /^tpl-[0-9a-f]{16}$/);
    assert.equal(written.version, 1);

    const stored = lookupTemplate(written.id);
    assert.isNotNull(stored);
    assert.deepEqual(stored!.config, agentConfig);
    assert.equal(templateHash(stored!.config), stored!.hash);
    // The link a run keeps is the three fields, and nothing about the owner or the clock.
    assert.deepEqual(templateLink(stored!), { id: written.id, version: 1, hash: written.hash });
  });

  it("the hash is the content, not the key order the object happened to have", () => {
    // `templateHash(stored.config) === stored.hash` above re-derives the expected value with the
    // function under test, so it holds for *any* hash function — including `JSON.stringify`, which
    // is key-order dependent. That matters: the content address is what `implicitTemplate` dedupes
    // on and what "a clone is lineage, not a new configuration" compares, and a store round trip
    // or one added optional field is enough to reorder keys. So: two objects equal as values, and
    // one literal pinning the canonical form itself, derived by hand from `canonicalJson`'s rule
    // (sort keys, drop undefined) rather than from this function.
    const reordered = {
      expirationDays: 14,
      budgetCapUsdc: "1.00",
      tools: ["solana.slot", "solana.fees"],
      model: "deepseek/deepseek-v4.1-flash",
    } as AgentTemplateConfig;
    assert.equal(
      templateHash(reordered),
      templateHash(agentConfig),
      "canonicalJson sorts keys; JSON.stringify does not"
    );
    assert.equal(templateHash(agentConfig), "30db606d5e11911034332aab31452cf71bbf98c55f04ba91e8be72d8fa8daa07");
    // And the other half of the rule: an absent key and an explicitly-undefined one are one config.
    assert.equal(templateHash({ ...agentConfig, prompt: undefined }), templateHash(agentConfig));
  });

  it("a second write of the same config appends a version with the same hash", () => {
    const v1 = recordTemplate({ kind: "agent", owner: OWNER, name: "researcher", config: agentConfig });
    const v2 = recordTemplate({ id: v1.id, kind: "agent", owner: OWNER, name: "researcher", config: agentConfig });

    assert.equal(v2.id, v1.id);
    assert.equal(v2.version, 2);
    assert.equal(v2.hash, v1.hash);
    assert.deepEqual(
      readTemplates()[v1.id].map((t) => t.version),
      [1, 2]
    );
    // v1 is what a run started before the edit points at, so the write must not have touched it.
    assert.deepEqual(lookupTemplate(v1.id, 1)!.config, agentConfig);
  });

  it("an edited config is a new version with a new hash; both versions resolve", () => {
    const v1 = recordTemplate({ kind: "agent", owner: OWNER, name: "researcher", config: agentConfig });
    const edited: AgentTemplateConfig = { ...agentConfig, budgetCapUsdc: "2.50" };
    const v2 = recordTemplate({ id: v1.id, kind: "agent", owner: OWNER, name: "researcher", config: edited });

    assert.notEqual(v2.hash, v1.hash);
    assert.equal(lookupTemplate(v1.id, 1)!.hash, v1.hash);
    assert.equal(lookupTemplate(v1.id, 2)!.hash, v2.hash);
    // No version given is the latest, which is what the list and the wizard offer.
    assert.equal(lookupTemplate(v1.id)!.version, 2);
    assert.isNull(lookupTemplate(v1.id, 3));
    assert.isNull(lookupTemplate("tpl-0000000000000000"));
  });

  it("an id the prototype answers to is not a template", () => {
    for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      assert.isNull(lookupTemplate(id), id);
      assert.deepEqual(templateVersions(id), [], id);
      assert.isNull(archiveTemplate(id), id);
    }
  });

  it("archive hides every version from the list and leaves them readable by id", () => {
    const kept = recordTemplate({ kind: "agent", owner: OWNER, name: "kept", config: agentConfig });
    const gone = recordTemplate({ kind: "loop", owner: OWNER, name: "gone", config: loopConfig });
    recordTemplate({ id: gone.id, kind: "loop", owner: OWNER, name: "gone", config: loopConfig });

    assert.isNotNull(archiveTemplate(gone.id));
    assert.isNull(archiveTemplate("tpl-0000000000000000"));

    const listed = ownedTemplates(OWNER);
    assert.deepEqual(
      listed.map((t) => t.latest.id),
      [kept.id]
    );
    assert.deepEqual(
      readTemplates()[gone.id].map((t) => typeof t.archivedAt),
      ["number", "number"]
    );
    // A run that points at an archived version still resolves it: archiving is not deletion.
    assert.equal(lookupTemplate(gone.id, 1)!.hash, gone.hash);
  });

  it("a new version brings an archived id back, and the versions before it keep their stamp", () => {
    const put = recordTemplate({ kind: "agent", owner: OWNER, name: "put-away", config: agentConfig });
    archiveTemplate(put.id);
    assert.notInclude(
      ownedTemplates(OWNER).map((t) => t.latest.id),
      put.id
    );

    // What `POST /api/agents` tells the owner to do when it refuses a deploy from an archived
    // template. It is possible only because `archivedAt` is not carried onto a new version.
    const revived = recordTemplate({ id: put.id, kind: "agent", owner: OWNER, name: "put-away", config: agentConfig });
    assert.isUndefined(revived.archivedAt);
    assert.include(
      ownedTemplates(OWNER).map((t) => t.latest.id),
      put.id
    );
    assert.isNumber(lookupTemplate(put.id, 1)!.archivedAt, "the version that was archived still says so");
  });

  it("the list is per owner, latest version first, with a version count", () => {
    const mine = recordTemplate({ kind: "agent", owner: OWNER, name: "mine", config: agentConfig });
    recordTemplate({ id: mine.id, kind: "agent", owner: OWNER, name: "mine", config: { ...agentConfig, tools: [] } });
    recordTemplate({ kind: "agent", owner: OTHER, name: "theirs", config: agentConfig });

    const listed = ownedTemplates(OWNER);
    assert.deepEqual(
      listed.map((t) => [t.latest.id, t.latest.version, t.versions]),
      [[mine.id, 2, 2]]
    );
    // No owner is every non-archived template, as `GET /api/loops` lists every loop.
    assert.equal(ownedTemplates().length, 2);
  });

  it("a deploy and a loop start each produce a template whose hash re-derives", () => {
    // The two configs the routes build: the agent's validated policy (no prompt while the system
    // prompt is hardcoded) and the checked loop request with its coordinator.
    const agent = implicitTemplate({ kind: "agent", owner: OWNER, name: "researcher", config: agentConfig });
    const loop = implicitTemplate({ kind: "loop", owner: OWNER, name: "researcher-loop", config: loopConfig });

    for (const link of [templateLink(agent), templateLink(loop)]) {
      const stored = lookupTemplate(link.id, link.version);
      assert.isNotNull(stored);
      assert.equal(templateHash(stored!.config), link.hash);
    }
    assert.equal(agent.kind, "agent");
    assert.equal(loop.kind, "loop");

    // A second deploy of the same config links to the same template rather than writing a row.
    const again = implicitTemplate({ kind: "agent", owner: OWNER, name: "researcher-2", config: agentConfig });
    assert.deepEqual(templateLink(again), templateLink(agent));
    // A different wallet's identical config is its own template: the hash is content, not identity.
    const theirs = implicitTemplate({ kind: "agent", owner: OTHER, name: "researcher", config: agentConfig });
    assert.notEqual(theirs.id, agent.id);
    assert.equal(theirs.hash, agent.hash);
    assert.equal(Object.keys(readTemplates()).length, 3);
  });

  it("a prompt changes the hash, and no prompt hashes as an absent key", () => {
    const withPrompt = templateHash({ ...agentConfig, prompt: "watch the cluster" });
    assert.notEqual(withPrompt, templateHash(agentConfig));
    // `canonicalJson` drops `undefined`, so a config that carries no prompt hashes as one that
    // never had the key — what keeps implicit templates without a prompt stable.
    assert.equal(templateHash({ ...agentConfig, prompt: undefined }), templateHash(agentConfig));
  });

  it("appending an unchanged config writes nothing, and an edited one is v n+1 under the same id", () => {
    // Deploying from your own asset extends that
    // asset's template. What that must *not* do is write a version per deploy — a lineage whose
    // versions differ in no byte says nothing about what changed and when.
    const v1 = recordTemplate({ kind: "agent", owner: OWNER, name: "researcher", config: agentConfig });

    const same = appendOrMint(OWNER, v1.id, undefined, { ...agentConfig }, { kind: "agent", name: "researcher-2" });
    assert.deepInclude(same, { appended: false });
    assert.deepEqual(templateLink((same as { template: Template }).template), templateLink(v1));
    assert.equal(readTemplates()[v1.id].length, 1, "an unedited deploy is a run of the template, not a version of it");

    const edited = appendOrMint(
      OWNER,
      v1.id,
      undefined,
      { ...agentConfig, budgetCapUsdc: "2.50" },
      // The name of the agent being deployed, which an append must ignore: a template keeps the
      // name of the first agent deployed from it.
      { kind: "agent", name: "researcher-2" }
    );
    assert.deepInclude(edited, { appended: true });
    const v2 = (edited as { template: Template }).template;
    assert.equal(v2.id, v1.id, "one template, many versions");
    assert.equal(v2.version, 2);
    assert.equal(v2.name, "researcher", "an append never renames");
    assert.isUndefined(v2.clonedFrom, "an append is not a copy of anything");
    assert.equal(lookupTemplate(v1.id, 1)!.hash, v1.hash, "v1 is what the first agent still points at");

    // The version a caller named, not just the latest: the review step offers a version, and a
    // deploy from v1 after v2 exists is an append onto v1's terms, not onto v2's.
    const fromV1 = appendOrMint(OWNER, v1.id, 1, { ...agentConfig }, { kind: "agent", name: "researcher-3" });
    assert.deepInclude(fromV1, { appended: false });
    assert.equal((fromV1 as { template: Template }).template.version, 1);
  });

  it("appending to an archived template brings the id back, which is what its refusal advises", () => {
    const put = recordTemplate({ kind: "agent", owner: OWNER, name: "put-away", config: agentConfig });
    archiveTemplate(put.id);

    // Unchanged bytes, and still a write: there is no un-archive verb, so this version is the
    // whole of "write a new version to deploy from it".
    const back = appendOrMint(OWNER, put.id, undefined, { ...agentConfig }, { kind: "agent", name: "put-away-2" });
    assert.deepInclude(back, { appended: true });
    assert.isUndefined((back as { template: Template }).template.archivedAt);
    assert.include(
      ownedTemplates(OWNER).map((t) => t.latest.id),
      put.id
    );
    assert.isNumber(lookupTemplate(put.id, 1)!.archivedAt, "the version that was archived still says so");
  });

  it("fork mints a separate template carrying clonedFrom, and leaves the source where it was", () => {
    // The escape hatch exists and is opt-in. `implicitTemplate`'s dedupe would have
    // handed back the source itself here, which is the one answer a fork must never give.
    const v1 = recordTemplate({ kind: "agent", owner: OWNER, name: "researcher", config: agentConfig });
    const forked = appendOrMint(
      OWNER,
      v1.id,
      undefined,
      { ...agentConfig },
      { kind: "agent", name: "spun-off", fork: true }
    );
    assert.deepInclude(forked, { appended: false });
    const copy = (forked as { template: Template }).template;

    assert.notEqual(copy.id, v1.id, "a fork is its own lineage");
    assert.equal(copy.version, 1);
    assert.equal(copy.name, "spun-off", "a fork takes the name of the agent that started it");
    assert.deepEqual(copy.clonedFrom, { id: v1.id, version: 1 });
    assert.equal(copy.hash, v1.hash, "same bytes, different lineage: the hash is content, not identity");
    assert.equal(readTemplates()[v1.id].length, 1, "the source is untouched");
  });

  it("refuses a template that is not the caller's, is not there, or is the other kind", () => {
    // Another wallet's asset never reaches the builder by having its
    // id named. The statuses are what the routes answer with, unchanged.
    const mine = recordTemplate({ kind: "agent", owner: OWNER, name: "mine", config: agentConfig });
    const loop = recordTemplate({ kind: "loop", owner: OWNER, name: "mine-loop", config: loopConfig });

    assert.deepInclude(templateForAppend(OTHER, mine.id, undefined, "agent"), { status: 403 });
    assert.deepInclude(templateForAppend(OWNER, "tpl-0000000000000000", undefined, "agent"), { status: 404 });
    assert.deepInclude(templateForAppend(OWNER, mine.id, 7, "agent"), { status: 404 });
    assert.deepInclude(templateForAppend(OWNER, mine.id, 0, "agent"), { status: 400 });
    assert.deepInclude(templateForAppend(OWNER, loop.id, undefined, "agent"), { status: 400 });

    // And the refusal is the whole answer: nothing is written on the way to giving it.
    assert.deepInclude(
      appendOrMint(OTHER, mine.id, undefined, { ...agentConfig, tools: [] }, { kind: "agent", name: "theirs" }),
      { status: 403 }
    );
    assert.equal(readTemplates()[mine.id].length, 1);

    // No template named at all is the implicit write every run has always had.
    const implicit = appendOrMint(OWNER, undefined, undefined, agentConfig, { kind: "agent", name: "blank" });
    assert.deepInclude(implicit, { appended: false });
    assert.deepEqual(templateLink((implicit as { template: Template }).template), templateLink(mine));
  });

  it("a version that is not a readable record is dropped, not cast", () => {
    fs.writeFileSync(
      path.join(traceDir, "templates.json"),
      JSON.stringify({
        "tpl-000000000000000a": [{ id: "tpl-000000000000000a", kind: "agent", owner: OWNER, name: "half" }],
        "tpl-000000000000000b": [
          {
            id: "tpl-000000000000000b",
            kind: "agent",
            owner: OWNER,
            name: "whole",
            version: 1,
            hash: templateHash(agentConfig),
            createdAt: 1,
            config: agentConfig,
          },
        ],
      })
    );
    assert.deepEqual(Object.keys(readTemplates()), ["tpl-000000000000000b"]);
  });
});

/**
 * Teams, the template half.
 *
 * What is under test is the one rule that keeps every loop template already on disk verifiable:
 * `workers` is normalised to **absent** before the hash is taken, so a version stored before
 * teams existed, one written with no team, and one written with `workers: undefined` are the
 * same bytes and the same content address. A stored version written with a team keeps
 * its bytes and its hash; a write that asks for one is refused (`checkWorkersRequest`).
 */
describe("template registry: a loop version with a team", () => {
  beforeEach(clearStore);

  const terms = { model: "deepseek/deepseek-v4.1-flash", budgetMicroUsdcPerTask: "20000" };
  const team = { agentIds: ["cc".repeat(32)], ...terms };

  it("hashes a version with no team exactly as one whose team is undefined", () => {
    const withoutKey = templateHash(loopConfig);
    const undefinedKey = templateHash({ ...loopConfig, workers: undefined });
    assert.equal(undefinedKey, withoutKey, "canonicalJson drops undefined, so the key is not there");

    const withTeam = templateHash({ ...loopConfig, workers: team });
    assert.notEqual(withTeam, withoutKey, "a team is in the hash: it is a term of the run");
  });

  it("links a second teamless start to the version the first one minted", () => {
    // The reuse an implicit write depends on: two ad-hoc starts of the same teamless loop are one
    // lineage, and a `workers` key that was written as `undefined` must not split them in two.
    const first = implicitTemplate({ kind: "loop", owner: OWNER, name: "watcher-loop", config: loopConfig });
    const second = implicitTemplate({
      kind: "loop",
      owner: OWNER,
      name: "watcher-loop",
      config: { ...loopConfig, workers: undefined },
    });
    assert.equal(second.id, first.id);
    assert.equal(second.version, 1, "nothing was appended: the bytes are the same bytes");
  });

  it("appends a version when a team is added, and re-reads it as written", () => {
    const v1 = recordTemplate({ kind: "loop", owner: OWNER, name: "watcher-loop", config: loopConfig });
    const v2 = appendOrMint(
      OWNER,
      v1.id,
      undefined,
      { ...loopConfig, workers: team },
      {
        kind: "loop",
        name: "watcher-loop",
      }
    );
    assert.deepInclude(v2, { appended: true });
    const stored = lookupTemplate(v1.id, 2)!;
    assert.deepEqual((stored.config as LoopTemplateConfig).workers, team);
    assert.equal(stored.hash, templateHash({ ...loopConfig, workers: team }));
  });

  it("refuses a version that stores a team, whatever its terms, and still refuses the retired members array", () => {
    // The validator is the same function the start path is checked by, so a team a run would be
    // refused is a version a `PUT` refuses — read and refused rather than dropped, because a key it
    // neither reads nor returns is a key a `PUT` silently drops. This build starts no team,
    // so a version that stored one would be a template nobody can start.
    const slots = [{ model: "moonshotai/kimi-k3", policy: { systemPrompt: "Find the sources.", tools: [] } }, {}];
    const scratch = { scratch: { policy: { prompt: "read one source" }, count: 2 } };
    for (const workers of [
      { ...scratch, ...terms },
      { ...scratch, ...terms, slots, synthesize: true },
      { ...scratch, ...terms, slots: [], synthesize: false },
      team,
    ]) {
      assert.deepEqual(checkLoopConfig({ ...loopConfig, workers }), { error: TEAM_REFUSAL });
    }
    // No team is no team: the version stores no key, and hashes as one stored before teams existed.
    const none = checkLoopConfig({ ...loopConfig, workers: null }) as { config: LoopTemplateConfig };
    assert.notProperty(none.config, "workers");

    // The `members` slot shape is a different thing and stays refused: nothing
    // downstream would run it, and teams are `workers`.
    assert.deepEqual(
      checkLoopConfig({ ...loopConfig, members: [{ ref: { agentId: "cc".repeat(32) }, mode: "owned" }] }),
      { error: "Teams are not built yet; a loop runs one agent. Leave `members` empty." }
    );
  });
});
