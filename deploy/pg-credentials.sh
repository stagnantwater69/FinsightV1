# shellcheck shell=bash
# Sourced by the backup and restore scripts; not run on its own.
#
# pg_split_url URL
#   Sets PG_URL to URL without its password, and exports the password,
#   percent-decoded, as PGPASSWORD. Pass PG_URL on command lines and
#   `docker run -e PGPASSWORD` (by name, never `-e PGPASSWORD=...`): the URL a
#   process sees in its argv is then safe to show in `ps`, `docker top` and
#   logs, and libpq reads the password from its environment. Returns 1, saying
#   why, for anything that is not a postgres:// or postgresql:// URL, a password
#   given as a ?password= parameter (it would stay in PG_URL), an unencoded "/"
#   in the password, and a malformed or NUL percent escape.
pg_split_url() {
  local url=$1 scheme rest pre userinfo after hostport tail user pass pair key
  # The URL is the only source; an inherited PGPASSWORD must not ride along.
  unset PGPASSWORD
  case "$url" in
    postgres://*|postgresql://*) ;;
    *) echo "not a postgresql:// URL" >&2; return 1 ;;
  esac
  scheme=${url%%://*}
  rest=${url#*://}
  # Like libpq, the userinfo ends at the last "@" before the first "/", so a
  # "?" in the password stays in the password.
  pre=${rest%%/*}
  if [[ $pre == *@* ]]; then
    userinfo=${pre%@*}
    after=${rest:${#userinfo}+1}
  else
    [[ ${rest%%\?*} == *@* ]] && { echo "percent-encode any / in the password (as %2F)" >&2; return 1; }
    userinfo="" after=$rest
  fi
  hostport=${after%%[/?]*}
  tail=${after:${#hostport}}
  if [[ $tail == *\?* ]]; then
    local pairs
    IFS='&' read -ra pairs <<< "${tail#*\?}"
    for pair in "${pairs[@]}"; do
      key=${pair%%=*}
      if [[ ${key,,} == password || $key == *%* ]]; then
        echo "put the password before the @, not in ?password=" >&2; return 1
      fi
    done
  fi
  if [ -z "$userinfo" ]; then PG_URL=$url; return 0; fi
  user=${userinfo%%:*}
  if [[ $userinfo == *:* ]]; then
    pass=${userinfo#*:}
    if [[ ${pass//%[0-9A-Fa-f][0-9A-Fa-f]/} == *%* || $pass == *%00* ]]; then
      echo "the password has a malformed percent escape (or %00)" >&2; return 1
    fi
    # Percent-decode, keeping any backslash literal for printf %b.
    pass=${pass//\\/\\\\}
    printf -v PGPASSWORD '%b' "${pass//%/\\x}"
    export PGPASSWORD
  fi
  PG_URL="$scheme://$user@$hostport$tail"
}

# pg_verify_tls CA_FILE
#   For the PG_URL pg_split_url set: sets PG_TLS to `docker run` arguments
#   under which libpq in the container verifies the server certificate against
#   CA_FILE and the host name (sslmode=verify-full; require and verify-ca do
#   not check the name). Returns 1, saying why, for a missing or non-PEM
#   CA_FILE, or a URL whose own settings would override it: any ssl* parameter
#   but sslmode=verify-full, requiressl, or gssencmode (GSS encryption would
#   replace TLS). Run those docker commands with MSYS_NO_PATHCONV=1, or Git
#   Bash rewrites the container path.
pg_verify_tls() {
  local ca=$1 pair pairs
  if [ ! -f "$ca" ] || ! grep -q -- '-----BEGIN CERTIFICATE-----' "$ca"; then
    echo "no PEM CA certificate at $ca" >&2; return 1
  fi
  if [[ $PG_URL == *\?* ]]; then
    IFS='&' read -ra pairs <<< "${PG_URL#*\?}"
    for pair in "${pairs[@]}"; do
      case "${pair,,}" in
        sslmode=verify-full) ;;
        ssl*|requiressl*|gssencmode*) echo "the URL's own ${pair%%=*} would override certificate verification" >&2; return 1 ;;
      esac
    done
  fi
  ca=$(cd "$(dirname "$ca")" && pwd)/$(basename "$ca")
  if command -v cygpath > /dev/null; then ca=$(cygpath -m "$ca"); fi
  # shellcheck disable=SC2034 # read by the scripts that source this file
  PG_TLS=(-v "$ca:/etc/finsight-ca.crt:ro" -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/etc/finsight-ca.crt -e PGGSSENCMODE=disable)
}

# pg_prisma_tls_url URL CA_FILE
#   Prints URL with its query replaced by the settings under which Prisma's
#   engine verifies the server certificate and host name against CA_FILE.
#   Measured: Prisma ignores sslmode=verify-full, and sslmode=require (with or
#   without sslcert) accepts any certificate; only sslcert plus
#   sslaccept=strict refuses an untrusted one or a wrong host name. CA_FILE
#   must be an absolute path without spaces (the runner copies it to one).
pg_prisma_tls_url() {
  local ca=$2
  if command -v cygpath > /dev/null; then ca=$(cygpath -m "$ca"); fi
  [[ $ca =~ ^([A-Za-z]:)?/[A-Za-z0-9._/-]+$ ]] || { echo "the CA path for Prisma must be absolute, without spaces: $ca" >&2; return 1; }
  printf '%s?sslmode=require&sslcert=%s&sslaccept=strict' "${1%%\?*}" "$ca"
}

# pg_mounted_ca URL
#   Prints backend/certs/<file> for URL's one sslcert=/app/certs/<file>, the CA
#   file docker-compose.yml mounts at /app/certs. Returns 1 for none, several,
#   another directory, or a name that is not plain (letters, digits, . _ -):
#   Prisma percent-decodes the path and reads "+" as a space, this does not,
#   and both must open the same file (backend/src/config/databaseTls.ts refuses
#   the same names).
pg_mounted_ca() {
  local pair pairs ca="" n=0
  [[ $1 == *\?* ]] || return 1
  IFS='&' read -ra pairs <<< "${1#*\?}"
  for pair in "${pairs[@]}"; do
    if [ "${pair%%=*}" = sslcert ]; then ca=${pair#*=}; n=$((n + 1)); fi
  done
  [ "$n" = 1 ] && [[ $ca =~ ^/app/certs/[A-Za-z0-9._-]+$ ]] || return 1
  printf 'backend/certs/%s' "${ca#/app/certs/}"
}
