/**
 * A model's context window, for the `context_window` key of a sandbox's `config.toml`
 * (`zeroclaw/CONTRACT.md` §1).
 *
 * Why the host has to say it: the Lath-patched ZeroClaw resolves a model's window from its provider
 * entry and, with none there, runs against upstream's 32 000-token compatibility fallback, refusing
 * before dispatch any turn whose retained tokens pass it. A sandbox that reads a dozen sources crosses
 * that on its first few reads, so both of a step's sessions failed on a model whose real window is
 * several times larger. The sandbox has no network and cannot ask; the host can.
 *
 * Where it comes from: OpenRouter's public model list, `GET https://openrouter.ai/api/v1/models`,
 * which needs no key and is not a paid call (it goes to openrouter.ai directly, not through the MPP
 * gateway, and moves nothing on Tempo). Its `context_length` is the window OpenRouter states for the
 * model across its providers. The console reads it once when it starts (`frontend/src/instrumentation.ts`,
 * `prefetchOpenRouterContextWindows`), before any step needs it, and keeps it for the process.
 *
 * A read that fails is not kept. The first read can land while the console is pinning a loop's files
 * on Irys and time out there, although the list answers in well under a second on an idle process; a
 * failure cached for even a few minutes would then hold every step in that window at the fallback,
 * each failing on _exceeds the selected model's context window_ although a later read would have
 * found the real figure. So a failed read is forgotten as soon as it settles and the next step asks
 * again, with a timeout (`LOOKUP_TIMEOUT_MS`) long enough for a process busy pinning a loop's
 * sources; one bad fetch never decides a later step's window.
 *
 * When the list still cannot be read, `KNOWN_CONTEXT_WINDOWS` answers for the models the console offers:
 * a table copied from that same list, on the date its comment gives. It is not a guess, and nothing
 * outside it is guessed: a model it does not name gives `undefined`, and the step then renders the
 * config it always did — the fallback is upstream's behaviour, never an estimate of ours, because a
 * window larger than the served one would only move the failure from the sandbox to the provider. The
 * table can go stale the same way: a provider that shrinks a model's window after the date below makes
 * the table's figure too large. That is why it answers only when the live list is unreadable, why it
 * takes the smaller of the two windows the list states for a model when they differ, and why it is
 * re-read from the list, not edited by hand, whenever a model is added to `MODELS`.
 *
 * The window is a per-step value like the model, not a posture key: it never moves `postureHash`,
 * the policy hash or any pinned vector. It does reach the step's report, in `postureToml`, and the
 * step's replay record, as `contextWindow`: it is an input of the config the sandbox ran, and a
 * replayer that rebuilt that config without it would run at the fallback and could refuse a turn the
 * run took. The record carries it only when the TOML did, so a step with no window has no such key;
 * whether the figure came from the live list or the table, the record holds the figure the TOML had.
 */

/** Resolves a model id to its context window in tokens, or `undefined` when unknown. Never throws. */
export type ContextWindowLookup = (model: string) => Promise<number | undefined>;

/** A lookup over OpenRouter's list that can also be asked to read the list before any step needs it. */
export interface OpenRouterContextWindows extends ContextWindowLookup {
  /**
   * Reads the list now unless a read is held or in flight: `true` once it is held, `false` when this
   * read failed (and is already forgotten, so the next lookup asks again). Never throws.
   */
  prefetch(): Promise<boolean>;
}

/** OpenRouter's public model list. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/**
 * How long one read of the list may take. The list is about 774 KB; read alone it answers in well
 * under a second, but the first read can land while the console is pinning a loop's files on Irys,
 * and a few seconds is not enough there (the header). A step that has to wait waits at most this once, and only
 * when the boot read failed too; with the network down the table answers after it.
 */
const LOOKUP_TIMEOUT_MS = 15_000;

/**
 * The windows of the models the console offers (`MODELS` in `frontend/src/app/api/_lib/runner.ts`), as
 * OpenRouter's list stated them on 2026-10-07, read from `GET /api/v1/models` that day: `context_length`,
 * or the row's `top_provider.context_length` where that was smaller. Used only when the list cannot be
 * read (the header); every figure here is the list's own, and a model the list did not name that day is
 * left out rather than estimated. `deepseek/deepseek-chat` is the one row whose two figures differed
 * (163 840 for the model, 128 000 for its top provider), so it carries the smaller.
 */
export const KNOWN_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["deepseek/deepseek-v4.1-flash", 1_048_576],
  ["deepseek/deepseek-v4-flash", 1_048_576],
  ["deepseek/deepseek-chat", 128_000],
  ["moonshotai/kimi-k3", 1_048_576],
  ["anthropic/claude-fable-5.1", 1_000_000],
  ["anthropic/claude-haiku-4.5", 200_000],
  ["meta-llama/llama-3.3-70b-instruct", 131_072],
]);

type Fetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** `id → context_length` from the list's body, with `canonical_slug` as a second name for a row. */
export function contextWindowsFromModels(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const rows = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const r = row as { id?: unknown; canonical_slug?: unknown; context_length?: unknown };
    const n = r?.context_length;
    // Anything but a positive integer is a row we cannot render: patch 0005 refuses it, and a
    // step refused for a bad window is worse than a step at the fallback.
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) continue;
    if (typeof r.id === "string" && r.id) out.set(r.id, n);
    if (typeof r.canonical_slug === "string" && r.canonical_slug && !out.has(r.canonical_slug)) {
      out.set(r.canonical_slug, n);
    }
  }
  return out;
}

/**
 * The window of `model` in `windows`: its exact id first, then the id without a `:variant` suffix
 * (`:nitro`, `:floor` and the like route the same model and are not rows of the list).
 */
export function lookUpContextWindow(windows: ReadonlyMap<string, number>, model: string): number | undefined {
  const id = model.trim();
  if (!id) return undefined;
  const exact = windows.get(id);
  if (exact !== undefined) return exact;
  const colon = id.lastIndexOf(":");
  return colon > 0 ? windows.get(id.slice(0, colon)) : undefined;
}

/**
 * A lookup over OpenRouter's list, read through `fetchImpl` and kept once a read succeeds; a read that
 * fails is forgotten when it settles, so the next call reads again. Until one succeeds, `known` answers
 * (`KNOWN_CONTEXT_WINDOWS` by default; tests pass their own, or an empty map for none). Tests build their
 * own with a stub fetch, or pass a plain function as `ZeroClawSandboxOptions.contextWindow`.
 */
export function openRouterContextWindows(opts?: {
  fetch?: Fetch;
  url?: string;
  timeoutMs?: number;
  known?: ReadonlyMap<string, number>;
}): OpenRouterContextWindows {
  const fetchImpl: Fetch | undefined = opts?.fetch ?? (globalThis.fetch as unknown as Fetch | undefined);
  const url = opts?.url ?? OPENROUTER_MODELS_URL;
  const timeoutMs = opts?.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const known = opts?.known ?? KNOWN_CONTEXT_WINDOWS;
  // The read held, or the one in flight that every caller meanwhile shares — never a failed one.
  let held: Promise<Map<string, number> | undefined> | undefined;

  const read = (): Promise<Map<string, number> | undefined> => {
    if (held) return held;
    const attempt = (async () => {
      if (!fetchImpl) return undefined;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        const windows = contextWindowsFromModels(await res.json());
        // A body with no row we can read is a list we did not get (a changed shape, an error page
        // served as 200), not a list that knows no model: kept, it would stop every later read.
        return windows.size > 0 ? windows : undefined;
      } catch {
        return undefined;
      }
    })();
    held = attempt;
    // Forgotten as soon as it settles empty-handed, so the next step asks again rather than inheriting
    // this one's failure (the header). Only this attempt is cleared, never a later one that replaced it.
    void attempt.then((windows) => {
      if (!windows && held === attempt) held = undefined;
    });
    return attempt;
  };

  const lookup = (async (model: string) => {
    const windows = await read();
    return lookUpContextWindow(windows ?? known, model);
  }) as OpenRouterContextWindows;
  lookup.prefetch = async () => (await read()) !== undefined;
  return lookup;
}

/**
 * The process's one lookup: every sandbox of every loop shares its read. Kept on `globalThis` under a
 * registered symbol, not in a module variable, because Next compiles `instrumentation.ts` and each route
 * into module graphs of their own: a module-level lookup would be one per graph, and the boot read would
 * fill a cache that no loop step reads — the loop route would still pay its first read while it pinned
 * the loop's files, which is the failure the boot read exists to avoid.
 */
const PROCESS_LOOKUP = Symbol.for("lath.zeroclaw.openRouterContextWindow");

export const openRouterContextWindow: OpenRouterContextWindows = ((
  globalThis as { [PROCESS_LOOKUP]?: OpenRouterContextWindows }
)[PROCESS_LOOKUP] ??= openRouterContextWindows());

/**
 * Reads the process's list now, before any step needs it: called once from the console's start
 * (`frontend/src/instrumentation.ts`). `true` when the list is held. A `false` costs nothing later —
 * the failed read is already forgotten, and the first step reads again or, failing that, takes the table.
 */
export function prefetchOpenRouterContextWindows(): Promise<boolean> {
  return openRouterContextWindow.prefetch();
}
