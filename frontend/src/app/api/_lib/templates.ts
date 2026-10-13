/**
 * Templates: the config half of an agent and of a loop.
 *
 * A run is a fact and a template is a document. A deployed agent and a `LoopRecord` are
 * produced once and never edited; the template they came from is editable, versioned, and
 * points at nothing on chain. Editing one writes a new version and touches no run; archiving
 * one hides it and leaves every run it produced verifiable, because the chain never referenced
 * the template — only the hashes of what a session committed.
 *
 * What the hash is and is not: `hash` is the content address of `config` alone — no owner, no
 * id, no timestamps — so two people who write the same config get the same bytes. It is the
 * console's lineage key. It is *not* a chain fact: a session commits `policy_version_hash`,
 * built from what that session ran with, and two runs from one template can already commit
 * different hashes.
 *
 * The store is `LATH_TRACE_DIR/templates.json`, `{ [id]: version[] }`, read and written through
 * `json-store.ts` as `agents.json` is. A write appends; nothing here overwrites
 * a version, so a run's `{ id, version, hash }` always resolves to the config it ran under.
 */
import * as path from "path";
import { hex, idFromString, sha256, utf8, type GateConfig, type TraceStore } from "@lath/sdk";
import { canonicalJson, promptHash } from "@lath/runtime";
import type { LoopWorkersConfig, SandboxConfig } from "../../../types/loop";
import { TRACE_DIR, rateLimit, rateLimited, type DeployedAgent } from "./runner";
import { readJsonOr, writeJsonAtomic } from "./json-store";

/**
 * The hundred-year grant the billing program needs in place of a "never" sentinel: an allowance
 * with no expiry has to carry *some* unix second, and this is the one every path uses.
 *
 * It lives here, in the leaf, rather than in `../templates/validate` where it is re-exported
 * from. `validate.ts` imports `_lib/loops.ts` for the run's bounds, and `loops.ts` imports most of
 * `_lib`, so anything under that chain that reaches back for this constant joins a module cycle — and a
 * cycle is fine until something reads a `const` across it at module scope, which is a TDZ crash that
 * only webpack's graph produces and no node test reproduces: a module that does so 500s every route
 * that loads it.
 */
export const MAX_EXPIRATION_DAYS = 36_500;

/**
 * The smallest allowance the wizard will submit (`CreatorWizard.tsx`, `budgetValid`), and so the
 * floor both a deploy's config (`../templates/validate`) and a copy's own terms (`copy.ts`) hold
 * a budget cap to. Here, in the leaf, for the reason `MAX_EXPIRATION_DAYS` is.
 */
export const MIN_BUDGET_CAP_USDC = 0.25;

// ─── Records ────────────────────────────────────────────────────────────────

export interface TemplateBase {
  /** `tpl-<hash16 of owner:name:createdAt>`, minted the way loop ids are. Stable across versions. */
  id: string;
  kind: "agent" | "loop";
  /** Base58 of the wallet that signed the write. */
  owner: string;
  /** Display name of the template, not of the agent a run deploys under. */
  name: string;
  /** 1, 2, …; a write is a new version, never an overwrite. */
  version: number;
  /** `sha256(canonicalJson(config))`, hex — the content address of the config below. */
  hash: string;
  clonedFrom?: { id: string; version: number };
  /** Unix ms the template was archived. Archived templates are hidden, never deleted. */
  archivedAt?: number;
  /** Unix ms this version was written; the first version's value mints the id. */
  createdAt: number;
}

/** What a deployed agent runs under. `prompt` is absent while the system prompt is hardcoded. */
export interface AgentTemplateConfig {
  prompt?: string;
  model: string;
  tools: string[];
  budgetCapUsdc: string;
  expirationDays: number;
  /**
   * How the agent's inference is paid for. Absent means the default, which `railFor` computes per
   * agent. A marketplace listing, a roadmap feature, carries it in its manifest's `config` only as
   * `"tempo"`, and an older listing carries no config at all, so no manifest on chain names a rail.
   *
   * `"vault"` is readable and not writable (`templates/validate.ts`): older template versions carry
   * it, and their bytes are their hash, so they must not move. An explicit `"vault"` hashes as
   * absent, so such a version launches and runs like any other, and a listing of it names no rail.
   */
  payment?: "vault" | "tempo";
}

