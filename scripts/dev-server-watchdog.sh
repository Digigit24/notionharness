#!/usr/bin/env bash
# Keeps the production server on :3000 alive. Not part of the app itself —
# a session-scratch supervisor for this dev machine, since `npm start` has
# died unexpectedly (exit 127, and separately a wiped .next dir) multiple
# times in one session with no clear single cause. Checks health every 10s;
# on failure, does a clean rebuild only if .next looks broken, otherwise
# just restarts. Logs every check/restart with a timestamp so a human (or
# an agent) can see exactly when and why it acted.
set -u
cd "E:/Digitech/softwares/notionharness" || exit 1

LOG="scripts/.watchdog.log"
SERVER_LOG="scripts/.watchdog-server.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

is_up() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3000/ 2>/dev/null | grep -qE '^(200|30[0-9])$'
}

# Force-kill is genuinely unavoidable here: tried a graceful `taskkill`
# (without `/F`) on this exact kind of backgrounded Node process first —
# Windows refuses it outright ("can only be terminated forcefully"), so
# there's no signal this process will actually catch to run its own
# pool.end() cleanup before dying. Confirmed live: this is why connections
# stayed near the shared Postgres instance's 15-connection cap even after
# trimming every pool's own `max` — every forced restart across one long
# session left that process's connections for Postgres/Supavisor's own
# (much slower) idle reaping to clean up instead of an immediate close.
# Not fixable from this side; the real mitigations are trimming what a
# fresh process asks for (each pool's own `max`) and reducing how often a
# restart is even needed (health-check + rebuild-only-when-needed above).
stop_server() {
  for pid in $(netstat -ano 2>/dev/null | grep ':3000 ' | grep LISTENING | awk '{print $5}' | sort -u); do
    powershell -NoProfile -Command "Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue" 2>/dev/null
  done
}

start_server() {
  if [ ! -f ".next/BUILD_ID" ]; then
    log "no .next/BUILD_ID found — running a clean rebuild before starting"
    rm -rf .next
    npm run build >> "$SERVER_LOG" 2>&1
  fi
  log "starting npm start"
  nohup npm start >> "$SERVER_LOG" 2>&1 &
  echo $! > scripts/.watchdog-server.pid
}

log "watchdog started (pid $$)"
start_server

while true; do
  sleep 10
  if ! is_up; then
    log "health check failed — restarting"
    stop_server
    start_server
  fi
done
