# Did an exited step leave its whole trace on disk? (patch 0006)
# argv: <runtime-trace.jsonl> <tool name of the step's last tool call>
# Exit 0 if the file holds a `tool_call_result` record for that tool and ends with the step's
# `turn_final_response`, the last record a run writes.
import json, sys

path, tool = sys.argv[1], sys.argv[2]
try:
    records = [json.loads(line) for line in open(path) if line.strip()]
except FileNotFoundError:
    print(f"trace-last-tool: no trace at {path}")
    sys.exit(1)
messages = [r.get("message") for r in records]
has_result = any(r.get("message") == "tool_call_result" and r.get("attributes", {}).get("tool") == tool for r in records)
ends_final = bool(messages) and messages[-1] == "turn_final_response"
if not (has_result and ends_final):
    print(f"trace-last-tool: {len(records)} records, {tool} result {'present' if has_result else 'MISSING'}, "
          f"last record {messages[-1] if messages else None!r}")
    sys.exit(1)
