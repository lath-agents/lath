"use client";

/**
 * Loop presets: a named set of terms `/create?loop=1&agent=<id>&preset=<id>` opens the loop form
 * on, filled in and every field still editable. A preset is not a template: it has no lineage, no
 * hash and no version, and nothing of it reaches the server except the terms the person then
 * signs. It exists so the demo's loop is one link rather than a page of typing, and so a person
 * can see what a research-and-audit loop over a real protocol is made of before changing any of it.
 *
 * No preset is listed on screen: a preset is reached only by its link,
 * `/create?loop=1&agent=<id>&preset=<id>`, which the demo opens directly. The form opens exactly as
 * that link opens it, with _Start from_ and the preset note off.
 *
 * Carried to the form by context rather than by prop because the loop page mounts the form through
 * `LoopEntry`, which picks the agent and owns the remount `key`; the preset is a property of the
 * page's URL, and the form is the only thing that reads it.
 */
import { createContext, useContext } from "react";
// Relative rather than `@/`, as `plugins-view.ts` imports: `tests/console-sources.ts` holds the presets
// to the route's caps under the root `tsconfig.json`, which has no `@/` path.
import type { DraftLoop } from "./draft";
import type { SandboxConfig } from "../types/loop";

export interface LoopPreset {
  id: string;
  /** What the form says it was filled from. */
  name: string;
  /** The terms, in the shape a picked run hands the form (`LoopStartForm`'s `initial`). */
  loop: DraftLoop;
  /** The Sandbox section, opened on this config. */
  sandbox: SandboxConfig;
  /*
   * No `plugins` (a Squads · pay grant over the console's demo treasury) and no `attest` (an `sas.attest`
   * grant over its SAS demo): both plugins are on the roadmap, not in this build.
   */
  /**
   * SAS · receipt picked: a flag and nothing more, because the receipt's pointer — credential, schema,
   * signer — is the console's own and the only one it accepts, so the form reads it from
   * `attestDemo.receipt` when that answer arrives.
   */
  receipt?: boolean;
}

/**
 * The demo's protocol: Squads v4, a medium-sized open-source Solana program whose repo is public
 * and whose program is deployed at the same address on devnet and mainnet. The devnet account is the
 * one the preset reads, because the demo console may have no mainnet RPC and devnet is where a
 * reader can check what the loop says about it.
 */
const SQUADS_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/**
 * The audit's code: the program's `instructions` folder only — 23 files, 111 435 bytes at Squads v4
 * commit `af94153` (counted from GitHub's tree), against 43 files and 202 459 bytes for `programs`
 * whole. Every instruction's handler and its checks are there, which is all the note cites
 * from the code; what the program is and who can upgrade it come from the devnet source's `idl.json`
 * and `program.json`. A narrower tree is a shorter index in every step and fewer files for a step to
 * open, and the largest file (`transaction_accounts_close.rs`, 17 830 bytes) is far under the 1 MiB
 * per-file cap. A tree URL is the only GitHub form a source takes (`parseGithubUrl`: no `/blob/`), so
 * `lib.rs` would be a second source of the same repo; the folder's own `mod.rs` lists the
 * instructions instead.
 */
const SQUADS_INSTRUCTIONS =
  "https://github.com/Squads-Protocol/v4/tree/main/programs/squads_multisig_program/src/instructions";

/*
 * One Goal per preset, as the loop form has one _Goal_ field (`lib/loop-goal-field.ts`): the form
 * sends that text as the instruction every step runs and, with _Jev checks the goal_ on, as the goal
 * Jev judges. Method the loop needs stays in the Goal's own words, in the open, rather than as a
 * second text riding on the start: each paragraph below says what the loop is for, how a step works, then when it is done. Each
 * stays under the 2000 characters the route takes for either field (`checkLoopRequest`, `MAX_GOAL`), as
 * `tests/console-sources.ts` checks. A preset carries `goal` alone; the form reads it as the field.
 */

/**
 * The submission demo's task: the question a signer asks before approving, answered as a one-page note
 * in four named parts, every claim cited. Four named parts are a bar each step can be judged against,
 * and _exactly one part per step_ makes the run a loop a reader can watch: the note grows a part a
 * step, each step paid, recorded and checked, and the decision model cannot judge it done before the
 * fourth. Given room for more than one part, the agent writes all four in its first step. _Start from
 * the note in what you remember_ says where the note is, since an agent asked to read what it
 * remembers looks for it on disk (`SOURCES_INDEX_READING`, runtime/src/zeroclaw/sources.ts).
 *
 * _Write the whole note to report/note.md_: a step publishes to Tempo storage only the file it wrote
 * under `report/` (`runtime/src/zeroclaw/report.ts`). One write a step, of bytes the step already has:
 * a step that leaves the note unchanged writes the same bytes, and the host publishes nothing for it.
 *
 * The question comes first and alone, one sentence a reader takes in at a glance, and the whole goal is
 * four plain sentences: the question, the four parts, how a step works, the bar. _The note's first line answers the question_: the loop page shows that
 * line under the goal line, and
 * the steps table's Answer cell shows an answer's first sentence, so the line is the answer rather
 * than a description of the program. The answer opens with it and carries the whole note after it,
 * because the next step starts from what it remembers. The goal's opening words are what
 * `demo-record.spec.ts` matches the form on.
 */
const AUDIT_GOAL =
  "Before I approve a Squads transaction: who can upgrade this program, and what must pass before funds move or " +
  "members change? Answer in four parts, one per step: upgrades, moving funds, changing members, spending " +
  "limits. Each step, add the next part to the note you remember, open it with no heading, just the answer to " +
  "the whole question in one or two sentences, " +
  "cite a file under sources/ for every claim, and put the whole note in your answer and in report/note.md. " +
  "Done when all four parts are there.";

export const LOOP_PRESETS: Record<string, LoopPreset> = {
  "protocol-audit": {
    id: "protocol-audit",
    name: "Protocol research and audit",
    loop: {
      goal: AUDIT_GOAL,
      // One budget for the whole loop: the smallest chip.
      budgetMicroUsdc: "1000000",
      verify: {},
      // The note takes a part or two a step, so two to four steps reach its bar, and six — the middle
      // chip — leave room for a step that fails or a part the decision model sends back. The shortest
      // Step Interval, 10 s between steps. Jev's _achieved_ stops it early.
      intervalMs: 10_000,
      maxSteps: 6,
    },
    sandbox: {
      sources: [
        { kind: "github", url: SQUADS_INSTRUCTIONS },
        { kind: "solana", cluster: "devnet", address: SQUADS_PROGRAM },
      ],
    },
    // The receipt on SAS when the decision model says the note is done (R7): sent only from a console
    // that offers it, so elsewhere this preset starts as before.
    receipt: true,
  },
};

/** The preset a `?preset=` value names, or `null` for none or one this console does not know. */
export function loopPreset(id: string | undefined | null): LoopPreset | null {
  if (!id) return null;
  return Object.prototype.hasOwnProperty.call(LOOP_PRESETS, id) ? LOOP_PRESETS[id] : null;
}

/** The preset the page's URL named; `null` everywhere else the form is mounted, which is the default. */
export const LoopPresetContext = createContext<LoopPreset | null>(null);

export function useLoopPreset(): LoopPreset | null {
  return useContext(LoopPresetContext);
}
