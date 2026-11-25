import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, readlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repo = fileURLToPath(new URL("../../",import.meta.url));
const desktop = JSON.parse(await readFile(join(repo,"desktop","package.json"),"utf8"));
const out = join(repo,".minder-dev","macos");
const receipt = JSON.parse(await readFile(join(out,"latest.json"),"utf8"));
const app = resolve(out,receipt.app);
const dmg = resolve(out,receipt.dmg);
const contents = join(app,"Contents"), resources = join(contents,"Resources","app");
const binary = join(contents,"MacOS","Minder");
const temp = await mkdtemp(join(out,"acceptance-"));
process.env.TMPDIR = temp;

test("校验本地发行归档、应用签名、磁盘映像和内置 SQLite", async()=>{
  const sha = createHash("sha256");
  for await (const part of createReadStream(dmg)) sha.update(part);
  assert.equal(sha.digest("hex"),receipt.sha256);
  execFileSync("/usr/bin/hdiutil",["verify",dmg]);
  execFileSync("/usr/bin/codesign",["--verify","--deep","--strict",app]);
  const bundle = JSON.parse(execFileSync("/usr/bin/plutil",["-convert","json","-o","-",join(contents,"Info.plist")],{encoding:"utf8"}));
  assert.equal(bundle.CFBundleIdentifier,"io.github.bei7777.minder");
  assert.equal(bundle.CFBundleShortVersionString,receipt.version);
  assert.equal(receipt.version,desktop.version);
  assert.equal(receipt.runtimeVersion,desktop.minderRuntime.version);
  assert.equal(receipt.runtimeArchiveSha256,desktop.minderRuntime.archiveSha256);
  await access(join(contents,"Resources",bundle.CFBundleIconFile));
  for (const file of ["lib/main.js","lib/preload.cjs","lib/renderer.js","ui/index.html","ui/styles.css","LICENSE",
    "third-party/Electron-LICENSE.txt","third-party/LICENSES.chromium.html"]) await access(join(resources,file));
  for (const name of ["marked", "dompurify"]) {
    assert.deepEqual(await readFile(join(resources, "third-party", name + "-LICENSE.txt")),
      await readFile(join(repo, "desktop", "node_modules", name, "LICENSE")));
  }
  assert.deepEqual((await readdir(resources)).sort(),["LICENSE","lib","node_modules","package.json","third-party","ui"]);
  for (const pkg of receipt.packages) {
    assert.equal(pkg.version,receipt.runtimeVersion);
    const manifest = JSON.parse(await readFile(join(resources,"node_modules",pkg.name,"package.json"),"utf8"));
    assert.equal(manifest.version,pkg.version);
    assert.equal(manifest.name,pkg.name);
  }
  const result = execFileSync(binary,["--input-type=module","-e",[
    "import {DatabaseSync} from 'node:sqlite'",
    "import {openSnapshot, MemoryStore, Firewall} from '@minder/cli/desktop'",
    "const db = new DatabaseSync(':memory:')",
    "db.exec('create virtual table docs using fts5(body)')",
    "db.prepare('insert into docs(body) values (?)').run('Minder')",
    "console.log(JSON.stringify([process.versions.electron, typeof openSnapshot, typeof MemoryStore, typeof Firewall, db.prepare('select count(*) n from docs where docs match ?').get('Minder').n]))"
  ].join("\n")],{cwd:resources,env:{...process.env,ELECTRON_RUN_AS_NODE:"1"},encoding:"utf8"});
  assert.deepEqual(JSON.parse(result),[receipt.electron,"function","function","function",1]);
});

test("通过 macOS 启动服务打开应用并从设置界面读取隔离状态",{timeout:100000},async t=>{
  // Finder 会对文稿目录请求独立授权。应用和空白配置位于测试卷，所有数据随映像保存在项目目录中。
  const volumeName = "Minder-Test-"+randomUUID();
  const volume = join("/Volumes",volumeName);
  const testDisk = join(temp,"installation.sparseimage");
  execFileSync("/usr/bin/hdiutil",["create","-size","1200m","-type","SPARSE","-fs","APFS","-volname",volumeName,testDisk]);
  execFileSync("/usr/bin/hdiutil",["attach",testDisk,"-nobrowse","-mountpoint",volume]);
  t.after(()=>execFileSync("/usr/bin/hdiutil",["detach",volume]));
  await mkdir(join(volume,"Applications"));
  const mount = join(temp,"mounted"), installedApp = join(volume,"Applications","Minder.app");
  await mkdir(mount);
  execFileSync("/usr/bin/hdiutil",["attach",dmg,"-readonly","-nobrowse","-mountpoint",mount]);
  try {
    assert.equal(await readlink(join(mount,"Applications")),"/Applications");
    execFileSync("/usr/bin/ditto",[join(mount,"Minder.app"),installedApp]);
  } finally { execFileSync("/usr/bin/hdiutil",["detach",mount]); }
  execFileSync("/usr/bin/codesign",["--verify","--deep","--strict",installedApp]);
  const probe = createServer();
  probe.listen(0,"127.0.0.1");
  await once(probe,"listening");
  const port = probe.address().port;
  await new Promise((yes,no)=>probe.close(error=>error?no(error):yes()));
  const home = join(volume,"home"), userData = join(volume,"chromium"), appTemp=join(volume,"temp");
  await Promise.all([mkdir(home),mkdir(userData),mkdir(appTemp)]);
  execFileSync("/usr/bin/open",["-n","--env","MINDER_HOME="+home,"--env","TMPDIR="+appTemp,
    "--stdout",join(volume,"app.stdout"),"--stderr",join(volume,"app.stderr"),
    "-a",installedApp,"--args","--user-data-dir="+userData,"--remote-debugging-address=127.0.0.1","--remote-debugging-port="+port]);
  const origin = "http://127.0.0.1:"+port;
  let ready = false;
  for (let count=0;count<200&&!ready;count++) {
    try { ready=(await fetch(origin+"/json/version",{signal:AbortSignal.timeout(1000)})).ok; }
    catch(error) { if(error.cause?.code!=="ECONNREFUSED") throw error; }
    if (!ready) await delay(100);
  }
  assert.ok(ready,"macOS did not start the packaged application.");
  const browser = await chromium.connectOverCDP(origin);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent("page");
    await page.getByRole("heading",{name:"连接 Minder"}).waitFor();
    assert.equal(await page.title(),"Minder");
    const state = await page.evaluate(async()=>({
      configured:(await window.minder.status()).configured,
      api:typeof window.minder.chooseWorkspace,node:typeof window.require,
    }));
    assert.deepEqual(state,{configured:false,api:"function",node:"undefined"});
    await page.getByRole("button",{name:"文件记录",exact:true}).click();
    await page.getByRole("button",{name:"打开设置"}).click();
    await page.getByRole("button",{name:"选择目录…"}).waitFor();
  } finally {
    for (const page of browser.contexts().flatMap(context=>context.pages())) await page.close();
    await browser.close();
  }
});
