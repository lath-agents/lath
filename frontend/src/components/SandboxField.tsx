"use client";

/**
 * **Files** — what every sandbox of this loop is opened with: up to eight **sources** the host fetches
 * once when the loop starts and copies read-only into every sandbox of it.
 *
 * The form attaches files and nothing else: it offers no switch for the host's tools, no lower
 * workspace cap and no typed-in source of another kind. A GitHub, URL or Solana row arrives only from a
 * run, template or preset and is shown read-only, and carried tools or caps are named in one read-only
 * line. `sandboxRequest` writes every carried key, so what a carried config sends is what it
 * was started with, and the server still takes every kind and switch from an API client.
 *
 * Off by default and collapsed while off: every default here *is* today's posture. A form that leaves
 * it off, or opens it and changes nothing, sends no `sandbox` key, so its policy, its template and
 * every step's posture hash exactly as a loop started with no sandbox config (`sandboxRequest`).
 *
 * The words on screen are _sandbox_, _sources_, _posture_ and _read-only_. Never _worker_, _provider_,
 * _hire_ or _proven isolated_: the sandbox is air-gapped by the host's wrapper, and what the chain
 * proves is the posture it committed, not that the wrapper held. The wrapper's own program name,
 * `sandbox-exec`, is shown as the host reports it, because it is a name.
 */
import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Button, CheckIcon, Info } from "@/components/ui";
import { SectionToggle } from "@/components/loop-terms";
import { IrysMark } from "@/components/Tempo";
import { useCheckSources, type CheckSourcesResponse } from "@/lib/loops";
import {
  TEXT_SOURCE_MAX_BYTES,
  attachFile,
  attachedListProblem,
  attachedProblem,
  utf8Bytes,
} from "@/lib/attached-sources";
import type { SandboxConfig } from "@/types/loop";
import type { ResolvedSource, SandboxSourceInput, TextSourceType } from "@/types/zeroclaw";

/**
 * The host's caps, restated from `runtime/src/zeroclaw/{posture,sources}.ts` because `@lath/runtime`
 * is a Node package and this is a browser component. They are the ceilings the form offers, not
 * the ones the server enforces: the route checks `sandbox` against the runtime's own constants again,
 * so a drift here costs a refusal before the signature, never a sandbox wider than the host's.
 */
export const WORKSPACE_MAX_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_MAX_FILES = 1000;
export const SOURCES_MAX_INPUTS = 8;

/** Lower only: the host's cap first, then what an owner might narrow it to. */
const BYTE_CAPS = [WORKSPACE_MAX_BYTES, 4 * 1024 * 1024, 2 * 1024 * 1024, 1024 * 1024];
const FILE_CAPS = [WORKSPACE_MAX_FILES, 500, 250, 100];

/**
 * A row's kinds: the fetched ones, and an attached file (`text`), which only _Attach a file_ makes
 * and no kind switch turns a row into. The server also takes a whole set restored from another loop's
 * sources on Irys (`irys`); the form does not offer that, so no draft holds one. The server's restore
 * path serves the callers that send it.
 */
export type SandboxSourceKind = Exclude<SandboxSourceInput["kind"], "irys">;

/** One source row as the form holds it: every kind's fields, so switching kinds loses nothing typed. */
export interface SandboxSourceDraft {
  kind: SandboxSourceKind;
  url: string;
  cluster: "devnet" | "mainnet";
  address: string;
  /** An attached file's name, content and type; empty on every other row. */
  name: string;
  content: string;
  contentType: TextSourceType;
}

