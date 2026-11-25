set -euo pipefail

host=${1:?Supply a host name}
check_tasks="$PWD/tests/distribution/portable-tasks.mjs"
archive="$PWD/releases/minder-${MINDER_RELEASE_VERSION:?Supply a release version}.tar.gz"
if [[ "$host" = WSL2 ]]; then
  grep -Eiq 'microsoft.*WSL2' /proc/sys/kernel/osrelease
  work=$(mktemp -d "$HOME/minder-release.XXXXXXXX")
  test "$(findmnt -n -T "$work" -o FSTYPE)" = ext4
  cd "$work"
  node_version=v24.9.0
  node_archive="node-$node_version-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/$node_version/$node_archive"
  curl -fsSLO "https://nodejs.org/dist/$node_version/SHASUMS256.txt"
  sha256sum --strict --ignore-missing --check SHASUMS256.txt
  tar -xf "$node_archive"
  export PATH="$work/node-$node_version-linux-x64/bin:$PATH"
  test "$(node -p process.platform)" = linux
else
  mkdir -p .minder-dev/portable-check
  work=$(mktemp -d "$PWD/.minder-dev/portable-check/install.XXXXXXXX")
fi

node -e 'const {readFileSync} = require("node:fs"), {createHash} = require("node:crypto");
const digest = createHash("sha256").update(readFileSync(process.argv[1])).digest("hex");
require("node:assert/strict").equal(digest, process.env.MINDER_RELEASE_SHA256);
console.log(process.platform, process.arch, process.version, "archive SHA-256", digest);' "$archive"
tar -xzf "$archive" -C "$work"
cd "$work/delivery"
npm run verify
npm ci --ignore-scripts --no-audit --no-fund --cache "$work/npm-cache"
npm exec --offline --cache "$work/empty-cache" -- minder --help > "$work/help.txt"
grep -Fq 'minder doctor' "$work/help.txt"
node "$check_tasks" "$MINDER_RELEASE_VERSION"
echo "Offline Minder startup passed on $host"
