#!/usr/bin/env bash
# Checks that a server can back Fatline. Usage: ./check.sh https://your-server.example/your-path
# It never prints the URL, because the URL can contain a secret path.
# shellcheck disable=SC2016  # $want in the filters is a jq variable, not a shell one.
set -u

base="${1:-}"
while [ "${base%/}" != "$base" ]; do base="${base%/}"; done

case "$base" in
  https://*|http://localhost*|http://127.0.0.1*) ;;
  *) echo "Usage: ./check.sh https://your-server.example/your-path" >&2; exit 2 ;;
esac

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

body=$(mktemp)
trap 'rm -f "$body"' EXIT
failed=0
code=000
want=""

pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s: %s\n' "$1" "$2"; failed=$((failed + 1)); }

# Sends a request, leaving the response in $body and the status in $code.
call() {
  code=$(curl -sS -m 45 -o "$body" -w '%{http_code}' "$@" 2>/dev/null) || true
  [ -n "$code" ] || code=000
}

explain() {
  case "$code" in
    000) echo "no answer" ;;
    401|403) echo "HTTP $code, the key was rejected or can't use Snapchain" ;;
    402) echo "HTTP 402, out of credits" ;;
    404) echo "HTTP 404, wrong URL or missing route" ;;
    429) echo "HTTP 429, too many requests" ;;
    503) if grep -q "Server not configured" "$body"; then echo "HTTP 503, a secret is missing or PATH_SECRET is too weak"; else echo "HTTP 503"; fi ;;
    *) echo "HTTP $code" ;;
  esac
}

# expect NAME JQ_FILTER CURL_ARGS... passes on HTTP 200 and a true filter. The filter can use $want.
expect() {
  local name=$1 filter=$2
  shift 2
  call "$@"
  if [ "$code" != 200 ]; then
    fail "$name" "$(explain)"
  elif jq -e --arg want "$want" "$filter" "$body" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name" "HTTP 200 with the wrong response shape"
  fi
}

# A node reports a missing record with 404, or with 400 and NotFound in the body.
expect_not_found() {
  local name=$1
  shift
  call "$@"
  if [ "$code" = 404 ] || { [ "$code" = 400 ] && grep -q "NotFound" "$body"; }; then
    pass "$name"
  else
    fail "$name" "$(explain)"
  fi
}

expect_404() {
  local name=$1
  shift
  call "$@"
  if [ "$code" = 404 ]; then pass "$name"; else fail "$name" "expected 404, got $code"; fi
}

username_query='fid=1&user_data_type=USER_DATA_TYPE_USERNAME'

echo "Connectivity"
expect "feed route answers" '.casts | type == "array"' "$base/v2/farcaster/feed/following/?fid=1&limit=1&with_recasts=false"
expect "node route answers" '.messages | type == "array"' "$base/v1/userDataByFid?$username_query"

echo "Sign-in"
expect "users load" '.users[0].fid == 1' "$base/v2/farcaster/user/bulk/?fids=1"
address=$(jq -r '.users[0].custody_address // empty' "$body" 2>/dev/null | tr '[:upper:]' '[:lower:]')
[ -n "$address" ] || address=0x7071cfba18280fd0bc1142d98f8e67fb094d9544
want=$address
expect "account lookup" '.fid == 1 and (.idRegisterEventBody.to | ascii_downcase) == $want' "$base/v1/onChainIdRegistryEventByAddress?address=$address"
expect_not_found "unknown account reports not found" "$base/v1/onChainIdRegistryEventByAddress?address=0x00000000000000000000000000000000000dead1"
expect "signers and nonce" '(.currentUserNonce | type == "number") and (.signers[0].key | startswith("0x"))' "$base/v1/signersByFid?fid=1&pageSize=1"

echo "Feed"
expect "follows load" '.messages[0].data.linkBody.targetFid | type == "number"' "$base/v1/linksByFid?fid=3&link_type=follow&pageSize=1"
token=$(jq -r '.nextPageToken // empty' "$body" 2>/dev/null)
if [ -n "$token" ]; then
  expect "follows next page" '.messages | type == "array"' -G --data-urlencode "pageToken=$token" -d fid=3 -d link_type=follow -d pageSize=1 "$base/v1/linksByFid"
else
  fail "follows next page" "no nextPageToken"
fi

expect "feed page" '(.casts | length) > 0 and (.next.cursor | type == "string")' "$base/v2/farcaster/feed/following/?fid=3&limit=10&with_recasts=false"
cursor=$(jq -r '.next.cursor // empty' "$body" 2>/dev/null)
hash=$(jq -r '.casts[0].hash // empty' "$body" 2>/dev/null)
author=$(jq -r '.casts[0].author.fid // empty' "$body" 2>/dev/null)
if [ -n "$cursor" ]; then
  want=$hash
  expect "feed next page" '(.casts | length) > 0 and .casts[0].hash != $want' -G --data-urlencode "cursor=$cursor" -d fid=3 -d limit=10 -d with_recasts=false "$base/v2/farcaster/feed/following/"
else
  fail "feed next page" "no next.cursor"
fi

echo "Posting routes"
case "$hash" in
  ""|0x*) ;;
  *) hash="0x$hash" ;;
esac
if [ -n "$hash" ] && [ -n "$author" ]; then
  want=$(printf %s "$hash" | tr '[:upper:]' '[:lower:]')
  expect "cast lookup" '(.hash | ascii_downcase) == $want' "$base/v1/castById?fid=$author&hash=$hash"
else
  fail "cast lookup" "the feed had no cast to look up"
fi
expect_not_found "missing cast reports not found" "$base/v1/castById?fid=1&hash=0x0000000000000000000000000000000000000000"

# These bytes aren't a message, so a node rejects them and nothing is posted.
call -X POST -H 'content-type: application/octet-stream' --data-binary $'\x01\x02\x03' "$base/v1/submitMessage"
case "$code" in
  404) fail "submit route rejects a bad message" "$(explain)" ;;
  4??) pass "submit route rejects a bad message" ;;
  *) fail "submit route rejects a bad message" "$(explain)" ;;
esac

echo "Access"
expect_404 "unsupported route is 404" "$base/v1/notARoute"
origin=$(printf %s "$base" | sed -E 's#^(https?://[^/]+).*#\1#')
if [ "$origin" != "$base" ]; then
  expect_404 "wrong path is 404" "${base%/*}/wrong-path/v1/userDataByFid?$username_query"
fi

echo
if [ "$failed" -gt 0 ]; then
  echo "$failed check(s) failed."
  exit 1
fi
echo "All checks passed. Sign in, post a test cast, and delete it in Fatline to prove writing works."