/** What this component holds while the form is open. `on: false` is *today's sandbox*, not an empty one. */
export interface SandboxDraft {
  on: boolean;
  /** Chain reads: on in today's posture, so only `false` is ever sent. */
  chain: boolean;
  /**
   * The agent store, as the box shows it: what the agent was deployed with until the owner moves it
   * (unticked when the form does not know), and the owner's choice after.
   */
  store: boolean;
  /**
   * Whether the owner moved the store switch, or the carried config named it. It does not decide
   * whether `store` is sent for an agent's own sandboxes — the box against the agent's policy does, so a
   * box ticked off and back on sends nothing — only for a team from scratch, where an explicit switch
   * is what mints the members' tools (`scratchWithSandboxTools`) and so is a choice even when it agrees
   * with the agent.
   */
  storeSet: boolean;
  maxBytes: number;
  maxFiles: number;
  /**
   * The caps a run or template carried that are not among the offered ones, kept as they were so a
   * *Run again* commits the posture it was started with (a 512 KiB cap snapped to 1 MiB would be a
   * wider sandbox than the owner chose; one snapped down, a narrower one nobody chose). Offered in the
   * select beside the others and labelled as carried.
   */
  carried?: { maxBytes?: number; maxFiles?: number };
  sources: SandboxSourceDraft[];
  /**
   * The last _Check sources_ answer and the rows it answered (their wire form, as a key). Held here
   * rather than in `Sources` so `sandboxRequest` can start at the commits the check showed; any row
   * edit changes the key, and a stale answer is then neither shown nor used.
   */
  checked?: { key: string; answer: CheckSourcesResponse } | null;
  /**
   * Every row a check has resolved, by the row's own wire form. A resolved row is frozen — shown
   * read-only with its tick, removable but not editable — so adding a sixth row does not throw away
   * what the first five were shown; the key is the row's input, so nothing stale can be reused.
   */
  verified?: Record<string, ResolvedRow>;
}

type ResolvedRow = { source: ResolvedSource; files: number; bytes: number };

const rowKey = (d: SandboxSourceDraft) => JSON.stringify(sourceInput(d));

/**
 * The agent's deployed tools, reduced to the one fact the store switch needs: whether its policy
 * names the store (`store.get` / `store.set`, opt-in, so a policy naming no tools lacks it).
 * `undefined` when the caller did not say: the form then cannot show the box as the agent has it,
 * and says so rather than guessing.
 */
export function agentHasStore(tools: readonly string[] | undefined): boolean | undefined {
  if (!tools) return undefined;
  return tools.includes("store.get") || tools.includes("store.set");
}

export function emptySandbox(hasStore?: boolean): SandboxDraft {
  return {
    on: false,
    chain: true,
    store: hasStore === true,
    storeSet: false,
    maxBytes: WORKSPACE_MAX_BYTES,
    maxFiles: WORKSPACE_MAX_FILES,
    sources: [],
  };
}

function emptySource(kind: SandboxSourceKind = "github"): SandboxSourceDraft {
  return { kind, url: "", cluster: "devnet", address: "", name: "", content: "", contentType: "text/plain" };
}

/**
 * A wire source as a row, or `null` for one the form does not show (a set restored from Irys). One
 * mapping for a stored config and for the preset's demo files (`LoopStartForm`), so a row reads the
 * same whichever opened it.
 */
export function sourceDraft(s: SandboxSourceInput): SandboxSourceDraft | null {
  if (s.kind === "irys") return null;
  if (s.kind === "solana") return { ...emptySource("solana"), cluster: s.cluster, address: s.address };
  if (s.kind === "text") {
    return { ...emptySource("text"), name: s.name, content: s.content, contentType: s.contentType ?? "text/plain" };
  }
  return { ...emptySource(s.kind), url: s.url };
}

/**
 * A stored or preset config as the form holds it, opened when it says anything. Absent opens the
 * section off, which is what keeps a start from a source without a sandbox sending none.
 */
