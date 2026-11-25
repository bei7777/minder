import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 公网包使用发布者的 scope。便携包与编译代码中的模块标识通过 npm 别名保持可用。
const names = new Map([["@minder/cli", "@bei7777/minder-cli"]]);
for (const feature of ["snapshot", "memory", "firewall"]) {
  names.set("@minder/core-" + feature, "@bei7777/minder-core-" + feature);
  names.set("pi-minder-" + feature, "pi-minder-" + feature);
  names.set("dsh-plugin-minder-" + feature, "dsh-plugin-minder-" + feature);
}
const kit = resolve(process.argv[2]);
const release = JSON.parse(readFileSync(join(kit, "release.json"), "utf8"));
assert.deepEqual(release.packages.map(pkg => pkg.name).sort(), [...names.keys()].sort());
const versions = new Map(release.packages.map(pkg => [pkg.name, pkg.version]));
const buildRoot = fileURLToPath(new URL("../.minder-dev/public-packs/", import.meta.url));
mkdirSync(buildRoot, {recursive:true});
const output = mkdtempSync(join(buildRoot, "release-"));
const env = {...process.env, TMPDIR:output, TMP:output, TEMP:output, npm_config_cache:join(buildRoot,"cache")};
const integrity = bytes => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const result = [];
for (const pkg of release.packages) {
  assert.match(pkg.file, /^tarballs\/[A-Za-z0-9-]+\.tgz$/);
  const archive = join(kit, pkg.file);
  assert.equal(integrity(readFileSync(archive)), pkg.integrity);
  const stage = mkdtempSync(join(output,"stage-"));
  execFileSync("tar", ["-xzf",archive,"-C",stage], {env});
  const source = join(stage,"package");
  const path = join(source,"package.json");
  const manifest = JSON.parse(readFileSync(path,"utf8"));
  assert.equal(manifest.name,pkg.name);
  assert.equal(manifest.version,pkg.version);
  manifest.name = names.get(pkg.name);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const published = names.get(name);
    if (published && published !== name) manifest.dependencies[name] = "npm:" + published + "@" + versions.get(name);
  }
  writeFileSync(path, JSON.stringify(manifest,null,2) + "\n");
  const readmePath = join(source,"README.md");
  let readme = readFileSync(readmePath,"utf8");
  for (const [from,to] of names) if (from !== to) readme = readme.replaceAll(from,to);
  writeFileSync(readmePath,readme);
  const [packed] = JSON.parse(execFileSync("npm", ["pack","--ignore-scripts","--json","--pack-destination",output], {cwd:source,env,encoding:"utf8"}));
  const tarball = join(output,basename(packed.filename));
  assert.equal(integrity(readFileSync(tarball)),packed.integrity);
  const checked = mkdtempSync(join(output,"check-"));
  execFileSync("tar",["-xzf",tarball,"-C",checked],{env});
  const packedFiles = packed.files.map(item=>item.path).sort();
  const sources = readdirSync(source,{recursive:true,withFileTypes:true})
    .filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name).slice(source.length+1).replaceAll("\\","/")).sort();
  assert.deepEqual(packedFiles,sources);
  for (const file of packedFiles) assert.deepEqual(readFileSync(join(checked,"package",file)),readFileSync(join(source,file)));
  result.push({name:manifest.name,version:manifest.version,source:pkg.name,sourceIntegrity:pkg.integrity,
    integrity:packed.integrity,file:basename(tarball)});
}
writeFileSync(join(output,"packages.json"),JSON.stringify(result,null,2)+"\n");
console.log(output);
