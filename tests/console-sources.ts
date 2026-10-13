/**
 * `sourceToDraft` (`frontend/src/lib/sources.ts`), over the four things the *Start from* step can
 * start from and the two it refuses.
 *
 * Node-only by construction: `sources.ts` imports React, its own pure sibling `shelf.ts` and
 * nothing else at runtime, so the rule is checkable here with no browser, no RPC and no
 * validator — the same reason `tests/tile-rows.ts` can import `lib/tiles.ts`.
 *
 * What is being pinned is the rules, not the field copying: a deployed name is an id and cannot
 * be reused, a template keeps its own name, a prompt is copied only from a row this wallet owns,
 * lineage points at the template a deploy will append a version to, and a blueprint is launched
 * rather than drafted.
 */
import { assert } from "chai";
import {
  BuilderSource,
  SourceAgentRow,
  SourceLoopRow,
  SourceRefused,
  SourceTemplateRow,
  sourceToDraft,
} from "../frontend/src/lib/sources";
import { loopFormKey } from "../frontend/src/lib/loop-form-key";
import { MAX_GOAL_TEXT, goalFieldFrom, loopGoalTerms, sendsGoal } from "../frontend/src/lib/loop-goal-field";
import { LOOP_PRESETS } from "../frontend/src/lib/loop-presets";

const WALLET = "Ghs6xWa11etOwnerBase58";
const STRANGER = "5d5DsSomeoneElseBase58";

/** An agent deployed before templates existed: the registry kept its policy and nothing else. */
const preTemplate: SourceAgentRow = {
  id: "a1".repeat(16),
  name: "slot-watcher",
  owner: WALLET,
  description: "Watches the slot and says when it stalls.",
  policy: {
    model: "deepseek/deepseek-v4.1-flash",
    tools: ["chain.read", "http.get"],
    budgetCapUsdc: "10.00",
    expirationDays: 30,
  },
};

/** Version 3 of an agent template — the shape `GET /api/templates?owner=` returns. */
const templateV3: SourceTemplateRow = {
  id: "tpl-0f1e2d3c4b5a6978",
  kind: "agent",
  owner: WALLET,
  name: "fee-reporter",
  version: 3,
  versions: 3,
  config: {
    prompt: "  Report the fee market once an hour.  ",
    model: "anthropic/claude-haiku-4",
    tools: ["chain.read"],
    budgetCapUsdc: "2.50",
    expirationDays: 7,
  },
};

const loopRecord: SourceLoopRow = {
  id: "loop-77aabb",
  agentId: "b2".repeat(16),
  agentName: "chain-auditor",
  owner: WALLET,
  prompt: "Audit the last hour of records.",
  intervalMs: 300_000,
  maxSteps: 24,
  budgetMicroUsdcPerStep: "25000",
  model: "anthropic/claude-haiku-4",
  template: { id: "tpl-loop-aabbccdd", version: 2 },
  status: "stopped",
  steps: 24,
};

/**
 * The same run with a judge, stored with a team — the shape `GET /api/loops` returns for one
 * (`publicLoop`): `verify` filled, and the team named in `earlierBuild` rather than projected,
 * since teams are not in this build.
 */
const judgedTeamRun: SourceLoopRow = {
  ...loopRecord,
  id: "loop-d55225bd1b7de628",
  verify: { model: "x-ai/grok-4-fast", minConfidence: 0.2 },
  earlierBuild: ["team"],
};

const loopTemplate: SourceTemplateRow = {
  id: "tpl-loop-aabbccdd",
  kind: "loop",
  owner: WALLET,
  name: "balance-monitor",
  version: 4,
  config: {
    prompt: "Report the treasury balance.",
    intervalMs: 3_600_000,
    maxSteps: 12,
    budgetMicroUsdcPerStep: "40000",
    model: "deepseek/deepseek-v4.1-flash",
    coordinator: { agentId: "c3".repeat(16) },
  },
};

