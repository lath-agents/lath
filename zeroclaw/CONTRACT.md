# The contract between the host and the Lath-patched ZeroClaw

_Two sides build against it: the patches in `zeroclaw/patches/` make the binary accept exactly this,
and the host (`runtime/src/zeroclaw/`) produces and serves exactly this. A change to this file is a
change to both sides, in one commit._

## 1. The config the host writes

One `config.toml` per step, in a fresh directory the host passes as `--config-dir`, rendered
from the posture JSON and never hand-edited. Placeholders are `<…>`. Every
key below exists upstream at `dc372cc` except the two marked **Lath**, which patches 0003 and
0004 add. Under the `lath` feature, a config that differs from this shape in a way patch 0005
checks (an extra provider, tool, MCP server, skill, channel, delegate or plugin; an empty or
foreign `allowed_tools`; a TCP `uri`; retries) makes the binary exit non-zero, naming what it
refused.

```toml
schema_version = 3
locale = "en"

[providers.models.custom.lath]
model = "<policy.model>"                 # the proxy pins it again; a mismatch is a 400
uri = "http://localhost/v1"              # host ignored over a Unix socket; path kept
unix_socket = "<abs path to m.sock>"     # Lath (0003)
api_key = "<step token>"                 # sent as Authorization: Bearer
native_tools = true
temperature = <policy.temperature>

[agents.lath]
enabled = true
model_provider = "custom.lath"
risk_profile = "lath"
runtime_profile = "lath"

[agents.lath.workspace]
path = "<abs path to the loop's workspace>"   # /lath/work under bwrap

[agents.lath.memory]
backend = "none"

[risk_profiles.lath]
level = "full"
workspace_only = true
allowed_tools = ["file_read", "file_write", "<host tool wire names the policy allows>"]
always_ask = []
sandbox_enabled = false                  # the host's wrapper is the sandbox; nothing is spawned to detect one

[runtime_profiles.lath]
max_tool_iterations = <maxSteps, default 16>

[memory]
backend = "none"

[cost]
enabled = false

[reliability]
provider_retries = 0

[lath]                                   # Lath (0004)
tools_socket = "<abs path to t.sock>"
tools_token = "<step token>"
```

**One optional key, `context_window = <tokens>`**, on its own line right after `temperature` in
`[providers.models.custom.lath]` (upstream's key, which patch 0005 adds to its allow-list).
The host sets it per step, like `model`: `ZeroClawRuntime` asks OpenRouter's public model list
for the policy model's `context_length` (`runtime/src/zeroclaw/context-window.ts`, read by the host,
which has a network — the sandbox has none — when the console starts, and again by the next step
while no read has succeeded; a failed read is not kept) and writes it
when the answer is a positive integer. Unset, upstream runs against its 32 000-token compatibility
fallback and refuses before dispatch any turn whose retained tokens pass it, which a sandbox reading
its sources does; so when the list cannot be read the host takes the window from a table copied from
that list for the console's own models (`KNOWN_CONTEXT_WINDOWS`, dated in its comment), and omits the
key only for a model neither names, which then gets exactly the block above. The Lath build refuses any value
but a positive integer: `0` by the key (patch 0005's posture check), and anything that is not an
unsigned integer by its section, which upstream's typed load cannot read. It is not in the posture JSON, so it moves neither
`postureHash` nor the policy hash; the step's report carries it in `postureToml`.

## 2. The model socket (`m.sock`)

HTTP/1.1 over the Unix socket. The binary sends exactly what upstream's `custom` provider sends
to `POST /v1/chat/completions` with `stream: false`. The host answers `200` with one
chat-completion JSON body (`usage` verbatim, no `payment`), or a status the binary does not
retry on. A request without the step's bearer is `401`; a request naming another model is `400`
before anything is paid.

## 3. The tools socket (`t.sock`)

HTTP/1.1 over the Unix socket.

- Request: `POST /tools/<tool id>` with `Authorization: Bearer <tools_token>` and
  `content-type: application/json`; the body is the tool's arguments object exactly as the
  model gave it (the JSON the binary parsed, re-serialised by `serde_json`).
- The tool id is the dotted Lath id (`store.get`), never the wire name.
- Response `200` `{"result": <any JSON>}`: the binary returns `ToolResult::ok` with the result
  as JSON. Response `404` or `500` `{"error": "<text>"}`: the binary returns `ToolResult::err`
  with the text. `401` for a wrong token. Anything else, or a transport failure, is an `Err`.
- Each call is one Action on the host, with the status as its status code, exactly as an
  in-process tool call is today (`runtime.ts` `runToolCall`).

The six host tools, with their wire name (what the model sees) and their id (what the chain
records). Their `description` and `parameters` are copied verbatim from the Lath definitions in
`frontend/src/app/api/_lib/tools.ts` so the model sees the same spec in or out of the sandbox, and
a test compares them.

| wire name | tool id |
| --- | --- |
| `store_get` | `store.get` |
| `store_set` | `store.set` |
| `solana_slot` | `solana.slot` |
| `solana_fees` | `solana.fees` |
| `solana_balance` | `solana.balance` |
| `lath_verify_chain` | `lath.verify_chain` |

The older alias `lattice.verify_chain` (`LEGACY_TOOL_NAMES`) is not in the Lath build: a
sandboxed loop whose policy names it is refused at start with the name, as a `web.*` tool is.

`file_read` and `file_write` are ZeroClaw's own, run inside the sandbox, and are recorded by the
host from the model traffic as `zc.file_read` and `zc.file_write`.

## 4. The process

- Invocation: `zeroclaw --config-dir <cfg> agent -a lath -m "<step message>"`, stdin closed,
  detached from any terminal (a new session), under the wrapper.
- Environment, and nothing else: `HOME=<the step's directory>`, `TZ=UTC`, `LANG=C`,
  `ZEROCLAW_NOW=<the step's start, RFC 3339>`, `ZEROCLAW_OMIT_HOST=1`.
- Output: the final text on stdout; exit 0. Anything else is a failed step.
- Files it may write: under `<cfg>/data` and the workspace. Nothing else is mounted or allowed.

## 5. Sources

A loop with sources finds them at `<workspace>/sources/`, which the
host seeds before the sandbox starts and which is read-only at the OS: a `(deny file-write*)` on the
subpath after the workspace's allow under `sandbox-exec`, a `--ro-bind` over `/lath/work/sources`
after the workspace's bind under `bwrap`. The binary reads them with `file_read` like any other
workspace file, and a `file_write` there fails with the OS's error, reported as the tool's error
result. Nothing else changes: no config key, flag, environment variable or socket, and so no
patch and no new binary hash. A loop without sources has no `sources/` and exactly §1–§4.
