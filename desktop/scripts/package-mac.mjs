import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { Resvg } from "@resvg/resvg-js";

assert.equal(process.platform,"darwin","Run this build on macOS.");
assert.equal(process.arch,"arm64","Use an Apple silicon Node.js installation.");
const desktop = fileURLToPath(new URL("../",import.meta.url));
const repo = resolve(desktop,"..");
const readJSON = async path => JSON.parse(await readFile(path,"utf8"));
const manifest = await readJSON(join(desktop,"package.json"));
const out = join(repo,".minder-dev","macos");
const cache = join(repo,".minder-dev","mac-tools","electron");
await mkdir(out,{recursive:true});
const work = await mkdtemp(join(out,"build-"));
const temp = join(work,"temp"), consumer = join(work,"consumer"), stage = join(work,"app");
await Promise.all([temp,stage,consumer].map(path=>mkdir(path)));
const env = {...process.env,TMPDIR:temp,TMP:temp,TEMP:temp,electron_config_cache:cache};
const run = (program,args,opts={}) => execFileSync(program,args,{cwd:work,env,stdio:"inherit",...opts});
async function digest(path,algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(algorithm==="sha512" ? "base64" : "hex");
}

const runtimeVersion = manifest.minderRuntime.version;
const archive = join(repo, "releases", `minder-${runtimeVersion}.tar.gz`);
assert.equal(await digest(archive, "sha256"), manifest.minderRuntime.archiveSha256, "Portable release checksum mismatch");
run("/usr/bin/tar", ["-xzf", archive, "-C", work, "delivery"]);
const referenceKit = join(work, "delivery");
const kit = process.argv[2] ? resolve(process.argv[2]) : referenceKit;
if (kit !== referenceKit) {
  for (const name of ["release.json", "package.json", "package-lock.json"]) {
    assert.deepEqual(await readJSON(join(kit, name)), await readJSON(join(referenceKit, name)), name);
  }
}
const release = await readJSON(join(kit,"release.json"));
const lock = await readJSON(join(kit,"package-lock.json"));
const dependencies = (await readJSON(join(kit,"package.json"))).dependencies;
const runtime = release.packages.filter(pkg=>pkg.repo!=="dsh-plugin-minder");
assert.equal(runtime.length,7);
assert.deepEqual(Object.keys(dependencies).sort(),runtime.map(pkg=>pkg.name).sort());
assert.equal(runtime.find(pkg=>pkg.name==="@minder/cli")?.version,runtimeVersion,"CLI version mismatch");
await mkdir(join(consumer,"tarballs"));
for (const pkg of runtime) {
  assert.match(pkg.file,/^tarballs\/[a-z0-9-]+\.tgz$/);
  const installed = lock.packages["node_modules/"+pkg.name];
  assert.equal(installed.version,pkg.version,pkg.name);
  assert.equal(installed.integrity,pkg.integrity,pkg.name);
  assert.equal(installed.resolved,"file:"+pkg.file,pkg.name);
  assert.equal("sha512-"+await digest(join(kit,pkg.file),"sha512"),pkg.integrity,pkg.name);
  await copyFile(join(kit,pkg.file),join(consumer,pkg.file));
}
for (const name of ["package.json","package-lock.json"]) await copyFile(join(kit,name),join(consumer,name));
run("npm",["ci","--omit=dev","--ignore-scripts","--no-audit","--no-fund","--prefer-offline",
  "--registry=https://registry.npmjs.org/","--cache",join(repo,".minder-dev","distribution","npm-cache")],{cwd:consumer});
