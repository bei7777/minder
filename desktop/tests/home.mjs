import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";

const repo=fileURLToPath(new URL("../../",import.meta.url));
assert.ok(process.argv[2],"Pass a packaged Minder.app");
const bundle=resolve(process.argv[2],"Contents"), execute=promisify(execFile);
const parent=join(repo,".minder-dev","desktop-home");
await mkdir(parent,{recursive:true});
const run=await mkdtemp(join(parent,"run-"));
const a=join(run,"论文资料"), b=join(run,"旅行计划"), temp=join(run,"temp");
await Promise.all([a,b,temp].map(path=>mkdir(path)));
const env={...process.env,MINDER_HOME:join(run,"home"),TMPDIR:temp,TMP:temp,TEMP:temp};
delete env.ELECTRON_RUN_AS_NODE;
const cli=join(bundle,"Resources","app","node_modules","@minder","cli","lib","bin.js");
const runCli=(...args)=>execute(process.execPath,[cli,...args],{env,cwd:a});
const provider=await realpath(env.MINDER_TEST_PROVIDER_FILE??join(repo,"../..","api-credentials.local.json"));
const model=JSON.parse(await readFile(provider,"utf8")).providers.dmxapi.models[0].id;
await runCli("init","--root",a,"--provider-file",provider,"--provider","dmxapi","--model",model,"--no-verify");
const quiet=offset=>new Date(Date.now()+offset*3_600_000).toISOString().slice(11,16);
await runCli("rules","quiet",quiet(-3),quiet(3),"UTC");

let app,page;
const button=name=>page.getByRole("button",{name,exact:true});
const cards=()=>page.locator("#home-followups button");
const prompt=()=>page.getByRole("textbox",{name:"任务"});
const at=offset=>new Date(Date.now()+offset*3_600_000).toISOString();
async function open() {
  app=await electron.launch({executablePath:join(bundle,"MacOS","Minder"),env,cwd:a,
    args:["--user-data-dir="+join(run,"profile")],timeout:60_000});
  page=await app.firstWindow();page.setDefaultTimeout(35_000);await prompt().waitFor();
}
async function close() {if(app){await app.close();app=undefined;}}
async function order(expected) {
  await page.waitForFunction(titles=>JSON.stringify(Array.from(document.querySelectorAll("#home-followups button strong"),row=>row.textContent))===JSON.stringify(titles),expected);
}
async function switchRoot(root) {
  await button("设置").click();
  await page.getByRole("button",{name:/选择目录/}).click();
  const picker=fileURLToPath(new URL("./setup-picker.applescript",import.meta.url));
  await execute("/usr/bin/osascript",[picker,String(app.process().pid),root],{env,timeout:20_000});
  await page.getByText(await realpath(root),{exact:true}).waitFor();
  await button("保存设置").click();await prompt().waitFor();
  assert.equal(await page.locator("#workspace-name").getAttribute("title"),await realpath(root));
}
try {
  await open();
  assert.equal(await page.locator("#home-followups").isHidden(),true);
  const inputs=[
    {title:"了解文献",nextStep:"核对参考文献"},
    {title:"归档批注",dueAt:at(12)},
    {title:"审阅方法",nextStep:"列出待确认的参数",followUpAt:at(4),dueAt:at(20)},
    {title:"处理校样",dueAt:at(-1),nextStep:"联系编辑确认页码"},
  ];
  const tasks=await page.evaluate(async items=>{
    const result=[];for(const item of items) result.push(await window.minder.createTask(item));return result;
  },inputs);
  await order(["处理校样","审阅方法","归档批注"]);
  assert.ok((await cards().first().textContent()).includes("联系编辑确认页码"));
  const draft="请同时核对卷号。";
  await prompt().fill(draft);
  const previousPrompt=await prompt().elementHandle();await button("新对话").click();
  await page.waitForFunction(node=>!node.isConnected,previousPrompt);await previousPrompt.dispose();
  await order(["处理校样","审阅方法","归档批注"]);
  assert.equal(await prompt().inputValue(),draft);
  await button("继续跟进 审阅方法").click();
  await page.waitForFunction(id=>document.querySelector("#prompt")?.value.includes(id),tasks[2].id);
  const combined=await prompt().inputValue();
  assert.ok(combined.startsWith(draft) && combined.includes(tasks[2].id) && combined.includes("列出待确认的参数"));
  assert.equal(await prompt().evaluate(node=>node===document.activeElement),true);
  assert.equal(await page.locator(".message").count(),0);

  await button("委托").click();
  await page.getByRole("button",{name:/处理校样/}).click();await button("标记完成").click();await button("确认完成").click();
  await page.getByText("委托已完成",{exact:true}).waitFor();
  await button("对话").click();await order(["审阅方法","归档批注","了解文献"]);
  await runCli("tasks","complete",tasks[1].id);
  await order(["审阅方法","了解文献"]);assert.equal(await prompt().inputValue(),combined);
  await page.evaluate(()=>{
    document.querySelector("[data-page=chat]").click();
    document.querySelector("[data-page=files]").click();
  });
  await page.getByRole("heading",{name:"尚无文件修改"}).waitFor();
  assert.equal(await cards().count(),0);
  await switchRoot(b);assert.equal(await prompt().inputValue(),"");
  await page.evaluate(()=>window.minder.createTask({title:"预订车票",nextStep:"确认出行日期"}));
  await order(["预订车票"]);await prompt().fill("查询车次");
  await switchRoot(a);await order(["审阅方法","了解文献"]);assert.equal(await prompt().inputValue(),combined);
  await switchRoot(b);await order(["预订车票"]);assert.equal(await prompt().inputValue(),"查询车次");
  await close();await open();await order(["预订车票"]);
  await switchRoot(a);await order(["审阅方法","了解文献"]);
  console.log(JSON.stringify({rankedTopThree:true,draftPreserved:true,focusInComposer:true,manualSend:true,
    completedHidden:true,externallyCompletedHidden:true,workspaceIsolation:true,persistedAfterRestart:true,concurrentNavigation:true}));
} finally {await close();}
