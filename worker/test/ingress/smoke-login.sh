#!/bin/bash
# M3 ingress smoke test on a live Worker, curl only (no browser). Login flow, cookie gate, Origin, sessions,
# code link, revoke, rotate, wake-status, WS 503/101, Telegram hook path, login rate limit (last: it locks
# this IP's logins for 10 min).
# usage: U=https://<worker>.workers.dev T=<CONTROL_TOKEN> [CI=<CI_TOKEN>] [WH=<TELEGRAM_WEBHOOK_SECRET>] smoke-login.sh
set -u
: "${U:?U=worker origin}" "${T:?T=CONTROL_TOKEN}"
CI=${CI:-}
WH=${WH:-}
pass=0
fail=0
ok() { echo "PASS $*"; pass=$((pass + 1)); }
no() { echo "FAIL $*"; fail=$((fail + 1)); }
expect() { # name want got
  if [ "$2" = "$3" ]; then ok "$1 ($3)"; else no "$1: want $2 got $3"; fi
}
code() { curl --http1.1 -s -o /dev/null -w '%{http_code}' "$@"; }
cookie_from() { grep -i '^set-cookie:' "$1" | head -1 | sed -E 's/^[Ss]et-[Cc]ookie: *//; s/;.*//' | tr -d '\r'; }
H=$(mktemp)
trap 'rm -f "$H"' EXIT
t0=$(date +%s%3N)

