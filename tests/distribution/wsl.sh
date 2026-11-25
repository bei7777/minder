set -euo pipefail

grep -Eiq 'microsoft.*WSL2' /proc/sys/kernel/osrelease
uname -a
checkout=$(pwd)
work=$(mktemp -d "$HOME/minder-ci.XXXXXXXX")
windows_data=$(mktemp -d /mnt/c/minder-ci.XXXXXXXX)
linux_fs=$(findmnt -n -T "$work" -o FSTYPE)
windows_fs=$(findmnt -n -T "$windows_data" -o FSTYPE)
test "$linux_fs" = ext4
case "$windows_fs" in
  9p|drvfs) ;;
  *) echo "Expected a Windows-mounted volume, found $windows_fs" >&2; exit 1 ;;
esac
findmnt -T "$work" -o TARGET,FSTYPE
findmnt -T "$windows_data" -o TARGET,FSTYPE

for repo in minder pi-minder dsh-plugin-minder; do
  git config --global --add safe.directory "$checkout/$repo"
  git -c core.autocrlf=false clone --quiet --no-local "$checkout/$repo" "$work/$repo"
  test "$(git -C "$work/$repo" rev-parse HEAD)" = "$(git -C "$checkout/$repo" rev-parse HEAD)"
done

cd "$work"
version=v24.9.0
archive="node-$version-linux-x64.tar.xz"
curl --fail --show-error --silent --remote-name "https://nodejs.org/dist/$version/$archive"
curl --fail --show-error --silent --remote-name "https://nodejs.org/dist/$version/SHASUMS256.txt"
sha256sum --strict --ignore-missing --check SHASUMS256.txt
tar -xf "$archive"
export PATH="$work/node-$version-linux-x64/bin:$PATH"
test "$(node -p process.platform)" = linux
test "$(node -p process.version)" = "$version"
npm install --global --ignore-scripts pnpm@10.15.0
for repo in pi-minder dsh-plugin-minder minder; do
  pnpm --dir "$repo" install --frozen-lockfile
done
(cd minder && bash tests/distribution/build-candidate.sh)
pnpm --dir pi-minder test
pnpm --dir minder test
pnpm --dir minder lab verify-release
pnpm --dir minder lab test-hosts
pnpm --dir minder lab test-kit
node minder/tests/distribution/wsl-volumes.mjs "$work" "$windows_data"
pnpm --dir minder lab test-upgrade .minder-dev/upgrade-base/delivery/release.json
MINDER_LAB_DATA_PARENT="$windows_data" pnpm --dir minder lab test-upgrade .minder-dev/upgrade-base/delivery/release.json

cd "$windows_data"
node --test "$work/pi-minder/packages/core-snapshot/tests/snapshot.test.mjs" \
  "$work/pi-minder/packages/core-memory/test/memory.test.mjs" \
  "$work/pi-minder/packages/core-firewall/test/firewall.test.mjs" \
  "$work/minder/packages/cli/test/cli.test.mjs"