/** What a refusal looks like from the outside: the class, and the reason it carries. */
function refusal(source: BuilderSource): SourceRefused {
  try {
    sourceToDraft(source);
  } catch (err) {
    assert.instanceOf(err, SourceRefused, "a refused source throws SourceRefused");
    return err as SourceRefused;
  }
  throw new Error("expected the source to be refused");
}

describe("console builder sources", () => {
  describe("sourceToDraft", () => {
    it("synthesises a pre-template agent from its policy, and suffixes the name", () => {
      const draft = sourceToDraft({ kind: "agent", wallet: WALLET, row: preTemplate });

      // The name is the id (`agent_id = sha256(name)`), so the wizard has to open on another one.
      assert.equal(draft.name, "slot-watcher-2");
      assert.equal(draft.model, "deepseek/deepseek-v4.1-flash");
      assert.deepEqual(draft.tools, ["chain.read", "http.get"]);
      assert.equal(draft.budgetCapUsdc, "10.00");
      assert.equal(draft.expirationDays, 30);
      assert.equal(draft.description, "Watches the slot and says when it stalls.");
      // Nothing to copy: the prompt lives in a template, and this row predates them.
      assert.isUndefined(draft.prompt);
      assert.deepEqual(draft.lineage, { kind: "agent", sourceId: preTemplate.id, sourceName: "slot-watcher" });
    });

    it("copies the tools rather than the source's array", () => {
      const draft = sourceToDraft({ kind: "agent", wallet: WALLET, row: preTemplate });
      draft.tools!.push("evil.tool");
      assert.deepEqual(preTemplate.policy!.tools, ["chain.read", "http.get"]);
    });

    it("reads the agent's template version when the row links one", () => {
      const linked: SourceAgentRow = {
        ...preTemplate,
        name: "fee-reporter-run",
        template: { id: templateV3.id, version: 2 },
      };
      const draft = sourceToDraft({ kind: "agent", wallet: WALLET, row: linked, template: templateV3 });

      assert.equal(draft.prompt, "Report the fee market once an hour.");
      assert.equal(draft.model, "anthropic/claude-haiku-4");
      // The run used v2; the picker offers the latest, which is what a deploy appends v4 to.
      assert.deepEqual(draft.lineage, {
        kind: "agent",
        sourceId: linked.id,
        sourceName: "fee-reporter-run",
        templateId: templateV3.id,
        version: 3,
      });
    });

    it("opens a template v3 under its own name, with its config and its lineage", () => {
      const draft = sourceToDraft({ kind: "template", wallet: WALLET, row: templateV3 });

      // A template's name is the first agent's, not an id, so it is offered as written.
      assert.equal(draft.name, "fee-reporter");
      assert.equal(draft.prompt, "Report the fee market once an hour.");
      assert.equal(draft.budgetCapUsdc, "2.50");
      assert.equal(draft.expirationDays, 7);
      assert.isUndefined(draft.loop);
      assert.deepEqual(draft.lineage, {
        kind: "template",
        sourceId: templateV3.id,
        sourceName: "fee-reporter",
        templateId: templateV3.id,
        version: 3,
      });
    });

    it("runs a loop again on the agent that ran it, with its terms", () => {
      const draft = sourceToDraft({ kind: "loop", wallet: WALLET, row: loopRecord, template: loopTemplate });

      assert.deepEqual(draft.loop, {
        prompt: "Audit the last hour of records.",
        intervalMs: 300_000,
        maxSteps: 24,
        budgetMicroUsdcPerStep: "25000",
        agentId: loopRecord.agentId,
        agentName: "chain-auditor",
      });
      // A run that asked for no judge and ran with no roadmap feature leaves **no key** for either,
      // rather than `verify: null` or an empty list: the draft is byte-identical to a draft with
      // neither (the absent-when-off rule). `deepEqual` above already says so; these say why it
      // matters, in the words the failure would use.
      assert.notProperty(draft.loop!, "verify", "an unjudged run's draft has no verify key");
      assert.notProperty(draft.loop!, "earlierBuild", "a run with no roadmap feature names nothing");
      // The standing instruction is the loop's, and never the agent's system prompt.
      assert.isUndefined(draft.prompt);
      assert.deepEqual(draft.lineage, {
        kind: "loop",
        sourceId: loopRecord.id,
        sourceName: "chain-auditor",
        templateId: loopTemplate.id,
        version: 4,
      });
    });

    it("keeps the judge and names the team when a judged team run is run again", () => {
      const draft = sourceToDraft({ kind: "loop", wallet: WALLET, row: judgedTeamRun, template: loopTemplate });

      // *Run again with edits* of a judged run must not come out with `verify: null`, or the second
      // run would not be the same run and nothing would say so.
      assert.deepEqual(draft.loop!.verify, { model: "x-ai/grok-4-fast", minConfidence: 0.2 });
      // The team is named for the form's one line and never carried: a start carrying it is refused.
      assert.deepEqual(draft.loop!.earlierBuild, ["team"]);
      assert.notProperty(draft.loop!, "workers");
      // And the rest of the terms still come through unchanged.
      assert.equal(draft.loop!.prompt, "Audit the last hour of records.");
      assert.equal(draft.loop!.agentId, loopRecord.agentId);
    });

    it("names a gated run's gate and carries none of its terms", () => {
      const gatedRun = {
        ...loopRecord,
        id: "loop-6a7e0000c0ffee00",
        trigger: { kind: "gate", pollMs: 60_000 },
        earlierBuild: ["gate"],
      } as unknown as SourceLoopRow;
      const draft = sourceToDraft({ kind: "loop", wallet: WALLET, row: gatedRun, template: loopTemplate });
      assert.deepEqual(draft.loop!.earlierBuild, ["gate"]);
      assert.notProperty(draft.loop!, "gate");
      // A view that carries the gate's terms and no `earlierBuild` (an older console's): the
      // row's own keys name it the same way.
      const older = { ...gatedRun, earlierBuild: undefined, gate: { watch: [] } } as unknown as SourceLoopRow;
      assert.deepEqual(sourceToDraft({ kind: "loop", wallet: WALLET, row: older }).loop!.earlierBuild, ["gate"]);
      // And an ungated run's draft still has no key, so its bytes match the drafts written before gates.
      assert.notProperty(sourceToDraft({ kind: "loop", wallet: WALLET, row: loopRecord }).loop!, "earlierBuild");
    });

    it("names a loop template's stored team and trace audit, and carries its judge", () => {
      const fromBlueprint: SourceTemplateRow = {
        ...loopTemplate,
        config: {
          ...loopTemplate.config,
          verify: { model: "x-ai/grok-4-fast", minConfidence: 0.35 },
          workers: { blueprint: { offerId: "d4".repeat(32), count: 2 }, model: "deepseek/deepseek-v4.1-flash" },
          traceAudit: { model: "typesafe/jev-1.13", behaviours: { unsafe_funds: { bar: 0.5, onPresent: "stop" } } },
        },
      };
      const draft = sourceToDraft({ kind: "loop-template", wallet: WALLET, row: fromBlueprint });
      assert.deepEqual(draft.loop!.earlierBuild, ["team", "trace-audit"]);
      assert.notProperty(draft.loop!, "workers");
      assert.notProperty(draft.loop!, "traceAudit");
      assert.deepEqual(draft.loop!.verify, { model: "x-ai/grok-4-fast", minConfidence: 0.35 });
    });

    it("reads a run that asked for no judge as no key, not as null", () => {
      // `publicLoop` sends `verify: null` on purpose, so the browser has a value to read; a draft
      // that kept it would start the second run unjudged while claiming to carry the terms.
      const unjudged: SourceLoopRow = { ...judgedTeamRun, verify: null, earlierBuild: undefined };
      const draft = sourceToDraft({ kind: "loop", wallet: WALLET, row: unjudged, template: loopTemplate });
      assert.notProperty(draft.loop!, "verify");
      assert.notProperty(draft.loop!, "earlierBuild");
    });

    it("opens a loop template on its coordinator's terms", () => {
      const draft = sourceToDraft({ kind: "loop-template", wallet: WALLET, row: loopTemplate });

      assert.equal(draft.name, "balance-monitor");
      assert.equal(draft.model, "deepseek/deepseek-v4.1-flash");
      assert.deepEqual(draft.loop, {
        prompt: "Report the treasury balance.",
        intervalMs: 3_600_000,
        maxSteps: 12,
        budgetMicroUsdcPerStep: "40000",
        agentId: "c3".repeat(16),
      });
      assert.deepEqual(draft.lineage, {
        kind: "loop-template",
        sourceId: loopTemplate.id,
        sourceName: "balance-monitor",
        templateId: loopTemplate.id,
        version: 4,
      });
    });

    it("leaves the coordinator unset when a loop template names none", () => {
      const byTemplate: SourceTemplateRow = {
        ...loopTemplate,
        config: { ...loopTemplate.config, coordinator: { template: "tpl-other", count: 2 } },
      };
      const draft = sourceToDraft({ kind: "loop-template", wallet: WALLET, row: byTemplate });
      assert.isUndefined(draft.loop!.agentId, "no agent is not the empty agent");
    });
  });

  describe("refusals", () => {
    it("refuses another wallet's agent: only the wallet's own rows are a starting point", () => {
      const foreign = refusal({ kind: "agent", wallet: WALLET, row: { ...preTemplate, owner: STRANGER } });
      assert.equal(foreign.reason, "foreign");
      assert.include(foreign.message, "another wallet");
    });

    it("refuses another wallet's template and loop too", () => {
      assert.equal(
        refusal({ kind: "template", wallet: WALLET, row: { ...templateV3, owner: STRANGER } }).reason,
        "foreign"
      );
      assert.equal(
        refusal({ kind: "loop", wallet: WALLET, row: { ...loopRecord, owner: STRANGER } }).reason,
        "foreign"
      );
    });

    it("refuses a row with no owner at all, rather than reading it as this wallet's", () => {
      assert.equal(
        refusal({ kind: "agent", wallet: WALLET, row: { ...preTemplate, owner: undefined } }).reason,
        "foreign"
      );
    });

    it("refuses an archived agent, template and loop", () => {
      const at = 1_780_000_000_000;
      assert.equal(
        refusal({ kind: "agent", wallet: WALLET, row: { ...preTemplate, archivedAt: at } }).reason,
        "archived"
      );
      assert.equal(
        refusal({ kind: "template", wallet: WALLET, row: { ...templateV3, archivedAt: at } }).reason,
        "archived"
      );
      assert.equal(
        refusal({ kind: "loop-template", wallet: WALLET, row: { ...loopTemplate, archivedAt: at } }).reason,
        "archived"
      );
      assert.equal(
        refusal({ kind: "loop", wallet: WALLET, row: { ...loopRecord, archivedAt: at } }).reason,
        "archived"
      );
    });
  });
});

