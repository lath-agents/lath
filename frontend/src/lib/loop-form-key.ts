/**
 * The `key` `LoopEntry` mounts `LoopStartForm` under, which is the whole prefill contract between
 * them: the form reads its `initial` terms in `useState` initialisers only, so terms that change
 * have to arrive as a fresh mount or the form goes on showing the old ones — and posting them, since
 * what is on screen is what the start sends.
 *
 * The agent plus the picked source's template id and version would not do as the key, because two
 * different picks can share them on one agent. Two runs of one loop lineage both link to the
 * picker's latest template row (`sources.ts` `link`), so a run started from v1 and one started from
 * an edited v3 would key alike while their own terms differ; a run with no template link would key
 * like the blank form; and *Start from blank* after a pick of a template-less run would do nothing.
 * The second pick would then leave the first pick's prompt, goal, interval, budget, judge and
 * sandbox on screen, while the `model` prop — sent in the start body — changes to the new pick's.
 *
 * So the key counts picks: every pick in *Start from* is a new count and a new mount, whatever it
 * names, and a re-render with no pick (a registry refetch, the wallet's reads settling) keeps the
 * count and so keeps what the user typed. The template needs no place in it, because terms only
 * ever change through a pick. Choosing another agent in the select still remounts, through the
 * agent id.
 *
 * No imports, so `tests/console-sources.ts` pins it beside the drafts whose lineages collide.
 */
export function loopFormKey(agentId: string, pick: number): string {
  return `${agentId}:${pick}`;
}
