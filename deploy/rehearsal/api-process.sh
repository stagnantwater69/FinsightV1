# Sourced by run-local-supabase.sh (and verify-api-lifecycle.sh); not run on
# its own. Starts one background process tree this script owns and stops it,
# with ownership recorded at launch rather than handed back by the process:
#
#   api_start <log> <dir> <command...>   run command in dir, output to log
#   api_alive                            whether it is still running
#   api_stop                             stop it and everything it started,
#                                        then delete $api_secret_file if set
#
# Linux: the command runs under setsid, so it leads its own process group and
# api_stop signals the whole group (TERM, then KILL after 5 s), even after the
# leader has exited (a group ID is not reused while any member lives).
# Windows (Git Bash): /proc/<pid>/winpid of the launched shell is read at once;
# that process stays the Windows parent of whatever it execs (env, node), so
# `taskkill /T /F` on it stops the tree. That is sent only while the shell is
# still this script's child, so a reused Windows PID is never hit.
#
# A signal that arrives while api_start launches and records the process is
# held, then raised again once ownership is recorded, so the caller's own trap
# (restored as it was) handles it and the cleanup can stop the process.
#
# Limits: SIGKILL of this script, a crash or power loss runs no cleanup, so the
# tree keeps running and $api_secret_file stays until removed by hand. On
# Linux without setsid, children the command forks itself are not reached.
api_pid="" api_winpid="" api_group="" api_secret_file=""

api_start() {
  local log=$1 dir=$2 pending="" saved_traps job_control=""
  shift 2
  saved_traps=$(trap -p INT TERM HUP)
  trap 'pending=INT' INT; trap 'pending=TERM' TERM; trap 'pending=HUP' HUP
  # With job control on, the subshell would lead its own group and setsid would fork away from $!.
  case $- in *m*) job_control=1; set +m ;; esac
  if [ -z "${MSYSTEM:-}" ] && command -v setsid > /dev/null; then
    (cd "$dir" && exec setsid "$@") > "$log" 2>&1 &
    api_group=1
  else
    (cd "$dir" && exec "$@") > "$log" 2>&1 &
    api_group=""
  fi
  # Tests only: a signal in the narrowest window, before the PID is recorded ($! is unchanged by it).
  if declare -F api_start_hook > /dev/null; then api_start_hook; fi
  api_pid=$!
  if [ -r "/proc/$api_pid/winpid" ]; then api_winpid=$(cat "/proc/$api_pid/winpid"); fi
  [ -z "$job_control" ] || set -m
  trap - INT TERM HUP
  eval "$saved_traps"
  if [ -n "$pending" ]; then kill -s "$pending" $$; fi
}

api_alive() { [ -n "$api_pid" ] && kill -0 "$api_pid" 2> /dev/null; }

api_stop() {
  local pid=$api_pid winpid=$api_winpid group=$api_group
  api_pid="" api_winpid="" api_group=""
  if [ -n "$pid" ]; then
    if [ -n "$winpid" ]; then
      if kill -0 "$pid" 2> /dev/null; then taskkill //T //F //PID "$winpid" > /dev/null 2>&1 || true; fi
    elif [ -n "$group" ]; then
      kill -TERM -- "-$pid" 2> /dev/null || true
      for _ in $(seq 1 20); do kill -0 -- "-$pid" 2> /dev/null || break; sleep 0.25; done
      kill -KILL -- "-$pid" 2> /dev/null || true
    elif kill -0 "$pid" 2> /dev/null; then
      kill -TERM "$pid" 2> /dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2> /dev/null || break; sleep 0.25; done
      kill -KILL "$pid" 2> /dev/null || true
    fi
    wait "$pid" 2> /dev/null || true
  fi
  if [ -n "$api_secret_file" ]; then rm -f -- "$api_secret_file"; fi
}