/**
 * The loop form is remounted on every pick, not on every new template.
 *
 * `LoopStartForm` reads its terms once, in `useState` initialisers. A remount key of the agent and
 * the picked source's template id and version is not enough: two picks on one agent can share
 * those — two runs of one lineage both link to the picker's latest template row, and a run with no
 * link keys like the blank form — and the second pick would leave the first one's terms on screen
 * (and in the start body), with only the model taken from the new pick. The key counts picks.
 */
describe("the loop form's key", () => {
  // Two runs of one lineage on one agent: one started from v1, one from an edited v3, while the
  // picker's latest row of that template is v4.
  const fromV1: SourceLoopRow = { ...loopRecord, id: "loop-v1", template: { id: loopTemplate.id, version: 1 } };
  const fromV3: SourceLoopRow = {
    ...loopRecord,
    id: "loop-v3",
    prompt: "Audit the last day of records.",
    intervalMs: 3_600_000,
    template: { id: loopTemplate.id, version: 3 },
  };

  it("two runs of one lineage carry different terms under the same template id and version", () => {
    const one = sourceToDraft({ kind: "loop", wallet: WALLET, row: fromV1, template: loopTemplate });
    const three = sourceToDraft({ kind: "loop", wallet: WALLET, row: fromV3, template: loopTemplate });
    assert.equal(one.loop!.agentId, three.loop!.agentId, "the same agent runs both");
    // What the old key was built from: identical for both picks, so the form did not remount.
    const named = (d: typeof one) => [d.lineage.kind, (d.lineage as any).templateId, (d.lineage as any).version];
    assert.deepEqual(named(one), named(three));
    assert.notEqual(one.loop!.prompt, three.loop!.prompt, "while the terms the form shows differ");
    // Counted per pick, the second pick is a fresh mount.
    assert.notEqual(loopFormKey(one.loop!.agentId!, 1), loopFormKey(three.loop!.agentId!, 2));
  });

  it("a run with no template link is a new mount after the blank form, and blank after it is too", () => {
    const unlinked = sourceToDraft({ kind: "loop", wallet: WALLET, row: { ...loopRecord, template: undefined } });
    // Nothing in its lineage tells it apart from the blank form's, which is what the old key read.
    assert.isUndefined((unlinked.lineage as any).templateId);
    const agent = unlinked.loop!.agentId!;
    const keys = [loopFormKey(agent, 0), loopFormKey(agent, 1), loopFormKey(agent, 2)];
    assert.equal(new Set(keys).size, keys.length, "blank, then the run, then blank again: three mounts");
  });

  it("keeps the form mounted across a re-render with no pick, and remounts on another agent", () => {
    const agent = loopRecord.agentId;
    // A registry refetch re-renders `LoopEntry` without a pick: the same key keeps what was typed.
    assert.equal(loopFormKey(agent, 3), loopFormKey(agent, 3));
    // The select still remounts the form on a different agent, as it always did.
    assert.notEqual(loopFormKey(agent, 3), loopFormKey("c3".repeat(16), 3));
  });
});

