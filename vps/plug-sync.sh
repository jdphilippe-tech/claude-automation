#!/usr/bin/env bash
# Pulls The Plug from the PRIVATE repo jdphilippe-tech/the-plug every 2 minutes (cron).
#   preview  <- main branch       -> https://<server>.ts.net/preview/
#   live     <- plug-live branch  -> https://<server>.ts.net/
# Auth: read-only deploy key /root/.ssh/the_plug_deploy (added under the repo's Settings -> Deploy keys).
# Secrets (config.js) live only in /opt/plug/config.js and are copied in after each pull.
set -euo pipefail
REPO=git@github.com:jdphilippe-tech/the-plug.git
export GIT_SSH_COMMAND="ssh -i /root/.ssh/the_plug_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
for pair in "preview:main" "live:plug-live"; do
  name=${pair%%:*}; branch=${pair##*:}
  dir=/opt/plug/$name
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" remote get-url origin)" != "$REPO" ]; then
    rm -rf "$dir"   # old copy pulled from the public repo: replace it with a fresh clone of the private one
  fi
  if [ ! -d "$dir/.git" ]; then
    git clone -q --depth 1 --branch "$branch" "$REPO" "$dir"
  else
    git -C "$dir" fetch -q --depth 1 origin "+refs/heads/$branch:refs/remotes/origin/$branch"
    git -C "$dir" reset -q --hard "origin/$branch"
  fi
  cp /opt/plug/config.js "$dir/plug/site/config.js"
done
