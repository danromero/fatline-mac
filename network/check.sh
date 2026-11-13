#!/usr/bin/env bash
# Checks that a deployed Fatline network answers the way docs/NETWORK.md says, without signing in.
# Usage: ./check.sh https://network.example
set -u

base="${1:-}"
while [ "${base%/}" != "$base" ]; do base="${base%/}"; done

case "$base" in
  https://*|http://localhost*|http://127.0.0.1*) ;;
  *) echo "Usage: ./check.sh https://network.example" >&2; exit 2 ;;
esac

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

body=$(mktemp)
trap 'rm -f "$body"' EXIT
failed=0
code=000

pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s: %s\n' "$1" "$2"; failed=$((failed + 1)); }

call() {
  code=$(curl -sS -m 30 -o "$body" -w '%{http_code}' "$@" 2>/dev/null) || true
  [ -n "$code" ] || code=000
}

# status NAME WANT PATH passes when PATH answers with HTTP WANT.
status() {
  call "$base$3"
  if [ "$code" = "$2" ]; then pass "$1"; else fail "$1" "HTTP $code, expected $2"; fi
}

call "$base/api/v1/"
if [ "$code" = 200 ] && jq -e '.fatline == "network" and .version == 1' "$body" >/dev/null 2>&1; then
  pass "it's a Fatline network, version 1"
else
  fail "it's a Fatline network, version 1" "HTTP $code"
fi
status "the network itself needs a session" 401 /api/v1/network
status "the feed needs a session" 401 /api/v1/feed
status "an unknown invite code is refused" 404 /api/v1/invites/not-a-real-code
status "the admin pages need a session" 401 /admin

if [ "$failed" = 0 ]; then
  echo "Everything checked out."
else
  echo "$failed check(s) failed."
  exit 1
fi
