#!/bin/bash
# Stephen's idle CPU, memory and disk on macOS (docs/NFR-STEPHEN.md section 5).
# Usage: scripts/measure-idle.sh [--seconds N]   (default 600: one sample every 10 s for 10 minutes)
# Prints only process kinds, numbers and sizes. Never a command line (it can hold paths or ids).
# Close other Claude Code sessions first: they start their own "serve" processes, which would be counted too.
set -u

SECONDS_TOTAL=600
INTERVAL=10
if [ "${1:-}" = "--seconds" ] && [ -n "${2:-}" ]; then SECONDS_TOTAL=$2
elif [ $# -gt 0 ]; then echo "Usage: $0 [--seconds N]" >&2; exit 2; fi

# Stephen's home, as src/config.ts resolveStephenHome finds it.
HOME_DIR=${STEPHEN_HOME:-${BROWSER_HUB_HOME:-}}
if [ -z "$HOME_DIR" ]; then
  HOME_DIR=$HOME/.stephen
  [ ! -d "$HOME_DIR" ] && [ -d "$HOME/.browser-hub" ] && HOME_DIR=$HOME/.browser-hub
fi

SAMPLES=$(mktemp "${TMPDIR:-/tmp}/stephen-idle.XXXXXX")
trap 'rm -f "$SAMPLES"' EXIT

n=0
end=$(( $(date +%s) + SECONDS_TOTAL ))
while :; do
  n=$((n + 1))
  # One line per process: sample, kind, rss KB, cpu %. The kind is decided here; the command line goes nowhere.
  ps -axo rss=,%cpu=,command= | awk -v s="$n" '
    /dist\/cli\.js listen/ { k = "listen" }
    /dist\/cli\.js serve/  { k = "serve" }
    /dist\/cli\.js jobs _run/ { k = "job" }
    /Stephen Helper/        { k = "helper" }
    k != "" { print s, k, $1, $2; k = "" }' >> "$SAMPLES"
  [ "$(date +%s)" -ge "$end" ] && break
  sleep "$INTERVAL"
done

# Per sample, sum each kind (several serves count together), then take max, median and p95 over the samples.
awk -v samples="$n" '
  { mem[$1 SUBSEP $2] += $3; cpu[$1 SUBSEP $2] += $4; kinds[$2] = 1; tm[$1] += $3; tc[$1] += $4 }
  function pct(a, cnt, p,   i) { asorti_n(a, cnt); i = int((cnt - 1) * p + 0.5) + 1; return srt[i] }
  function asorti_n(a, cnt,   i, j, t) { for (i = 1; i <= cnt; i++) srt[i] = a[i];
    for (i = 2; i <= cnt; i++) { t = srt[i]; for (j = i - 1; j >= 1 && srt[j] > t; j--) srt[j + 1] = srt[j]; srt[j + 1] = t } }
  function row(name, m, c,   mx, i) { mx = 0; for (i = 1; i <= samples; i++) if (m[i] > mx) mx = m[i]
    printf "%-8s %9.0f %9.0f %8.1f %8.1f\n", name, mx / 1024, pct(m, samples, 0.5) / 1024, pct(c, samples, 0.5), pct(c, samples, 0.95) }
  END {
    printf "Samples: %d (every 10 s)\n\n%-8s %9s %9s %8s %8s\n", samples, "process", "max MB", "med MB", "med CPU", "p95 CPU"
    for (k in kinds) { delete m; delete c; for (i = 1; i <= samples; i++) { m[i] = mem[i SUBSEP k] + 0; c[i] = cpu[i SUBSEP k] + 0 }; row(k, m, c) }
    delete m; delete c; for (i = 1; i <= samples; i++) { m[i] = tm[i] + 0; c[i] = tc[i] + 0 }; row("total", m, c)
    if (!length(kinds)) print "\nNo Stephen process was running. Start Stephen and run this again."
  }' "$SAMPLES"

echo
echo "Disk:"
if [ -d "$HOME_DIR" ]; then
  echo "  Stephen home  $(du -sh "$HOME_DIR" 2>/dev/null | cut -f1)"
  [ -d "$HOME_DIR/models" ] && echo "  speech models $(du -sh "$HOME_DIR/models" 2>/dev/null | cut -f1)"
else
  echo "  Stephen home not found"
fi
exit 0
