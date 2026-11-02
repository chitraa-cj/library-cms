#!/usr/bin/env bash
# Log rotation for the EC2 box. Idempotent: safe to re-run after every deploy.
#
#   bash deploy/setup-log-rotation.sh
#
# Before this (2026-11-02) nothing rotated anything: ~/.pm2/logs had grown to 763MB
# (strapi-backend-out.log alone 482MB) and the disk sat at 81%. Three pieces:
#
#  1. pm2-logrotate — every pm2 app's stdout/stderr, including the workers' custom
#     out_file/error_file paths under library-cms/logs (it rotates whatever path pm2
#     writes to). Rotates at 50MB or daily, keeps 10 gzipped files per log.
#  2. /etc/logrotate.d/library-cms — logs/activity.log, which the portal appends to
#     itself (server/activity-log.ts opens it per write, so a plain rename is safe).
#  3. A daily cron that deletes Hermex raw-reply dumps and diagnostics older than 14
#     days (python/hermex_translate writes one per unparseable reply).
#
# NOT touched, on purpose: logs/draft-snapshots (the portal's draft recovery copies —
# data, not logs), the Chrome profiles (Chrome caps its own cache; deleting files
# under a running browser corrupts the profile), and the hermex-checkpoints (resume
# state for jobs).
set -euo pipefail

CMS_DIR="${CMS_DIR:-/home/ubuntu/library/library-cms}"
RUN_USER="${RUN_USER:-ubuntu}"

echo "[logs] 1/3 pm2-logrotate"
if ! pm2 describe pm2-logrotate >/dev/null 2>&1; then
  pm2 install pm2-logrotate
fi
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 10
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:workerInterval 300
pm2 save

echo "[logs] 2/3 logrotate rule for activity.log"
sudo tee /etc/logrotate.d/library-cms >/dev/null <<EOF
${CMS_DIR}/logs/activity.log {
    su ${RUN_USER} ${RUN_USER}
    daily
    maxsize 50M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
}
EOF
sudo logrotate --debug /etc/logrotate.d/library-cms >/dev/null 2>&1 || {
  echo "[logs] logrotate rejected the rule:"; sudo logrotate --debug /etc/logrotate.d/library-cms; exit 1;
}

echo "[logs] 3/3 daily prune of Hermex dumps (>14 days)"
CRON_LINE="17 3 * * * find ${CMS_DIR}/logs/hermex-raw ${CMS_DIR}/logs/hermex-diagnostics -type f -mtime +14 -delete 2>/dev/null"
# `|| true`: with no crontab yet, `crontab -l` fails and grep matches nothing — under
# pipefail that killed the subshell before the echo and installed an EMPTY crontab.
existing="$(crontab -l 2>/dev/null | grep -v 'logs/hermex-raw' || true)"
printf '%s\n%s\n' "$existing" "$CRON_LINE" | sed '/^$/d' | crontab -

echo "[logs] done:"
pm2 conf pm2-logrotate 2>/dev/null | grep -E 'max_size|retain|compress|rotateInterval' || true
crontab -l | grep hermex-raw || { echo "[logs] cron line missing"; exit 1; }
df -h / | tail -1
