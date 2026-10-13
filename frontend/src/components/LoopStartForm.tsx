"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowIcon, Button, ErrorNote, Field, Note } from "@/components/ui";
import {
  DEFAULT_MIN_CONFIDENCE,
  LOOP_FORM_INTERVALS,
  LOOP_BUDGETS,
  LOOP_PROMPT_MIN,
  LOOP_MAX_STEPS_DEFAULT,
  clampSteps,
  LoopCostLine,
  LoopGoalCheckToggle,
  LoopSelfStopToggle,
  LoopTermChips,
  LoopTreasuryShortfall,
  budgetMicroOf,
  loopBudgetOptions,
  loopStepOptions,
} from "@/components/loop-terms";
import { useTempoTreasury } from "@/lib/tempo";
import {
  SandboxField,
  agentHasStore,
  sandboxFromConfig,
  sandboxProblem,
  sandboxRequest,
} from "@/components/SandboxField";
import { useLoopPreset } from "@/lib/loop-presets";
import { PluginsField, usePluginsConsole } from "@/components/PluginsField";
import { receiptOffered, receiptPointerOf } from "@/lib/plugins-view";
import { presetPluginPicks, presetPluginsOn, receiptPicked } from "@/lib/plugin-catalog";
import { SCHEDULE_FAST_MS, pollOptions } from "@/lib/loop-trigger";
import { LoopView, StartLoopRequest, loopKeys, useLoops, useStartLoop } from "@/lib/loops";
import { draftLoopBudget, type DraftLoop } from "@/lib/draft";
import { earlierBuildStartSentence } from "@/types/loop";
import { MAX_GOAL_TEXT, goalFieldFrom, loopGoalTerms, sendsGoal } from "@/lib/loop-goal-field";
import { explainError } from "@/lib/writes";
import { loopStartStageLabel, type LoopStartStage } from "@/lib/loop-start-stream";
import { IrysMark } from "@/components/Tempo";

/*
 * No `GOAL_DEFAULT_PROMPT`: the one Goal field is the instruction (`lib/loop-goal-field.ts`), so every
 * start names its own `prompt`, and the server's default plan line applies only to an API client that
 * sends a goal alone.
 */

/**
 * The four terms of a loop — its Goal, interval, number of steps, the loop's budget — and the
 * signature that starts it, for an agent that already exists.
 *
 * The Goal is one field. The start body carries two keys, the standing instruction (`prompt`) and the
 * goal (`goal`), filled from the one text by the rule in `lib/loop-goal-field.ts` — always the
 * instruction, and the goal too when _Jev checks the goal_ is on — so the route, the policy and every
 * hash read both keys.
 *
 * The one place a loop begins: `/create` deploys an agent and nothing else, and a loop is started
 * here — on the agent's own page, or at `/create?loop=1&agent=<id>` — over an agent that already
 * exists, with its own `"Lath loop"` signature. One running loop per agent: when the wallet already
 * has one on this agent, the form gives way to a link to it.
 *
 * `initial` and `template` are what the builder's *Start from* step hands it: the terms of a run or of
 * a loop template, filled in and still editable — *run again with edits* is the point, so nothing
 * prefilled here is read-only but a carried GitHub, URL or Solana source, which the form can remove
 * and does not add — and the template those terms came from, which the start carries so the run stays
 * on that lineage instead of minting a fresh implicit template.
 */
/** What the form hands the wizard's _Agent loop_ step: the start's body when it is complete, else why not. */
export interface LoopTerms {
  request: StartLoopRequest | null;
  problem: string | null;
}

