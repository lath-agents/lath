/**
 * The client half of a streamed loop start: reading the stages
 * `POST /api/loops` sends to a request that asked for `text/event-stream`, and naming each on the
 * Start button.
 *
 * React-free and wallet-free, so a Node suite can read the route's own stream with it
 * (`tests/console-loop-start-stream.ts`) — what the button shows is then the parse of what the server
 * sent, not a second guess at it.
 */
import type { LoopStartStage } from "../app/api/_lib/loops";

export type { LoopStartStage };

/**
 * One SSE block's `event:` name and `data:` text, or null when it lacks either.
 *
 * Lines are split on `\n` alone and matched with `startsWith`, never with `.` or a multiline `$`:
 * in a JS regex both treat U+2028 and U+2029 as line ends, and `JSON.stringify` leaves those two
 * characters raw. A prompt pasted with one, or a model token carrying one, would be cut there, the
 * `JSON.parse` would throw, and the browser would drop the rest of a session the server is still
 * writing.
 */
export function parseSseBlock(block: string): { event: string; data: string } | null {
  let event: string | null = null;
  let data: string | null = null;
  for (const line of block.split("\n")) {
    if (event === null && line.startsWith("event: ")) event = line.slice("event: ".length).trim();
    else if (data === null && line.startsWith("data: ")) data = line.slice("data: ".length);
  }
  return event && data ? { event, data } : null;
}

/** Every `event:`/`data:` pair in a server-sent stream, in order, in `/api/run`'s framing. */
export async function readSseEvents(
  body: ReadableStream<Uint8Array>,
  on: (event: string, data: unknown) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (block: string) => {
    const parsed = parseSseBlock(block);
    if (parsed) on(parsed.event, JSON.parse(parsed.data));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) flush(block);
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}

/**
 * A start's answer, streamed or not, as `postLoopRaw` has always returned one: the JSON body on
 * success, a thrown `Error` carrying the server's reason on a refusal.
 *
 * Not every answer to a streamed request is a stream: a refusal that comes before the start — no
 * signature, no runtime keypair — is the plain JSON it always was, and is read as such. A stream
 * that ends with no `result` is a connection that dropped mid-start; the start may well have gone
 * through (it runs to its end whoever is listening), so the error says where to look rather than
 * that it failed.
 */
export async function readLoopStart(res: Response, onStage?: (stage: LoopStartStage) => void): Promise<unknown> {
  const streamed = /\btext\/event-stream\b/i.test(res.headers.get("content-type") ?? "");
  if (!streamed || !res.body) {
    const answered = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(answered.error ?? `the server refused the loop (${res.status})`);
    return answered;
  }
  let result: { status: number; body: { error?: string } } | null = null;
  await readSseEvents(res.body, (event, data) => {
    if (event === "stage") {
      try {
        onStage?.(data as LoopStartStage);
      } catch {
        /* a display; the start goes on */
      }
    } else if (event === "result") {
      result = data as { status: number; body: { error?: string } };
    }
  });
  const final = result as { status: number; body: { error?: string } } | null;
  if (!final) {
    throw new Error(
      "the connection closed before the start answered; it may still have started — look for it under Loops"
    );
  }
  if (final.status < 200 || final.status >= 300) {
    throw new Error(final.body.error ?? `the server refused the loop (${final.status})`);
  }
  return final.body;
}

/**
 * What the Start button says while a stage runs. The counts are the server's: the inputs a fetch
 * was given, the files a pin uploads. A restore reads its files from Irys rather than the sources'
 * hosts, and says so, since the owner named an Irys set rather than a URL.
 */
export function loopStartStageLabel(stage: LoopStartStage): string {
  switch (stage.stage) {
    case "checking":
      return "Checking…";
    case "fetching sources":
      if (stage.restoring) return "Restoring the sources from Irys…";
      return stage.sources === 1 ? "Fetching the source…" : `Fetching ${stage.sources} sources…`;
    case "pinning on Irys":
      return `Pinning ${stage.files} ${stage.files === 1 ? "file" : "files"} on Irys…`;
    case "reusing Irys pin":
      return "Reusing the Irys pin…";
    case "starting":
      return "Starting…";
  }
}
