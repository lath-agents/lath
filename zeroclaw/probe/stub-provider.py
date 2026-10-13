# A scripted OpenAI-shaped provider: replies in order, logs every request verbatim.
# argv: <log path> <tcp port | unix socket path> [scenario]
#
# Scenarios (the replies, in order; the last one repeats if the binary asks again):
#   files  file_write, file_read, then a final answer (the plain file step)
#   lath   file_write, file_read, store_get, then a final answer (the Lath registry step: two
#          ZeroClaw tools in the sandbox and one host tool through the tools socket)
import json, os, sys, http.server, socketserver

LOG, WHERE = sys.argv[1], sys.argv[2]
SCENARIO = sys.argv[3] if len(sys.argv) > 3 else "files"


def call(n, name, args):
    return {"tool_calls": [{"id": f"call_{n}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}


SCENARIOS = {
    "files": [
        call(1, "file_write", {"path": "notes/hello.txt", "content": "hello from step one\n"}),
        call(2, "file_read", {"path": "notes/hello.txt"}),
        {"content": "DONE: wrote and read notes/hello.txt"},
    ],
    "lath": [
        call(1, "file_write", {"path": "notes/hello.txt", "content": "hello from step one\n"}),
        call(2, "file_read", {"path": "notes/hello.txt"}),
        call(3, "store_get", {"key": "greeting"}),
        {"content": "DONE: wrote and read notes/hello.txt, read greeting from the store"},
    ],
}
REPLIES = SCENARIOS[SCENARIO]
n = {"i": 0}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        with open(LOG, "ab") as f:
            f.write(json.dumps({"path": self.path, "headers": dict(self.headers), "body": body.decode()}).encode() + b"\n")
        r = REPLIES[min(n["i"], len(REPLIES) - 1)]
        n["i"] += 1
        msg = {"role": "assistant", "content": r.get("content")}
        if "tool_calls" in r:
            msg["tool_calls"] = r["tool_calls"]
        out = json.dumps({"id": "cmpl-%d" % n["i"], "object": "chat.completion", "created": 0, "model": "stub",
            "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if "tool_calls" in r else "stop"}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


if WHERE.isdigit():
    socketserver.TCPServer.allow_reuse_address = True
    s = socketserver.TCPServer(("127.0.0.1", int(WHERE)), H)
else:
    class U(socketserver.UnixStreamServer):
        def get_request(self):
            req, _ = super().get_request()
            return req, ("uds", 0)
    if os.path.exists(WHERE):
        os.unlink(WHERE)
    s = U(WHERE, H)
s.serve_forever()
