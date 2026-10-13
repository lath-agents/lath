# A stub of the Lath host-tool listener (zeroclaw/CONTRACT.md §3): HTTP/1.1 on a Unix socket,
# `POST /tools/<tool id>` with the step's bearer, the model's arguments as the body. Logs every
# request verbatim and answers from a tiny in-memory store, so a step can call store_set and read
# the value back with store_get.
# argv: <log path> <unix socket path> <token>
import json, os, sys, http.server, socketserver

LOG, WHERE, TOKEN = sys.argv[1], sys.argv[2], sys.argv[3]
STORE = {"greeting": "hello from the host"}


def answer(tool, args):
    if tool == "store.get":
        key = args.get("key")
        if key is None:
            return 200, {"result": {"entries": [{"key": k, "value": v} for k, v in sorted(STORE.items())]}}
        if key not in STORE:
            return 200, {"result": {"key": key, "found": False}}
        return 200, {"result": {"key": key, "found": True, "value": STORE[key]}}
    if tool == "store.set":
        STORE[args["key"]] = args["value"]
        return 200, {"result": {"key": args["key"], "version": "1", "opSeq": "1", "signature": "stub"}}
    if tool == "solana.slot":
        return 200, {"result": {"cluster": "stub", "slot": 1, "blockTime": 0}}
    if tool == "solana.fees":
        return 200, {"result": {"samples": 0, "medianMicroLamports": 0}}
    if tool == "solana.balance":
        return 500, {"error": "stub: no RPC behind this listener"}
    if tool == "lath.verify_chain":
        return 200, {"result": {"ok": True, "seq": "0"}}
    return 404, {"error": f"unknown tool {tool}"}


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        with open(LOG, "ab") as f:
            f.write(json.dumps({"path": self.path, "headers": dict(self.headers), "body": body.decode()}).encode() + b"\n")
        if self.headers.get("authorization") != f"Bearer {TOKEN}":
            status, out = 401, {"error": "wrong token"}
        elif not self.path.startswith("/tools/"):
            status, out = 404, {"error": f"no route {self.path}"}
        else:
            status, out = answer(self.path[len("/tools/"):], json.loads(body or b"{}"))
        data = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class U(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        req, _ = super().get_request()
        return req, ("uds", 0)


if os.path.exists(WHERE):
    os.unlink(WHERE)
U(WHERE, H).serve_forever()
