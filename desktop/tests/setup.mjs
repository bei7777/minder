import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";

const execute = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [bundle, scenario, previousBundle] = process.argv.slice(2);
assert.ok(bundle && ["existing", "first-run"].includes(scenario), "Pass Minder.app and existing or first-run");
const contents = resolve(bundle, "Contents");
const parent = join(repo, ".minder-dev", "desktop-setup");
await mkdir(parent, {recursive:true});
const area = await mkdtemp(join(parent, "run-"));
const root = join(area, "documents"), temp = join(area, "temp"), home = join(area, "state");
await Promise.all([root,temp].map(path=>mkdir(path)));
const configFile = join(home,"config.json");
const env = {...process.env, TMPDIR:temp, TMP:temp, TEMP:temp, MINDER_HOME:home};
delete env.ELECTRON_RUN_AS_NODE;
const providerFile = await realpath(process.env.MINDER_TEST_PROVIDER_FILE ?? join(repo, "../..", "api-credentials.local.json"));
const providers = JSON.parse(await readFile(providerFile,"utf8")).providers;
const model = providers.dmxapi.models[0].id;
const launchOptions={env,cwd:root,args:["--user-data-dir="+join(area,"profile")],timeout:60_000};
if(scenario==="existing") {
  assert.ok(previousBundle,"Pass the previous Minder 0.1.5 app as the third argument");
  assert.notEqual(await realpath(previousBundle),await realpath(bundle));
  const oldApp=resolve(previousBundle,"Contents","Resources","app");
  assert.equal(JSON.parse(await readFile(join(oldApp,"package.json"),"utf8")).version,"0.1.5");
  const cli=join(oldApp,"node_modules","@minder","cli");
  assert.equal(JSON.parse(await readFile(join(cli,"package.json"),"utf8")).version,"0.1.4");
  await execute(process.execPath,[join(cli,"lib","bin.js"),"init","--root",root,"--provider-file",providerFile,
    "--provider","dmxapi","--model",model,"--no-verify"],{env,cwd:root});
  const previous=await electron.launch({...launchOptions,executablePath:resolve(previousBundle,"Contents","MacOS","Minder")});
  try {
    assert.equal(await previous.evaluate(({app})=>app.getVersion()),"0.1.5");
    const page=await previous.firstWindow();
    await page.getByRole("textbox",{name:"任务"}).waitFor();
    await page.locator("[data-page=settings]").click();
    await page.getByRole("button",{name:/^保存设置/}).click();
    await page.getByRole("textbox",{name:"任务"}).waitFor();
    assert.equal((await page.evaluate(()=>window.minder.status())).model,model);
  } finally {await previous.close();}
}

const app = await electron.launch({...launchOptions,executablePath:join(contents,"MacOS","Minder")});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  async function save() {
    await page.getByRole("button",{name:/^保存(?:设置|并开始对话)/}).click();
    await page.locator("#notice").filter({hasText:/已保存/}).waitFor();
    assert.equal(await page.locator("[data-page][aria-current=page]").getAttribute("data-page"),"chat");
  }
  const prompt = page.locator("#prompt");
  const settings = page.locator("[data-page=settings]");
  if(scenario==="first-run") {
    async function pick(name,path) {
      await page.getByRole("button",{name}).click();
      const script=fileURLToPath(new URL("./setup-picker.applescript",import.meta.url));
      await execute("osascript",[script,String(app.process().pid),path],{env,timeout:20_000});
    }
    await pick(/选择目录/,root);
    await page.getByText(await realpath(root),{exact:true}).waitFor();
    await pick(/选择供应商 JSON/,providerFile);
    await page.getByText(basename(providerFile),{exact:true}).waitFor();
    await page.getByLabel("供应商",{exact:true}).selectOption("dmxapi");
    await page.getByLabel("模型",{exact:true}).selectOption(model);
    await save();
    await prompt.waitFor();
    assert.equal(await prompt.evaluate(element=>element===document.activeElement),true);
    const saved = JSON.parse(await readFile(configFile,"utf8"));
    assert.equal(saved.root,await realpath(root));
    assert.equal(saved.providerFile,providerFile);
    assert.equal(saved.model,model);
    console.log(JSON.stringify({nativeDirectoryPicker:true,nativeProviderPicker:true,firstSaveToChat:true}));
  } else {
    await prompt.fill("继续审阅刚才的文件");
    const originalStat=await stat(configFile,{bigint:true});
    await settings.click();
    await save();
    await prompt.waitFor();
    assert.equal(await prompt.inputValue(),"继续审阅刚才的文件");
    assert.equal(await prompt.evaluate(element=>element===document.activeElement),true);
    assert.equal((await stat(configFile,{bigint:true})).mtimeNs,originalStat.mtimeNs);
    await assert.rejects(page.evaluate(()=>window.minder.openWebLink("file:///etc/hosts")));
    await assert.rejects(page.evaluate(()=>window.minder.openWebLink("https://user@example.com/")));

    const dbFile=join(home,"firewall","state.sqlite");
    await page.evaluate(()=>window.minder.rules());
    const db=new DatabaseSync(dbFile,{readOnly:true});
    let slowest=0, completedDuringIndexing=0;
    try {
      const sourceId="dir:"+await realpath(root);
      const count=db.prepare("SELECT count(DISTINCT external) AS n FROM events WHERE source=? AND external LIKE 'entry-%'");
      const total=4000;
      const entry=await readFile(join(repo,"README.md"));
      for(let first=0;first<total;first+=100)
        await Promise.all(Array.from({length:100},(_,i)=>writeFile(join(root,"entry-"+(first+i)+".md"),entry)));
      const deadline=Date.now()+60_000;
      while(Date.now()<deadline && count.get(sourceId).n<total) {
        const start=performance.now();
        const state=await page.evaluate(()=>window.minder.status());
        slowest=Math.max(slowest,performance.now()-start);
        assert.equal(state.configured,true);
        const indexed=count.get(sourceId).n;
        if(indexed>0 && indexed<total) completedDuringIndexing++;
        await delay(15);
      }
      assert.equal(count.get(sourceId).n,total);
      assert.ok(completedDuringIndexing>=1,"Main-process IPC should respond during SQLite indexing");
      assert.ok(slowest<1500,"IPC response took "+Math.round(slowest)+" ms");
    } finally {db.close();}
    console.log(JSON.stringify({previousDesktop:"0.1.5",previousCli:"0.1.4",existingConfigSaveToChat:true,preservedDraft:true,preservedConfig:true,
      indexedFiles:4000,ipcResponsesDuringIndexing:completedDuringIndexing,slowestIpcMs:Math.round(slowest)}));
  }
} finally {await app.close();}