await rename(join(consumer,"node_modules"),join(stage,"node_modules"));
const buildConfig = join(work, "tsconfig.json");
await writeFile(buildConfig, JSON.stringify({
  extends: join(desktop, "tsconfig.json"),
  compilerOptions: {
    paths: { "@minder/cli/desktop": [join(stage, "node_modules/@minder/cli/lib/desktop.d.ts")] },
    typeRoots: [join(desktop, "node_modules/@types")],
  },
}));
run(process.execPath, [join(desktop, "scripts/build.mjs"), join(stage, "lib"), buildConfig]);
await cp(join(desktop, "ui"), join(stage, "ui"), { recursive: true, filter: path => !basename(path).startsWith(".") });
await copyFile(join(repo,"LICENSE"),join(stage,"LICENSE"));
await writeFile(join(stage,"package.json"),JSON.stringify({
  name:manifest.name,productName:"Minder",version:manifest.version,description:manifest.description,
  type:"module",main:manifest.main,license:"MIT"
},null,2)+"\n");

const require = createRequire(import.meta.url);
const electron = dirname(require.resolve("electron/package.json"));
run(process.execPath,[join(electron,"install.js")]);
const licenses = join(stage,"third-party");
await mkdir(licenses);
await copyFile(join(electron,"dist","LICENSE"),join(licenses,"Electron-LICENSE.txt"));
await copyFile(join(electron,"dist","LICENSES.chromium.html"),join(licenses,"LICENSES.chromium.html"));
for (const name of ["marked", "dompurify"]) {
  await copyFile(join(desktop, "node_modules", name, "LICENSE"), join(licenses, name + "-LICENSE.txt"));
}
const iconset = join(work,"Minder.iconset");
await mkdir(iconset);
const svg = await readFile(join(desktop,"assets","icon.svg"),"utf8");
for (const size of [16,32,128,256,512]) {
  for (const scale of [1,2]) {
    const image = new Resvg(svg,{fitTo:{mode:"width",value:size*scale}}).render();
    await writeFile(join(iconset,`icon_${size}x${size}${scale===2?"@2x":""}.png`),image.asPng());
  }
}
const icon = join(work,"Minder.icns");
run("/usr/bin/iconutil",["-c","icns","-o",icon,iconset]);
const identity = process.env.MINDER_MAC_SIGN_IDENTITY;
const [packed] = await packager({
  dir:stage,out:join(work,"packed"),name:"Minder",platform:"darwin",arch:"arm64",
  electronVersion:manifest.devDependencies.electron,download:{cacheRoot:cache,checksums:await readJSON(join(electron,"checksums.json"))},
  appBundleId:"io.github.bei7777.minder",appCategoryType:"public.app-category.productivity",icon,
  appVersion:manifest.version,tmpdir:temp,asar:false,prune:false,
  ...(identity ? {osxSign:{identity,continueOnError:false}} : {})
});
const imageDir = join(work,"image");
await mkdir(imageDir);
const app = join(imageDir,"Minder.app");
await rename(join(packed,"Minder.app"),app);
if (!identity) run("/usr/bin/codesign",["--force","--deep","--sign","-",app]);
run("/usr/bin/codesign",["--verify","--deep","--strict",app]);
await symlink("/Applications",join(imageDir,"Applications"));
const dmg = join(work,`Minder-${manifest.version}-macos-arm64.dmg`);
run("/usr/bin/hdiutil",["create","-volname","Minder","-srcfolder",imageDir,"-format","UDZO",dmg]);
run("/usr/bin/hdiutil",["verify",dmg]);
await rename(app,join(work,"Minder.app"));
const result = {version:manifest.version,runtimeVersion,runtimeArchiveSha256:manifest.minderRuntime.archiveSha256,
  arch:"arm64",electron:manifest.devDependencies.electron,
  signing:identity ? "Developer ID" : "ad-hoc",app:relative(out,join(work,"Minder.app")),dmg:relative(out,dmg),
  sha256:await digest(dmg,"sha256"),packages:runtime.map(({name,version,integrity})=>({name,version,integrity}))};
await writeFile(join(work,"artifacts.json"),JSON.stringify(result,null,2)+"\n");
const pointer = join(work,"latest.json");
await copyFile(join(work,"artifacts.json"),pointer);
await rename(pointer,join(out,"latest.json"));
console.log(join(work,"Minder.app"),"\n"+dmg,"\nSHA-256",result.sha256,basename(dmg));
