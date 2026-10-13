"use client";

import { useState, useMemo, useEffect, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { hex, idFromString, toBytes32 } from "@lath/sdk/browser";
import {
  ArrowIcon,
  Badge,
  Button,
  Card,
  CheckIcon,
  ErrorNote,
  ExplorerLink,
  Facts,
  Info,
  KV,
  Note,
} from "@/components/ui";
import { InfoField } from "@/components/loop-terms";
import { OpenRouterMark, TempoLink, TempoMark } from "@/components/Tempo";
import { useBilling, useLath } from "@/lib/clients";
import { useOwnerState } from "@/lib/queries";
import { config } from "@/lib/config";
import { INDEFINITE_DAYS, formatUsdc } from "@/lib/format";
import { confirmPrepared, explainError, useSendPrepared } from "@/lib/writes";
import { unrecordedWriteError } from "@/lib/broadcast";
import { useRunnerInfo } from "@/lib/console-stream";
import { useTempoTreasury } from "@/lib/tempo";
import { marketKeys } from "@/lib/market";
import { LoopStartForm, type LoopTerms } from "@/components/LoopStartForm";
import { policyVersionHash, promptHash } from "@lath/runtime";
import type { Draft } from "@/lib/draft";

/** Re-exported for the wizard's own callers; defined in `lib/format` beside the other money and
 * time helpers, so the allowance panel and this page cannot drift. */
export { INDEFINITE_DAYS };

/** The one-click amounts; anything else is typed into the box beside them. */
export const BUDGET_PRESETS = ["1.00", "2.50", "5.00", "10.00", "25.00", "50.00"];

/** Where the budget slider stops: the largest preset, so the slider and the chips agree. */
export const BUDGET_SLIDER_MAX = BUDGET_PRESETS[BUDGET_PRESETS.length - 1];

/** The longest name the wizard keeps, and the launch modal too: one limit. */
export const NAME_MAX = 32;

/**
 * The two server ceilings the step-1 fields are held to, duplicated here with their source named
 * rather than imported: `templates/validate.ts` and `_lib/runner.ts` pull in the runtime's keypair
 * and filesystem code, which has no business in a browser bundle. A field that lets a person type past
 * what the route accepts spends a wallet signature on a 400 the console could have predicted.
 */
/** `MAX_PROMPT` in `app/api/templates/validate.ts`; `agents/route.ts` slices a deploy's prompt to it. */
export const MAX_PROMPT = 2000;
/** `MAX_DESCRIPTION` in `app/api/_lib/runner.ts`, which clamps rather than refuses. */
export const MAX_DESCRIPTION = 200;

/**
 * What the review step says about where this agent came from. A source of the wallet's own that resolved to a template
 * *extends* that template — the deploy is v‹n+1› of it, under the name the template kept from its first agent — so the
 * sentence says appends, not copies.
 *
 * A lineage with no `templateId` is a source recorded without a template, so there is nothing to
 * append to and the line stays off. An absent `version` means *latest*, which the server resolves
 * at prepare time; the sentence stays vague rather than naming a number that may be wrong by then.
 *
 * `fork` is the review step's checkbox (off by default). It changes only the sentence
 * and the deploy body: the source is then where the configuration was read from, not what the
 * deploy extends, so the line names the version it *forked from* rather than the one it writes.
 */
export function lineageLine(lineage: Draft["lineage"] | undefined, fork = false): string | null {
  if (!lineage || lineage.kind === "blank") return null;
  if (!lineage.templateId) return null;
  if (fork)
    return typeof lineage.version === "number"
      ? `forks a new template from ${lineage.sourceName} v${lineage.version}`
      : `forks a new template from ${lineage.sourceName}`;
  return typeof lineage.version === "number"
    ? `appends v${lineage.version + 1} to ${lineage.sourceName}`
    : `appends a version to ${lineage.sourceName}`;
}

/**
 * The lineage a *fork* is even a question for: one of the wallet's own sources that resolved to a
 * template. A blank start or a pre-template source has nothing to fork, so neither gets the checkbox.
 */
export function appendableLineage(
  lineage: Draft["lineage"] | undefined
): { sourceName: string; templateId: string; version?: number } | null {
  if (!lineage || lineage.kind === "blank") return null;
  return lineage.templateId
    ? { sourceName: lineage.sourceName, templateId: lineage.templateId, version: lineage.version }
    : null;
}

/**
 * Reading the chain grants nothing away, so the four reads the runtime actually ships are on for
 * every agent and are not a choice. `route.ts` intersects a deployed allow-list with these names,
 * so what is checked here is what the agent really gets.
 */
export const CHAIN_READ_TOOLS = [
  {
    id: "solana.slot",
    name: "Cluster Slot & Throughput",
    description: "Reads the cluster's current slot, block height and how busy it is.",
  },
  {
    id: "solana.fees",
    name: "Priority Fee Market",
    description: "Reads the recent priority-fee market the batcher prices its writes against.",
  },
  {
    id: "solana.balance",
    name: "Wallet & Token Balance",
    description: "Reads the SOL and SPL token balances held by any address on the cluster.",
  },
  {
    id: "lath.verify_chain",
    name: "Chain Verification",
    description: "Replays this agent's own hash chain and reports the seq it verifies to.",
  },
];

export const CHAIN_READ_IDS = CHAIN_READ_TOOLS.map((tool) => tool.id);

/** Everything that reaches past a chain read: the network, a price feed, or another agent. */
export const AVAILABLE_TOOLS: {
  id: string;
  name: string;
  description: string;
}[] = [
  {
    id: "web.search",
    name: "Web Search",
    description: "Query the open web and quote what it finds.",
  },
  {
    id: "web.fetch_page",
    name: "Read Web Pages",
    description: "Fetch a URL and read the text on it.",
  },
  {
    id: "market.prices",
    name: "Market Data",
    description: "Read off-chain token prices and volumes.",
  },
  {
    id: "store.get",
    name: "Store: Read",
    description: "Read the agent's own key-value store, kept on chain across sessions and loop steps.",
  },
  {
    id: "store.set",
    name: "Store: Write",
    description: "Write keys to that store. Each write is a chain transaction, and the store is public.",
  },
];

/**
 * The policy hash the wizard shows and the allowance transaction commits to, computed in the
 * browser from the same canonical document the runtime hashes at genesis.
 *
 * `prompt` is a template's `config.prompt` when the agent has one: it enters the document as
 * `promptHash = sha256(prompt)`, exactly as `templateSystemPrompt` puts it there on the server.
 * `canonicalJson` drops the key when there is no prompt, so an agent without one hashes as a policy
 * with no `promptHash` key.
 *
 * The wizard's hash and the genesis hash are still two different claims: the billing program
 * treats the allowance's policy hash as advisory, and a session commits what it actually ran
 * with. Matching inputs must nonetheless produce matching bytes, which is what this shares.
 */
export function browserPolicyHash(
  policy: {
    model: string;
    temperature: number;
    toolAllowList: string[];
    maxCost: number;
    /**
     * How inference is paid for, the one part of it that enters the document: `payment` is
     * absent-preserving and the vault rail's name is normalised away before hashing
     * (`runtime/src/policy.ts`), so every older genesis hash — with no `payment` key, or naming the
     * vault rail — stays where it is.
     */
    payment?: "vault" | "tempo";
  },
  prompt?: string
): string {
  const trimmed = prompt?.trim();
  return hex(policyVersionHash({ ...policy, promptHash: trimmed ? promptHash(trimmed) : undefined }));
}

/** The agent a deploy made, as `onDeployed` hands it on; `model` and `tools` only when this form set them. */
export interface DeployedAgent {
  id: string;
  name: string;
  model?: string;
  tools?: readonly string[];
  /** The deploy's transaction, or null for a name this wallet already held (nothing was signed). */
  signature: string | null;
  /** The loop the deploy carried, started at its confirm; absent when it carried none. */
  loopId?: string;
  /** Why the loop the deploy carried did not start, beside a deploy that stands. */
  loopError?: string;
}

/**
 * `draft` is what the *Start from* step picked (`lib/draft.ts`): the wizard opens filled from it
 * and the review step says which template it extends. Absent, the wizard opens blank.
 */
export function CreatorWizard({
  draft,
  onDeployed,
  withLoop = false,
}: {
  draft?: Draft;
  /**
   * The Agent loop page's _New_: a fourth step, _Agent loop_, before the
   * review, and a deploy that carries its terms, so the one transaction the wallet signs registers the
   * agent and starts its loop (`POST /api/agents`' `loop`, started at confirm and audited against that
   * transaction as the owner's word). Without it the wizard deploys an agent and nothing else.
   */
  withLoop?: boolean;
  /**
   * The Agent loop page's _New_: the agent is step 1 of 2, so its deploy hands the agent to the page,
   * which shows step 2 — the loop form on it — in place of the finish card. In place, not by a link to
   * `?agent=`: the form there would read the agent from a list that could predate the deploy, and open
   * on another agent or without its Goal.
   */
  onDeployed?: (agent: DeployedAgent) => void;
} = {}) {
  const { publicKey } = useWallet();
  // The console's runtime authority — the key that meters sessions against an allowance. The
  // allowance the wizard approves is for it, not for the wallet; a grant to oneself is never used.
  const runner = useRunnerInfo();
  const runtimeAuthority = runner.data?.ready && runner.data.authority ? runner.data.authority : null;
  const lath = useLath();
  const billing = useBilling();
  const sendPrepared = useSendPrepared();

  const [currentStep, setCurrentStep] = useState<number>(1);
  // The _Agent loop_ step sits between the policy and the review when the wizard carries a loop.
  const LOOP_STEP = 3;
  const REVIEW_STEP = withLoop ? 4 : 3;
  const [loopTerms, setLoopTerms] = useState<LoopTerms>({ request: null, problem: null });
  const nameId = useId();
  const modelId = useId();
  const descriptionId = useId();
  const promptId = useId();

  // Step 1: Identity
  //
  // Every field below opens on the draft when the *Start from* step picked one and on the wizard's own default when it
  // did not, so a blank start is the plain form. The initialisers run once: after that the fields belong to the person
  // typing, and a draft arriving late would be the picker overwriting what they had already written.
  const [name, setName] = useState(draft?.name ?? "");
  const [description, setDescription] = useState(draft?.description ?? "");
  /**
   * The agent's standing instruction. Optional: left empty the policy carries no `promptHash`, so
   * the allowance commits the same hash as a policy with no prompt.
   */
  const [prompt, setPrompt] = useState(draft?.prompt ?? "");

  // Step 2: Policy & Tools
  const [model, setModel] = useState(draft?.model ?? "deepseek/deepseek-v4.1-flash");
  // The chain reads are not a choice (`CHAIN_READ_TOOLS`), so a draft adds to them rather than
  // replacing them: a source whose stored list predates the always-allowed four must not deploy
  // an agent hashing a shorter allow-list than the runtime will hand it anyway.
  const [selectedTools, setSelectedTools] = useState<string[]>(() =>
    Array.from(new Set([...CHAIN_READ_IDS, ...(draft?.tools ?? [])]))
  );

  // Step 3: Allowance & Budget
  const [budgetCapUsdc, setBudgetCapUsdc] = useState(draft?.budgetCapUsdc ?? "10.00");
  // No expiry by default: the spend cap is the control that matters to get started, and an
  // allowance that quietly lapses is a worse surprise than one that is still there. An expiry is
  // opt-in, below.
  const [expirationDays, setExpirationDays] = useState(draft?.expirationDays ?? INDEFINITE_DAYS);
  /**
   * How inference is paid for, which is not a choice: Tempo pays the model, and the wallet's
   * allowance on Solana is the cap and the debit. The one thing read from the deployment is whether
   * it *has* a treasury — with none nothing can be billed at all and every session runs the scripted
   * transport, which the step says rather than offering an option that cannot be honoured. The policy
   * carries `payment: "tempo"` only in that first case, so no genesis hash moves.
   */
  const tempoTreasury = useTempoTreasury();
  const billed = !!tempoTreasury.data?.enabled;
  // Set when the treasury route did not answer: `billed` is false then too, but *this deployment
  // has no treasury* is a claim nothing established, so the rail line says it could not ask.
  const treasuryUnreachable = tempoTreasury.data?.unreachable;

  // The lineage this deploy extends, and whether the review step was told to break it instead.
  // Off by default: starting from your own asset appends a version to its template,
  // and forking is the escape hatch a person asks for, never the path they fall into.
  const lineage = useMemo(() => appendableLineage(draft?.lineage), [draft?.lineage]);
  const [forkTemplate, setForkTemplate] = useState(false);

  // Step 4: Deployment State
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploymentSignature, setDeploymentSignature] = useState<string | null>(null);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const [deploymentNote, setDeploymentNote] = useState<string | null>(null);
  const [deployedId, setDeployedId] = useState<string | null>(null);
  const [registrationSignature, setRegistrationSignature] = useState<string | null>(null);
  const [deployed, setDeployed] = useState(false);
  const queryClient = useQueryClient();
  // The deploy answered with an agent this wallet already owns under this name: nothing was signed
  // and nothing on the form was applied, which the finish card has to say instead of *deployed*.
  const [alreadyYours, setAlreadyYours] = useState(false);

  // Derived Cryptographic Values
  const sanitizedName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, NAME_MAX);
  const ownerIdBytes = useMemo(() => idFromString(sanitizedName || "unnamed"), [sanitizedName]);
  const ownerIdHex = useMemo(() => hex(ownerIdBytes), [ownerIdBytes]);
  const named = sanitizedName.length >= 3;

  // `agent_id = sha256(name)`, so a name is a claim on an id, not a label: whoever registered it
  // first owns that chain and no one else may append to it. Check the chain while the name is
  // still editable rather than letting the deploy fail on a header that already exists.
  const [checkName, setCheckName] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setCheckName(sanitizedName), 300);
    return () => clearTimeout(t);
  }, [sanitizedName]);
  const checkId = useMemo(() => (checkName.length >= 3 ? hex(idFromString(checkName)) : ""), [checkName]);
  const existing = useOwnerState(checkId, checkId.length > 0);
  const deployedHere = useQuery<{ agents: { id: string; name: string; owner?: string }[] }>({
    queryKey: ["deployed-agents"],
    queryFn: async () => (await fetch("/api/agents")).json(),
    staleTime: 30_000,
  });
  const checking = named && (checkName !== sanitizedName || existing.isFetching);
  // An RPC hiccup must not block the wizard, so an errored lookup is treated as "not taken".
  const taken = named && !checking && !existing.isError && Boolean(existing.data?.state);
  // `GET /api/agents` lists everything this console deployed, for **any** wallet, so matching on
  // the id alone told wallet B it already owned an agent wallet A had deployed — and then B found
  // no such agent in its own list. The owner is on the record; use it.
  const takenHere =
    taken && (deployedHere.data?.agents ?? []).some((a) => a.id === ownerIdHex && a.owner === publicKey?.toBase58());
  const grantedTools = selectedTools.filter((t) => !CHAIN_READ_IDS.includes(t));
  const shownTools = selectedTools;
  const offeredTools = AVAILABLE_TOOLS;
  const budgetUsdc = Number.parseFloat(budgetCapUsdc);
  const budgetValid = Number.isFinite(budgetUsdc) && budgetUsdc >= 0.25;
  // The header shows the cap in the micro-USDC the deploy sends (`budgetCapMicro` below), exact and
  // trimmed to no fewer than two places: `toFixed(2)` printed 0.999 as "1.00", a cap nobody signed.
  const budgetShown = budgetValid
    ? formatUsdc(BigInt(Math.round(budgetUsdc * 1_000_000))).replace(/(\.\d\d\d*?)0+$/, "$1")
    : "—";

  const compressedAddress = useMemo(() => {
    try {
      return lath.agentAddress(ownerIdBytes).toBase58();
    } catch {
      return "Compressed PDA (Light Protocol)";
    }
  }, [lath, ownerIdBytes]);

  // The system prompt this agent will run, from step 1's field — typed there, or filled from the draft the *Start from*
  // step picked. While it is empty the policy carries no `promptHash`, so the hash below is byte for byte a promptless
  // policy's; the moment it says something it enters the document and moves `policy_version_hash`, which is what makes
  // configuring from an asset mean anything on chain.
  const templatePrompt: string | undefined = prompt.trim() || undefined;

  const rawPolicyObject = useMemo(() => {
    return {
      model,
      temperature: 0.2,
      toolAllowList: [...selectedTools].sort(),
      maxCost: budgetValid ? Math.round(budgetUsdc * 1_000_000) : 0,
      // Only where a call can actually be billed: an agent on a console with no treasury hashes
      // as a policy with no `payment` key, which is what keeps the allowance's hash and the
      // genesis's comparable.
      ...(billed ? { payment: "tempo" as const } : {}),
    };
  }, [model, selectedTools, budgetCapUsdc, billed]);

  const computedPolicyHash = useMemo(
    () => browserPolicyHash(rawPolicyObject, templatePrompt),
    [rawPolicyObject, templatePrompt]
  );

  function toggleTool(toolId: string) {
    if (CHAIN_READ_IDS.includes(toolId)) return; // reads are not a choice
    if (selectedTools.includes(toolId)) {
      setSelectedTools(selectedTools.filter((t) => t !== toolId));
    } else {
      setSelectedTools([...selectedTools, toolId]);
    }
  }

  async function handleDeploy() {
    setIsDeploying(true);
    setDeploymentError(null);
    setDeploymentNote(null);
    setDeploymentSignature(null);
    setAlreadyYours(false);

    // Deploy is disabled unless `budgetValid`, which needs at least 0.25 USDC, so by the time
    // this runs there is always an allowance to sign for, and no budgetless path registers on a
    // signed message instead.
    const budgetCapMicro = BigInt(Math.round(budgetUsdc * 1_000_000));
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + expirationDays * 86400);

    try {
      // No wallet, no deployment.
      if (!publicKey) throw new Error("connect a wallet first");

      // Why the server registers and not the wallet: on chain an owner's `authority` is whoever
      // signed `register_agent`, and only that key may append to its chain. An agent registered
      // by the browser would have a header no runtime could ever write a session to. So the
      // server signs that half with a key derived from the name, in the same transaction the
      // wallet signs for its allowance — one prompt, and neither half without the other.
      // `payment` is sent only where the console can bill, and only ever as `tempo`: the server
      // decides the rail for itself (`_lib/tempo.ts`), and a template that named the retired rail
      // is refused on write.
      const policyBody = {
        model,
        tools: selectedTools,
        budgetCapUsdc,
        expirationDays,
        ...(billed ? { payment: "tempo" as const } : {}),
      };

      // One transaction for the whole deploy: funding, the header and the allowance land or
      // none of them do. The server builds and partly signs it; the wallet adds the signature
      // that matters — its own — and this page broadcasts it. Only then is a record written.
      //
      // Without an allowance there is nothing for the wallet to sign, so that case stays on the
      // server-registers path: an agent with no budget is a deliberate thing to make, not a
      // half-finished deploy.

      let deployed: {
        id: string;
        name: string;
        authority: string;
        existing?: boolean;
        owner?: string | null;
        loop?: { id?: string };
        loopError?: string;
      };
      let deploymentSig: string | null = null;
      const prep = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "agent",
          name: sanitizedName,
          policy: policyBody,
          // The prompt goes in the body, not in the policy: the route folds it into the config it
          // hands `implicitTemplate`, which is where `templateSystemPrompt` reads it back from at
          // session time (`_lib/templates.ts`). Omitted when blank so the template hashes exactly as
          // a promptless deploy's does.
          ...(templatePrompt ? { prompt: templatePrompt } : {}),
          // The description: the route clamps it to `MAX_DESCRIPTION` and writes it on the record,
          // and drops it when blank so the row stays byte-identical to one written without the field.
          ...(description.trim() ? { description: description.trim() } : {}),
          // Where this deploy sits in a lineage. A `templateId` beside the policy above
          // is the builder's *start from this and edit*: the server appends v‹n+1› to that
          // template when the config differs and re-uses the named version when it does not. The
          // `version` is the one the form was filled from, so the append lands on the version the
          // person actually saw and not on whatever became latest while they were typing. Both are
          // sent only when the source resolved to a template — a blank start or an
          // agent recorded without a template has nothing to append to, and a `templateId` the wallet does not
          // own is refused with a 403.
          ...(lineage
            ? {
                templateId: lineage.templateId,
                ...(typeof lineage.version === "number" ? { version: lineage.version } : {}),
                // Sent only when ticked: the route reads `fork === true` and mints a fresh
                // template with `clonedFrom` instead of appending.
                ...(forkTemplate ? { fork: true } : {}),
              }
            : {}),
          // The loop's terms, checked at prepare (before the wallet signs) and started at confirm on
          // the agent this transaction registers. Absent unless the wizard carries one.
          ...(withLoop && loopTerms.request ? { loop: loopTerms.request } : {}),
          prepare: true,
          wallet: publicKey.toBase58(),
          allowance: {
            capMicroUsdc: budgetCapMicro.toString(),
            expiresAt: expiresAt.toString(),
            policyVersionHash: computedPolicyHash,
          },
        }),
      });
      const prepared = await prep.json();
      if (!prep.ok) throw new Error(prepared.error ?? `the server refused the deployment (${prep.status})`);

      // A name this console has already deployed is answered with the record rather than a
      // transaction — there is nothing left to sign, and the note below says so. Without this
      // the missing `transaction` would reach `sendPrepared` and become an opaque TypeError.
      //
      // The server answers `existing` for a name it holds, whoever holds it, so the owner
      // comparison is what makes this branch a statement about the person asking. Without it a
      // name another wallet deployed would read *Agent deployed on Solana* — confirmed, over someone
      // else's agent, with this form's prompt, policy and cap silently dropped. The branch is
      // reachable although step 1 disables a taken name: the name check errors often on devnet,
      // two tabs can race, and the route can be called directly. An answer with no `owner` — an
      // older record written without one, or a server that does not send the field — cannot say
      // whose agent this is, and a deploy is not claimed on a guess.
      if (prepared.existing) {
        const owner = typeof prepared.owner === "string" ? prepared.owner : null;
        if (!owner)
          throw new Error(
            `“${sanitizedName}” is already deployed here, and this console cannot say by which wallet. Pick another name.`
          );
        if (owner !== publicKey.toBase58())
          throw new Error(`“${sanitizedName}” is already registered by another wallet. Pick another name.`);
        setAlreadyYours(true);
        setDeployedId(prepared.id);
        deployed = prepared;
      } else {
        // Held to what this form sent, not to what the answer says it prepared: the cap, the expiry
        // and the policy hash are the page's own numbers, so an `approve_agent` carrying any other
        // is refused before the prompt. The agent key is the one thing only the server knows (it
        // derives it from the name), so that is the answer's `authority`, and the check ties it to
        // the key `register_agent` records as the header's authority.
        let agentAuthority: PublicKey;
        try {
          agentAuthority = new PublicKey(prepared.authority);
        } catch {
          throw new Error("the console did not say which agent key it prepared; refusing to sign");
        }
        const sent = await sendPrepared(prepared.transaction, prepared.lastValidBlockHeight, {
          agentAuthority,
          cap: budgetCapMicro,
          expiresAt,
          policyVersionHash: Uint8Array.from(Buffer.from(computedPolicyHash, "hex")),
        });
        const signature = sent.signature;
        deploymentSig = signature;
        setRegistrationSignature(signature);
        setDeploymentSignature(signature);

        // The ticket, not the signed message: one deploy asks the wallet for one signature, and
        // re-sending the first message would be a replay the server is right to refuse.
        //
        // `confirmPrepared` presents the ticket until the chain has answered: the transaction has
        // already landed by now, and a ticket thrown away on a slow indexer leaves a registered,
        // funded agent with no record under a name `prepareDeployTx` refuses forever. It is
        // presented too when this browser could not read whether the transaction landed
        // (`sent.landed` false), since the console reads the chain for itself.
        try {
          deployed = await confirmPrepared(
            "/api/agents",
            { confirm: signature, ticket: prepared.ticket },
            {
              onWaiting: (n, of) =>
                setDeploymentNote(
                  sent.landed
                    ? `The transaction landed; waiting for the indexer to see it (try ${n} of ${of})…`
                    : `The transaction was sent; asking the console whether it landed (try ${n} of ${of})…`
                ),
            }
          );
        } catch (err: any) {
          // Name the transaction, because this is the one failure where the console's record and
          // the chain can disagree and only the operator can close the gap — said as landed when
          // this browser saw it land, and as possibly landed when it could not read it.
          throw unrecordedWriteError(err, sent, "agent");
        }
        setDeploymentNote(null);
        setDeployedId(deployed.id);
      }

      // The wallet's agent list is read once and kept (`useDeployedAgents`, no refetch on focus), and
      // _Continue to the loop_ is a client navigation that keeps the loop entry around it mounted. A
      // list from before this deploy has no row for the new agent, so the loop form would fall back to
      // the wallet's first agent, and one "Lath loop" signature would start the loop on it (or say
      // "none yet" on a first deploy). So the list is read again before the finish card offers the link.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: marketKeys.deployed() }),
        queryClient.invalidateQueries({ queryKey: ["agents-registry"] }),
      ]);
      setDeployed(true);
      // What the form typed is what was deployed, except for a name this wallet already held, whose
      // record kept its own model and tools: that one is handed over by id, and the page reads the rest.
      onDeployed?.(
        prepared.existing
          ? { id: deployed.id, name: sanitizedName, signature: null }
          : {
              id: deployed.id,
              name: sanitizedName,
              model,
              tools: selectedTools,
              signature: deploymentSig,
              ...(typeof deployed.loop?.id === "string" ? { loopId: deployed.loop.id } : {}),
              ...(deployed.loopError ? { loopError: deployed.loopError } : {}),
            }
      );
    } catch (err: any) {
      setDeploymentError(explainError(err));
    } finally {
      setIsDeploying(false);
    }
  }

  const steps = [
    { step: 1, label: "Agent identity" },
    { step: 2, label: "Budget and policy" },
    ...(withLoop ? [{ step: LOOP_STEP, label: "Agent loop" }] : []),
    { step: REVIEW_STEP, label: "Review and deploy" },
  ];
  // Whether each step's own *next* button would let you leave it — the same conditions, so the step
  // bar cannot do what those buttons refuse: skipping ahead unvalidated, a person could reach Review
  // with a taken name and sign into a refusal at prepare.
  const stepDone: Record<number, boolean> = {
    1: named && !checking && !taken,
    2: budgetValid,
  };
  if (withLoop) stepDone[LOOP_STEP] = !!loopTerms.request;
  const reachable = (step: number) => steps.every((s) => s.step >= step || stepDone[s.step]);

  return (
    <div className="space-y-6">
      {/* Progress: three steps, the done ones ticked, the current one lit. */}
      <ol className="surface flex items-stretch divide-x divide-line/[0.08] overflow-hidden" aria-label="Steps">
        {steps.map((s) => {
          const isActive = currentStep === s.step;
          const isDone = currentStep > s.step;
          // Back is always open; forward only over steps that pass. Disabled rather than hidden, so
          // the bar still says how many steps there are.
          const open = s.step <= currentStep || reachable(s.step);
          return (
            <li key={s.step} className="flex-1">
              <button
                type="button"
                onClick={() => open && setCurrentStep(s.step)}
                disabled={!open}
                aria-current={isActive ? "step" : undefined}
                className={`flex h-full w-full items-center gap-3 px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  isActive ? "bg-accent/[0.06]" : "enabled:hover:bg-line/[0.03]"
                }`}
              >
                <span
                  className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-2xs font-semibold ${
                    isDone
                      ? "bg-spine-green/15 text-spine-green"
                      : isActive
                      ? "bg-accent text-neutral-950"
                      : "border border-line/[0.14] text-ink-3"
                  }`}
                >
                  {isDone ? <CheckIcon /> : s.step}
                </span>
                <span className="min-w-0">
                  <span className="hidden text-2xs text-ink-3 sm:block">Step {s.step}</span>
                  <span
                    className={`hidden truncate text-xs font-medium sm:block ${isActive ? "text-ink-1" : "text-ink-2"}`}
                  >
                    {s.label}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {/* STEP 1: IDENTITY */}
      {currentStep === 1 && (
        <Card
          title={
            <>
              Identity
              <Info label="Why the name is the identity" testId="wizard-identity-info">
                <p>The id on chain is sha256 of the name, so the name is the identity. Pick it once.</p>
              </Info>
            </>
          }
          right={<Badge tone="cyan">agent</Badge>}
        >
          <div className="space-y-5">
            {/* The id and the compressed address as you type, behind the ⓘ on the name: they are what
                the name commits to, read when wanted rather than on every key. */}
            {/* The field's helper lines live in its ⓘ: the byte limit here, what the description and
                the prompt commit to below. */}
            <InfoField
              label="Agent name"
              htmlFor={nameId}
              infoLabel="The id and address this name commits to"
              infoTestId="wizard-name-info"
              info={
                <>
                  <p>
                    <code>agent_id = sha256(name)</code>. The id is sha256 of the name, so a name is a claim on an id:
                    whoever registers it first owns that chain.
                  </p>
                  <p>Up to 32 bytes, stored inline.</p>
                  {named ? (
                    <Facts
                      items={[
                        { label: "id", value: ownerIdHex, mono: true, title: ownerIdHex, source: "chain" },
                        {
                          label: "compressed address",
                          value: compressedAddress,
                          mono: true,
                          title: compressedAddress,
                          source: "chain",
                        },
                      ]}
                    />
                  ) : (
                    <p className="text-ink-3">The id is sha256 of the name; it appears here as you type.</p>
                  )}
                </>
              }
            >
              <input
                id={nameId}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. agent-sentinel-v2"
                className="input-mono h-10"
              />
            </InfoField>

            <InfoField
              label="Agent description"
              htmlFor={descriptionId}
              right={`${description.length}/${MAX_DESCRIPTION}`}
              infoLabel="Where the description is kept"
              infoTestId="wizard-description-info"
              info={
                <p>
                  A label for the console&apos;s lists, in your words. Kept in the deployment&apos;s record; not written
                  on chain.
                </p>
              }
            >
              <textarea
                id={descriptionId}
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
                placeholder="What this agent is for…"
                maxLength={MAX_DESCRIPTION}
                className="input h-auto resize-y py-2.5 leading-relaxed"
              />
            </InfoField>

            {/* The standing instruction, and the one thing that makes starting from another
                asset mean anything: it is the only step-1 field that reaches the chain. Optional
                on purpose — an agent with no prompt runs the hardcoded system prompt of whatever
                context it is invoked in, which is every agent deployed before this field existed. */}
            <InfoField
              label="System prompt"
              htmlFor={promptId}
              right={`${prompt.length}/${MAX_PROMPT}`}
              infoLabel="What the system prompt commits to"
              infoTestId="wizard-prompt-info"
              info={
                <p>
                  Optional. What this agent is told before every session. Only its sha256 goes on chain, inside{" "}
                  <code>policy_version_hash</code>; the bytes are served from the trace store so an auditor can check
                  them.
                </p>
              }
            >
              <textarea
                id={promptId}
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT))}
                placeholder="e.g. You watch this cluster's fee market and report only what moved."
                maxLength={MAX_PROMPT}
                data-testid="agent-prompt"
                className="input h-auto resize-y py-2.5 leading-relaxed"
              />
            </InfoField>

            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line/[0.08] pt-4">
              {!named ? (
                <span className="text-2xs text-ink-3">
                  {sanitizedName.length === 0 ? "Name it to continue." : "Agent name should be at least 3 characters."}
                </span>
              ) : checking ? (
                <span className="text-2xs text-ink-3">Checking the name…</span>
              ) : taken ? (
                <span className="text-2xs text-rose-300">
                  {takenHere
                    ? `You already have an agent called “${sanitizedName}”.`
                    : `“${sanitizedName}” is already registered on Solana. Pick another name.`}
                </span>
              ) : existing.isError ? (
                // An errored lookup does not block the wizard — that is deliberate — but it says so:
                // rendering *nothing* would make "we could not check this name" and "this name is
                // free" the same clean step, and the person would go on through three steps, sign,
                // and see the deploy fail at `prepare` with "already registered".
                <span className="text-2xs text-amber-300">
                  This name could not be checked against the chain just now; a deploy will still refuse it if it is
                  taken.
                </span>
              ) : null}
              <Button onClick={() => setCurrentStep(2)} disabled={!named || checking || taken} icon={<ArrowIcon />}>
                Budget and policy
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* STEP 2: MODEL, BUDGET, TOOLS */}
      {currentStep === 2 && (
        <Card
          title={
            <>
              Budget and policy
              <Info label="What this step commits" testId="wizard-policy-info">
                <p>
                  The model and tools are committed in the policy hash; the budget is an allowance your wallet grants
                  the runtime.
                </p>
              </Info>
            </>
          }
          right={<span className="num text-xs text-ink-3">{shownTools.length} tools allowed</span>}
        >
          <div className="space-y-6">
            <InfoField
              label="Model"
              htmlFor={modelId}
              infoLabel="What the model field is"
              infoTestId="wizard-model-info"
              info={
                <>
                  <p>An OpenRouter slug.</p>
                  <p>
                    Pricing and context limits are the model&apos;s to state; the runtime meters each call by the
                    voucher it paid over Tempo.
                  </p>
                </>
              }
            >
              <select id={modelId} value={model} onChange={(e) => setModel(e.target.value)} className="input-mono h-10">
                {["deepseek/deepseek-v4.1-flash"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </InfoField>

            <div className="space-y-4 border-t border-line/[0.08] pt-5">
              <div className="flex items-end justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <div className="text-xs font-medium text-ink-2">Agent budget</div>
                  <Info label="What the budget caps" testId="wizard-budget-info">
                    <p>The cap on what this agent may meter against your escrow.</p>
                  </Info>
                </div>
                <span className="num text-xl font-semibold text-ink-1">
                  {budgetShown} <span className="text-xs font-normal text-ink-3">USDC</span>
                </span>
              </div>

              {/* To 50, the largest chip below: a slider to 100 would offer twice what any chip
                  does. A larger cap is the custom box's to type. */}
              <input
                type="range"
                min="0.25"
                max={BUDGET_SLIDER_MAX}
                step="0.25"
                value={budgetValid ? budgetCapUsdc : "0.25"}
                onChange={(e) => setBudgetCapUsdc(e.target.value)}
                aria-label="Budget in USDC"
              />

              <div className="flex flex-wrap items-center gap-1.5">
                {BUDGET_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setBudgetCapUsdc(p)}
                    aria-pressed={budgetCapUsdc === p}
                    className="chip"
                  >
                    {p}
                  </button>
                ))}
                <div className="relative ml-1">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0.25"
                    step="0.25"
                    value={BUDGET_PRESETS.includes(budgetCapUsdc) ? "" : budgetCapUsdc}
                    onChange={(e) => setBudgetCapUsdc(e.target.value)}
                    placeholder="custom"
                    aria-label="Custom budget in USDC"
                    className={`input-mono h-7 w-32 pr-12 text-xs ${
                      BUDGET_PRESETS.includes(budgetCapUsdc) ? "" : "border-accent/50 text-accent-strong"
                    }`}
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-ink-3">
                    USDC
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <div className="text-xs font-medium text-ink-2">Duration</div>
                  {/* Said in the ⓘ, not under the chips when Indefinite is picked. */}
                  <Info label="What Indefinite writes" testId="wizard-duration-info">
                    <p>
                      With Indefinite, the cap is what bounds this agent&apos;s spending. The billing program requires a
                      date, so the grant is written a hundred years out; revoke it any time from the agent&apos;s
                      Allowance panel.
                    </p>
                  </Info>
                </div>
                <div className="grid gap-2 sm:grid-cols-4">
                  {[
                    { days: INDEFINITE_DAYS, label: "Indefinite" },
                    { days: 7, label: "7 days" },
                    { days: 30, label: "30 days" },
                    { days: 90, label: "90 days" },
                  ].map((dur) => {
                    const active = expirationDays === dur.days;
                    return (
                      <button
                        key={dur.days}
                        type="button"
                        onClick={() => setExpirationDays(dur.days)}
                        aria-pressed={active}
                        className={`rounded-lg border px-3 py-2 text-center text-xs font-medium transition-colors ${
                          active
                            ? "border-accent/50 bg-accent/[0.08] text-ink-1"
                            : "border-line/[0.1] text-ink-2 hover:border-line/[0.2] hover:text-ink-1"
                        }`}
                      >
                        {dur.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="space-y-3 border-t border-line/[0.08] pt-5">
              <div className="text-xs font-medium text-ink-2">Tools</div>

              <ul className="divide-y divide-line/[0.06] overflow-hidden rounded-lg border border-line/[0.08]">
                {offeredTools.map((tool) => {
                  const isChecked = selectedTools.includes(tool.id);
                  return (
                    <li key={tool.id}>
                      <button
                        type="button"
                        onClick={() => toggleTool(tool.id)}
                        aria-pressed={isChecked}
                        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                          isChecked ? "bg-accent/[0.05] hover:bg-accent/[0.08]" : "hover:bg-line/[0.03]"
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 flex-none items-center justify-center rounded border ${
                            isChecked
                              ? "border-accent bg-accent text-neutral-950"
                              : "border-line/[0.2] text-transparent"
                          }`}
                        >
                          <CheckIcon />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-medium text-ink-1">{tool.name}</span>
                          <span className="mt-0.5 block text-2xs text-ink-3">{tool.description}</span>
                        </span>
                        <Badge tone={isChecked ? "good" : "neutral"}>{isChecked ? "allowed" : "excluded"}</Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="rounded-lg border border-spine-green/20 bg-spine-green/[0.05] p-3">
                <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-spine-green">
                  Always allowed
                </div>
                <ul className="space-y-1">
                  {CHAIN_READ_TOOLS.map((tool) => (
                    <li key={tool.id} className="flex items-baseline gap-2 text-2xs">
                      <span className="text-spine-green">
                        <CheckIcon />
                      </span>
                      <span className="font-medium text-ink-1">{tool.name}</span>
                      <span className="min-w-0 flex-1 truncate text-ink-3">{tool.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-line/[0.08] pt-4">
              <Button onClick={() => setCurrentStep(1)} variant="ghost">
                Back
              </Button>
              <Button
                onClick={() => setCurrentStep(withLoop ? LOOP_STEP : REVIEW_STEP)}
                disabled={!budgetValid}
                icon={<ArrowIcon />}
              >
                {withLoop ? "Agent loop" : "Review and deploy"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* STEP 3 WITH A LOOP: the loop's terms. Mounted from the start and hidden off its step, so going
          back to the policy or on to the review keeps what was typed (the form reads its terms in
          `useState` initialisers). The agent's id is the one its name derives, as the deploy's will. */}
      {withLoop && (
        <div className={currentStep === LOOP_STEP ? "" : "hidden"}>
          <Card
            title="Agent loop"
            description="What the agent works toward, how often it steps and the loop's budget. It starts with the deploy."
          >
            <div className="space-y-5" data-testid="wizard-loop-step">
              <LoopStartForm
                agentId={hex(ownerIdBytes)}
                agentName={sanitizedName || "this agent"}
                model={model}
                agentTools={selectedTools}
                onTerms={setLoopTerms}
              />
              <div className="flex items-center justify-between border-t border-line/[0.08] pt-4">
                <Button onClick={() => setCurrentStep(2)} variant="ghost">
                  Back
                </Button>
                <Button
                  onClick={() => setCurrentStep(REVIEW_STEP)}
                  disabled={!loopTerms.request}
                  icon={<ArrowIcon />}
                  testId="wizard-loop-next"
                >
                  Review and deploy
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* REVIEW & DEPLOY */}
      {currentStep === REVIEW_STEP && (
        <Card
          // The how in the ⓘ, the one thing the person does in the line.
          title={
            <>
              Review and deploy
              <Info label="What the deploy does" testId="wizard-deploy-info">
                <p>
                  One registration by this server&apos;s runtime key, then one allowance transaction your wallet signs.
                  The server gives the agent&apos;s key about 0.01 SOL for fees; the USDC cap below is the budget it
                  runs on.
                </p>
              </Info>
            </>
          }
          description="One transaction your wallet signs."
        >
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="well p-4">
                <div className="mb-3 flex items-center justify-between border-b border-line/[0.08] pb-2">
                  <span className="text-xs font-semibold text-ink-1">Identity</span>
                  <Badge tone="cyan">agent</Badge>
                </div>
                <KV
                  items={[
                    {
                      label: "Name",
                      value: <span className="font-mono text-xs font-medium text-ink-1">{sanitizedName}</span>,
                    },
                    {
                      label: "Id",
                      value: <span className="font-mono text-xs text-accent-strong">{ownerIdHex.slice(0, 16)}…</span>,
                    },
                    // Where the form was filled from: a source of the wallet's own is extended,
                    // not copied. Off for a blank start, and off
                    // for a source with no template to append to.
                    ...(lineageLine(draft?.lineage, forkTemplate)
                      ? [
                          {
                            label: "From",
                            value: (
                              <span className="text-xs text-ink-1" data-testid="lineage-line">
                                {lineageLine(draft?.lineage, forkTemplate)}
                              </span>
                            ),
                          },
                        ]
                      : []),
                    {
                      label: "Operated by",
                      value: (
                        <span
                          className={`font-mono text-xs ${runtimeAuthority ? "text-spine-green" : "text-amber-300"}`}
                        >
                          {runtimeAuthority ? `${runtimeAuthority.slice(0, 8)}…` : "no runtime on this server"}
                        </span>
                      ),
                    },
                  ]}
                />
              </div>

              <div className="well p-4">
                <div className="mb-3 border-b border-line/[0.08] pb-2">
                  <span className="text-xs font-semibold text-ink-1">Policy and budget</span>
                </div>
                <KV
                  items={[
                    { label: "Model", value: <span className="font-mono text-xs text-ink-1">{model}</span> },
                    {
                      label: "Tools",
                      value: (
                        <span className="num text-xs text-ink-1">
                          {grantedTools.length} granted{" "}
                          <span className="text-ink-3">+ {CHAIN_READ_IDS.length} reads</span>
                        </span>
                      ),
                    },
                    {
                      label: "Budget cap",
                      value: <span className="num text-xs font-medium text-ink-1">{budgetCapUsdc} USDC</span>,
                    },
                    {
                      label: "Expiry",
                      value:
                        expirationDays === INDEFINITE_DAYS ? (
                          <span className="text-xs text-ink-3">none</span>
                        ) : (
                          <span className="num text-xs text-ink-1">{expirationDays} days</span>
                        ),
                    },
                    {
                      // The first thing to make clear about money: who a model
                      // call is paid to, and on which chain.
                      label: "Model calls",
                      value: (
                        <span className="text-xs text-ink-1" data-testid="deploy-rail">
                          {billed ? (
                            <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
                              <span className="inline-flex items-center gap-1 font-medium">
                                OpenRouter via Tempo
                                <OpenRouterMark title="OpenRouter" />
                                <TempoMark title="Tempo" />
                              </span>
                              {/* No channel exists before the first paid call, so the link is the
                                  treasury that will open it: its channels and closes are listed there. */}
                              {tempoTreasury.data?.address && (
                                <span className="inline-flex items-center gap-1 text-ink-3">
                                  paid by
                                  <TempoLink
                                    kind="address"
                                    value={tempoTreasury.data.address}
                                    label="Lath's treasury"
                                    testId="deploy-rail-treasury"
                                  />
                                </span>
                              )}
                            </span>
                          ) : treasuryUnreachable ? (
                            "unknown — the treasury route did not answer"
                          ) : (
                            "nothing — this deployment runs the scripted transport"
                          )}
                        </span>
                      ),
                      // Billed, the value says it all; the other two branches are the ones that need a reason.
                      hint: billed
                        ? undefined
                        : treasuryUnreachable
                        ? `the treasury route did not answer (${treasuryUnreachable})`
                        : "no treasury is configured, so no call can be billed",
                    },
                  ]}
                />
              </div>
            </div>

            {/* The one lineage choice the builder offers, and only where there is a lineage to
                choose about: a source of this wallet's own that resolved to a template. It is a
                checkbox and not a pair of radios because there is a default (append) and an
                exception, not two equal paths. Hidden once the deploy has landed — the lineage is
                written by then, and an inert control that still toggles would read as undone. */}
            {/* The loop this deploy carries, in one line before the signature that starts it: the terms on
                screen are the terms signed. */}
            {withLoop && loopTerms.request && (
              <div className="well space-y-1 p-4 text-xs" data-testid="wizard-review-loop">
                <div className="text-2xs font-medium text-ink-3">Agent loop · starts with the deploy</div>
                <p className="line-clamp-3 text-ink-1">{loopTerms.request.prompt}</p>
                <p className="num text-ink-2">
                  up to {loopTerms.request.maxSteps} steps, every {Math.round(loopTerms.request.intervalMs / 1000)} s,
                  budget {formatUsdc(BigInt(loopTerms.request.budgetMicroUsdc))} USDC
                  {loopTerms.request.goalCheck ? " · the decision model checks the goal" : ""}
                </p>
              </div>
            )}

            {lineage && !deployed && (
              <div className="flex items-center gap-2 rounded-lg border border-line/[0.08] p-3">
                <button
                  type="button"
                  onClick={() => setForkTemplate(!forkTemplate)}
                  aria-pressed={forkTemplate}
                  data-testid="lineage-fork"
                  className={`flex min-w-0 flex-1 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    forkTemplate ? "border-amber-400/40 bg-amber-400/[0.06]" : "border-line/[0.08] hover:bg-line/[0.03]"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 flex-none items-center justify-center rounded border ${
                      forkTemplate
                        ? "border-amber-400 bg-amber-400 text-neutral-950"
                        : "border-line/[0.2] text-transparent"
                    }`}
                  >
                    <CheckIcon />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-ink-1">Fork into a new template</span>
                  </span>
                  <Badge tone={forkTemplate ? "warn" : "neutral"}>{forkTemplate ? "fork" : "append"}</Badge>
                </button>
                {/* What the tick costs: the registry reads as one template with many versions and many
                    runs, or as two lineages that never meet again. In an ⓘ beside the box, not a
                    paragraph under it; outside the button,
                    so opening it never flips the choice. */}
                <Info label="What forking changes" testId="lineage-fork-info" wide>
                  <p>
                    Left off, this deploy is another version of {lineage.sourceName} — one template, its versions, and
                    every run made from them under one name. Ticked, it starts a template of its own, which records
                    where it was copied from and then goes its own way.
                  </p>
                </Info>
              </div>
            )}

            <div className="border-t border-line/[0.08] pt-4">
              {!deployed ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Button onClick={() => setCurrentStep(withLoop ? LOOP_STEP : 2)} variant="ghost">
                    Back
                  </Button>
                  <div className="flex flex-col items-end gap-1.5">
                    <Button
                      onClick={handleDeploy}
                      loading={isDeploying}
                      disabled={
                        isDeploying ||
                        !publicKey ||
                        !runner.data?.ready ||
                        !named ||
                        taken ||
                        !budgetValid ||
                        (withLoop && !loopTerms.request)
                      }
                      size="lg"
                      testId="wizard-deploy"
                    >
                      {isDeploying
                        ? "Waiting for the wallet…"
                        : withLoop
                        ? "Deploy agent and start loop"
                        : "Deploy agent"}
                    </Button>
                    {!publicKey ? (
                      <span className="text-2xs text-ink-3">Connect a wallet to sign the deploy.</span>
                    ) : !runner.data?.ready && !runner.isLoading ? (
                      <span className="text-2xs text-amber-300">
                        This server runs no agents: {runner.data?.reason ?? "no runtime keypair"}.
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {alreadyYours ? (
                    // Not *deployed ✓ confirmed*: nothing was deployed. The agent is this wallet's
                    // already, and what the form holds was not applied to it.
                    <Note tone="neutral">
                      <p data-testid="deploy-already-yours">
                        You already have an agent called {sanitizedName}. Nothing was signed, and nothing on this form
                        was applied — its prompt, policy and cap are the ones it was deployed with; change them from its
                        page.
                      </p>
                    </Note>
                  ) : (
                    <Note tone="good">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">Agent deployed on Solana</span>
                        <Badge tone="good" dot>
                          confirmed
                        </Badge>
                      </div>
                      <div className="mt-2 space-y-1 font-mono">
                        {registrationSignature && (
                          <div>
                            <span className="text-spine-green/70">registration </span>
                            <ExplorerLink kind="tx" value={registrationSignature} />
                          </div>
                        )}
                        {deploymentSignature && (
                          <div>
                            <span className="text-spine-green/70">allowance </span>
                            <ExplorerLink kind="tx" value={deploymentSignature} />
                          </div>
                        )}
                      </div>
                    </Note>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/agent/${deployedId}`}>
                      <Button variant="primary" icon={<ArrowIcon />}>
                        Open {sanitizedName}
                      </Button>
                    </Link>
                    {/* A loop is started from the agent it runs, never from the deploy: one job per
                        screen, and the deploy's one signature is the deploy's. Straight to the loop
                        form on this agent: the agent page links to the same form, so going through
                        it would be one hop more. */}
                    <Link href={`/create?loop=1&agent=${deployedId}`}>
                      <Button variant="secondary" icon={<ArrowIcon />} testId="open-agent-loop">
                        Run as agent loop
                      </Button>
                    </Link>
                    {/* The workspace's list, which `/agents` redirects to. */}
                    <Link href="/">
                      <Button variant="ghost">All agents</Button>
                    </Link>
                  </div>
                </div>
              )}

              {deploymentNote && (
                <div className="mt-3">
                  <Note tone="warn">{deploymentNote}</Note>
                </div>
              )}
              {deploymentError && (
                <div className="mt-3">
                  <ErrorNote>{deploymentError}</ErrorNote>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