/** What a slot in a loop points at. */
export type AgentRef = { agentId: string } | { template: string; version?: number; count?: number } | { offer: string };

export interface LoopTemplateConfig {
  prompt: string;
  /** 0 = back to back. */
  intervalMs: number;
  maxSteps: number;
  /**
   * The loop's one overall budget, micro-USDC. Absent on an older version — its bytes are its hash —
   * and a start from one derives the budget from `budgetMicroUsdcPerStep` and its team's per-task
   * figure (`checkLoopBudget`).
   */
  budgetMicroUsdc?: string;
  /**
   * The per-step budget on an older version; on one that carries `budgetMicroUsdc`, the derived
   * `floor(budgetMicroUsdc / maxSteps)`, kept so every reader that requires the key still reads it.
   */
  budgetMicroUsdcPerStep: string;
  model?: string;
  coordinator: AgentRef;
  /**
   * Members are agents the owner holds. An older row may carry a retired mode and an `{ offer }` ref;
   * it is read back as written and nothing starts it.
   */
  members: { ref: AgentRef; mode: "owned"; task?: string }[];
  /**
   * The second model each step's output is judged by before it becomes memory, and the bar its
   * confidence must clear. Stored resolved, never as `true`.
   *
   * The key is **absent** when the loop did not ask for one, rather than `false` or a default:
   * `templateHash` drops `undefined`, so a version without it hashes as if the key did not exist,
   * and a run started from it keeps the template link it has.
   */
  verify?: { model: string; minConfidence: number };
  /**
   * What a run started from this version is working toward. A step whose answer says it is reached
   * ends the run.
   *
   * Absent when the version names none, and normalised to absent before hashing the way an
   * explicit `"vault"` payment is: `templateHash` drops `undefined`, so a loop template without a
   * goal hashes as if the key did not exist, and a *Run again* from one keeps the template link it
   * has. A goal is a term of the run, not a knob, which is why it lives here
   * and the trigger does not.
   */
  goal?: string;
  /**
   * Jev's goal check a run started from this version asks after each step, stored resolved like
   * `verify`. Absent when off, and `templateHash` drops `undefined`, so a version without the check
   * hashes as if the key did not exist and its runs keep their template link.
   */
  goalCheck?: { model: string; minConfidence: number };
  /**
   * The trace audit a run started from this version ran after each step, on an older version: the
   * reader's model and each picked behaviour's bar and action. The trace audit is a roadmap feature:
   * this build stores it on no version and starts no run from one that has it (`asksForTraceAudit`);
   * the type keeps it so such a version reads, and hashes, as it was stored. Absent on every other
   * version.
   */
  traceAudit?: { model: string; behaviours: Record<string, { bar: number; onPresent: "flag" | "stop" }> };
  /**
   * The team a run started from this version hands its tasks to, on an older version: teams are a
   * roadmap feature this build does not start. Stored as the **source** the start named — owned
   * agents, a blueprint and a count, or a policy and a count — never as the copies one wallet
   * happened to register, so a loop blueprint on the shelf resolves its team under the buyer's
   * wallet at launch rather than pointing at the author's agents.
   *
   * Absent when the version names no team, and normalised to absent before hashing the way
   * `goal` and an explicit `"vault"` payment are: `templateHash` drops `undefined`, so a loop
   * template without a team hashes as if the key did not exist, every run started from one keeps
   * its template link, and a start that sent `workers: undefined` reuses the same
   * implicit template a start that sent nothing minted.
   *
   * `members` above is a different thing and stays where it is: it is a retired member-slot shape,
   * refused non-empty by the validator, while this is the shape a team takes.
   */
  workers?: LoopWorkersConfig;
  /**
   * The gate a run started from this version looks through before each step, on an older version:
   * gates are a roadmap feature this build does not start. It holds the pinned model, the bar in
   * bps, the watch list, the fail mode and the heartbeat.
   *
   * Here although the trigger is not, and the difference is the one this interface's own rule
   * draws: the trigger is a knob, while the gate is policy — committed in `policy_version_hash`
   * the way `verify` and `goal` are — so it is a term of the run. A version that carries one asks
   * for the `gate` trigger, polling every `intervalMs`, which is the gated run's poll.
   *
   * Absent on every version without one, and `templateHash` drops `undefined`, so a loop template
   * without a gate hashes as if the key did not exist and its runs keep their template link.
   */
  gate?: GateConfig;
  /**
   * The sandbox every step of a run from this version opens: the tool
   * switches and the sources **as typed**, never what they resolved to — a run from this version
   * fetches them afresh at its own start and pins them again, so a version is a recipe for a sandbox
   * and not a copy of one run's files. A term like `gate`: the switches reach every step's policy
   * hash and the sources its posture.
   *
   * Absent on every version without one, normalised to absent by `checkSandboxConfig` when it says
   * only the host's defaults, and `templateHash` drops `undefined` — so a loop template without a
   * sandbox config hashes as if the key did not exist and its runs keep their template link.
   */
  sandbox?: SandboxConfig;
}

