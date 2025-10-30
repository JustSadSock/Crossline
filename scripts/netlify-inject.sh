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
  if [[ -n "${CROSSLINE_API_URL_DEFAULT-}" ]]; then
    CROSSLINE_API_URL="$CROSSLINE_API_URL_DEFAULT"
    echo "[WARN] CROSSLINE_API_URL not provided; using CROSSLINE_API_URL_DEFAULT=$CROSSLINE_API_URL" >&2
  else
    CROSSLINE_API_URL="https://api.example.com"
    echo "[WARN] CROSSLINE_API_URL not provided; using fallback $CROSSLINE_API_URL" >&2
    echo "        Configure CROSSLINE_API_URL in Netlify to target your backend." >&2
  fi
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
