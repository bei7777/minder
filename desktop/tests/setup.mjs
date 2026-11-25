import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";

const execute = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [bundle, scenario] = process.argv.slice(2);
assert.ok(bundle && ["existing", "first-run"].includes(scenario), "Pass Minder.app and existing or first-run");
const contents = resolve(bundle, "Contents");
const cli = join(contents, "Resources", "app", "node_modules", "@minder", "cli");
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
if(scenario==="existing") {
  assert.equal(JSON.parse(await readFile(join(cli,"package.json"),"utf8")).version,"0.1.4");
  await execute(process.execPath,[join(cli,"lib","bin.js"),"init","--root",root,"--provider-file",providerFile,
    "--provider","dmxapi","--model",model,"--no-verify"],{env,cwd:root});
}

const app = await electron.launch({executablePath:join(contents,"MacOS","Minder"),env,cwd:root,
  args:["--user-data-dir="+join(area,"profile")],timeout:60_000});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const save = () => page.getByRole("button",{name:/^保存(?:设置|并开始对话)/}).click();
  const prompt = page.locator("#prompt");
  const settings = page.locator("[data-page=settings]");
  if(scenario==="first-run") {
    async function pick(name,path) {
      await page.getByRole("button",{name}).click();
      const script=fileURLToPath(new URL("./setup-picker.applescript",import.meta.url));
      await execute("osascript",[script,String(app.process().pid),path],{env,timeout:20_000});
    }
    await pick(/选择目录/,root);
    await pick(/选择供应商 JSON/,providerFile);
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
    console.log(JSON.stringify({existing014SaveToChat:true,preservedDraft:true,preservedConfig:true,
      indexedFiles:4000,ipcResponsesDuringIndexing:completedDuringIndexing,slowestIpcMs:Math.round(slowest)}));
  }
} finally {await app.close();}
