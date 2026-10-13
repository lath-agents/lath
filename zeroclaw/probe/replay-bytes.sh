#!/usr/bin/env bash
# Is a one-shot step byte-reproducible given its replies?
#
#   zeroclaw/probe/replay-bytes.sh <Lath-patched zeroclaw binary>
#
# Runs the same step twice, a few seconds apart, in the same sandbox path, with the contract config
# (zeroclaw/CONTRACT.md §1) over the two Unix sockets: the scripted stub provider
# (stub-provider.py, scenario `lath`) on m.sock and the stub host-tool listener (stub-tools.py) on
# t.sock, serving the same replies both times. Then it diffs every request body byte for byte.
# The binary gets ZEROCLAW_NOW and ZEROCLAW_OMIT_HOST (patch 0001) and nothing else it was not
# named. Exit 0 only if every request matches. No Tempo spend: both stubs are local.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(realpath "$1")"
TOKEN="session-token"
# shellcheck source=contract-config.sh
source "$HERE/contract-config.sh"
ROOT="$(realpath "$(mktemp -d /tmp/lzc.XXXXXX)")"
PIDS=()
trap 'for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done; rm -rf "$ROOT"' EXIT
MSOCK="$ROOT/m.sock"
TSOCK="$ROOT/t.sock"

run() { # <n>
  rm -rf "$ROOT/cfg" "$ROOT/work"
  mkdir -p "$ROOT/work"
  contract_config "$ROOT/cfg" "$ROOT/work" "$MSOCK" "$TSOCK" "$TOKEN"
  rm -f "$MSOCK" "$TSOCK"
  python3 "$HERE/stub-provider.py" "$ROOT/requests-$1.jsonl" "$MSOCK" lath & PIDS+=($!)
  python3 "$HERE/stub-tools.py" "$ROOT/tools-$1.jsonl" "$TSOCK" "$TOKEN" & PIDS+=($!)
  for _ in $(seq 100); do [[ -S "$MSOCK" && -S "$TSOCK" ]] && break; sleep 0.05; done
  (cd "$ROOT/work" && env -i HOME="$ROOT/cfg" TZ=UTC LANG=C \
    ZEROCLAW_NOW=2026-09-24T12:00:00Z ZEROCLAW_OMIT_HOST=1 \
    "$BIN" --config-dir "$ROOT/cfg" agent -a lath -m "Write a note, read it back, and read the greeting." \
    </dev/null >"$ROOT/stdout-$1.txt" 2>"$ROOT/stderr-$1.txt") || { echo "run $1 failed:"; tail -5 "$ROOT/stderr-$1.txt"; exit 1; }
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done
  PIDS=()
}

run 1
sleep 2
run 2

python3 - "$ROOT/requests-1.jsonl" "$ROOT/requests-2.jsonl" "$ROOT/tools-1.jsonl" "$ROOT/tools-2.jsonl" <<'PY'
import json, sys, hashlib
a = [json.loads(l) for l in open(sys.argv[1])]
b = [json.loads(l) for l in open(sys.argv[2])]
ta = [json.loads(l) for l in open(sys.argv[3])]
tb = [json.loads(l) for l in open(sys.argv[4])]
ok = len(a) == len(b) and len(a) > 0
print(f"model requests: {len(a)} and {len(b)}")
for i, (x, y) in enumerate(zip(a, b)):
    same = x["body"] == y["body"]
    ok &= same
    h = hashlib.sha256(x["body"].encode()).hexdigest()[:16]
    print(f"  request {i + 1}: {'identical' if same else 'DIFFERS'}  sha256 {h}…  {len(x['body'])} bytes")
    if not same:
        for n, (p, q) in enumerate(zip(x["body"], y["body"])):
            if p != q:
                print(f"    first difference at byte {n}: {x['body'][max(0, n - 60):n + 40]!r}")
                break
tools_same = [t["body"] for t in ta] == [t["body"] for t in tb] and [t["path"] for t in ta] == [t["path"] for t in tb]
ok &= tools_same and len(ta) > 0
print(f"host-tool requests: {len(ta)} and {len(tb)}, {'identical' if tools_same else 'DIFFER'}")
first = json.loads(a[0]["body"])["messages"]
sysmsg = first[0]["content"]
for needle in ("Host:", "Shell:", "## Current Date"):
    i = sysmsg.find(needle)
    print(f"  {needle!r}: {sysmsg[i:i + 60]!r}" if i >= 0 else f"  {needle!r}: absent")
ok &= "Shell:" not in sysmsg and "Host:" not in sysmsg
print(f"  user message starts {first[-1]['content'][:30]!r}")
print("replay bytes:", "REPRODUCIBLE" if ok else "NOT REPRODUCIBLE")
sys.exit(0 if ok else 1)
PY
