import type { ChatRequest, ChatResult, ChatStreamOptions, ChatTransport } from "../../runtime/src";

/**
 * Replays recorded `ChatResult`s in order. The fixture tests' whole point is that the loop, the
 * metering and the chain are exercised with no network, so a request past the end of the
 * recording is an error rather than a fallback.
 *
 * It lives here rather than in `runtime/src/openrouter.ts` because it is a test double and the
 * published `@lath/runtime` bundle should not carry one. `tests/loop.ts` deliberately does
 * not use it — a loop runs forever, and an exhausted recording is the wrong failure there, so it
 * has its own `cycling()` transport.
 */
export class RecordedTransport implements ChatTransport {
  readonly requests: ChatRequest[] = [];
  private i = 0;

  constructor(private readonly recording: ChatResult[]) {}

  async chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatResult> {
    this.requests.push(req);
    if (this.i >= this.recording.length) {
      throw new Error(`RecordedTransport exhausted after ${this.recording.length} responses`);
    }
    const result = this.recording[this.i++];
    if (!opts?.onToken) return result;
    // A recording has no deltas to replay, so the whole message arrives as one token. That is
    // enough for a caller to prove it wired `onToken` through; token granularity is the live
    // transport's business, and `tests/openrouter-stream.ts` is where it is tested.
    const content = result.body?.choices?.[0]?.message?.content;
    if (typeof content === "string") opts.onToken(content);
    return { ...result, streamed: true };
  }

  get calls(): number {
    return this.i;
  }
}
