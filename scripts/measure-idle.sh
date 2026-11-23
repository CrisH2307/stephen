#!/bin/bash
# Measures Stephen's idle CPU, memory, and disk usage on macOS.
# Usage: measure-idle.sh [--seconds N]
# Default: 600 seconds (10 minutes), sample every 10 seconds

set -e

# Default duration
DURATION=600
INTERVAL=10

# Parse --seconds option
while [ $# -gt 0 ]; do
  case "$1" in
    --seconds)
      shift
      DURATION="$1"
      shift
      ;;
    *)
      echo "Usage: $0 [--seconds N]" >&2
      exit 1
      ;;
  esac
done

# Calculate number of samples
SAMPLES=$((DURATION / INTERVAL))

# Create temp file for collecting samples
SAMPLE_FILE=$(mktemp /tmp/stephen_samples_XXXXXX)

cleanup() {
  rm -f "$SAMPLE_FILE"
}
trap cleanup EXIT

# Collect samples - avoid subshell by using process substitution
sample_count=0
while [ $sample_count -lt $SAMPLES ]; do
  # Get Stephen processes and process them without subshell
  ps -axo pid=,rss=,%cpu=,command= 2>/dev/null | grep -E '(node.*dist/cli\.js|Stephen Helper|sherpa-onnx)' | grep -v 'grep' > /tmp/ps_out_$$
  
  while read -r pid rss cpu cmd; do
    # Determine process name
    if echo "$cmd" | grep -q 'node.*dist/cli\.js'; then
      if echo "$cmd" | grep -q 'serve'; then
        name="serve"
      else
        name="cli"
      fi
    elif echo "$cmd" | grep -q 'Stephen Helper'; then
      name="Stephen Helper"
    elif echo "$cmd" | grep -q 'sherpa-onnx'; then
      name="sherpa-onnx"
    else
      continue
    fi
    # Store: name|rss|cpu
    printf "%s|%s|%s\n" "$name" "$rss" "$cpu" >> "$SAMPLE_FILE"
  done < /tmp/ps_out_$$
  
  rm -f /tmp/ps_out_$$
  
  sample_count=$((sample_count + 1))
  if [ $sample_count -lt $SAMPLES ]; then
    sleep $INTERVAL
  fi
done

# Process all samples - handle spaces in process names
# Use a while loop with IFS to read process names with spaces
OLDIFS="$IFS"
IFS=$'\n'
PROCESS_NAMES=$(cut -d'|' -f1 "$SAMPLE_FILE" 2>/dev/null | sort -u)
for name in $PROCESS_NAMES; do
  # Restore IFS for the rest of processing
  IFS="$OLDIFS"
  
  proc_rss=$(grep "^${name}|" "$SAMPLE_FILE" | cut -d'|' -f2)
  proc_cpu=$(grep "^${name}|" "$SAMPLE_FILE" | cut -d'|' -f3)
  
  if [ -n "$proc_rss" ]; then
    proc_count=$(echo "$proc_rss" | wc -w | tr -d ' ')
    
    # Max RSS
    proc_max=$(echo $proc_rss | tr ' ' '\n' | sort -n | tail -1)
    proc_max_mb=$(echo "scale=1; $proc_max / 1024" | bc)
    
    # Median RSS
    proc_med_rss=$(echo $proc_rss | tr ' ' '\n' | sort -n | sed -n "$(( (proc_count + 1) / 2 ))p")
    proc_med_rss_mb=$(echo "scale=1; $proc_med_rss / 1024" | bc)
    
    # Median CPU
    proc_med_cpu=$(echo $proc_cpu | tr ' ' '\n' | sort -n | sed -n "$(( (proc_count + 1) / 2 ))p")
    
    # p95 CPU
    proc_p95_pos=$((proc_count * 95 / 100))
    if [ $proc_p95_pos -lt 1 ]; then
      proc_p95_pos=1
    fi
    proc_p95_cpu=$(echo $proc_cpu | tr ' ' '\n' | sort -n | sed -n "${proc_p95_pos}p")
    
    echo "$name $proc_max_mb $proc_med_rss_mb $proc_med_cpu $proc_p95_cpu"
  fi
  
  IFS=$'\n'
done
IFS="$OLDIFS"

# Total stats
all_rss=$(cut -d'|' -f2 "$SAMPLE_FILE")
all_cpu=$(cut -d'|' -f3 "$SAMPLE_FILE")

if [ -n "$all_rss" ]; then
  total_count=$(echo "$all_rss" | wc -w | tr -d ' ')
  
  total_max=$(echo $all_rss | tr ' ' '\n' | sort -n | tail -1)
  total_max_mb=$(echo "scale=1; $total_max / 1024" | bc)
  
  total_med_rss=$(echo $all_rss | tr ' ' '\n' | sort -n | sed -n "$(( (total_count + 1) / 2 ))p")
  total_med_rss_mb=$(echo "scale=1; $total_med_rss / 1024" | bc)
  
  total_med_cpu=$(echo $all_cpu | tr ' ' '\n' | sort -n | sed -n "$(( (total_count + 1) / 2 ))p")
  
  total_p95_pos=$((total_count * 95 / 100))
  if [ $total_p95_pos -lt 1 ]; then
    total_p95_pos=1
  fi
  total_p95_cpu=$(echo $all_cpu | tr ' ' '\n' | sort -n | sed -n "${total_p95_pos}p")
  
  echo ""
  echo "=== Total ==="
  echo "total $total_max_mb $total_med_rss_mb $total_med_cpu $total_p95_cpu"
else
  echo "No Stephen processes found during the sample period"
fi

# Disk usage
echo ""
echo "=== Disk usage ==="

if [ -d "$HOME/.stephen" ]; then
  stephen_size=$(du -sh "$HOME/.stephen" 2>/dev/null | cut -f1)
  echo "~/.stephen $stephen_size"
else
  echo "~/.stephen not found"
fi

# Check for speech model directories
for dir in "$HOME/.stephen/speech" "$HOME/.stephen/models" "$HOME/.stephen/voice"; do
  if [ -d "$dir" ]; then
    model_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
    basename=$(basename "$dir")
    echo "$basename $model_size"
  fi
done