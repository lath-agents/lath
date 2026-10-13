import { assert } from "chai";
import { sse } from "../frontend/src/app/api/_lib/sse";
import { parseSseBlock, readSseEvents } from "../frontend/src/lib/loop-start-stream";

/**
 * The browser's SSE parsing against the server's own framing (`_lib/sse.ts`).
 *
 * `JSON.stringify` leaves U+2028 and U+2029 raw, and a JS regex's `.` and multiline `$` treat both
 * as line ends, so a parser written as `/^data: (.+)$/m` cut a payload at either character and the
 * `JSON.parse` after it threw — one pasted prompt or one model token was enough to drop the rest of a
 * session's stream in the browser. These pin that both characters round-trip.
 */
describe("sse parse", () => {
  const payload = { delta: "a\u2028b\u2029c", nested: { text: "line\nbreak \u2028 end" } };

  it("parses a block whose data carries U+2028 and U+2029", () => {
    const block = sse("session:token", payload).replace(/\n\n$/, "");
    const parsed = parseSseBlock(block);
    assert.isNotNull(parsed);
    assert.equal(parsed!.event, "session:token");
    assert.deepEqual(JSON.parse(parsed!.data), payload);
  });

  it("answers null for a block with no event or no data", () => {
    assert.isNull(parseSseBlock("data: {}"));
    assert.isNull(parseSseBlock("event: x"));
    assert.isNull(parseSseBlock(": keep-alive"));
  });

  it("reads every event of a stream in order, split across chunk boundaries", async () => {
    const text = sse("stage", { stage: "checking" }) + sse("session:token", payload) + sse("result", { status: 200 });
    const bytes = new TextEncoder().encode(text);
    // Cut mid-character too: U+2028 is three UTF-8 bytes, and the decoder must carry it over.
    const cut = text.indexOf("\u2028");
    const at = new TextEncoder().encode(text.slice(0, cut)).length + 1;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, at));
        c.enqueue(bytes.slice(at));
        c.close();
      },
    });
    const seen: [string, unknown][] = [];
    await readSseEvents(body, (event, data) => seen.push([event, data]));
    assert.deepEqual(seen, [
      ["stage", { stage: "checking" }],
      ["session:token", payload],
      ["result", { status: 200 }],
    ]);
  });
});
