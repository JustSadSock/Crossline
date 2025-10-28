#!/usr/bin/env bash
set -euo pipefail

escape_replacement() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//&/\\&}"
  value="${value//|/\\|}"
  printf '%s' "$value"
}

api="$(escape_replacement "${CROSSLINE_API_URL-}")"
ws="$(escape_replacement "${CROSSLINE_WS_URL-}")"

sed -i "s|<%= process.env.CROSSLINE_API_URL %>|${api}|g" index.html
sed -i "s|<%= process.env.CROSSLINE_WS_URL %>|${ws}|g" index.html
