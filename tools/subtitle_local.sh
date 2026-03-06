#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: subtitle_local.sh <input> <output> <lang>" >&2
  exit 2
fi

INPUT_FILE="$1"
OUTPUT_FILE="$2"
LANG_RAW="$3"

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "input file not found: $INPUT_FILE" >&2
  exit 3
fi

LANG_VALUE="$LANG_RAW"
if [[ "$LANG_VALUE" == "auto" ]]; then
  LANG_VALUE=""
fi

exec python3 /home/container/tools/subtitle_local.py \
  --input "$INPUT_FILE" \
  --output "$OUTPUT_FILE" \
  --lang "$LANG_VALUE"
