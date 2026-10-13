#!/usr/bin/env bash
# The Lath-patched ZeroClaw against the contract, run as the host runs it (zeroclaw/CONTRACT.md).
#
#   zeroclaw/probe/lath-binary.sh <zeroclaw binary> [trace runs, default 50]
#
# 1. Refusals: each config below differs from the contract in one way the Lath build refuses. The
#    binary must exit non-zero with the refused name in its error, before any request reaches the
#    model socket.
# 2. The happy path: the contract config, the scripted provider (stub-provider.py, scenario `lath`)
#    on m.sock and the stub host-tool listener (stub-tools.py) on t.sock. The step calls
#    file_write, file_read and store_get and completes; the tool list in the first request is
#    exactly the eight allowed names; HTTP_PROXY, HTTPS_PROXY and ALL_PROXY point at a listener
#    that must see no connection; stdout is the final text.
# 3. The trace: over <trace runs> runs, the last tool record of each run is in the runtime trace
#    when the process has exited (patch 0006).
#
# Exit 0 only if every check passed. No network, no Tempo spend: both stubs are local.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(realpath "$1")"
TRACE_RUNS="${2:-50}"
TOKEN="step-token-0123456789"
# Short on purpose: a Unix socket path is at most 104 bytes on macOS.
ROOT="$(realpath "$(mktemp -d /tmp/lzb.XXXXXX)")"
PIDS=()
# KEEP=1 leaves the sandbox on disk for inspection.
cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  if [[ -n "${KEEP:-}" ]]; then echo "kept $ROOT"; else rm -rf "$ROOT"; fi
}
trap cleanup EXIT

MSOCK="$ROOT/m.sock"
TSOCK="$ROOT/t.sock"
# shellcheck source=contract-config.sh
source "$HERE/contract-config.sh"
ALL_TOOLS="$CC_ALL_TOOLS"

# render <dir> [allowed_tools] [provider extra lines] [top-level extra toml] [uri] [retries]
# Writes <dir>/cfg/config.toml in the contract's shape and makes <dir>/work.
render() {
  # `${2-…}`, not `${2:-…}`: an empty second argument means an empty allowed_tools.
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir/work"
  CC_TOOLS="${2-$ALL_TOOLS}" CC_PEXTRA="${3:-}" CC_EXTRA="${4:-}" CC_URI="${5:-}" CC_RETRIES="${6:-}" \
    contract_config "$dir/cfg" "$dir/work" "$MSOCK" "$TSOCK" "$TOKEN"
}

# step <dir> [extra env...]: one invocation as the host makes it (CONTRACT §4). Sets RC.
step() {
  local dir="$1"; shift
  set +e
  (cd "$dir/work" && env -i HOME="$dir" TZ=UTC LANG=C ZEROCLAW_NOW=2026-09-24T12:00:00Z ZEROCLAW_OMIT_HOST=1 "$@" \
    "$BIN" --config-dir "$dir/cfg" agent -a lath -m "Write a note, read it back, and read the greeting." \
    </dev/null >"$dir/stdout" 2>"$dir/stderr")
  RC=$?
  set -e
}

start_stubs() { # <provider log> <tools log>
  rm -f "$MSOCK" "$TSOCK"
  python3 "$HERE/stub-provider.py" "$1" "$MSOCK" lath & PIDS+=($!)
  python3 "$HERE/stub-tools.py" "$2" "$TSOCK" "$TOKEN" & PIDS+=($!)
  for _ in $(seq 100); do [[ -S "$MSOCK" && -S "$TSOCK" ]] && break; sleep 0.05; done
}
stop_stubs() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done; PIDS=(); }

fail=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; fail=1; }

# refuse <label> <needle> <dir> [env...]: the step must exit non-zero, name <needle>, and send
# the model nothing.
refuse() {
  local label="$1" needle="$2" dir="$3"; shift 3
  : >"$ROOT/refusal-requests.jsonl"
  step "$dir" "$@"
  local err; err="$(tr '\n' ' ' <"$dir/stderr")"
  if [[ $RC -eq 0 ]]; then bad "$label: exited 0"
  elif ! grep -qF -- "$needle" "$dir/stderr"; then bad "$label: exit $RC without \`$needle\`: ${err:0:300}"
  elif [[ -s "$ROOT/refusal-requests.jsonl" ]]; then bad "$label: refused, but only after a model request"
  else ok "$label: exit $RC, names \`$needle\`"; fi
}