export function LoopStartForm({
  agentId,
  agentName,
  model,
  agentTools,
  initial: picked,
  template,
  lineageName,
  onStarted,
  onTerms,
}: {
  agentId: string;
  agentName: string;
  model?: string;
  /**
   * The tools the agent's deployed policy names, when the caller holds its row. Only the sandbox's
   * store switch reads it: the box starts as the agent has the store, and a switch that would
   * widen the policy is refused before the signature rather than by the route after it.
   */
  agentTools?: readonly string[];
  /** Terms to open with, from the loop or loop template this run starts from — its goal included. */
  initial?: DraftLoop;
  /** The loop template those terms came from; sent with the start so the run stays on its lineage. */
  template?: { id: string; version?: number };
  /** What to call that template on screen — the ‹name› in *appends v‹n+1› to ‹name›*. */
  lineageName?: string;
  /**
   * Where a started run goes when the caller has a place to show it — the agent page's card keeps it
   * in the card. Without one (_Deploy loop_, `/create?loop=1`), the loop's own page is that place and
   * the form goes there on success, rather than stopping on a link to it.
   */
  onStarted?: (loop: LoopView) => void;
  /**
   * The wizard's _Agent loop_ step: the terms only, for a deploy that
   * carries them, so the agent and its loop go out in the one transaction the deploy signs. The form
   * then has no Start and asks for nothing, and leaves out the two terms a deploy's loop cannot carry
   * (`POST /api/agents` refuses both): the sandbox's files, fetched at start, and the receipt.
   */
  onTerms?: (terms: LoopTerms) => void;
}) {
  const termsMode = !!onTerms;
  const { publicKey, signMessage } = useWallet();
  const router = useRouter();
  const owner = publicKey?.toBase58() ?? null;
  const loops = useLoops(owner);
  const queryClient = useQueryClient();
  // The stage the server says the start is in: the fetch and the Irys pin are the minute a
  // start with sources takes, and a bare spinner through it read as a hang. `null` until the first
  // stage arrives — which is also while the wallet is asked to sign.
  const [stage, setStage] = useState<LoopStartStage | null>(null);
  const start = useStartLoop(publicKey ?? null, signMessage, setStage);
  // A `?preset=` link's terms (`lib/loop-presets.ts`), used only when no run or template was picked:
  // a pick is the person's own choice made after the link was followed, and `LoopEntry` remounts
  // this form with it, so the pick wins and the preset is what the page opened on before it.
  const preset = useLoopPreset();
  const presetUsed = !picked && preset ? preset : null;
  const initial = picked ?? presetUsed?.loop;

  // Prefilled from the source when there is one, and the defaults otherwise. `useState`'s
  // initialiser rather than an effect: the caller remounts this form with a `key` when the pick
  // changes, so no later render can walk over what the user has since typed.
  // The one Goal field (`lib/loop-goal-field.ts`): a source's goal, else its instruction, and both
  // folded into one text — the instruction first, said in a line above the field — when a run or
  // template carried two that differ, so nothing it ran with leaves the screen unseen.
  const carried = goalFieldFrom(initial);
  const [text, setText] = useState(carried.text);
  // The Goal box grows with its text: measured, not guessed. A
  // row count from eighty characters a line left half the box empty on a wide screen under a preset's
  // paragraph, and too short on a narrow one; the box's own scroll height is right at any width.
  // Three rows stay the minimum (`rows`), and a resize of the window re-measures, since the wrap moves.
  // After every render rather than on `text` alone: the box can mount later than the text (the note
  // that stands in for the form while a loop runs gives way to it), and one measure is cheap.
  const goalRef = useRef<HTMLTextAreaElement>(null);
  useIsoLayoutEffect(() => {
    const el = goalRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      // A box measured before it is laid out (in a hidden subtree) reads 0, and pinned at 0 px it would
      // be a Goal field with no box until something re-rendered it. Left at `auto` it keeps its three rows.
      if (!el.scrollHeight) return;
      // The border is outside `scrollHeight`; without it the last line sits under a 1 px scroll.
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });
  // _Jev checks the goal_: on by default whenever there is text, so a fresh form and a preset open
  // with it pressed. A picked run or template opens where it left it, by the rule below that the terms
  // on screen are the terms signed — a source that ran without the check comes back without it.
  const carriedCheck = picked ? picked.goalCheck === true : true;
  // _The agent says when it is done_: on only for a picked source that had a goal and no check — the
  // goal loop its agent's own `GOAL REACHED` stopped — so a *Run again* of one is still that loop. A
  // source with no goal opens with both off, which is the instruction-only loop it was.
  const carriedSelfStop = !!picked?.goal?.trim() && picked.goalCheck !== true;
  const [goalCheckOn, setGoalCheckOn] = useState(carriedCheck);
  const [selfStop, setSelfStop] = useState(carriedSelfStop);
  const carriedGoal = sendsGoal(carried.text, carriedCheck, carriedSelfStop) ? carried.text : "";
  // Every loop the form starts is on the clock (there is no trigger picker), so a source's interval
  // snaps against the schedule's chips, 10 s included — a gated source's interval, which was its poll,
  // among them. A source that opens as a goal loop
  // and has no interval of its own opens on the shortest pause, the one a goal is given when typed.
  const [intervalMs, setIntervalMs] = useState(() =>
    snap(
      initial?.intervalMs,
      pollOptions(LOOP_FORM_INTERVALS).map((i) => i.ms),
      carriedGoal ? SCHEDULE_FAST_MS : 5 * 60_000
    )
  );
  // The interval the form had before the field went out as a goal, so turning that off gives it back
  // rather than leaving a loop with no goal on the goal loop's 10 s pause.
  const [preGoalIntervalMs, setPreGoalIntervalMs] = useState<number | null>(null);
  // Any whole count (the steps field takes a number besides the chips), so a carried
  // count is kept as it was rather than snapped to a chip; the bound is applied below.
  const [maxSteps, setMaxSteps] = useState(() =>
    initial?.maxSteps && Number.isFinite(initial.maxSteps) && initial.maxSteps >= 1 ? Math.floor(initial.maxSteps) : 6
  );
  // The loop's one budget. A source that carries only a per-step figure is read by
  // `draftLoopBudget` as `perStep × maxSteps` — the most that loop could have spent — before it is
  // snapped to a chip.
  const [budgetUsdc, setBudgetUsdc] = useState(() => snapBudget(draftLoopBudget(initial)));
  // A carried term starts where the source left it, not at off. `initial` is this wallet's own run
  // or template (`lib/sources.ts` refuses anyone else's), every carried term is on screen before the
  // signature, and resetting one in silence would turn a *Run again* into a different run with
  // nothing saying so. The terms a run commits in its policy hash are the terms on screen when it is
  // signed.
  // Every step is verified: it runs by default, with no toggle. The bar is a carried run's or
  // template's own, else the default 0.5; Lath pays for the answers.
  const verifyOn = true;
  const minConfidence = String(initial?.verify?.minConfidence ?? DEFAULT_MIN_CONFIDENCE);
  // What the source ran with that this build does not have — a team, a gate, the trace audit, an
  // oracle trigger, grants (`DraftLoop.earlierBuild`). The form sends none of them, and the rule above
  // — the terms on screen are the terms signed — is why that is said on screen, in one line, rather
  // than dropped in silence. A *Run again* that would carry one is refused by the server.
  const droppedFrom = template ? "This template" : presetUsed ? "This preset" : "This run";
  const earlier = earlierBuildStartSentence(droppedFrom, initial?.earlierBuild);
  const hasStore = agentHasStore(agentTools);
  // Opened on the picked run's or template's sandbox when it had one (`lib/sources.ts`
  // `sandboxTerms`): a *Run again* whose sandboxes lost their sources would read from memory what the
  // first run read from files. A preset's sandbox when nothing was picked; off otherwise, and off is
  // what sends no `sandbox` key.
  const [sandbox, setSandbox] = useState(() => sandboxFromConfig(picked?.sandbox ?? presetUsed?.sandbox, hasStore));
  /*
   * No trigger on the form: every start is a schedule loop — a body with no `trigger` key, which is
   * what the server reads as the clock. The request and feed triggers and the gate are on the roadmap,
   * and a gated source is started on the clock with a line saying so (above).
   */
  // `goal` is the text when it is sent as the goal and empty otherwise, so every rule below reads it
  // as a goal and nothing else. A goal loop steps until Jev answers `achieved`, or with the check off
  // until a step says so, and the interval is the pause between its steps.
  const goal = sendsGoal(text, goalCheckOn, selfStop) ? text : "";
  const goalLoop = goal.trim().length > 0;
  const [started, setStarted] = useState<LoopView | null>(null);
  // Protocol plugins: offered only on a console that reports them on, and sent only while switched on,
  // so every other start carries no `receipt` key and hashes its policy as a start without plugins
  // does; no start carries `grants`, which are on the roadmap. Switched on by hand with nothing picked,
  // the section picks SAS · receipt (`PluginsField`), the one plugin it lists.
  const pluginsConsole = usePluginsConsole();
  const pluginsOffered = !termsMode && pluginsConsole.data?.protocolPlugins === "on";
  const attestDemo = pluginsConsole.data?.attestDemo ?? null;
  // A preset with a receipt (the goal preset) opens switched on with SAS · receipt picked — but only
  // on a console that offers the receipt, plugins on and a schema to publish under. Anywhere else it opens off,
  // nothing picked and nothing sent, with no line about a receipt the loop was never going to get. Read
  // from the cached answer when there is one, so the section does not open in one state and flip; the
  // effect below applies a later answer.
  const receiptOnOffer = receiptOffered(pluginsConsole.data);
  const [pluginsOn, setPluginsOn] = useState(() => presetPluginsOn(presetUsed, { receipt: receiptOnOffer }));
  const [pluginPicks, setPluginPicks] = useState<string[]>(() =>
    presetPluginPicks(presetUsed, { receipt: receiptOnOffer })
  );
  // Once, when the answer arrives after the first render: the preset's receipt picked if this console
  // offers it. Nothing the owner did can be walked over, because the section is not on screen until that
  // same answer says plugins are on; and once only, so a refetch never re-picks what the owner unpicked.
  const receiptApplied = useRef(receiptOnOffer || pluginsConsole.isSuccess);
  useEffect(() => {
    if (receiptApplied.current || !pluginsConsole.isSuccess) return;
    receiptApplied.current = true;
    if (!receiptOnOffer || !presetUsed?.receipt) return;
    setPluginPicks(presetPluginPicks(presetUsed, { receipt: true }));
    setPluginsOn(presetPluginsOn(presetUsed, { receipt: true }));
  }, [pluginsConsole.isSuccess, receiptOnOffer, presetUsed]);
  // The treasury read the shortfall hint beside Start is made from (`LoopTreasuryShortfall`).
  const treasury = useTempoTreasury();

  // A read that rejected is not "this agent has no loop". Collapsing the two let the form render,
  // take an instruction, and spend a `"Lath loop"` signature on a refusal it had the
  // information to predict — one running loop per agent.
  const loopsUnread = loops.isError;
  // The chips the _Step Interval_ row offers: a schedule loop's, which gain a 10 s chip unless the
  // route's interval floor is above it.
  const limits = loops.data?.limits;
  const intervals = pollOptions(LOOP_FORM_INTERVALS, limits?.minIntervalMs ?? 0);
  const intervalOptions = intervals.map((i) => i.ms);
  // The interval as shown and sent, snapped to the chips on screen, as the budget and steps are below.
  // The floor arrives with the loop list, after a goal or a carried run may already have set the 10 s
  // chip; held as it was, it went out with no chip pressed and the route refused it after the signature.
  const intervalShown = intervalOptions.includes(intervalMs)
    ? intervalMs
    : snap(intervalMs, intervalOptions, 5 * 60_000);
  // The field starting to go out as a goal — its first character typed with a switch on, or a switch
  // turned on over text — turns the form into a goal loop, on the shortest pause offered (10 s unless
  // the route's floor is above it), since a goal loop's pace is how soon Jev can say it is done.
  // Stopping gives back the interval the form had, snapped to the chips. Keyed on what is sent, not on
  // the text alone: the one field is text either way, and only the switches say whether it is a goal.
  const goalModeChange = (was: boolean, is: boolean) => {
    if (!was && is) {
      setPreGoalIntervalMs(intervalShown);
      setIntervalMs(intervalOptions[0]);
    } else if (was && !is) {
      setIntervalMs(snap(preGoalIntervalMs ?? intervalMs, intervalOptions, 5 * 60_000));
      setPreGoalIntervalMs(null);
    }
  };
  const onTextChange = (next: string) => {
    setText(next);
    goalModeChange(goalLoop, sendsGoal(next, goalCheckOn, selfStop));
  };
  const onGoalCheckChange = (on: boolean) => {
    setGoalCheckOn(on);
    goalModeChange(goalLoop, sendsGoal(text, on, selfStop));
  };
  const onSelfStopChange = (on: boolean) => {
    setSelfStop(on);
    goalModeChange(goalLoop, sendsGoal(text, goalCheckOn, on));
  };
  // A paused loop still holding its Tempo channel blocks a start as surely as a running one:
  // `loopRunRefusal` answers 409 for it (its settle record is still to go on this chain), so a form
  // offered beside it would only spend a `"Lath loop"` signature on that refusal.
  const running =
    loops.data?.loops.find(
      (l) => l.agentId === agentId && (l.status === "running" || (l.status === "paused" && !!l.channel))
    ) ?? null;
  // The chips the console's bound allows (`limits.loopBudgetMaxMicroUsdc`). The bound arrives
  // with the loop list, after the form opened on a chip, so a pick above it is shown and sent as
  // the largest chip that is allowed rather than as a budget the route would clamp unseen.
  const budgets = loopBudgetOptions(limits?.loopBudgetMaxMicroUsdc);
  const budgetShown = budgets.includes(budgetUsdc) ? budgetUsdc : clampToChips(budgetUsdc, budgets);
  const budgetMicro = budgetMicroOf(budgetShown);
  // The steps chips by the same rule against `limits.maxSteps` (48 unless the operator lowered it),
  // and any typed count clamped to that bound: a count above it is shown and sent as the bound.
  const stepOptions = loopStepOptions(limits?.maxSteps);
  const stepsBound = limits?.maxSteps && limits.maxSteps > 0 ? limits.maxSteps : LOOP_MAX_STEPS_DEFAULT;
  const stepsShown = clampSteps(maxSteps, stepsBound);
  // `checkLoopRequest`'s floor, which is 10 — the same number `CreatorWizard`'s `LOOP_PROMPT_MIN`
  // and `MIN_LOOP_PROMPT` in `templates/validate.ts` carry. A lower floor here would enable Start for
  // an instruction the route refuses, so the wallet would sign a message and get a 400.
  // Held against the one field, which is always the instruction; and so is the cap, 2000 on both the
  // instruction and the goal, so one figure covers the text whatever it is sent as.
  const bar = Number.parseFloat(minConfidence);
  const barOk = !verifyOn || (Number.isFinite(bar) && bar >= 0 && bar <= 1);
  const goalOk = text.trim().length <= MAX_GOAL_TEXT;
  // Shape only (a row that is not a URL or an address); whether a source resolves is _Check
  // sources_' question, and the start's fetch asks it again whatever the check said.
  const sandboxBad = termsMode ? null : sandboxProblem(sandbox, hasStore);
  // With no team on the form there is no team from scratch, so the store switch never mints members'
  // tools here (`sandboxRequest`'s third argument stays at its default).
  const sandboxBody = termsMode ? undefined : sandboxRequest(sandbox, hasStore);
  // The receipt, on the rule every optional term follows, and
  // not a grant: picked in an offered, switched-on section, the start carries the console's own pointer
  // under `receipt`. On with nothing picked sends nothing and leaves Start enabled: the section says so,
  // and nothing is signed that is not shown. Picked on a console with no receipt schema, Start is
  // held with a reason rather than signed into a loop that would publish none while the section says it
  // will: the terms on screen are the terms signed.
  const receiptWanted = pluginsOffered && pluginsOn && receiptPicked(pluginPicks);
  const receiptPointer = receiptWanted ? receiptPointerOf(attestDemo) : null;
  // And held without a goal Jev checks: the receipt is published only on Jev's `achieved`, so such a loop
  // could never earn one, and the console refuses the start (`checkLoopStart`) after the signature otherwise.
  const receiptBad =
    receiptWanted && !receiptPointer
      ? "This console has no receipt schema: seed it, or switch Protocol plugins off to start without a receipt."
      : receiptWanted && !(goal.trim() && goalCheckOn)
      ? "A receipt is published when the decision model says the goal is reached: write a Goal and keep Decision model checks the goal on, or switch Protocol plugins off."
      : null;
  const valid =
    text.trim().length >= LOOP_PROMPT_MIN && budgetMicro > 0 && barOk && goalOk && !sandboxBad && !receiptBad;

  const verifyLine = `Every step is checked by the decision model, at a minimum confidence of ${minConfidence}. Lath pays for it.`;
  // Why Start is held, in words; null when it is not. Under the form, and handed to the wizard's step.
  const problem = valid
    ? null
    : !goalOk
    ? `The goal is too long (${MAX_GOAL_TEXT} characters).`
    : text.trim().length < LOOP_PROMPT_MIN
    ? `A goal needs at least ${LOOP_PROMPT_MIN} characters.`
    : budgetMicro <= 0
    ? "Set a loop budget above zero."
    : !barOk
    ? "Set a minimum confidence between 0 and 1."
    : sandboxBad
    ? sandboxBad
    : receiptBad
    ? receiptBad
    : null;

  // The start's body, built up key by key because each optional term is written only when it is on.
  //
  // The server treats *any* body with a `templateId` as the short form: `planLoopStart` rebuilds the
  // terms from the stored config and ignores the long body, so an edited interval re-runs the version
  // as stored. Sending both is what lets a server that reads the long body when the terms differ, and
  // appends v‹n+1›, take this form unchanged.
  //
  // `verify` is never written as `false`: a loop that did not ask for a second model must hash its
  // policy and mint its template exactly as a loop whose policy has no `verify` key. This form always
  // asks, so only an API client that omits the key starts such a loop.
  // `receipt` is on `StartLoopRequest`: the hook spreads the request into the body it signs, so the
  // key is bound by the `"Lath loop"` message's `Request ID` like every other.
  // The one Goal field as the start's two keys (`lib/loop-goal-field.ts`): always the instruction,
  // and the goal too while _Jev checks the goal_ — or, with it off, _The agent says when it is
  // done_ — is on.
  function buildRequest(): StartLoopRequest {
    const terms = loopGoalTerms(text, goalCheckOn, selfStop);
    const req: StartLoopRequest = {
      agentId,
      prompt: terms.prompt,
      intervalMs: intervalShown,
      maxSteps: stepsShown,
      budgetMicroUsdc: String(budgetMicro),
      model,
    };
    // The goal is written only when there is one, the same rule `verify` follows: a loop with
    // no goal must hash its policy and mint its template exactly as every loop started before
    // goals existed, and an empty string is a goal the server would only normalise away again.
    if (terms.goal) req.goal = terms.goal;
    // Jev's goal check, only beside a goal and only when on: a start without it hashes its
    // policy and mints its template as a goal loop whose policy has no `goalCheck` key.
    if (terms.goalCheck) req.goalCheck = true;
    // No `trigger` and no `gate`: a body with neither is a scheduled run, which is every start this
    // form sends. A carried gate is not written either, and since this body names
    // its own terms the route reads none of a template's stored config, so the gate does not come
    // back through `templateId` (`checkLoopStart`'s `editing`).
    if (verifyOn) req.verify = { minConfidence: bar };
    // No `workers` and no `traceAudit` (above). The sandbox, on the same rule as every optional
    // term: `sandboxRequest` writes a key only for what differs from the host's default posture and
    // returns nothing when nothing does, so a start that never opened the section — or opened it and
    // changed nothing — hashes its policy, template and every step's posture as a start with no
    // sandbox config.
    if (sandboxBody) req.sandbox = sandboxBody;
    // The receipt's pointer, only when picked and the console has one, so every other
    // start's policy hashes as one without a receipt. It rides in the same body the one signature binds.
    if (receiptPointer) req.receipt = receiptPointer;
    if (template) {
      req.templateId = template.id;
      if (template.version !== undefined) req.version = template.version;
    }
    return req;
  }

  // The wizard's step reads the terms as they change: the body when Start would be allowed, else
  // why not. Keyed on the body's bytes, so a render that changes nothing tells it nothing.
  const termsRequest = termsMode && valid ? buildRequest() : null;
  const termsKey = termsRequest ? JSON.stringify(termsRequest) : "";
  const onTermsRef = useRef(onTerms);
  onTermsRef.current = onTerms;
  useEffect(() => {
    onTermsRef.current?.({ request: termsRequest, problem });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termsKey, problem]);

  if (!termsMode && (started || running)) {
    const loop = started ?? running!;
    return (
      <Note tone="good">
        {started
          ? "The loop is running."
          : loop.status === "paused"
          ? `${agentName} has a paused loop holding a Tempo channel; stop it before starting another.`
          : `${agentName} already has a loop running.`}{" "}
        <Link href={`/loop/${loop.id}`} className="inline-flex items-center gap-1 font-medium text-ink-1 underline">
          Watch the loop <ArrowIcon />
        </Link>
      </Note>
    );
  }

  const submit = async () => {
    setStage(null);
    try {
      const req = buildRequest();
      const loop = await start.mutateAsync(req);
      // Set first either way: the note and its link are what stays on screen if the navigation
      // below does not happen — a router that refuses, a page the person has already left.
      setStarted(loop);
      void queryClient.invalidateQueries({ queryKey: loopKeys.all(owner ?? undefined) });
      if (onStarted) onStarted(loop);
      else router.push(`/loop/${loop.id}`);
    } catch {
      // `start.error` carries the reason; it is rendered below.
    } finally {
      setStage(null);
    }
  };

  return (
    // The preset a form was filled from is not said on screen: the fields themselves are what is
    // started. `data-preset` keeps it readable for the specs.
    <div className="space-y-4" data-testid="loop-start-form" data-preset={presetUsed?.id}>
      {(earlier || carried.folded) && (
        <div className="space-y-1 text-2xs leading-relaxed text-ink-3" data-testid="loop-dropped-terms">
          {/* A carried instruction and goal that differ, folded into the one field (`goalFieldFrom`):
              said, for the reason a dropped term is, since the start sends the folded text where the
              source had two. */}
          {carried.folded && (
            <p data-testid="loop-folded-goal">
              {droppedFrom} had a separate instruction and goal; both are in the Goal below, the instruction first.
            </p>
          )}
          {earlier && <p data-testid="loop-dropped-earlier-build">{earlier}</p>}
        </div>
      )}
      {/* One field: what the loop is for and when it is done. The start sends both keys, the standing
          instruction and the goal, from this one text, by `loopGoalTerms` (`lib/loop-goal-field.ts`).
          No hint under it. The placeholder reads as one text: the work, then when it is done. */}
      <Field label="Goal">
        <textarea
          ref={goalRef}
          rows={3}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="e.g. Check the cluster's fee level each step and say whether it moved since the last one. Done when it has moved three steps in a row."
          className="input h-auto resize-none overflow-hidden py-2.5 leading-relaxed"
          data-testid="loop-goal-input"
        />
      </Field>

      {/* Right under the text it checks, once there is some: Jev's answer, not the step's own claim, ends a goal loop
          with the check on, and on is what sends the text as the goal at all. The bar shown is the one
          the server will resolve — the verify seat's when it is on, the committed 0.5 otherwise. With
          the check off, the agent's own stop takes its place: the one other way the text is a goal. */}
      {text.trim() && (
        <LoopGoalCheckToggle
          on={goalCheckOn}
          setOn={onGoalCheckChange}
          bar={verifyOn && barOk ? bar : DEFAULT_MIN_CONFIDENCE}
          seat={verifyOn}
          // What ends a goal loop and what the decision model checks, in this toggle's ⓘ rather than
          // under the chips: the toggle is where it is named.
          more={
            <>
              {goalLoop && (
                <p className="mt-2" data-testid="loop-goal-wakes">
                  A goal loop steps on the clock, one step after another, until{" "}
                  {goalCheckOn
                    ? "the decision model answers that the goal is achieved"
                    : "a step says the goal is reached"}{" "}
                  or its steps or budget run out.
                </p>
              )}
              <p className="mt-2">{verifyLine}</p>
            </>
          }
        />
      )}
      {text.trim() && !goalCheckOn && <LoopSelfStopToggle on={selfStop} setOn={onSelfStopChange} />}

      {/* No _What wakes a step_: every loop the form starts steps on the clock, so there is no trigger
          picker and no gate section. What ends a goal loop is said in the goal check's ⓘ. */}

      {/* The three terms every loop has and what they cost; the other options follow, all on screen.
          The interval row reads _Step Interval_ (`LoopTermChips`). */}
      <LoopTermChips
        intervalMs={intervalShown}
        setIntervalMs={setIntervalMs}
        maxSteps={stepsShown}
        setMaxSteps={setMaxSteps}
        budgetUsdc={budgetShown}
        setBudgetUsdc={setBudgetUsdc}
        intervals={intervals}
        budgets={budgets}
        steps={stepOptions}
        maxStepsBound={stepsBound}
      />

      <LoopCostLine
        intervalMs={intervalShown}
        maxSteps={stepsShown}
        budgetUsdc={budgetShown}
        intervals={intervals}
        jevPercent={limits?.jevBudgetPercent}
      />

      {/* Every option in the open, with no *Advanced* disclosure, so no term is ever signed out of sight
          and nothing needs a summary to say what it hides. The test id is what the e2e helpers find the
          section by. */}
      <div className="space-y-4" data-testid="loop-advanced-body">
        {/* First: the files every step's sandbox opens with, one config for the loop. Files only;
              carried sources and settings show read-only. */}
        {termsMode ? (
          <p className="text-2xs text-ink-3" data-testid="loop-terms-no-files">
            A loop started with its agent&apos;s deploy runs without files or a receipt on SAS; add them by starting a
            loop on an agent that already exists.
          </p>
        ) : (
          <SandboxField sandbox={sandbox} setSandbox={setSandbox} hasStore={hasStore} />
        )}

        {/* Protocol plugins, only on a console that offers them: a console with the switch off renders
              the form without the section, and its starts carry no `receipt` key. */}
        {pluginsOffered && (
          <PluginsField on={pluginsOn} setOn={setPluginsOn} picked={pluginPicks} setPicked={setPluginPicks} />
        )}
        {/* No line for the goal preset's receipt when the console does not offer it: the preset picks the
              receipt only where the console offers it, so on a console without plugins nothing on screen
              says a receipt would be published. */}

        {/* Last, and not a choice: said because it is in what the start signs, and because a step it
            sends back keeps no memory and makes no payment. Drawn in the goal check's ⓘ, and kept here
            for screen readers — the sentence is on the page, not only behind a popover — and for the
            specs that read it by `loop-verify-always`. */}
        <p className="sr-only" data-testid="loop-verify-always">
          {verifyLine}
        </p>
      </div>

      {template && (
        // Someone starting from their own asset is extending it, not copying it, and this sentence
        // is what says so before the signature. The name is the template's own — the one the first
        // agent deployed from it gave it.
        <div data-testid="loop-lineage">
          <Note>
            Appends <span className="num text-ink-1">v{(template.version ?? 0) + 1}</span> to{" "}
            <span className="text-ink-1">{lineageName || template.id}</span>, rather than starting a separate lineage.
          </Note>
        </div>
      )}

      {/* No plugin summary above the button: the _Protocol plugins_ section's one-liner and chips are
          the receipt in words, and the wallet's `Request ID` binds it like every other term. */}
      {!termsMode && start.error && <ErrorNote>{explainError(start.error)}</ErrorNote>}

      {/* A disabled button with no reason on screen is the one way a form can dead-end a person —
          the wizard says so in its own comment, and this form posts the same request, so it says
          why too. */}
      {/* Grey while the Goal is still empty: a form that has not been written in yet is not wrong, and in
          red it read as a failed start before anything was typed. */}
      {publicKey && problem && (
        <p className={`text-2xs ${text.trim() ? "text-rose-300" : "text-ink-3"}`} data-testid="loop-start-problem">
          {problem}
        </p>
      )}
      {!termsMode && loopsUnread && (
        <p className="text-2xs text-amber-300">
          Whether this agent already has a loop running could not be read, so a start may still be refused: one running
          loop per agent.
        </p>
      )}
      {/* Read before the signature rather than learnt from a 409 after it. A hint,
          not a block: the route also counts what other loops' open channels may still draw from the
          treasury, which no route serves, so it can refuse where this is silent — and it asks again
          either way. Only on a console with a treasury; one without bills nothing and checks nothing. */}
      {treasury.data?.enabled && (
        <LoopTreasuryShortfall
          budgetMicro={budgetMicro}
          percent={limits?.jevBudgetPercent}
          balanceBase={treasury.data.balanceBase}
        />
      )}
      {/* Right-aligned whether or not the line beside it is there: it says only what is missing. None in
          the wizard's step, whose deploy is the start. */}
      <div className={`flex items-center justify-end gap-3 ${termsMode ? "hidden" : ""}`}>
        {!publicKey && (
          <span className="mr-auto text-2xs text-ink-3">Connect the wallet that deployed this agent.</span>
        )}
        <Button
          onClick={submit}
          disabled={!publicKey || !valid || start.isPending}
          loading={start.isPending}
          testId="loop-start"
        >
          {/* The stages that name Irys carry its mark, the way Solana and Tempo carry theirs. */}
          {start.isPending && stage && namesIrys(stage) && <IrysMark title="Irys" />}
          {start.isPending ? (stage ? loopStartStageLabel(stage) : "Waiting for the signature…") : "Start the loop"}
        </Button>
      </div>
    </div>
  );
}

