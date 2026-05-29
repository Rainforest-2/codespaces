#!/usr/bin/env bash
set -euo pipefail

BASE='https://players.streaks.jp/prod-sundai/634f85d3a7674636bd1212b5904b1d81/index.html?m=ref:'

START="${START:-1520982}"
STEP="${STEP:-240}"
MIN_REF="${MIN_REF:-1400000}"
MAX_REF="${MAX_REF:-1599999}"

BATCH_COUNT="${BATCH_COUNT:-20}"
CONCURRENCY="${CONCURRENCY:-5}"
TIMEOUT_MS="${TIMEOUT_MS:-5000}"

RESULT_FILE="${RESULT_FILE:-heads-true.txt}"
RESULT_FALSE_FILE="${RESULT_FALSE_FILE:-heads-false.txt}"
SORTED_TRUE_FILE="${SORTED_TRUE_FILE:-heads-true.sorted.txt}"
SORTED_FALSE_FILE="${SORTED_FALSE_FILE:-heads-false.sorted.txt}"
LOG_FILE="${LOG_FILE:-heads-step240-no-stop.log}"

touch "$RESULT_FILE" "$RESULT_FALSE_FILE" "$SORTED_TRUE_FILE" "$SORTED_FALSE_FILE"
: > "$LOG_FILE"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

KNOWN="$TMPDIR/known.txt"
CANDIDATES="$TMPDIR/candidates.txt"
TODO="$TMPDIR/todo.txt"

perl -ne 'print "$1\n" if /ref:(\d+)/' "$SORTED_TRUE_FILE" "$RESULT_FILE" \
  | sort -n -u > "$KNOWN"

: > "$CANDIDATES"

for ((ref=START; ref>=MIN_REF; ref-=STEP)); do
  echo "$ref" >> "$CANDIDATES"
done

for ((ref=START+STEP; ref<=MAX_REF; ref+=STEP)); do
  echo "$ref" >> "$CANDIDATES"
done

sort -n -u "$CANDIDATES" -o "$CANDIDATES"

comm -23 "$CANDIDATES" "$KNOWN" > "$TODO"

TOTAL="$(wc -l < "$TODO" | tr -d ' ')"
echo "todo: $TOTAL refs" | tee -a "$LOG_FILE"

run_batch() {
  if (( ${#BATCH[@]} == 0 )); then
    return 0
  fi

  TIMEOUT_MS="$TIMEOUT_MS" \
  CONCURRENCY="$CONCURRENCY" \
  RESULT_FILE="$RESULT_FILE" \
  RESULT_FALSE_FILE="$RESULT_FALSE_FILE" \
  node check-streaks-fast.mjs "${BATCH[@]}" | tee -a "$LOG_FILE"

  BATCH=()
}

BATCH=()

while read -r ref; do
  BATCH+=("${BASE}${ref}")

  if (( ${#BATCH[@]} >= BATCH_COUNT )); then
    run_batch
  fi
done < "$TODO"

run_batch

cat "$SORTED_TRUE_FILE" "$RESULT_FILE" \
  | perl -ne 'print if /ref:(\d+)/' \
  | sort -t: -k3,3n -u > "${SORTED_TRUE_FILE}.tmp"
mv "${SORTED_TRUE_FILE}.tmp" "$SORTED_TRUE_FILE"

cat "$SORTED_FALSE_FILE" "$RESULT_FALSE_FILE" \
  | perl -ne 'print if /ref:(\d+)/' \
  | sort -t: -k3,3n -u > "${SORTED_FALSE_FILE}.tmp"
mv "${SORTED_FALSE_FILE}.tmp" "$SORTED_FALSE_FILE"

echo "done"
echo "true:  $SORTED_TRUE_FILE"
echo "false: $SORTED_FALSE_FILE"
echo "log:   $LOG_FILE"
