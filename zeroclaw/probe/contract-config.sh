# Render the step config of zeroclaw/CONTRACT.md §1 (sourced by the probes, not run).
#
#   contract_config <config dir> <workspace path> <m.sock path> <t.sock path> <token>
#
# The paths are the ones the binary will see: the sandbox's real paths on macOS, the /lath/... mount
# points under bwrap. Knobs, each empty by default, for the refusal cases:
#   CC_TOOLS    the allowed_tools list body (default: all eight); set it empty for `[]`
#   CC_PEXTRA   extra lines inside [providers.models.custom.lath]
#   CC_EXTRA    extra TOML appended at the end
#   CC_URI      the provider uri (default http://localhost/v1)
#   CC_RETRIES  reliability.provider_retries (default 0)
CC_ALL_TOOLS='"file_read", "file_write", "store_get", "store_set", "solana_slot", "solana_fees", "solana_balance", "lath_verify_chain"'

contract_config() {
  local cfg="$1" work="$2" msock="$3" tsock="$4" token="$5"
  mkdir -p "$cfg"
  cat >"$cfg/config.toml" <<EOF
schema_version = 3
locale = "en"

[providers.models.custom.lath]
model = "deepseek/deepseek-v4.1-flash"
uri = "${CC_URI:-http://localhost/v1}"
unix_socket = "$msock"
api_key = "$token"
native_tools = true
temperature = 0.2
${CC_PEXTRA:-}

[agents.lath]
enabled = true
model_provider = "custom.lath"
risk_profile = "lath"
runtime_profile = "lath"

[agents.lath.workspace]
path = "$work"

[agents.lath.memory]
backend = "none"

[risk_profiles.lath]
level = "full"
workspace_only = true
allowed_tools = [${CC_TOOLS-$CC_ALL_TOOLS}]
always_ask = []
sandbox_enabled = false

[runtime_profiles.lath]
max_tool_iterations = 16

[memory]
backend = "none"

[cost]
enabled = false

[reliability]
provider_retries = ${CC_RETRIES:-0}

[lath]
tools_socket = "$tsock"
tools_token = "$token"
${CC_EXTRA:-}
EOF
}
