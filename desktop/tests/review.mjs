import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { MemoryStore } from "../../packages/cli/node_modules/@minder/core-memory/lib/index.js";
import { openSnapshot } from "../../packages/cli/node_modules/@minder/core-snapshot/lib/index.js";

const appPath=process.argv[2];
assert.ok(appPath?.endsWith(".app"),"Pass the packaged Minder.app path");
const executablePath=join(resolve(appPath),"Contents","MacOS","Minder");
const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const parent=join(repo,".minder-dev","desktop-review");
await mkdir(parent,{recursive:true});
const run=await mkdtemp(join(parent,"run-")), home=join(run,"home");
const root=join(run,"notes"); await mkdir(root);
const env={...process.env,MINDER_HOME:home};
const cli=join(repo,"packages","cli","lib","bin.js");
await promisify(execFile)(process.execPath,[cli,"init","--root",root,"--provider","ollama","--model","local","--no-verify"],{env});
const file=join(root,"notes.md"), original=await readFile(join(repo,"README.md"));
await writeFile(file,original);
const snapshot=await openSnapshot({stateDir:join(home,"snapshot"),roots:[root]});
try {
  const tx=await snapshot.begin("桌面审阅");
  await tx.write(file,original.toString()+"\nDesktop review acceptance\n"); await tx.commit();
} finally {snapshot.close();}
const memory=new MemoryStore(join(home,"memory"));
try {
  memory.begin("desktop-review"); memory.propose("desktop-review",{key:"demo.review",layer:"core",text:"验收使用真实本地文件。",source:"桌面验收",intent:"user"});
} finally {memory.close();}
const app=await electron.launch({executablePath,args:["--user-data-dir="+join(run,"electron")],env,timeout:60000});
try {
  const page=await app.firstWindow();
  page.setDefaultTimeout(20000);
  const click=name=>page.getByRole("button",{name,exact:true}).click();
  await page.getByRole("textbox",{name:"任务"}).waitFor();
  await click("文件记录"); await page.getByText("+Desktop review acceptance",{exact:true}).waitFor();
  await click("撤销整项修改"); await page.getByRole("dialog").getByRole("button",{name:"撤销修改"}).click();
  await page.getByText("文件修改已撤销",{exact:true}).waitFor();
  assert.deepEqual(await readFile(file),original);
  await click("记忆审阅"); await page.getByRole("heading",{name:"demo.review"}).waitFor();
  await click("接受修改"); await page.getByText("已保存记忆修订",{exact:true}).waitFor();
  const verified=new MemoryStore(join(home,"memory"));
  try {assert.equal(verified.search("本地文件")[0]?.key,"demo.review");} finally {verified.close();}
  await click("设置"); await click("添加来源");
  await page.getByLabel("事件来源").fill("dir:"+await realpath(root));
  await page.getByLabel("免打扰时提醒").check();
  await click("保存提醒规则"); await page.getByText("提醒规则已保存",{exact:true}).waitFor();
  await writeFile(join(root,"desktop-inbox.md"),"Review a local change from the desktop.\n");
  await click("提醒");
  let card=page.getByRole("button",{name:/desktop-inbox\.md/});
  for(let i=0;i<25 && await card.count()===0;i++){
    await new Promise(ok=>setTimeout(ok,300)); await click("刷新");
  }
  await card.first().click(); await click("接受草稿");
  assert.match(await page.getByRole("textbox",{name:"任务"}).inputValue(),/desktop-inbox\.md/);
  console.log(JSON.stringify({fileDiff:true,undoByteIdentical:true,reviewedMemory:true,ruleSaved:true,receivedFileEvent:true,draftInComposer:true}));
} finally {await app.close();}