/** A start stage whose label names Irys: the pin, a reused pin, or a restore read from Irys. */
function namesIrys(stage: LoopStartStage): boolean {
  if (stage.stage === "fetching sources") return stage.restoring;
  return stage.stage === "pinning on Irys" || stage.stage === "reusing Irys pin";
}

/** `useLayoutEffect` in the browser, so the Goal box is sized before paint; a no-op warning-free `useEffect` on the server. */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/* ------------------------------------------------------------------------------------------ */
/* Prefilling                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * A prefilled term, snapped to the nearest value the chips offer.
 *
 * Every loop this console has started was set with those chips, so a source's terms land on one
 * of them already; a stored config written any other way would otherwise leave the chip row with
 * nothing pressed, which reads as *unset* rather than as *five and a half minutes*. Snapping
 * shows what will actually be sent.
 */
function snap(value: number | undefined, options: readonly number[], fallback: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) ? o : best), options[0]);
}

/**
 * The same, for the budget: micro-USDC as a loop record stores it, to one of the chips' strings. The
 * default is the smallest chip, 1 USDC — the figure a person has to raise deliberately rather than
 * notice afterwards on `/billing`.
 */
function snapBudget(micro: string | undefined): string {
  const usdc = Number.parseInt(micro ?? "", 10) / 1_000_000;
  if (!Number.isFinite(usdc) || usdc <= 0) return LOOP_BUDGETS[0];
  const numbers = LOOP_BUDGETS.map((b) => Number.parseFloat(b));
  const nearest = snap(usdc, numbers, numbers[0]);
  return LOOP_BUDGETS[numbers.indexOf(nearest)] ?? LOOP_BUDGETS[0];
}

/** A chip the bound no longer offers, as the largest one it does: never more than the console allows. */
function clampToChips(usdc: string, budgets: readonly string[]): string {
  const want = Number.parseFloat(usdc) || 0;
  const under = budgets.filter((b) => Number.parseFloat(b) <= want);
  return under.length ? under[under.length - 1] : budgets[0];
}
