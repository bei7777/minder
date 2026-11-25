set -euo pipefail

baseline=.minder-dev/upgrade-base
mkdir -p "$baseline"
tar -xzf releases/minder-0.1.4.tar.gz -C "$baseline" delivery/release.json delivery/tarballs/
pnpm --dir ../pi-minder build
pnpm lab publish-local --reuse "$baseline/delivery/release.json" \
  @minder/core-snapshot pi-minder-snapshot dsh-plugin-minder-snapshot @minder/cli
