#!/usr/bin/env bash
# Commit new monitoring data back to the repo (retries if another run pushed first).
set -e
git config user.name  "site-monitor-bot"
git config user.email "site-monitor-bot@users.noreply.github.com"
git add docs/data
if git diff --cached --quiet; then echo "No data changes"; exit 0; fi
git commit -m "data: $1 $(date -u +%Y-%m-%dT%H:%MZ)" -q
for i in 1 2 3 4 5; do
  if git push -q; then echo "Pushed"; exit 0; fi
  echo "Push rejected, rebasing (attempt $i)"; git pull --rebase -q -X theirs || { git rebase --abort; git pull --no-rebase -q -X ours; }
  sleep $((i * 3))
done
echo "Could not push data"; exit 1
