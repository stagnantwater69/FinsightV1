#!/usr/bin/env bash
# Checks deploy/rehearsal/api-process.sh, which run-local-supabase.sh uses to
# own the API it starts. A stand-in API (node) listens on one port and starts
# a child that listens on another; a driver script sources the library the way
# the runner does (same traps, same cleanup) and then:
#   during-launch  is sent SIGTERM inside api_start, between the launch and
#               recording ownership (the deferred-signal path)
#   interrupt   is sent SIGTERM right after the launch, before the process
#               could report anything about itself
#   no-ready    gives up waiting for readiness, as on a failed startup
#   normal      stops it after it is up
# Each time both listeners must close, the secret file must be gone, and the
# driver's exit status must say what happened (130, 1, 0). Local; no network.
# RR_LIFECYCLE_LIB=<file> tests another implementation.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
lib=${RR_LIFECYCLE_LIB:-$here/api-process.sh}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
fail() { echo "verify-api-lifecycle: FAIL: $*" >&2; exit 1; }
native() { if command -v cygpath > /dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

cat > "$work/fake-api.js" <<'JS'
// As the old pidfile.cjs did: report its own PID once node is up.
if (process.env.RR_PIDFILE) require("fs").writeFileSync(process.env.RR_PIDFILE, String(process.pid));
const net = require("net");
const [port, childPort] = process.argv.slice(2).map(Number);
require("child_process").spawn(process.execPath,
  ["-e", `require("net").createServer().listen(${childPort}, "127.0.0.1"); setInterval(() => {}, 1e6)`], { stdio: "ignore" });
net.createServer().listen(port, "127.0.0.1");
setInterval(() => {}, 1e6);
JS

cat > "$work/driver.sh" <<'SH'
#!/usr/bin/env bash
# driver.sh <lib> <work> <scenario> <port> <child port>
set -euo pipefail
lib=$1 work=$2 scenario=$3 port=$4 child=$5
run="$work/run-$scenario"; mkdir -p "$run"
. "$lib"
cleanup() { api_stop; rm -rf -- "$run"; }
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
api_secret_file="$run/api.env"
( umask 077; echo 'SUPABASE_SERVICE_ROLE_KEY="synthetic"' > "$api_secret_file" )
[ "$scenario" != during-launch ] || api_start_hook() { kill -TERM $$; }
api_start "$run/api.log" "$run" node "$FAKE" "$port" "$child"
[ "$scenario" != during-launch ] || { echo "driver: the signal was lost" >&2; exit 3; }
case $scenario in
  interrupt) kill -TERM $$; sleep 5 ;;
  no-ready)
    for _ in $(seq 1 6); do [ -e "$run/ready" ] && break; sleep 0.5; done
    [ -e "$run/ready" ] || { echo "driver: the API did not start" >&2; exit 1; } ;;
  normal)
    for _ in $(seq 1 40); do (exec 3<>"/dev/tcp/127.0.0.1/$port") 2> /dev/null && break; sleep 0.25; done
    for _ in $(seq 1 40); do (exec 3<>"/dev/tcp/127.0.0.1/$child") 2> /dev/null && break; sleep 0.25; done
    api_stop ;;
esac
SH

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2> /dev/null; }
free_port() { node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'; }
export FAKE; FAKE=$(native "$work/fake-api.js")
failures=0
for case in 'during-launch 130' 'interrupt 130' 'no-ready 1' 'normal 0'; do
  set -- $case; scenario=$1 want=$2
  port=$(free_port) child=$(free_port)
  status=0; bash "$work/driver.sh" "$lib" "$work" "$scenario" "$port" "$child" > "$work/$scenario.out" 2>&1 || status=$?
  open=""
  for _ in $(seq 1 20); do
    open=""; listening "$port" && open="API"; listening "$child" && open="$open child"
    [ -z "$open" ] && break; sleep 0.25
  done
  problems=""
  [ "$status" = "$want" ] || problems="exit $status, want $want;"
  [ -z "$open" ] || problems="$problems still listening: $open;"
  [ ! -e "$work/run-$scenario/api.env" ] || problems="$problems secret file left;"
  if [ "$scenario" = no-ready ] && ! grep -q 'did not start' "$work/$scenario.out"; then problems="$problems no failure message;"; fi
  if [ -n "$problems" ]; then
    echo "verify-api-lifecycle: FAIL: $scenario: $problems" >&2; failures=$((failures + 1))
  else
    echo "verify-api-lifecycle: $scenario: exit $status, both listeners closed, secret file removed"
  fi
  # Whatever a failed implementation left running, by the ports this test chose.
  if [ -n "$open" ] && command -v powershell > /dev/null; then
    powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort $port,$child -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" > /dev/null 2>&1 || true
  elif [ -n "$open" ] && command -v fuser > /dev/null; then fuser -k "$port/tcp" "$child/tcp" > /dev/null 2>&1 || true; fi
done
[ "$failures" = 0 ] || fail "$failures of 4 scenarios"
echo "verify-api-lifecycle: OK"
