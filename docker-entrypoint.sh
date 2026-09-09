#!/bin/sh
set -eu

# Docker-managed volumes are commonly created as root:root. The application
# process runs as uid/gid 10001, so fix the mounted data directory before
# dropping privileges. This also makes first-run named-volume deployment work
# without a manual chown step.
mkdir -p /data
chown -R 10001:10001 /data

exec gosu ledger "$@"
