#!/usr/bin/env bash
# DAST baseline: black-box security tests against the RUNNING application in Kubernetes.
# (A lightweight alternative to OWASP ZAP baseline, sized for a 1 GB t3.micro.)
#
# Usage: BASE_URL=http://localhost:30100 DOCTOR_TOKEN=... STAFF_TOKEN=... dast-baseline.sh
# Exit code 1 if any check fails, so the pipeline stops.
set -uo pipefail
set +x   # never echo tokens

BASE_URL="${BASE_URL:?}"; DOCTOR_TOKEN="${DOCTOR_TOKEN:?}"; STAFF_TOKEN="${STAFF_TOKEN:?}"
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

check() { # check "description" <condition exit code>
  if [ "$2" -eq 0 ]; then echo "  [PASS] $1"; PASS=$((PASS+1)); else echo "  [FAIL] $1"; FAIL=$((FAIL+1)); fi
}
# req METHOD PATH [TOKEN] [BODY] [CONTENT_TYPE] -> writes headers/body to $TMP, prints status code
req() {
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X "$1")
  [ -n "${3:-}" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "${4:-}" ] && args+=(-H "Content-Type: ${5:-application/json}" --data-binary "$4")
  curl "${args[@]}" "$BASE_URL$2"
}
header() { grep -i "^$1:" "$TMP/headers" | head -1 | cut -d' ' -f2- | tr -d '\r'; }

echo "DAST baseline against $BASE_URL  ($(date -u +%FT%TZ))"

echo "1. Availability"
[ "$(req GET /health)" = 200 ]; check "GET /health returns 200" $?

echo "2. Security headers (OWASP Secure Headers)"
req GET / >/dev/null
[[ "$(header Content-Security-Policy)" == *"default-src 'self'"* ]]; check "Content-Security-Policy restricts sources to 'self'" $?
[[ "$(header Content-Security-Policy)" != *"unsafe-inline"* ]];      check "CSP does not allow unsafe-inline" $?
[ "$(header X-Content-Type-Options)" = nosniff ];                    check "X-Content-Type-Options: nosniff" $?
[ "$(header X-Frame-Options)" = DENY ];                              check "X-Frame-Options: DENY (clickjacking)" $?
[ "$(header Referrer-Policy)" = no-referrer ];                       check "Referrer-Policy: no-referrer" $?
[ -n "$(header Strict-Transport-Security)" ];                        check "Strict-Transport-Security present" $?
[ -z "$(header X-Powered-By)" ] && [ -z "$(header Server)" ];        check "No X-Powered-By / Server banner (technology disclosure)" $?

echo "3. Authentication"
[ "$(req GET /api/patients)" = 401 ];                    check "Patient API without token -> 401" $?
[ "$(req GET /api/patients '' )" = 401 ];                check "Patient API with empty token -> 401" $?
[ "$(req GET /api/patients wrong-token)" = 401 ];        check "Patient API with invalid token -> 401" $?
[ "$(req GET /api/patients "' OR '1'='1")" = 401 ];      check "SQL-injection style token rejected -> 401" $?

echo "4. Authorisation and PHI protection (minimum necessary)"
[ "$(req GET /api/patients "$STAFF_TOKEN")" = 200 ];     check "Staff can list patients" $?
grep -q '"diagnosis":"\[REDACTED\]"' "$TMP/body";          check "Staff sees diagnosis as [REDACTED]" $?
! grep -qE '"phone":"[0-9]{10}"' "$TMP/body";              check "Staff sees masked phone numbers" $?
[ "$(header Cache-Control)" = no-store ];                  check "PHI responses are not cacheable (Cache-Control: no-store)" $?
[ "$(req GET /api/patients "$DOCTOR_TOKEN")" = 200 ];    check "Doctor can list patients" $?
! grep -q '\[REDACTED\]' "$TMP/body";                      check "Doctor sees the full clinical record" $?
[ "$(req POST /api/patients "$STAFF_TOKEN" '{"name":"Dast Probe","age":30,"department":"Neurology","phone":"9000000000","diagnosis":"probe"}')" = 403 ]
check "Staff cannot create records -> 403" $?

echo "5. Input validation and error handling"
[ "$(req POST /api/patients "$DOCTOR_TOKEN" '{"name":"<script>alert(1)</script>","age":30,"department":"Neurology","phone":"9000000000","diagnosis":"x1"}')" = 400 ]
check "XSS payload in name rejected -> 400" $?
[ "$(req POST /api/patients "$DOCTOR_TOKEN" '{"name": ')" = 400 ];                check "Malformed JSON -> 400" $?
! grep -qE 'at .*\.js|SyntaxError|Error:' "$TMP/body";                            check "No stack trace / internal error leaked" $?
[ "$(req POST /api/patients "$DOCTOR_TOKEN" 'name=x' text/plain)" = 415 ];        check "Non-JSON content type -> 415" $?
BIG=$(head -c 6000 /dev/zero | tr '\0' 'A')
[ "$(req POST /api/patients "$DOCTOR_TOKEN" "{\"name\":\"$BIG\"}")" = 413 ];      check "Oversized body (6 KB) -> 413" $?
[ "$(curl -s -o "$TMP/body" -w '%{http_code}' --path-as-is "$BASE_URL/../../etc/passwd")" = 404 ] && ! grep -q 'root:' "$TMP/body"
check "Path traversal /../../etc/passwd blocked" $?
[ "$(req DELETE /api/patients "$DOCTOR_TOKEN")" = 405 ];                         check "Unsupported method -> 405" $?

echo "6. Brute-force protection (runs last: locks out this client IP for 60 s)"
CODE=""; for i in $(seq 1 15); do CODE=$(req GET /api/patients "guess-$i"); [ "$CODE" = 429 ] && break; done
[ "$CODE" = 429 ];                                         check "Repeated failed logins -> 429 lockout (after $i attempts)" $?

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