echo "== refusals (each must exit non-zero, name what it refused, and reach no model)"
start_stubs "$ROOT/refusal-requests.jsonl" "$ROOT/refusal-tools.jsonl"
C="$ROOT/case"
render "$C" "$ALL_TOOLS" "" $'[providers.models.openrouter.default]\nmodel = "openai/gpt-5"'
refuse "a second provider family" "providers.models.openrouter.default" "$C"
render "$C" "$ALL_TOOLS" 'fallback = ["custom.backup"]' $'[providers.models.custom.backup]\nmodel = "m"\nuri = "http://localhost/v1"\nunix_socket = "'"$MSOCK"'"'
refuse "a provider fallback" "custom.backup" "$C"
render "$C" "$ALL_TOOLS" "" $'[[model_routes]]\nhint = "fast"\nmodel_provider = "custom.lath"\nmodel = "other/model"'
refuse "a model route" "fast" "$C"
render "$C" "$ALL_TOOLS" "" "" "http://127.0.0.1:9/v1"
refuse "a TCP uri" "http://127.0.0.1:9/v1" "$C"
render "$C" '"file_read", "file_write", "shell"'
refuse "shell in allowed_tools" "shell" "$C"
render "$C" "$ALL_TOOLS" "" $'[mcp_bundles.web]\nservers = ["fetch"]'
refuse "an MCP bundle" "mcp_bundles" "$C"
render "$C"; mkdir -p "$C/work/skills/evil"; echo '[skill]' >"$C/work/skills/evil/SKILL.toml"
refuse "a skills/ directory in the workspace" "skills" "$C"
render "$C"
refuse "ZEROCLAW_OPEN_SKILLS_ENABLED=1" "ZEROCLAW_OPEN_SKILLS_ENABLED" "$C" ZEROCLAW_OPEN_SKILLS_ENABLED=1
render "$C" ""
refuse "empty allowed_tools" "allowed_tools" "$C"
render "$C" "$ALL_TOOLS" "" "" "http://localhost/v1" 1
refuse "provider_retries = 1" "provider_retries" "$C"
# The one optional provider key (CONTRACT §1): only a positive integer, since 0 would silently mean
# upstream's 32k fallback and anything else is a host bug. Zero parses as upstream's `usize`, and
# patch 0005's posture check names the key; a value that is not a `usize` at all never reaches it,
# because the typed load already fails and the Lath build refuses the section it could not read.
render "$C" "$ALL_TOOLS" "context_window = 0"
refuse "context_window = 0" "context_window" "$C"
for w in -1 1.5 '"163840"'; do
  render "$C" "$ALL_TOOLS" "context_window = $w"
  refuse "context_window = $w" "providers.models.custom.lath" "$C"
done
render "$C" "$ALL_TOOLS" "" $'[web_search]\nenabled = true'
refuse "a web tool section" "web_search" "$C"
render "$C" "$ALL_TOOLS" "" $'[channels.telegram.default]\nbot_token = "x"'
refuse "a channel" "channels" "$C"
rm -rf "$C"; mkdir -p "$C/cfg" "$C/work"
refuse "no config file" "config.toml" "$C"
if [[ -e "$C/cfg/config.toml" ]]; then bad "no config file: a default config was written"; else ok "no config file: nothing written"; fi
stop_stubs

echo "== the happy path: the contract config, both sockets, a proxy that must stay silent"
H="$ROOT/happy"
render "$H"
start_stubs "$ROOT/requests.jsonl" "$ROOT/tools.jsonl"
# The proxy stand-in: counts every connection it accepts.
python3 - "$ROOT/proxy.port" "$ROOT/proxy.hits" <<'PY' & PIDS+=($!)
import socket, sys, threading
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(16)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
open(sys.argv[2], "w").write("")
while True:
    c, _ = s.accept()
    with open(sys.argv[2], "a") as f: f.write("hit\n")
    c.close()
