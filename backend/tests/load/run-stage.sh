#!/usr/bin/env bash
# Runs one load stage and captures what k6 cannot see: API process memory,
# database CPU/memory, and Postgres connection count.
#
#   ./run-stage.sh <name> <target-vus> <ramp> <hold>
#
# Needs k6 on PATH, or K6 pointing at a binary. k6 is not vendored here: it is
# a 60 MB static binary and belongs in the runner's environment, not in git.
#   https://github.com/grafana/k6/releases
set -u
SP="$(cd "$(dirname "$0")" && pwd)"
NAME="${1:?stage name}"; TARGET="${2:?target vus}"; RAMP="${3:-30s}"; HOLD="${4:-60s}"
OUT="$SP/results/$NAME"
mkdir -p "$OUT"

K6="${K6:-$(command -v k6 || true)}"
if [ -z "$K6" ]; then echo "k6 not found: install it or set K6=/path/to/k6" >&2; exit 2; fi

API_PID="$(pgrep -f 'node dist/server.js' | head -1)"
# Never the shared finsight-test-db or the phase-2 audit container.
DB="${LOAD_DB_CONTAINER:-finsight-loadtest-db}"

# Sampler: one line per second while the stage runs.
(
  echo "ts,api_rss_mb,db_cpu_pct,db_mem_mb,pg_conns,pg_active"
  while :; do
    RSS="$( [ -n "$API_PID" ] && awk '/VmRSS/{print int($2/1024)}' "/proc/$API_PID/status" 2>/dev/null || echo 0 )"
    STATS="$(docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' "$DB" 2>/dev/null | tr -d '%' )"
    CPU="$(echo "$STATS" | awk '{print $1}')"
    MEM="$(echo "$STATS" | awk '{print $2}' | sed 's/MiB//;s/GiB/*1024/' | bc 2>/dev/null || echo 0)"
    CONNS="$(docker exec "$DB" psql -U testuser -d finsight_test -tAc 'select count(*) from pg_stat_activity' 2>/dev/null || echo 0)"
    ACTIVE="$(docker exec "$DB" psql -U testuser -d finsight_test -tAc "select count(*) from pg_stat_activity where state='active'" 2>/dev/null || echo 0)"
    echo "$(date +%s),${RSS:-0},${CPU:-0},${MEM:-0},${CONNS:-0},${ACTIVE:-0}"
    sleep 1
  done
) > "$OUT/samples.csv" &
SAMPLER=$!

STAGES="[{\"duration\":\"$RAMP\",\"target\":$TARGET},{\"duration\":\"$HOLD\",\"target\":$TARGET},{\"duration\":\"15s\",\"target\":0}]"
STAGES="$STAGES" "$K6" run --quiet --summary-export "$OUT/summary.json" "$SP/session.js" > "$OUT/k6.txt" 2>&1
RC=$?

kill "$SAMPLER" 2>/dev/null

echo "=== $NAME (target ${TARGET} VUs) k6 exit=$RC ==="
grep -E "flow_|http_req_duration|http_req_failed|http_reqs|iterations\.|rate_limited|server_errors|business_errors|vus_max" "$OUT/k6.txt" | sed 's/^\s*//'
echo "--- server side (max observed) ---"
awk -F, 'NR>1 && $2!="" {if($2+0>rss)rss=$2; if($3+0>cpu)cpu=$3; if($5+0>c)c=$5; if($6+0>a)a=$6}
  END{printf "api_rss_mb_max=%d db_cpu_pct_max=%.1f pg_conns_max=%d pg_active_max=%d\n", rss, cpu, c, a}' "$OUT/samples.csv"
