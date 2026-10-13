/**
 * The wire shape of a deployed agent: what `GET /api/agents/<id>` returns, declared once for
 * both sides.
 *
 * It was declared twice — the projection `publicAgent` builds and `DeployedDetail` in
 * `OwnerHeaderCard` — and the copies had drifted: the browser's was missing `createdAt`, which
 * the route has always sent. Annotating `publicAgent` with `AgentView` is what keeps them equal
 * from here.
 *
 * The storage record `DeployedAgent` in `_lib/runner.ts` stays where it is: it holds things the
 * browser is never sent, and this is the projection of it, not a copy of it.
 */
import type { TemplateLinkView } from "./template";

/** The policy a deploy fixed, as the console recorded it. */
export interface AgentPolicyView {
  model: string;
  tools: string[];
  budgetCapUsdc: string;
  expirationDays: number;
}

/**
 * One deployed agent as the page reads it. No team fields: which running loop has an agent on its
 * roster, and whose cap pays for it, are a team's, and teams are on the roadmap, not in this build.
 */
export interface AgentView {
  id: string;
  name: string;
  /** Base58 of the key this server derived and registered the header with. */
  authority: string;
  /** Base58 of the wallet that signed the deploy; `null` on older records that do not keep it. */
  owner: string | null;
  createdAt: number;
  policy: AgentPolicyView;
  /** `null` on an older agent deployed without a template. */
  template: TemplateLinkView | null;
  /** The template's display name and newest version, so the page can offer *use version n*. */
  templateName: string | null;
  latestVersion: number | null;
  templateArchived: boolean;
  /**
   * The agent this one was cloned from, when it was. The chain has no notion of a clone —
   * a clone is a new name and therefore a new chain — and this is what lets the page say where
   * it came from. `via: "market"` means it was launched from someone else's published offer (the
   * marketplace is on the roadmap), and the page reads it as a copy; absent means the owner copied
   * their own agent, which is also how an older row that does not record the distinction reads.
   */
  clonedFrom: { agentId: string; name: string; via?: "market" } | null;
  archivedAt: number | null;
  /**
   * Legacy per-agent funding: the Tempo address this server derived for the agent, what the
   * treasury transferred into it, and the transfer. Kept because rows on disk can carry them and the
   * page reads them; nothing writes them — on the `tempo` rail the operator's treasury is the payer.
   * Null on `vault` and on rows without per-agent funding.
   */
  tempoAddress?: string | null;
  /** Legacy per-agent funding: base units transferred into `tempoAddress`, for that agent's life. */
  tempoFunded?: string | null;
  /** Legacy per-agent funding: the TIP-20 transfer that funded it. */
  tempoFundTx?: string | null;
  /** Legacy per-agent funding: base units a drain returned to the treasury, as a decimal string. */
  tempoDrained?: string | null;
  /** Legacy per-agent funding: the transfer the drain sent. */
  tempoDrainTx?: string | null;
  /** Why this agent is not on the rail it asked for, when it is not. Rendered as written. */
  tempoNote?: string | null;
}