PY
for _ in $(seq 100); do [[ -s "$ROOT/proxy.port" ]] && break; sleep 0.05; done
PROXY="http://127.0.0.1:$(cat "$ROOT/proxy.port")"
step "$H" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" ALL_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"
if [[ $RC -eq 0 ]]; then ok "exit 0"; else bad "exit $RC: $(tail -3 "$H/stderr")"; fi
if grep -q '^DONE:' "$H/stdout"; then ok "stdout is the final text: $(head -1 "$H/stdout")"; else bad "stdout: $(head -3 "$H/stdout")"; fi
if [[ "$(cat "$H/work/notes/hello.txt" 2>/dev/null)" == "hello from step one" ]]; then ok "file_write landed in the workspace"; else bad "notes/hello.txt missing or wrong"; fi
python3 - "$ROOT/requests.jsonl" "$ROOT/tools.jsonl" "$TOKEN" <<'PY' || fail=1
import json, sys
reqs = [json.loads(l) for l in open(sys.argv[1])]
tools = [json.loads(l) for l in open(sys.argv[2])] if open(sys.argv[2]).read() else []
want = ["file_read", "file_write", "store_get", "store_set", "solana_slot", "solana_fees", "solana_balance", "lath_verify_chain"]
bad = 0
def check(cond, label):
    global bad
    print(("ok    " if cond else "FAIL  ") + label)
    bad |= not cond
check(len(reqs) == 4, f"four model requests (file_write, file_read, store_get, final): {len(reqs)}")
first = json.loads(reqs[0]["body"])
names = [t["function"]["name"] for t in first.get("tools", [])]
check(sorted(names) == sorted(want) and len(names) == len(want), f"tool specs in the first request are exactly the eight: {names}")
check(all(r["headers"].get("authorization") == f"Bearer {sys.argv[3]}" for r in reqs), "every model request carries the step's bearer")
check(all(r["path"] == "/v1/chat/completions" for r in reqs), "every model request is POST /v1/chat/completions")
check(len(tools) == 1 and tools[0]["path"] == "/tools/store.get" and json.loads(tools[0]["body"]) == {"key": "greeting"},
      f"one host-tool call, POST /tools/store.get with the model's arguments: {[t['path'] for t in tools]}")
check(all(t["headers"].get("authorization") == f"Bearer {sys.argv[3]}" for t in tools), "the host-tool call carries the step's token")
last = json.loads(reqs[-1]["body"])["messages"]
tool_msgs = [m for m in last if m.get("role") == "tool"]
check(any("hello from the host" in (m.get("content") or "") for m in tool_msgs), "the store_get result reached the model")
sysmsg = first["messages"][0]["content"]
check("Shell:" not in sysmsg, "no `Shell:` in the system prompt")
check("Host:" not in sysmsg, "no `Host:` in the system prompt (ZEROCLAW_OMIT_HOST)")
sys.exit(bad)
PY
if [[ -s "$ROOT/proxy.hits" ]]; then bad "the HTTP_PROXY listener saw $(wc -l <"$ROOT/proxy.hits" | tr -d ' ') connection(s)"; else ok "the HTTP_PROXY listener saw no connection"; fi
if grep -qF '"tools":["file_read","file_write","store_get","store_set","solana_slot","solana_fees","solana_balance","lath_verify_chain"]' -r "$H/cfg/data" 2>/dev/null; then
  ok "the trace records the assembled registry: exactly the eight"
else
  bad "no 'Lath registry assembled' record with the eight names under $H/cfg/data"
fi

stop_stubs

echo "== the trace is flushed before exit, $TRACE_RUNS runs"
# Each run gets fresh stubs, so the scripted replies start over and every run makes the same
# three tool calls; the check is on the trace file as the exited process left it.
T="$ROOT/trace"
lost=0
i=0
while [[ $i -lt $TRACE_RUNS ]]; do
  i=$((i + 1))
  render "$T"
  start_stubs "$ROOT/trace-requests.jsonl" "$ROOT/trace-tools.jsonl"
  step "$T"
  stop_stubs
  if [[ $RC -ne 0 ]] || ! python3 "$HERE/trace-last-tool.py" "$T/cfg/data/state/runtime-trace.jsonl" store_get; then
    lost=$((lost + 1))
  fi
done
if [[ $lost -eq 0 ]]; then ok "the last tool call's result record (store_get) was on disk after each of $TRACE_RUNS runs"
else bad "$lost of $TRACE_RUNS runs exited without the last tool call's result record on disk"; fi

if [[ $fail -ne 0 ]]; then echo "LATH BINARY: FAIL"; exit 1; fi
echo "LATH BINARY: PASS"
