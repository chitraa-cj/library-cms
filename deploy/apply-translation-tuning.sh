#!/usr/bin/env bash
# Apply the translation-worker tuning on the EC2 box, restart the worker cleanly,
# then set up log rotation. Idempotent.
#
#   cd ~/library/library-cms && git pull -q && bash deploy/apply-translation-tuning.sh
#
# Why these values (measured 2026-11-02): each prompt is ~1000 chars of fixed
# instructions around a 80-200 char verse, and Gemini's per-prompt latency is
# ~2 min whatever the size, so more languages per prompt cuts both tokens and time.
#   HERMEX_CHUNK_SIZE=6        languages per prompt for short sources (long ones still
#                              drop to 1-2 via effectiveChunkSizeForSource): 15 → 8 prompts
#   HERMEX_SESSION_BATCH=18    languages per fresh Chrome (+ warm-up prompt): 8 → 3 launches
#   TRANSLATION_TIMEOUT=6h     a full mantra (3 fields × 43 langs) took longer than 2h
# Undo: cp .env.bak-translation-tuning .env && pm2 restart cms-translation-worker --update-env
set -euo pipefail

CMS_DIR="${CMS_DIR:-/home/ubuntu/library/library-cms}"
cd "$CMS_DIR"

[ -f .env.bak-translation-tuning ] || cp .env .env.bak-translation-tuning

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s/^${key}=.*/${key}=${value}/" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
set_env HERMEX_CHUNK_SIZE 6
set_env HERMEX_SESSION_BATCH 18
set_env TRANSLATION_TIMEOUT 21600000
echo "[tuning] .env now has:"
grep -E '^(HERMEX_CHUNK_SIZE|HERMEX_SESSION_BATCH|TRANSLATION_TIMEOUT)=' .env

echo "[tuning] stopping cms-translation-worker (30s shutdown grace)"
pm2 stop cms-translation-worker >/dev/null
sleep 35
# A translate_cli started during the grace outlives the worker and holds the profile
# lock (seen 2026-11-02: two items burned 2 attempts each). The [x] trick stops pkill
# matching this script's own command line.
pkill -f '[t]ranslate_cli.py' || true
pkill -f '[h]ermex-translation/chrome-profile' || true
sleep 2
pm2 restart cms-translation-worker --update-env >/dev/null
pm2 save >/dev/null
echo "[tuning] worker restarted"

bash "$CMS_DIR/deploy/setup-log-rotation.sh"