export interface AgentTemplate extends TemplateBase {
  kind: "agent";
  config: AgentTemplateConfig;
}

export interface LoopTemplate extends TemplateBase {
  kind: "loop";
  config: LoopTemplateConfig;
}

export type Template = AgentTemplate | LoopTemplate;

/** What a run records about the template version it came from. Optional on read: old rows have none. */
export interface TemplateLink {
  id: string;
  version: number;
  hash: string;
}

/** The three fields a run keeps, from a stored version. */
export function templateLink(t: Template): TemplateLink {
  return { id: t.id, version: t.version, hash: t.hash };
}

// ─── The hash ───────────────────────────────────────────────────────────────

/**
 * `sha256(canonicalJson(config))` in hex. `canonicalJson` (the runtime's, the same function
 * `policyVersionHash` hashes with) sorts keys and drops `undefined`, so a config with no prompt
 * hashes exactly as one whose prompt key is absent.
 */
export function templateHash(config: unknown): string {
  return hex(sha256(utf8(canonicalJson(config))));
}

// ─── The store ──────────────────────────────────────────────────────────────

const REGISTRY = () => path.join(TRACE_DIR, "templates.json");

/**
 * A stored version is a `Template` only if it has the keys the current code reads. A row that
 * does not is dropped rather than cast, for the reason `readLoops` drops one: a half-shaped
 * record reaches the console as a crash on a page, not as a missing row.
 */
function isTemplate(v: unknown): v is Template {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    (r.kind === "agent" || r.kind === "loop") &&
    typeof r.owner === "string" &&
    typeof r.name === "string" &&
    typeof r.version === "number" &&
    typeof r.hash === "string" &&
    typeof r.createdAt === "number" &&
    !!r.config &&
    typeof r.config === "object"
  );
}

const droppedTemplates = new Set<string>();

/**
 * An older loop version keeps its sandbox under `room`, and its `hash` was taken over that key. The
 * config is read under `sandbox` so nothing past here knows the older key, and the stored `hash` is
 * left as it was written, because it is what the runs linked to the version already carry. What
 * changes is only that saving such a version back unchanged appends a new version, because its
 * re-hash no longer matches: one extra row, once, per template.
 */
function withSandboxKey(t: Template): Template {
  if (t.kind !== "loop") return t;
  const { room, ...config } = t.config as LoopTemplateConfig & { room?: SandboxConfig };
  return room && !config.sandbox ? { ...t, config: { ...config, sandbox: room } } : t;
}

