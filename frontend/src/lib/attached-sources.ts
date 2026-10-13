/**
 * Attached files as sandbox sources (`text`): what the form's
 * _Attach a file_ makes of a picked file, and the checks it runs before the owner signs.
 *
 * An attached file is not fetched. Its content rides in the start body, so the `"Lath loop"`
 * signature's `Request ID` binds its exact bytes; the host writes it as one file under
 * `sources/text/<name>/` and commits its sha256 in the manifest, as it does a URL's file.
 *
 * The rule is the runtime's own (`textSourceProblem`, from the module's pure half, which the
 * browser already imports for `decodeSourcesManifest`), so the form refuses exactly what the start
 * would, before the signature rather than after it. Pure and free of React, for `tests/sources-text.ts`.
 */
import { TEXT_SOURCE_MAX_BYTES, TEXT_SOURCES_MAX_BYTES, textSourceProblem } from "@lath/runtime/zeroclaw/sources";
import type { SandboxSourceInput, SourceEntry, TextSourceType } from "../types/zeroclaw";

export { TEXT_SOURCE_MAX_BYTES, TEXT_SOURCES_MAX_BYTES };

export type TextSourceInput = Extract<SandboxSourceInput, { kind: "text" }>;

/**
 * The type a picked file is attached as, read off its name: JSON and markdown by extension, plain
 * text otherwise. The browser's own `File.type` is not used: it is the operating system's guess, and
 * empty for a `.md` on most of them.
 */
export function textTypeOf(name: string): TextSourceType {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  return "text/plain";
}

/** Why an attached file would be refused at start, or `null`: the runtime's sentence, word for word. */
export function attachedProblem(s: TextSourceInput): string | null {
  return textSourceProblem(s);
}

/** UTF-8 bytes of `s`, as the host writes the file and as the caps count it. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * A picked file as a `text` source, or why it cannot be one. The bytes are decoded strictly, so a
 * file that is not UTF-8 is refused by name rather than attached with replacement characters the
 * owner never wrote (and a leading byte-order mark is dropped, as every UTF-8 reader drops it). The
 * name is put in Unicode NFC, the form the sandbox's tree holds names in; nothing else is changed.
 */
export function attachFile(
  fileName: string,
  bytes: Uint8Array
): { ok: true; source: TextSourceInput } | { ok: false; error: string } {
  const name = fileName.normalize("NFC");
  if (bytes.length > TEXT_SOURCE_MAX_BYTES) {
    return {
      ok: false,
      error: `${name} is ${bytes.length} bytes; an attached file is ${TEXT_SOURCE_MAX_BYTES / 1024} KiB at most.`,
    };
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: `${name} is not UTF-8 text.` };
  }
  const source: TextSourceInput = { kind: "text", name, content, contentType: textTypeOf(name) };
  const problem = attachedProblem(source);
  return problem ? { ok: false, error: `${name}: ${problem}.` } : { ok: true, source };
}

/** A size as the ZeroClaw tab writes it: bytes under a KiB, else KiB to one place. */
function sizeLabel(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

/**
 * How the ZeroClaw tab names an attached file's entry: `text · <name> · <size> · <sha256 short>`,
 * the size and the hash the manifest commits (its one file), never the content, which is not in it.
 * `null` for an entry of any other kind.
 */
export function textSourceLine(entry: SourceEntry): string | null {
  if (entry.source.kind !== "text") return null;
  const file = entry.files[0];
  const size = entry.files.reduce((n, f) => n + f.size, 0);
  return `text · ${entry.source.name} · ${sizeLabel(size)} · ${file ? file.sha256.slice(0, 12) : "no file"}`;
}

/**
 * Why a list's attached files would be refused together, or `null`: two of one name (one path
 * twice), or more than `TEXT_SOURCES_MAX_BYTES` between them, the bound the start body sets.
 */
export function attachedListProblem(sources: readonly SandboxSourceInput[]): string | null {
  const names = new Set<string>();
  let total = 0;
  for (const s of sources) {
    if (s.kind !== "text") continue;
    if (names.has(s.name)) return `Two attached files are named ${s.name}.`;
    names.add(s.name);
    total += utf8Bytes(s.content);
  }
  if (total > TEXT_SOURCES_MAX_BYTES) {
    return `The attached files together are over the ${TEXT_SOURCES_MAX_BYTES / 1024} KiB a loop's start may carry.`;
  }
  return null;
}