expect "1 GET / no cookie → 404" 404 "$(code "$U/")"
expect "2 GET / owner bearer only → 404 (Z2.10)" 404 "$(code -H "authorization: Bearer $T" "$U/")"
expect "3 GET login page" 200 "$(code -D "$H" "$U/_ochost/login")"
grep -qi "^content-security-policy:.*frame-ancestors 'none'" "$H" && ok "3b login CSP" || no "3b login CSP"
expect "4 POST login, no Origin → 403" 403 "$(code -X POST --data-urlencode "token=$T" "$U/_ochost/login")"
expect "5 POST login, other Origin → 403" 403 "$(code -X POST -H 'origin: https://evil.example' --data-urlencode "token=$T" "$U/_ochost/login")"
expect "6 POST login, good token → 303" 303 "$(code -D "$H" -X POST -H "origin: $U" --data-urlencode "token=$T" "$U/_ochost/login")"
C1=$(cookie_from "$H")
grep -i '^set-cookie:' "$H" | grep -q 'HttpOnly; Secure; SameSite=Strict' && ok "6b cookie attrs" || no "6b cookie attrs: $(grep -i '^set-cookie' "$H")"
[[ "$C1" == __Host-ochost=v* ]] && ok "6c cookie name" || no "6c cookie: $C1"
expect "7 wake-status with cookie" 200 "$(code -H "cookie: $C1" "$U/_ochost/wake-status")"
WS=$(curl -s -H "cookie: $C1" "$U/_ochost/wake-status")
echo "   wake-status: $WS"
expect "8 wake-status without cookie → 404" 404 "$(code "$U/_ochost/wake-status")"
nav=$(code -D "$H" -H "cookie: $C1" -H 'accept: text/html' "$U/")
expect "9 GET / with cookie (UI or waking page)" 200 "$nav"
grep -qi '^strict-transport-security' "$H" && ok "9b HSTS on proxied answer" || no "9b HSTS"
wsh=(-H "cookie: $C1" -H 'connection: Upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==')
expect "10 WS with cookie, no Origin → 403" 403 "$(code --max-time 5 "${wsh[@]}" "$U/")"
wsc=$(code --max-time 5 "${wsh[@]}" -H "origin: $U" "$U/")
case "$wsc" in 503 | 101) ok "11 WS with cookie + Origin → $wsc (503 asleep/waking, 101 running)" ;; *) no "11 WS: $wsc" ;; esac
expect "12 POST proxied, no Origin → 403" 403 "$(code -X POST -H "cookie: $C1" -d '{}' "$U/api/x")"
expect "13 ops/auth/sessions owner" 200 "$(code -H "authorization: Bearer $T" "$U/ops/auth/sessions")"
S=$(curl -s -H "authorization: Bearer $T" "$U/ops/auth/sessions")
echo "   sessions: $S"
[ -n "$CI" ] && expect "14 ops/auth/sessions ci → 404" 404 "$(code -H "authorization: Bearer $CI" "$U/ops/auth/sessions")"
[ -n "$CI" ] && expect "14b ops/restore ci → 404" 404 "$(code -X POST -H "authorization: Bearer $CI" "$U/ops/restore")"
[ -n "$CI" ] && expect "14c ops/status ci → 200" 200 "$(code -H "authorization: Bearer $CI" "$U/ops/status")"
L=$(curl -s -X POST -H "authorization: Bearer $T" "$U/ops/auth/code" | sed -E 's/.*"url":"([^"]+)".*/\1/')
expect "15 code link → 200" 200 "$(code -D "$H" "$L")"
C2=$(cookie_from "$H")
expect "16 code link again → 404" 404 "$(code "$L")"
expect "17 code-session cookie works" 200 "$(code -H "cookie: $C2" "$U/_ochost/wake-status")"
# public session id = first 12 hex of sha256(sid); sid = the middle part of the cookie value
ID1=$(printf %s "$C1" | cut -d. -f2 | tr -d '\n' | sha256sum | cut -c1-12)
echo "$S" | grep -q "\"id\":\"$ID1\"" && ok "17b session 1 listed as $ID1" || no "17b $ID1 not in list"
expect "18 revoke session 1" 200 "$(code -X POST -H "authorization: Bearer $T" -d "{\"id\":\"$ID1\"}" "$U/ops/auth/revoke")"
sleep 6
expect "19 revoked cookie → 404" 404 "$(code -H "cookie: $C1" "$U/_ochost/wake-status")"
expect "20 other session still 200" 200 "$(code -H "cookie: $C2" "$U/_ochost/wake-status")"
R=$(curl -s -X POST -H "authorization: Bearer $T" "$U/ops/auth/rotate")
echo "   rotate: $R"
sleep 6
expect "21 after rotate old cookie → 404" 404 "$(code -H "cookie: $C2" "$U/_ochost/wake-status")"
expect "22 login after rotate → 303" 303 "$(code -D "$H" -X POST -H "origin: $U" --data-urlencode "token=$T" "$U/_ochost/login")"
C3=$(cookie_from "$H")
[[ "$C3" == __Host-ochost=v2.* || "$C3" == __Host-ochost=v[0-9]* ]] && ok "22b new key version ${C3:14:3}" || no "22b $C3"
expect "23 new cookie works at once" 200 "$(code -H "cookie: $C3" "$U/_ochost/wake-status")"
expect "24 logout → 303" 303 "$(code -X POST -H "cookie: $C3" -H "origin: $U" "$U/_ochost/logout")"
expect "25 hook, wrong path → 404" 404 "$(code -X POST -d '{}' "$U/_ochost/hook/telegram/00000000000000000000000000000000")"
if [ -n "$WH" ]; then
  P=$(printf 'oc-host:telegram-hook:%s' "$WH" | sha256sum | cut -c1-32)
  expect "26 hook, right path, bad header → 401" 401 "$(code -X POST -H 'x-telegram-bot-api-secret-token: nope' -H 'content-type: application/json' -d '{"update_id":1}' "$U/_ochost/hook/telegram/$P")"
  expect "27 hook, right path + header → 200" 200 "$(code -X POST -H "x-telegram-bot-api-secret-token: $WH" -H 'content-type: application/json' -d "{\"update_id\":$((RANDOM + 900000)),\"message\":{\"from\":{\"id\":42},\"chat\":{\"id\":42},\"text\":\"smoke\"}}" "$U/_ochost/hook/telegram/$P")"
fi
codes=""
for i in 1 2 3 4 5; do codes="$codes $(code -X POST -H "origin: $U" --data-urlencode "token=bad$i" "$U/_ochost/login")"; done
# step 16 (a spent code) already counted 1 failure for this IP: 4 more → the limit of 5
expect "28 5 bad logins: 4×401 then 429" " 401 401 401 401 429" "$codes"
expect "29 good token now also 429" 429 "$(code -X POST -H "origin: $U" --data-urlencode "token=$T" "$U/_ochost/login")"
echo "smoke: pass=$pass fail=$fail ms=$(($(date +%s%3N) - t0))"
[ "$fail" = 0 ]