/**
 * id → its versions, ascending. The file is the only thing that survives a restart.
 *
 * Throws when the file exists and cannot be read or parsed, rather than answering `{}`: the
 * `recordTemplate` that follows a read writes the whole map back, so an empty answer to a
 * transient read failure was the next write saving an empty store over every template (A-2).
 * Only a missing file is empty (`readJsonOr`).
 */
export function readTemplates(): Record<string, Template[]> {
  const parsed = readJsonOr<unknown>(REGISTRY(), () => ({}));
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, Template[]> = {};
  const unread: Record<string, unknown> = {};
  for (const [id, versions] of Object.entries(parsed as Record<string, unknown>)) {
    // `JSON.parse` makes `__proto__` an own key, and assigning it would set a map's prototype
    // rather than add a row (`readLoops`). No minted id is spelled so, so the key is dropped.
    if (id === "__proto__") continue;
    const rows = Array.isArray(versions) ? versions : [];
    const kept = rows
      .filter(isTemplate)
      .map(withSandboxKey)
      .sort((a, b) => a.version - b.version);
    const skipped = rows.filter((v) => !isTemplate(v));
    // Kept aside whole when the value is not even a list, and version by version when it is.
    if (!Array.isArray(versions)) unread[id] = versions;
    else if (skipped.length) unread[id] = skipped;
    if (kept.length) out[id] = kept;
    else if (!droppedTemplates.has(id)) {
      droppedTemplates.add(id);
      console.warn(`[templates] ${id} in templates.json has no readable version; not read, and kept as it is`);
    }
  }
  if (Object.keys(unread).length > 0) unreadTemplates.set(out, unread);
  return out;
}

/**
 * What `readTemplates` could not read, keyed by the map it returned: under each id the versions
 * this build does not read, or the id's whole value when that is not a list. Merged back by
 * `writeTemplates`, the `unreadRows` of `loop-registry.ts`: every write here saves the whole map, so
 * without the merge a version stored in another shape, by another build or a hand edit, would be erased
 * by the next save of any template, though nothing had asked to remove it.
 */
const unreadTemplates = new WeakMap<object, Record<string, unknown>>();

/** Whether `id` holds anything `readTemplates` set aside, so a minted id does not land on it. */
function heldUnread(all: Record<string, Template[]>, id: string): boolean {
  const unread = unreadTemplates.get(all);
  return !!unread && Object.prototype.hasOwnProperty.call(unread, id);
}

/**
 * The highest `version` among the versions of `id` that were set aside, or 0. A new version is
 * numbered past them too, so it never shares a number with a stored version a later build reads.
 */
function unreadVersionCeiling(all: Record<string, Template[]>, id: string): number {
  const rows = heldUnread(all, id) ? unreadTemplates.get(all)![id] : undefined;
  let top = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = (r as { version?: unknown } | null)?.version;
    if (typeof v === "number" && Number.isFinite(v) && v > top) top = v;
  }
  return top;
}

/**
 * Atomic: write beside the file and rename, so a crash never leaves half a registry. What
 * `readTemplates` set aside goes back beside the versions the caller holds (`unreadTemplates`); an
 * id the caller no longer holds at all gets its set-aside value back as it was.
 */
function writeTemplates(all: Record<string, Template[]>): void {
  const unread = unreadTemplates.get(all);
  if (!unread) {
    writeJsonAtomic(REGISTRY(), all);
    return;
  }
  const merged: Record<string, unknown> = { ...all };
  for (const [id, rows] of Object.entries(unread)) {
    const held = Object.prototype.hasOwnProperty.call(all, id) ? all[id] : undefined;
    if (!held) merged[id] = rows;
    else if (Array.isArray(rows)) {
      const at = (v: unknown) => {
        const n = (v as { version?: unknown } | null)?.version;
        return typeof n === "number" && Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
      };
      // Ascending, as the file has always been written; a row with no number goes last.
      merged[id] = [...rows, ...held].sort((a, b) => at(a) - at(b));
    }
  }
  writeJsonAtomic(REGISTRY(), merged);
}

