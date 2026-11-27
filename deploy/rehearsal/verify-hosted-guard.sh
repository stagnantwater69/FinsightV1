#!/usr/bin/env bash
# Checks the RR_TARGET=hosted guard of run-local-supabase.sh with no network
# and no Docker: the runner runs from a scratch checkout whose .env names a
# made-up "live" project, with RR_CHECK_ONLY=1, and every tool that could
# reach anything (docker, npx, curl, psql, aws...) is a stub that fails the
# test if called. Valid inputs must pass and stop; everything else must be
# refused, with the reason. CI runs it. RR_GUARD_RUNNER=<file> tests another copy.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
runner=${RR_GUARD_RUNNER:-$here/run-local-supabase.sh}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
fail() { echo "verify-hosted-guard: FAIL: $*" >&2; exit 1; }

mkdir -p "$work/repo/deploy/rehearsal" "$work/repo/backend" "$work/bin"
cp "$runner" "$work/repo/deploy/rehearsal/run-local-supabase.sh"
cp "$here/../pg-credentials.sh" "$work/repo/deploy/"
cp "$here/api-process.sh" "$work/repo/deploy/rehearsal/"
readonly LIVE=livelivelivelivelive REF=dispdispdispdispdisp OTHER=otherotherotherother
cat > "$work/repo/backend/.env" <<EOF
DATABASE_URL=postgresql://postgres.$LIVE:x@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
SUPABASE_URL=https://$LIVE.supabase.co
EOF
for t in docker npx curl psql pg_restore supabase aws age age-keygen wget ssh nc; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/calls"\nexit 97\n' "$t" "$work" > "$work/bin/$t"
done
# node is real (the guard decodes keys with it), but logs its argv: no key may be in it.
real_node=$(command -v node)
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/node-argv"\nexec "%s" "$@"\n' "$work" "$real_node" > "$work/bin/node"
chmod +x "$work"/bin/*
: > "$work/calls"; : > "$work/node-argv"

jwt() { node -e 'const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  console.log(`${b({ alg: "HS256", typ: "JWT" })}.${b({ iss: "supabase", ref: process.argv[1], role: process.argv[2] })}.c2ln`)' "$1" "$2"; }
ANON=$(jwt $REF anon) SERVICE=$(jwt $REF service_role)
POOLER="postgresql://postgres.$REF:p%40ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full"
DIRECT="postgresql://postgres:p%40ss@db.$REF.supabase.co:5432/postgres?sslmode=verify-full"
# A CA and a leaf certificate, made offline (openssl only signs; nothing is contacted).
w=$work; if command -v cygpath > /dev/null; then w=$(cygpath -m "$work"); fi   # native openssl, no path rewriting
MSYS_NO_PATHCONV=1 openssl req -x509 -new -nodes -newkey rsa:2048 -subj "/CN=guard test CA" -days 2 -keyout "$w/ca.key" -out "$w/ca.crt" 2> /dev/null
MSYS_NO_PATHCONV=1 openssl req -new -nodes -newkey rsa:2048 -subj "/CN=leaf" -keyout "$w/leaf.key" -out "$w/leaf.csr" 2> /dev/null
MSYS_NO_PATHCONV=1 openssl x509 -req -in "$w/leaf.csr" -CA "$w/ca.crt" -CAkey "$w/ca.key" -CAcreateserial -days 2 -out "$w/leaf.crt" 2> /dev/null
echo 'not a certificate' > "$work/junk.crt"
base=(RR_TARGET=hosted RR_HOSTED_CA_CERT="$work/ca.crt" RR_CHECK_ONLY=1 RR_HOSTED_REF=$REF RR_HOSTED_CONFIRM_DISPOSABLE=$REF RR_HOSTED_DB_URL=$POOLER
      RR_HOSTED_ANON_KEY=$ANON RR_HOSTED_SERVICE_ROLE_KEY=$SERVICE RR_HOSTED_S3_ACCESS_KEY_ID=s3id
      RR_HOSTED_S3_SECRET_ACCESS_KEY=s3secret RR_HOSTED_S3_REGION=ap-southeast-1)
# No network at all where the platform allows it (Linux CI); the stubs catch the rest.
isolate=(); if command -v unshare > /dev/null && unshare -rn true 2> /dev/null; then isolate=(unshare -rn); fi

cases=0
expect() { # expect <ok | refusal text> [VAR=value ...]: later values override the valid base
  local want=$1 out status=0; shift
  out=$(env -i PATH="$work/bin:$PATH" HOME="$work" SYSTEMROOT="${SYSTEMROOT:-}" TEMP="${TEMP:-/tmp}" TMP="${TMP:-/tmp}" \
        "${base[@]}" "$@" "${isolate[@]}" bash "$work/repo/deploy/rehearsal/run-local-supabase.sh" 2>&1) || status=$?
  [ ! -s "$work/calls" ] || fail "[$*] called a network tool: $(cat "$work/calls")"
  if [ "$want" = ok ]; then
    [ "$status" = 0 ] && grep -q 'inputs pass the guard' <<< "$out" || fail "[$*] valid inputs were not accepted: $out"
  else
    [ "$status" != 0 ] || fail "[$*] was accepted; want refusal: $want"
    grep -qF -- "$want" <<< "$out" || fail "[$*] refused for another reason: $out (want: $want)"
  fi
  cases=$((cases + 1))
}

expect ok
expect ok RR_HOSTED_DB_URL="$DIRECT"
expect ok RR_HOSTED_ALLOW_WRITES=$REF
expect ok RR_HOSTED_S3_ENDPOINT="https://$REF.supabase.co/storage/v1/s3"
expect ok RR_HOSTED_ANON_KEY=sb_publishable_abc RR_HOSTED_SERVICE_ROLE_KEY=sb_secret_abc
expect 'RR_TARGET is local or hosted' RR_TARGET=Hosted

# The ref and the owner's two confirmations.
expect '20-letter ref' RR_HOSTED_REF=
expect '20-letter ref' RR_HOSTED_REF=DISPDISPDISPDISPDISP
expect '20-letter ref' RR_HOSTED_REF=dispdispdispdispdis
expect '20-letter ref' RR_HOSTED_REF="$REF"$'\n'
expect '20-letter ref' RR_HOSTED_REF=dispdispdispdispdisé
expect 'RR_HOSTED_CONFIRM_DISPOSABLE' RR_HOSTED_CONFIRM_DISPOSABLE=
expect 'RR_HOSTED_CONFIRM_DISPOSABLE' RR_HOSTED_CONFIRM_DISPOSABLE=$OTHER
expect 'RR_HOSTED_ALLOW_WRITES is set but is not' RR_HOSTED_ALLOW_WRITES=yes
expect 'a project in use' RR_HOSTED_REF=$LIVE RR_HOSTED_CONFIRM_DISPOSABLE=$LIVE
for v in RR_HOSTED_DB_URL RR_HOSTED_ANON_KEY RR_HOSTED_SERVICE_ROLE_KEY RR_HOSTED_S3_ACCESS_KEY_ID RR_HOSTED_S3_SECRET_ACCESS_KEY RR_HOSTED_S3_REGION; do
  expect "set $v" "$v="
done

# The DB URL: the ref must be its user or host, with TLS required.
expect "names a project from this checkout" RR_HOSTED_DB_URL="postgresql://postgres.$REF:$LIVE@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full"
for url in \
  "postgresql://postgres:$REF@attacker.example:5432/postgres?sslmode=verify-full" \
  "postgresql://postgres.$REF:pw@attacker.example:5432/postgres?sslmode=verify-full" \
  "postgresql://postgres:pw@db.$REF.supabase.co.evil.example:5432/postgres?sslmode=verify-full" \
  "postgresql://postgres.$OTHER:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&application_name=$REF" \
  "postgresql://postgres.$OTHER:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full" \
  "postgresql://postgres.$REF:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  "postgresql://postgres.$REF:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=prefer" \
  "postgresql://postgres.$REF:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&host=attacker.example" \
  "postgresql://postgres.$REF:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full" \
  "postgresql://postgres.$REF:pw@aws-0-ap-southeast-1.pooler.supabase.com,attacker.example:5432/postgres?sslmode=verify-full" \
  "postgresql://postgres.$REF:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/other?sslmode=verify-full" \
  "postgresql://postgres:pw@db.$REF.supabase.co/postgres?sslmode=verify-full"   "postgresql://postgres.$REF:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require"   "postgresql://postgres.$REF:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-ca"   "postgresql://postgres.$REF:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=system"; do
  expect 'RR_HOSTED_DB_URL' RR_HOSTED_DB_URL="$url"
done
# Read one way by libpq and another by Prisma (WHATWG): a second host, or a URL Prisma cannot parse.
expect 'reads differently to Prisma' RR_HOSTED_DB_URL="postgresql://postgres.$REF:x@evil.example:5432?@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full"
expect 'reads differently to Prisma' RR_HOSTED_DB_URL="postgresql://postgres.$REF:a#b@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full"
expect ok RR_HOSTED_DB_URL="postgresql://postgres.$REF:a%23b%3Fc%40d@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full"
expect 'malformed' RR_HOSTED_DB_URL="mysql://u:p@h/$REF"
expect 'malformed' RR_HOSTED_DB_URL="postgresql://postgres.$REF:p/q@aws-0-x.pooler.supabase.com:5432/postgres?sslmode=verify-full"
expect 'malformed' RR_HOSTED_DB_URL="postgresql://postgres.$REF@aws-0-x.pooler.supabase.com:5432/postgres?sslmode=verify-full&password=pw"

# Storage and the keys.
expect 'RR_HOSTED_S3_ENDPOINT must be' RR_HOSTED_S3_ENDPOINT="https://$OTHER.supabase.co/storage/v1/s3"
expect 'RR_HOSTED_S3_ENDPOINT must be' RR_HOSTED_S3_ENDPOINT="https://$LIVE.supabase.co/storage/v1/s3"
expect 'no CA certificate' RR_HOSTED_CA_CERT="$work/absent.crt"
expect 'set RR_HOSTED_CA_CERT' RR_HOSTED_CA_CERT=
expect 'not a PEM file of current CA certificates' RR_HOSTED_CA_CERT="$work/junk.crt"
expect 'not a PEM file of current CA certificates' RR_HOSTED_CA_CERT="$work/leaf.crt"
expect 'belongs to another project' RR_HOSTED_ANON_KEY="$(jwt $OTHER anon)"
expect 'belongs to another project' RR_HOSTED_SERVICE_ROLE_KEY="$(jwt $LIVE service_role)"
expect 'is the service_role key, not the anon key' RR_HOSTED_ANON_KEY="$SERVICE"
expect 'is the anon key, not the service_role key' RR_HOSTED_SERVICE_ROLE_KEY="$ANON"
expect 'is a sb_secret key, not the anon key' RR_HOSTED_ANON_KEY=sb_secret_abc
expect 'is a sb_publishable key, not the service_role key' RR_HOSTED_SERVICE_ROLE_KEY=sb_publishable_abc
expect 'has characters no Supabase key has' RR_HOSTED_SERVICE_ROLE_KEY="$SERVICE\"
request = DELETE"

[ -s "$work/node-argv" ] || fail "the node shim never ran, so the argv check proves nothing"
if grep -qF -e "$SERVICE" -e "$ANON" "$work/node-argv"; then fail "a key was on node's command line"; fi
echo "verify-hosted-guard: $cases cases: valid inputs stop after the guard, the rest refused; no network tool called, no key in argv${isolate:+, no network namespace}"