export function sandboxFromConfig(config: SandboxConfig | undefined, hasStore?: boolean): SandboxDraft {
  const sandbox = emptySandbox(hasStore);
  if (!config) return sandbox;
  sandbox.on = true;
  if (config.tools?.chain === false) sandbox.chain = false;
  // Either value of a carried switch is the owner's earlier choice, so it is kept as a choice: a
  // *Run again* of a run that took the store away takes it away again.
  if (typeof config.tools?.store === "boolean") {
    sandbox.store = config.tools.store;
    sandbox.storeSet = true;
  }
  // Kept exactly, only held to the host's cap: the server does the same, so the value on
  // screen is the value the posture commits. One the select does not offer is added to it.
  const carried: NonNullable<SandboxDraft["carried"]> = {};
  if (config.maxBytes && config.maxBytes > 0) {
    sandbox.maxBytes = Math.min(config.maxBytes, WORKSPACE_MAX_BYTES);
    if (!BYTE_CAPS.includes(sandbox.maxBytes)) carried.maxBytes = sandbox.maxBytes;
  }
  if (config.maxFiles && config.maxFiles > 0) {
    sandbox.maxFiles = Math.min(config.maxFiles, WORKSPACE_MAX_FILES);
    if (!FILE_CAPS.includes(sandbox.maxFiles)) carried.maxFiles = sandbox.maxFiles;
  }
  if (Object.keys(carried).length) sandbox.carried = carried;
  // A set restored from Irys is dropped rather than carried: the form does not show one, and a
  // source it cannot show is not one it should send under the owner's signature. A *Run again* of
  // such a loop opens with the rest of its sandbox and an empty list, which the owner can see.
  sandbox.sources = (config.sources ?? []).slice(0, SOURCES_MAX_INPUTS).flatMap((s) => {
    const row = sourceDraft(s);
    return row ? [row] : [];
  });
  return sandbox;
}

/**
 * The rows' wire form, as a check is keyed by. A GitHub row the check resolved is started at the
 * commit it resolved to — `https://github.com/<o>/<r>/tree/<commit>[/<path>]`, which the fetcher
 * takes as is — so the tree fetched at start is the tree the person was shown before signing, not
 * whatever the branch has moved to since. Only when the answer is for exactly these rows; a URL and
 * a Solana account have no pin to send and are read again at start.
 */
function pinnedInputs(sandbox: SandboxDraft): SandboxSourceInput[] {
  return sandbox.sources.map((row) => {
    const input = sourceInput(row);
    const r = sandbox.verified?.[rowKey(row)]?.source;
    if (input.kind !== "github" || r?.kind !== "github") return input;
    const path = r.path ? "/" + r.path.split("/").map(encodeURIComponent).join("/") : "";
    return { kind: "github", url: `https://github.com/${r.owner}/${r.repo}/tree/${r.commit}${path}` };
  });
}

/** The row as the wire carries it, trimmed; no field of another kind rides along. */
export function sourceInput(d: SandboxSourceDraft): SandboxSourceInput {
  if (d.kind === "solana") return { kind: "solana", cluster: d.cluster, address: d.address.trim() };
  // The content exactly as attached: those bytes are what the signature binds and the sandbox reads.
  if (d.kind === "text") return { kind: "text", name: d.name, content: d.content, contentType: d.contentType };
  return { kind: d.kind, url: d.kind === "github" ? githubUrl(d.url) : d.url.trim() };
}

/**
 * A GitHub URL as people paste it, in the one form the server accepts: `github.com/o/r`,
 * `www.github.com/o/r` and `http://` all become `https://github.com/o/r`. Only the host prefix is
 * rewritten, so the server's strict parse still decides everything after it.
 */
export function githubUrl(raw: string): string {
  return raw.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "https://github.com/");
}