// ─── What bounds the store ──────────────────────────────────────────────────

/**
 * A template write is a file write, not a chain write, so these bound the store rather than a
 * cost. A wallet gets a few dozen writes an hour; the server as a whole gets a few wallets'
 * worth. The second exists because the first alone bounds nothing: a `"Lath template"` signature
 * needs only a fresh keypair, and a fresh keypair is a fresh per-wallet bucket, so 5 000 writes
 * from 5 000 minted wallets would be 5 000 writes, none refused, and megabytes of `templates.json`.
 * The server bucket is a constant, not an env var, because
 * nothing legitimate on this console writes templates by hand at that rate: the deploys and loop
 * starts that write implicit templates are behind their own, costlier buckets and never reach it.
 */
export const TEMPLATE_WRITES_PER_HOUR = Number(process.env.LATH_TEMPLATE_WRITES_PER_HOUR ?? 30);
export const TEMPLATE_WRITES_PER_HOUR_SERVER = 120;

/**
 * How many template ids one wallet may own, archived ones included. An archive is a free
 * owner-signed write, so a cap that excluded archived ids would be emptied for nothing, and an
 * archived version stays in the file, which is what the cap bounds. Two hundred is far past what
 * a person writes by hand — a season of daily edits is versions on a few ids, not new ids — and
 * applies to the signed route alone: an implicit template a deploy or a loop start mints lands
 * after a chain write that must be recorded (`agents/route.ts` `templateForDeploy`), so a
 * refusal there would orphan an agent, and those paths are already behind buckets that cost the
 * operator SOL.
 */
export const TEMPLATES_PER_OWNER = 200;

/**
 * The hourly write quota for the signed route, as a refusal or null: the server-wide bucket
 * `templates:server`, then the wallet's. Both are asked before either is stamped, as
 * `chargeListingRead` does it, so a write the wallet's bucket refuses has not spent the server's.
 * The server's is asked first so that a server at its ceiling says so, rather than telling a
 * wallet with writes to spare that it is out of them.
 */
export function chargeTemplateWrite(wallet: string, ip: string): string | null {
  const buckets: [string, string, number][] = [
    ["template writes on this server", "templates:server", TEMPLATE_WRITES_PER_HOUR_SERVER],
    ["template writes", `template:${wallet}:${ip}`, TEMPLATE_WRITES_PER_HOUR],
  ];
  for (const [what, key, perHour] of buckets) {
    const refused = rateLimited(what, key, perHour);
    if (refused) return refused;
  }
  for (const [what, key, perHour] of buckets) rateLimit(what, key, perHour);
  return null;
}

/** Why `owner` may not mint another template id, or null when it may. Versions of an id it owns are not counted. */
export function templateCapRefusal(owner: string): string | null {
  let owned = 0;
  for (const versions of Object.values(readTemplates())) if (versions[0].owner === owner) owned += 1;
  return owned >= TEMPLATES_PER_OWNER
    ? `this wallet already has ${TEMPLATES_PER_OWNER} templates; write a new version of one of them instead (a PUT to an archived id picks it back up)`
    : null;
}

/**
 * The versions stored under `id`, own keys only. `readTemplates()` is a plain object, so an id of
 * `constructor` or `toString` would read `Object`'s own function back as a version list and the route
 * would answer 500 on a `.map` (`lookupAgent` in `runner.ts` guards the same way). An id that is not
 * stored is not a template, whatever the prototype says.
 */
function versionsOf(all: Record<string, Template[]>, id: string): Template[] | undefined {
  return Object.prototype.hasOwnProperty.call(all, id) ? all[id] : undefined;
}

/** One version: the given one, or the latest when `version` is omitted. */
export function lookupTemplate(id: string, version?: number): Template | null {
  const versions = versionsOf(readTemplates(), id);
  if (!versions?.length) return null;
  if (version === undefined) return versions[versions.length - 1];
  return versions.find((t) => t.version === version) ?? null;
}

