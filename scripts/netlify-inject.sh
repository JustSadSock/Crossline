#!/usr/bin/env bash
set -euo pipefail

escape_replacement() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//&/\\&}"
  value="${value//|/\\|}"
  printf '%s' "$value"
}

if [[ -z "${CROSSLINE_API_URL-}" ]]; then
  echo "CROSSLINE_API_URL must be set for Netlify builds" >&2
  exit 1
fi

ws_origin="${CROSSLINE_WS_URL-}"
if [[ -z "$ws_origin" ]]; then
  case "$CROSSLINE_API_URL" in
    https:*) ws_origin="${CROSSLINE_API_URL/#https:/wss:}" ;;
    http:*) ws_origin="${CROSSLINE_API_URL/#http:/ws:}" ;;
    *) ws_origin="$CROSSLINE_API_URL" ;;
  esac
fi

api="$(escape_replacement "$CROSSLINE_API_URL")"
ws="$(escape_replacement "$ws_origin")"

sed -i "s|<%= process.env.CROSSLINE_API_URL %>|${api}|g" index.html
sed -i "s|<%= process.env.CROSSLINE_WS_URL %>|${ws}|g" index.html