/**
 * The loop form's one Goal field: the form shows one text for what a run stores as an _Objective_
 * (`prompt`) and a _Goal_ (`goal`), and sends it as both keys by one rule (`lib/loop-goal-field.ts`).
 * Pinned here because a *Run again* of a row with two different texts is where the two meet the one.
 */
describe("the loop form's one Goal field", () => {
  const GOAL = "A one-page report on the treasury, cited. Done when every account is listed.";

  it("opens a goal loop's Run again on its goal, and folds a prompt that differs into it, prompt first", () => {
    const goalRun: SourceLoopRow = { ...loopRecord, goal: GOAL, goalCheck: { model: "m", minConfidence: 0.5 } };
    const draft = sourceToDraft({ kind: "loop", wallet: WALLET, row: goalRun }).loop!;
    // The old run carried both texts, and they differ: both are on screen, and the form says so.
    assert.deepEqual(goalFieldFrom(draft), { text: `${loopRecord.prompt}\n\n${GOAL}`, folded: true });
    // A run the merged form started (one text as both) reopens as that one text, with nothing to say.
    const merged: SourceLoopRow = { ...goalRun, prompt: `  ${GOAL} ` };
    const again = sourceToDraft({ kind: "loop", wallet: WALLET, row: merged }).loop!;
    assert.deepEqual(goalFieldFrom(again), { text: GOAL, folded: false });
  });

  it("opens a run with no goal on its instruction, and a preset on its goal", () => {
    const plain = sourceToDraft({ kind: "loop", wallet: WALLET, row: loopRecord }).loop!;
    assert.deepEqual(goalFieldFrom(plain), { text: loopRecord.prompt, folded: false });
    assert.deepEqual(goalFieldFrom({ goal: GOAL }), { text: GOAL, folded: false });
    assert.deepEqual(goalFieldFrom(undefined), { text: "", folded: false });
  });

  it("sends the text as the instruction always, and as the goal with the check or the agent's own stop", () => {
    // The check on: one text, judged by Jev against exactly what the agent works from.
    assert.deepEqual(loopGoalTerms(` ${GOAL} `, true, false), { prompt: GOAL, goal: GOAL, goalCheck: true });
    // The check off, the agent's own stop on: the goal loop that stops on GOAL REACHED, unchecked.
    assert.deepEqual(loopGoalTerms(GOAL, false, true), { prompt: GOAL, goal: GOAL });
    // Both off: the instruction-only loop, with no goal key at all.
    assert.deepEqual(loopGoalTerms(GOAL, false, false), { prompt: GOAL });
    // The hidden switch does not matter while the check is on.
    assert.deepEqual(loopGoalTerms(GOAL, true, true), { prompt: GOAL, goal: GOAL, goalCheck: true });
    // No text, no goal, whatever the switches say: the route would refuse the instruction anyway.
    assert.deepEqual(loopGoalTerms("   ", true, true), { prompt: "" });
    assert.isFalse(sendsGoal("   ", true, false));
  });

  it("keeps every preset one text, inside the route's caps, with its method in the open", () => {
    for (const preset of Object.values(LOOP_PRESETS)) {
      // One text: no hidden instruction rides on a preset's start.
      assert.isUndefined(preset.loop.prompt, `${preset.id} carries no separate prompt`);
      const text = preset.loop.goal ?? "";
      assert.isAtLeast(text.trim().length, 10, `${preset.id}: the route's instruction floor`);
      assert.isAtMost(text.length, MAX_GOAL_TEXT, `${preset.id}: the route's 2000-character cap`);
    }
    const audit = LOOP_PRESETS["protocol-audit"];
    // The method is in the Goal itself, after the question: a note of four named parts written one part
    // a step, with the note carried in the step's memory rather than looked for on disk.
    // The question a signer asks opens the Goal, so it is what the form shows first; the note answers it.
    assert.match(audit.loop.goal, /^Before I approve a Squads transaction: [^?]+\? /);
    // Four plain sentences a reader takes in at a glance: the question, the parts, the step, the bar.
    assert.isAtMost(audit.loop.goal!.split(/(?<=[.?])\s+/).length, 4);
    assert.include(audit.loop.goal, "Answer in four parts, one per step");
    assert.include(audit.loop.goal, "add the next part to the note you remember");
    // The note's first line answers the question, and the whole note rides in the answer, which is what
    // the next step remembers, and in report/note.md, which the step publishes to Tempo storage.
    assert.include(
      audit.loop.goal,
      "open it with no heading, just the answer to the whole question in one or two sentences"
    );
    assert.include(audit.loop.goal, "cite a file under sources/ for every claim");
    assert.include(audit.loop.goal, "put the whole note in your answer and in report/note.md");
    assert.include(audit.loop.goal, "Done when all four parts are there.");
    assert.notMatch(audit.loop.goal ?? "", /two-page|both pages/);
    assert.deepEqual([audit.loop.intervalMs, audit.loop.maxSteps, audit.receipt], [10_000, 6, true]);
    // The narrowest tree that still lets the note be cited (the instructions folder, 23 files at af94153),
    // then the program on Solana devnet.
    assert.deepEqual(audit.sandbox.sources, [
      {
        kind: "github",
        url: "https://github.com/Squads-Protocol/v4/tree/main/programs/squads_multisig_program/src/instructions",
      },
      { kind: "solana", cluster: "devnet", address: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf" },
    ]);
    // The audit is the one preset this build offers.
    assert.deepEqual(Object.keys(LOOP_PRESETS), ["protocol-audit"]);
  });
});