/** Every version of one template, ascending. */
export function templateVersions(id: string): Template[] {
  return versionsOf(readTemplates(), id) ?? [];
}

export interface TemplateWrite {
  /** Omitted for a new template; given to append a version to an existing one. */
  id?: string;
  kind: Template["kind"];
  owner: string;
  name: string;
  config: AgentTemplateConfig | LoopTemplateConfig;
  clonedFrom?: { id: string; version: number };
}

/**
 * Appends a version and returns it. With no `id` this mints one and writes version 1; with an
 * `id` that exists it writes version n+1 and keeps the id's `kind` and owner — a template's
 * history is its own, and nothing here rewrites a version that a run already points at.
 */
export function recordTemplate(write: TemplateWrite): Template {
  const all = readTemplates();
  const existing = write.id ? versionsOf(all, write.id) : undefined;
  const previous = existing?.[existing.length - 1];
  // The id is minted from `owner:name:createdAt`, the way loop ids are, so two templates one
  // wallet wrote under one name in the same millisecond would mint the same id; the stamp is
  // moved on until the id is free rather than letting the second write land on the first's
  // history. `createdAt` is therefore the version's stamp, not a claim about the clock.
  let createdAt = Date.now();
  let minted = `tpl-${hex(idFromString(`${write.owner}:${write.name}:${createdAt}`)).slice(0, 16)}`;
  while (!previous && (versionsOf(all, minted) || heldUnread(all, minted))) {
    createdAt += 1;
    minted = `tpl-${hex(idFromString(`${write.owner}:${write.name}:${createdAt}`)).slice(0, 16)}`;
  }
  const id = previous ? previous.id : minted;
  const record = {
    id,
    kind: previous ? previous.kind : write.kind,
    owner: previous ? previous.owner : write.owner,
    name: write.name,
    version: previous ? Math.max(previous.version, unreadVersionCeiling(all, id)) + 1 : 1,
    hash: templateHash(write.config),
    ...(write.clonedFrom ? { clonedFrom: write.clonedFrom } : {}),
    // A new version un-archives the id. Carrying `archivedAt` forward would make an archive
    // permanent — there is no un-archive verb — and make the deploy route's own advice
    // ("archived; write a new version to deploy from it") impossible to follow. The versions
    // written before the archive keep their stamp, so what was put away stays put away; writing
    // to the id again is the owner picking it back up.

    createdAt,
    config: write.config,
  } as Template;
  all[id] = [...(existing ?? []), record];
  writeTemplates(all);
  return record;
}

/**
 * Archives every version of a template: the id is what a person archives, not one version of
 * it. Nothing is deleted — a run points at a version, and the console has to be able to say
 * what that run was configured with after the template is gone from the lists.
 */
export function archiveTemplate(id: string, at: number = Date.now()): Template[] | null {
  const all = readTemplates();
  const versions = versionsOf(all, id);
  if (!versions?.length) return null;
  all[id] = versions.map((t) => ({ ...t, archivedAt: t.archivedAt ?? at }));
  writeTemplates(all);
  return all[id];
}

/** The latest version of every template this owner has, excluding archived ones. */
export function ownedTemplates(owner?: string): { latest: Template; versions: number }[] {
  return Object.values(readTemplates())
    .map((versions) => ({ latest: versions[versions.length - 1], versions: versions.length }))
    .filter(({ latest }) => !latest.archivedAt && (owner ? latest.owner === owner : true))
    .sort((a, b) => b.latest.createdAt - a.latest.createdAt);
}

/**
 * The owner's newest non-archived template of this kind whose config hashes the same, if there
 * is one. What makes an implicit template cheap: deploying the same config twice links both
 * runs to one template instead of filling the store with identical rows.
 */
export function findTemplateByHash(owner: string, kind: Template["kind"], hash: string): Template | null {
  for (const { latest } of ownedTemplates(owner)) {
    if (latest.kind === kind && latest.hash === hash) return latest;
  }
  return null;
}