const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(\/tree\/[^\s?#]+)?\/?$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Why a row is not a source the server could even try, or `null`. Shape only: whether the repo is
 * public, the URL answers text, or the account exists is what _Check sources_ asks the server.
 * Checked here so a malformed row never costs a `"Lath loop"` signature.
 */
export function sourceProblem(d: SandboxSourceDraft): string | null {
  if (d.kind === "text") {
    const p = attachedProblem({ kind: "text", name: d.name, content: d.content, contentType: d.contentType });
    return p ? `${p.charAt(0).toUpperCase()}${p.slice(1)}.` : null;
  }
  if (d.kind === "github") {
    if (!d.url.trim()) return "Paste a public GitHub repository's URL.";
    if (!GITHUB_URL.test(githubUrl(d.url)))
      return "A GitHub source is https://github.com/owner/repo, optionally /tree/ref/path.";
    return null;
  }
  if (d.kind === "url") {
    if (!d.url.trim()) return "Paste an https:// URL.";
    let parsed: URL;
    try {
      parsed = new URL(d.url.trim());
    } catch {
      return "That is not a URL.";
    }
    if (parsed.protocol !== "https:") return "Only https:// URLs are fetched.";
    if (parsed.username || parsed.password) return "A URL with credentials in it is not fetched.";
    return null;
  }
  if (!d.address.trim()) return "Paste a Solana address.";
  if (!BASE58.test(d.address.trim())) return "That is not a Solana address (base58, 32 to 44 characters).";
  return null;
}

/**
 * Why the section would be refused, or `null` — the first row's problem, numbered as the server
 * numbers them. `hasStore` is the agent's policy when the caller knows it: the store switch on an
 * agent deployed without the store is what the server refuses (`storeSwitchRefusal`), said here so it
 * never costs a signature.
 */
export function sandboxProblem(sandbox: SandboxDraft, hasStore?: boolean): string | null {
  if (!sandbox.on) return null;
  if (sandbox.store && hasStore === false) {
    return "This agent was deployed without the store tools; the sandbox's switch narrows its policy, never widens it.";
  }
  if (sandbox.sources.length > SOURCES_MAX_INPUTS) return `A sandbox takes at most ${SOURCES_MAX_INPUTS} sources.`;
  for (let i = 0; i < sandbox.sources.length; i += 1) {
    const p = sourceProblem(sandbox.sources[i]);
    if (p) return `Source ${i + 1}: ${p}`;
  }
  return attachedListProblem(sandbox.sources.map(sourceInput));
}

/**
 * The `sandbox` key, or `undefined` when there is nothing to send.
 *
 * Each key is written only when it is not today's default — `tools` only for a switch moved off its
 * default, a cap only when lowered, `sources` only when there is one — and the whole key only when
 * one of them is. A section opened and closed again, or opened and left as it was, therefore sends
 * the same start as a form with no sandbox section, byte for byte.
 */
export function sandboxRequest(
  sandbox: SandboxDraft,
  hasStore?: boolean,
  scratchTeam = false
): SandboxConfig | undefined {
  if (!sandbox.on || sandboxProblem(sandbox, hasStore)) return undefined;
  const out: SandboxConfig = {};
  const tools: NonNullable<SandboxConfig["tools"]> = {};
  if (!sandbox.chain) tools.chain = false;
  // The store in both directions, but only where the box differs from the agent's policy: the box
  // starts there, and a start without the key already runs with it, so a box ticked off and back on
  // sends no sandbox key. `hasStore` unknown starts the box unticked, so only a tick is sent.
  //
  // A team from scratch is the exception: there the switch also mints the members' tools
  // (`scratchWithSandboxTools`), so a switch the owner moved is sent even when it agrees with the
  // agent. `false` is still dropped for an agent known to lack the store: it would narrow nothing.
  const storeSent = scratchTeam ? sandbox.storeSet : sandbox.store !== (hasStore === true);
  if (storeSent && sandbox.store) tools.store = true;
  if (storeSent && !sandbox.store && hasStore !== false) tools.store = false;
  if (Object.keys(tools).length) out.tools = tools;
  if (sandbox.maxBytes < WORKSPACE_MAX_BYTES) out.maxBytes = sandbox.maxBytes;
  if (sandbox.maxFiles < WORKSPACE_MAX_FILES) out.maxFiles = sandbox.maxFiles;
  if (sandbox.sources.length) out.sources = pinnedInputs(sandbox);
  return Object.keys(out).length ? out : undefined;
}

/** The sentence under the sources. */
export const SOURCES_COPY =
  "Fetched once when the loop starts, read-only in every sandbox of this loop, committed with the sandbox's posture.";

/**
 * The one line on the per-step re-read (_What changed since pinned_), under the sources sentence.
 */
export const SOLANA_REFRESH_COPY =
  "A loop with Solana sources is told what changed since they were pinned, at every step.";

/**
 * The line beside _Attach a file_: what attaching does, and where the bytes go. Said because an
 * attached file is the owner's own text, not a public URL: it is signed with the start, kept with
 * the run and its template so _Run again_ attaches it again, and — on a console that pins sources on
 * Irys — published there in clear like every other source's files.
 */
export const ATTACH_COPY =
  `A text, JSON or markdown file up to ${TEXT_SOURCE_MAX_BYTES / 1024} KiB. Its bytes are part of what you sign, ` +
  "kept with this run and its template, and treated like any other source's files, which a console that pins " +
  "sources on Irys publishes there in clear.";

export function SandboxField({
  sandbox,
  setSandbox,
  hasStore,
}: {
  sandbox: SandboxDraft;
  /** A state setter: the check's answer lands after an await, onto whatever the rows are by then. */
  setSandbox: Dispatch<SetStateAction<SandboxDraft>>;
  /** Whether the agent's deployed policy names the store (`agentHasStore`); `undefined` when unknown. */
  hasStore?: boolean;
}) {
  const patch = (p: Partial<SandboxDraft>) => setSandbox((r) => ({ ...r, ...p }));
  const files = sandbox.sources.filter((s) => s.kind === "text").length;
  const others = sandbox.sources.length - files;
  const settings = sandboxSettingsCarried(sandbox, hasStore);
  // The count in the label, not in a badge beside the checkbox:
  // `Files · 2`, attached files and sources counted together, since both open in the sandbox as files.
  // Nothing when off or empty; carried settings are said in the body's own line.
  const count = sandbox.on ? files + others : 0;

  return (
    <div className="rounded-lg border border-line/[0.08] p-3" data-testid="loop-sandbox-field">
      <SectionToggle
        on={sandbox.on}
        onToggle={() => patch({ on: !sandbox.on })}
        label={count ? `Files · ${count}` : "Files"}
        testId="loop-sandbox-toggle"
        info={
          <p>
            Every step of a loop runs in the ZeroClaw sandbox, always, with no network. A file attached here is copied
            into it read-only, at the start, and its bytes are part of what you sign. Left empty, the sandbox opens with
            no files.
          </p>
        }
        infoLabel="What attaching files changes"
        infoTestId="loop-sandbox-info"
      />

      {sandbox.on && (
        <div className="mt-3 space-y-4" data-testid="loop-sandbox-body">
          {/* The form offers no tools switches and no workspace cap, but a run, template or preset can
              carry them, and `sandboxRequest` sends them. Said here,
              read-only, so nothing is signed out of sight, with
              the one control that undoes them: back to the host's defaults, which sends no key for them. */}
          {settings && (
            <p className="text-2xs leading-relaxed text-ink-3" data-testid="loop-sandbox-carried">
              From the run or preset: <span className="text-ink-2">{settings}</span>.{" "}
              <button
                type="button"
                onClick={() =>
                  patch({
                    chain: true,
                    store: hasStore === true,
                    storeSet: false,
                    maxBytes: WORKSPACE_MAX_BYTES,
                    maxFiles: WORKSPACE_MAX_FILES,
                    carried: undefined,
                  })
                }
                className="underline hover:text-ink-1"
                data-testid="loop-sandbox-carried-reset"
              >
                use the defaults
              </button>
            </p>
          )}
          <Sources sandbox={sandbox} patch={patch} setSandbox={setSandbox} />
        </div>
      )}
    </div>
  );
}

/**
 * The sandbox settings other than sources that this start would send, in words, or `null` when there
 * are none. The same conditions `sandboxRequest` writes `tools`, `maxBytes` and `maxFiles` by (with no
 * team from scratch, which the form does not offer), checked without its refusal so a carried store
 * switch the agent's policy refuses is still named — the error beside Start says why it is refused.
 */
export function sandboxSettingsCarried(sandbox: SandboxDraft, hasStore?: boolean): string | null {
  if (!sandbox.on) return null;
  const parts: string[] = [];
  if (!sandbox.chain) parts.push("chain reads off");
  if (sandbox.store !== (hasStore === true)) {
    if (sandbox.store) parts.push("agent store on");
    else if (hasStore !== false) parts.push("agent store off");
  }
  const caps = [
    ...(sandbox.maxBytes < WORKSPACE_MAX_BYTES ? [humanBytes(sandbox.maxBytes)] : []),
    ...(sandbox.maxFiles < WORKSPACE_MAX_FILES ? [`${sandbox.maxFiles.toLocaleString("en-US")} files`] : []),
  ];
  if (caps.length) parts.push(`workspace capped at ${caps.join(" and ")}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The sources, and _Check sources_: the server resolves every row (commit, final URL, slot, sizes)
 * and keeps nothing, so the refusals a start would meet are on screen before the wallet signs.
 *
 * A result is shown, and its commits started at (`pinnedInputs`), only while the rows are the ones it
 * answered: editing any row drops it, since a commit shown against a URL it was not resolved from is
 * worse than no commit at all.
 */
function Sources({
  sandbox,
  patch,
  setSandbox,
}: {
  sandbox: SandboxDraft;
  patch: (p: Partial<SandboxDraft>) => void;
  setSandbox: Dispatch<SetStateAction<SandboxDraft>>;
}) {
  const check = useCheckSources();
  // _Attach a file_: a hidden picker, its last refusal, and which attached row is open for viewing.
  const picker = useRef<HTMLInputElement>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const inputs = sandbox.sources.map(sourceInput);
  const key = JSON.stringify(inputs);
  const answer = sandbox.checked?.key === key ? sandbox.checked.answer : null;
  // Kept under the key it was asked for: rows edited while the check was out make it stale on arrival.
  // A resolved answer also freezes each row it names, under that row's own key.
  const setChecked = (checked: { key: string; answer: CheckSourcesResponse }) => {
    const { answer } = checked;
    const fresh = answer.ok
      ? Object.fromEntries(inputs.map((input, i) => [JSON.stringify(input), answer.resolved[i]]))
      : {};
    setSandbox((r) => ({ ...r, checked, verified: { ...r.verified, ...fresh } }));
  };
  const allVerified = sandbox.sources.length > 0 && sandbox.sources.every((s) => sandbox.verified?.[rowKey(s)]);
  const shapeBad = sandbox.sources.some((s) => sourceProblem(s));

  const setSources = (sources: SandboxSourceDraft[]) => patch({ sources });
  // Removing a row forgets its check: a row added back is a new row and asks _Check sources_ again,
  // rather than reappearing ticked from a result the person no longer sees on screen.
  const removeRow = (i: number) => {
    const sources = sandbox.sources.filter((_, k) => k !== i);
    const keep = new Set(sources.map(rowKey));
    const verified = Object.fromEntries(Object.entries(sandbox.verified ?? {}).filter(([k]) => keep.has(k)));
    patch({ sources, verified });
    setViewing(null);
  };
  // A picked file read whole (it is 64 KiB at most, refused by size before it is read) and attached
  // as a `text` row, or refused in the runtime's words. One file per pick; the picker is cleared so
  // picking the same file again, after removing it, attaches it again.
  const onPick = async (file: File | undefined) => {
    if (picker.current) picker.current.value = "";
    if (!file) return;
    if (sandbox.sources.length >= SOURCES_MAX_INPUTS) {
      setAttachError(`A sandbox takes at most ${SOURCES_MAX_INPUTS} sources.`);
      return;
    }
    if (file.size > TEXT_SOURCE_MAX_BYTES) {
      setAttachError(
        `${file.name} is ${humanBytes(file.size)}; an attached file is ${TEXT_SOURCE_MAX_BYTES / 1024} KiB at most.`
      );
      return;
    }
    const got = attachFile(file.name, new Uint8Array(await file.arrayBuffer()));
    if (!got.ok) {
      setAttachError(got.error);
      return;
    }
    const row = sourceDraft(got.source)!;
    const listProblem = attachedListProblem([...sandbox.sources.map(sourceInput), got.source]);
    if (listProblem) {
      setAttachError(listProblem);
      return;
    }
    setAttachError(null);
    setSources([...sandbox.sources, row]);
  };

  const runCheck = async () => {
    try {
      const out = await check.mutateAsync(inputs);
      setChecked({ key, answer: out });
    } catch (e) {
      setChecked({ key, answer: { ok: false, error: e instanceof Error ? e.message : String(e) } });
    }
  };

  return (
    <div className="space-y-2" data-testid="loop-sandbox-sources">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-ink-2">Sources</span>
          <Info label="What sources are" testId="loop-sandbox-sources-info" wide>
            <p>
              {SOURCES_COPY} {SOLANA_REFRESH_COPY}
            </p>
          </Info>
        </span>
        <span className="text-2xs text-ink-3">{`${sandbox.sources.length} of ${SOURCES_MAX_INPUTS}`}</span>
      </div>

      {sandbox.sources.map((s, i) => {
        const problem = sourceProblem(s);
        const resolved = sandbox.verified?.[rowKey(s)];
        const refused = answer && !answer.ok && answer.input === i + 1 ? answer.error : null;
        return (
          <div
            key={i}
            className="space-y-2 rounded-lg border border-line/[0.06] bg-line/[0.02] p-2.5"
            data-testid="loop-sandbox-source"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              {s.kind === "text" ? (
                // An attached file is never edited in place, checked or not: its bytes are what was
                // picked. It is viewed, or removed and attached again.
                <span
                  className="min-w-0 flex-1 break-all font-mono text-2xs text-ink-1"
                  data-testid="loop-sandbox-source-attached"
                >
                  <span className="mr-2 font-sans text-ink-3">Attached file</span>
                  {s.name}
                  <span className="ml-2 font-sans text-ink-3">
                    {humanBytes(utf8Bytes(s.content))} · {s.contentType}
                  </span>
                </span>
              ) : (
                // Read-only whether or not a check has resolved it: the form attaches files
                // and nothing else, so a GitHub, URL or Solana row is one a run, template or preset
                // carried. It is shown as it will be sent, and removable, never edited here.
                <span
                  className="min-w-0 flex-1 break-all font-mono text-2xs text-ink-1"
                  data-testid="loop-sandbox-source-frozen"
                >
                  <span className="mr-2 font-sans text-ink-3">
                    {s.kind === "github" ? "GitHub" : s.kind === "url" ? "URL" : `Solana · ${s.cluster}`}
                  </span>
                  {s.kind === "solana" ? s.address.trim() : s.kind === "github" ? githubUrl(s.url) : s.url.trim()}
                </span>
              )}
              {/* The row's own verdict beside its kind, so a person scanning five rows sees which
                  resolved without reading each resolved line; absent until a check answers these rows. */}
              {resolved ? (
                <span
                  className="ml-auto flex items-center gap-1 text-2xs text-spine-green"
                  data-testid="loop-sandbox-source-ok"
                >
                  <CheckIcon />
                  checked
                </span>
              ) : refused ? (
                <span className="ml-auto text-2xs text-rose-300" data-testid="loop-sandbox-source-bad">
                  ✕ refused
                </span>
              ) : null}
              {s.kind === "text" && (
                <button
                  type="button"
                  onClick={() => setViewing(viewing === i ? null : i)}
                  className="text-2xs text-ink-3 underline hover:text-ink-1"
                  aria-expanded={viewing === i}
                  data-testid="loop-sandbox-source-view"
                >
                  {viewing === i ? "hide" : "view"}
                </button>
              )}
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="text-2xs text-ink-3 underline hover:text-ink-1"
                data-testid="loop-sandbox-source-remove"
              >
                remove
              </button>
            </div>
            {s.kind === "text" && viewing === i && (
              // Rendered as text in a <pre>: the file is the owner's, and nothing in it is markup.
              <pre
                className="well max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-2xs text-ink-2"
                data-testid="loop-sandbox-source-content"
              >
                {s.content}
              </pre>
            )}
            {!resolved && s.kind === "solana" && s.cluster === "mainnet" && (
              <p className="text-2xs leading-relaxed text-ink-3">
                Read through the host&apos;s mainnet RPC; a host without one refuses the start and says so.
              </p>
            )}
            {problem && <p className="text-2xs text-rose-300">{problem}</p>}
            {refused && (
              <p className="break-words text-2xs text-rose-300" data-testid="loop-sandbox-source-refused">
                {refused}
              </p>
            )}
            {resolved && <ResolvedLine source={resolved.source} files={resolved.files} bytes={resolved.bytes} />}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={sandbox.sources.length >= SOURCES_MAX_INPUTS}
            className="text-2xs text-ink-2 underline hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="loop-sandbox-source-attach"
          >
            + attach a file
          </button>
          <Info label="What attaching a file does" testId="loop-sandbox-attach-info" wide>
            <p>{ATTACH_COPY}</p>
          </Info>
          <input
            ref={picker}
            type="file"
            accept=".json,.md,.markdown,.txt,text/plain,text/markdown,application/json"
            className="hidden"
            onChange={(e) => void onPick(e.target.files?.[0])}
            data-testid="loop-sandbox-source-file"
          />
        </span>
        {/* Whenever there are rows, attached or carried: what the server would refuse — a repo gone
            private, an account that is not there, a file over the caps together — is said here, before
            the signature, and a GitHub row is then started at the commit the check showed. */}
        {sandbox.sources.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={runCheck}
            disabled={shapeBad || check.isPending}
            loading={check.isPending}
            testId="loop-sandbox-check-sources"
          >
            Check sources
          </Button>
        )}
      </div>
      {/* Where the files are, not how safe they are: "secure" would lean on an isolation nothing on this
          form proves. The files are
          pinned on Irys at the start (`publishSources`); a step reads the host's copy of those same
          bytes, laid out in its workspace, so this line names where they are pinned, not a fetch. */}
      <p className="text-2xs text-ink-3" data-testid="loop-sandbox-files-line">
        <IrysMark title="Irys" className="mr-1" />
        Each step reads these files from Irys.
      </p>

      {attachError && (
        <p className="break-words text-2xs text-rose-300" data-testid="loop-sandbox-attach-refused">
          {attachError}
        </p>
      )}
      {/* A refusal that names no row is the whole check's (the caps over all sources together, a
          server that could not be reached); it goes here rather than against a row it is not about. */}
      {answer && !answer.ok && !(answer.input && answer.input >= 1 && answer.input <= sandbox.sources.length) && (
        <p className="break-words text-2xs text-rose-300" data-testid="loop-sandbox-check-refused">
          {answer.error}
        </p>
      )}
      {allVerified && (
        <p className="text-2xs text-spine-green" data-testid="loop-sandbox-check-ok">
          Every source resolved. The loop starts GitHub sources at these commits; a URL is fetched again, a Solana
          account is read again at start, at the slot then, and an attached file is written as you attached it.
        </p>
      )}
    </div>
  );
}

/** What a row resolved to: the pin, then the size. */
function ResolvedLine({ source, files, bytes }: { source: ResolvedSource; files: number; bytes: number }) {
  const size = `${humanBytes(bytes)} · ${files.toLocaleString("en-US")} ${files === 1 ? "file" : "files"}`;
  let pin: ReactNode;
  if (source.kind === "github") {
    pin = (
      <>
        {source.owner}/{source.repo}
        {source.ref ? ` @ ${source.ref}` : ""} → <span className="num text-ink-1">{source.commit.slice(0, 7)}</span>
      </>
    );
  } else if (source.kind === "url") {
    pin = (
      <>
        <span className="break-all">{source.finalUrl}</span> · {source.contentType}
      </>
    );
  } else if (source.kind === "text") {
    pin = <>attached, written as it is · {source.contentType}</>;
  } else {
    // _Solana mainnet_, not a bare _mainnet_: the nav's _Tempo · mainnet_ pill is on the same screen,
    // and the cluster alone would read as Tempo's. The label only; the
    // source's `cluster` value is what was resolved and committed.
    pin = (
      <>
        Solana {source.cluster} · slot <span className="num text-ink-1">{source.slot}</span>
      </>
    );
  }
  return (
    <p
      className="flex flex-wrap justify-between gap-x-3 text-2xs leading-relaxed text-ink-2"
      data-testid="loop-sandbox-source-resolved"
    >
      <span className="min-w-0 break-words">{pin}</span>
      <span className="num text-ink-3">{size}</span>
    </p>
  );
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