/**
 * Which version of its own template may an agent be repointed at? The version, or why not.
 *
 * Here rather than in `POST /api/agents/:id` for the reason `copyContext` is in `_lib/copy.ts`:
 * a route that imports `next/server` cannot be loaded outside `frontend/`, and this is a rule
 * worth testing (`tests/console-clone.ts`).
 *
 * The archive check matches the other two routes: `POST /api/agents` refuses a deploy from an
 * archived version and `loopStartTemplate` refuses a loop start from one. A `useVersion` that
 * accepted it would make one stamp mean three different things depending on which route read it,
 * and an agent could be pointed at a configuration neither of the other two would start, whose
 * policy hash its next session would then commit. The refusal sentence is the one the other two
 * give, and since a new version un-archives the id it is advice that can actually be followed.
 */
export function useVersionContext(
  link: TemplateLink | undefined,
  version: number | undefined
): { template: AgentTemplate } | { error: string; status: number } {
  if (!link) return { error: "this agent was deployed without a template, so it has no version to use", status: 409 };
  if (!Number.isInteger(version) || (version as number) < 1) {
    return { error: "version is a positive integer", status: 400 };
  }
  const wanted = lookupTemplate(link.id, version);
  if (!wanted || wanted.kind !== "agent") {
    return { error: `${link.id} has no agent version ${version}`, status: 404 };
  }
  if (wanted.archivedAt) {
    return { error: `${link.id} v${wanted.version} is archived; write a new version to use it`, status: 409 };
  }
  return { template: wanted };
}

/**
 * The template an implicit write links a run to: the owner's existing one with this config, or
 * a new one. Called by `POST /api/agents` and by loop start, so that every run has a template
 * even when the request carried no `templateId`.
 */
export function implicitTemplate(write: TemplateWrite): Template {
  const found = findTemplateByHash(write.owner, write.kind, templateHash(write.config));
  return found ?? recordTemplate({ ...write, id: undefined });
}

// ─── Append, don't fork ─────────────────────────────────────────────────────

/** Why a template cannot be appended to. The shape `_lib/loop-terms.ts` calls a `Refusal`, so a route
 * answers with it unchanged rather than translating one error vocabulary into another. */
export interface TemplateRefusal {
  error: string;
  status: number;
}

export interface AppendOptions {
  kind: Template["kind"];
  /** The name a *mint* or a *fork* takes. An append ignores it — see `appendOrMint`. */
  name: string;
  /** Start a separate lineage instead of extending this one. */
  fork?: boolean;
}

/** The version that was appended or minted, and whether a version was actually written. */
export type AppendResult = { template: Template; appended: boolean } | TemplateRefusal;

/**
 * May this wallet append to this template? The version to append after, or why not.
 *
 * Separate from `appendOrMint` because the answer is needed *before* the work a deploy or a loop
 * start does — a 403 is worth giving before a transaction is prepared, not after one has landed
 * — and because it is the whole of the ownership rule in one testable place. Another wallet's
 * template is refused outright: naming someone else's template id is never a way to write to it.
 *
 * An archived template is *not* refused here. `recordTemplate` un-archives the id it writes to,
 * and "archived; write a new version" is the advice both deploy and loop start already give, so
 * appending to one is the owner following that advice rather than going around it.
 */
export function templateForAppend(
  owner: string,
  templateId: string,
  version: number | undefined,
  kind: Template["kind"]
): { template: Template } | TemplateRefusal {
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    return { error: "version is a positive integer", status: 400 };
  }
  const found = lookupTemplate(templateId, version);
  if (!found) {
    return { error: `no template ${version === undefined ? templateId : `${templateId} v${version}`}`, status: 404 };
  }
  if (found.kind !== kind) return { error: `${templateId} is a ${found.kind} template`, status: 400 };
  if (found.owner !== owner) return { error: `${templateId} belongs to another wallet`, status: 403 };
  return { template: found };
}

/**
 * What the builder does with a configuration the caller edited: **append a version, do not fork**.
 *
 * Four outcomes, in the order they are decided:
 *
 * - no `templateId` — the caller started from nothing, so this is the implicit write: the owner's
 *   template with this config, or a new one.
 * - `fork` — a fresh template carrying `clonedFrom`, the opt-in escape hatch and the only path
 *   here that starts a second lineage. Minted with `recordTemplate`
 *   and not `implicitTemplate`, because the dedupe would find the source itself and hand back
 *   the very template the caller asked to fork away from.
 * - the config already hashes to the named version's (or the latest's) — nothing to record. One
 *   deploy from an unedited template is a *run* of it, and a version that differs from its
 *   predecessor in no byte is lineage noise.
 * - anything else — version n+1 of the same id.
 *
 * The name is the template's own, taken from its first version: a template keeps the name of the
 * first agent deployed from it, so an append never renames — which is what
 * makes *appends v‹n+1› to ‹name›* on the review step true of what the server will write.
 *
 * The one exception to "same hash, no write" is an archived id: there the version is written even
 * though its bytes repeat the last one, because that write is what brings the id back into the
 * lists and there is no un-archive verb to do it with.
 */
export function appendOrMint(
  owner: string,
  templateId: string | undefined,
  version: number | undefined,
  config: AgentTemplateConfig | LoopTemplateConfig,
  opts: AppendOptions
): AppendResult {
  if (!templateId) {
    return { template: implicitTemplate({ kind: opts.kind, owner, name: opts.name, config }), appended: false };
  }
  const resolved = templateForAppend(owner, templateId, version, opts.kind);
  if ("error" in resolved) return resolved;
  const source = resolved.template;

  if (opts.fork) {
    const forked = recordTemplate({
      kind: opts.kind,
      owner,
      name: opts.name,
      config,
      clonedFrom: { id: source.id, version: source.version },
    });
    return { template: forked, appended: false };
  }

  if (source.hash === templateHash(config) && !source.archivedAt) return { template: source, appended: false };

  const first = templateVersions(source.id)[0] ?? source;
  const next = recordTemplate({ id: source.id, kind: opts.kind, owner, name: first.name, config });
  return { template: next, appended: true };
}

// ─── The system prompt a template carries ───────────────────────────────────

/**
 * The system prompt a session on this agent runs, and what its policy commits about it.
 *
 * A deployed agent whose linked template carries `config.prompt` runs that prompt and commits
 * `promptHash` inside `policy_version_hash`, so two sessions under different prompts are
 * distinguishable from their genesis records alone. Everything else runs `fallback`, unhashed:
 * the hardcoded prompts are not hashed, and hashing them would move the genesis hash of every agent
 * already deployed.
 *
 * `PolicyRegistry` holds only the 32-byte hash, so the prompt bytes go to the trace store
 * under the same `sha256` before the genesis event is written. That is the whole resolution
 * path: `policy_version_hash` → the policy document → `promptHash` → `GET /api/traces/[id]`.
 *
 * Here, beside the store it reads, because `/api/run` and every loop step call it, and this file is
 * a leaf that neither of them can reach a module cycle through.
 */
export async function templateSystemPrompt(
  record: Pick<DeployedAgent, "template"> | null | undefined,
  store: TraceStore,
  fallback: string
): Promise<{ system: string; promptHash?: string }> {
  const link = record?.template;
  const template = link ? lookupTemplate(link.id, link.version) : null;
  const prompt = template?.kind === "agent" ? template.config.prompt?.trim() : undefined;
  if (!prompt) return { system: fallback };
  // The preimage first: a genesis that names a hash nothing serves is a session an auditor
  // cannot read, and `put` is content-addressed, so writing it again is a no-op.
  await store.put(new TextEncoder().encode(prompt));
  return { system: prompt, promptHash: promptHash(prompt) };
}
