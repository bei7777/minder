import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, symlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";

const repo=fileURLToPath(new URL("../../",import.meta.url));
const execute=promisify(execFile);
const lifecycle=fileURLToPath(new URL("./lifecycle.applescript",import.meta.url));
const parent=join(repo,".minder-dev","desktop-tasks");
await mkdir(parent,{recursive:true});
const run=await mkdtemp(join(parent,"run-"));
const work=join(run,"documents"), temp=join(run,"temp");
await Promise.all([mkdir(work),mkdir(temp)]);
const env={...process.env,MINDER_HOME:join(run,"home"),TMPDIR:temp,TMP:temp,TEMP:temp};
delete env.ELECTRON_RUN_AS_NODE;

const bundle=process.argv[2];
let appRoot, executablePath, args;
if(bundle) {
  const contents=resolve(bundle,"Contents");
  executablePath=join(contents,"MacOS","Minder");
  appRoot=join(contents,"Resources","app");
  args=[];
} else {
  appRoot=join(run,"app");
  await mkdir(join(appRoot,"node_modules","@minder"),{recursive:true});
  await Promise.all(["package.json","lib","ui"].map(name=>cp(join(repo,"desktop",name),join(appRoot,name),{recursive:true})));
  await symlink(join(repo,"packages","cli"),join(appRoot,"node_modules","@minder","cli"),"dir");
  executablePath=join(repo,"desktop","node_modules","electron","dist","Electron.app","Contents","MacOS","Electron");
  args=[appRoot];
}
args.push("--user-data-dir="+join(run,"profile"));
const providerFile=await realpath(env.MINDER_TEST_PROVIDER_FILE ?? join(repo,"../..","api-credentials.local.json"));
const external=JSON.parse(await readFile(providerFile,"utf8")).providers.dmxapi;
const cli=join(appRoot,"node_modules","@minder","cli","lib","bin.js");
const runCli=(...argv)=>execute(process.execPath,[cli,...argv],{env,cwd:work});
await runCli("init","--root",work,"--provider-file",providerFile,
  "--provider","dmxapi","--model",external.models[0].id,"--no-verify");

let app, page;
const button=name=>page.getByRole("button",{name,exact:true});
const title="投稿材料跟进 "+basename(run), step="核对投稿材料清单";
function localInput(date) {
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,-1);
}
async function open() {
  app=await electron.launch({executablePath,args,env,cwd:work,timeout:60_000});
  page=await app.firstWindow();page.setDefaultTimeout(35_000);
  await page.getByRole("textbox",{name:"任务"}).waitFor();
}
async function close() { if(app) {await app.close();app=undefined;} }
async function nativeCommand(operation) {
  await execute("/usr/bin/osascript",[lifecycle,String(app.process().pid),operation],{env,timeout:15_000});
}
async function waitFor(check,description) {
  const deadline=Date.now()+35_000;
  while(Date.now()<deadline) {if(await check()) return;await delay(200);}
  assert.fail(description);
}
async function settings() {
  await button("设置").click();await button("内置能力").click();
  const desktopVersion=JSON.parse(await readFile(join(appRoot,"package.json"),"utf8")).version;
  const cliVersion=JSON.parse(await readFile(join(appRoot,"node_modules","@minder","cli","package.json"),"utf8")).version;
  await page.getByText("桌面版 "+desktopVersion+(bundle?"":"（开发环境）")+" · CLI "+cliVersion,{exact:true}).waitFor();
  await button("提醒规则").click();
  await page.getByLabel("免打扰开始").fill("00:00");
  await page.getByLabel("免打扰结束").fill("00:00");
  await button("保存提醒规则").click();
  await page.getByText("提醒规则已保存",{exact:true}).waitFor();
}
async function create(name,when) {
  await button("新建委托").click();
  const editor=page.getByRole("dialog");
  await editor.getByLabel("委托名称").fill(name);
  await editor.getByLabel("下一步").fill(step);
  await editor.getByLabel("跟进时间").fill(localInput(when));
  await editor.getByLabel("截止时间").fill(localInput(new Date(Date.now()+86_400_000)));
  await editor.getByRole("button",{name:"创建委托"}).click();
  await page.getByRole("heading",{name,exact:true}).waitFor();
}

try {
  await open();await settings();
  await button("委托").click();
  await create(title,new Date(Date.now()+6000));
  const nativeWindow=await app.browserWindow(page);
  await nativeCommand("close-window");
  assert.equal(await nativeWindow.evaluate(win=>win.isVisible()),false);
  const events=new DatabaseSync(join(env.MINDER_HOME,"firewall","state.sqlite"),{readOnly:true});
  const tasks=new DatabaseSync(join(env.MINDER_HOME,"tasks","tasks.sqlite"),{readOnly:true});
  let claims,nativeInHistory;
  try {
    const due=events.prepare("SELECT id FROM events WHERE json_extract(body,'$.kind')='task:follow-up' AND status='ready'");
    await waitFor(()=>due.get(),"The resident worker did not deliver the due follow-up");
    assert.equal(await nativeWindow.evaluate(win=>win.isVisible()),false);
    const supported=await app.evaluate(({Notification})=>Notification.isSupported());
    const count=tasks.prepare("SELECT COUNT(*) AS n FROM native_notifications");
    if(supported) await waitFor(()=>count.get().n===1,"The worker did not claim the immediate notification");
    claims=count.get().n;
    assert.equal(claims,Number(supported));
    const identifier="minder-task-"+due.get().id;
    nativeInHistory=false;
    for(let attempt=0;supported && attempt<12 && !nativeInHistory;attempt++) {
      const ids=await app.evaluate(async({Notification})=>(await Notification.getHistory()).map(notice=>notice.id));
      nativeInHistory=ids.includes(identifier);
      if(!nativeInHistory) await delay(250);
    }
  } finally {events.close();tasks.close();}
  await execute("/usr/bin/open",["-a",resolve(executablePath,"../../..")],{env});
  await waitFor(()=>nativeWindow.evaluate(win=>win.isVisible()),"Launch Services did not restore the resident window");
  await nativeWindow.dispose();
  await page.locator("#inbox-count").filter({hasText:/^1$/}).waitFor();
  await button("提醒").click();
  await page.getByRole("heading",{name:new RegExp(title)}).waitFor();
  await page.getByText(new RegExp(step)).waitFor();
  await button("委托").click();await button("编辑委托").click();
  await page.getByLabel("跟进时间").fill(localInput(new Date(Date.now()+3_600_000)));
  await button("保存更改").click();await page.getByText("委托已更新",{exact:true}).waitFor();
  await button("提醒").click();await page.getByRole("heading",{name:"目前没有需要处理的提醒"}).waitFor();

  const offlineTitle="重启后检查投稿附件", when=new Date(Date.now()+5000);
  await button("委托").click();await create(offlineTitle,when);
  const quit=app.waitForEvent("close",{timeout:25_000});
  await nativeCommand("command-q");
  await quit;app=undefined;
  await delay(Math.max(0,when.getTime()-Date.now())+100);
  await open();await page.locator("#inbox-count").filter({hasText:/^1$/}).waitFor();
  const existingDraft="请同时核对修订后的材料。";
  await page.getByRole("textbox",{name:"任务"}).fill(existingDraft);
  await button("提醒").click();await page.getByRole("heading",{name:new RegExp(offlineTitle)}).waitFor();
  await button("接受草稿").click();
  const combined=await page.getByRole("textbox",{name:"任务"}).inputValue();
  assert.ok(combined.startsWith(existingDraft) && combined.includes(offlineTitle));
  await button("委托").click();
  await page.getByRole("button",{name:new RegExp(offlineTitle)}).click();
  await button("标记完成").click();await button("确认完成").click();
  await page.getByText("委托已完成",{exact:true}).waitFor();
  await close();await open();await button("委托").click();await button("已完成").click();
  await page.getByRole("heading",{name:offlineTitle,exact:true}).waitFor();
  await page.getByText(step,{exact:true}).waitFor();
  await button("提醒").click();await page.getByRole("heading",{name:"目前没有需要处理的提醒"}).waitFor();
  await close();

  const quietTitle="静默时段前已经投递的委托";
  await runCli("tasks","add",quietTitle,"--follow-up",new Date().toISOString());
  const cards=JSON.parse((await runCli("inbox")).stdout).flatMap(group=>group.events);
  const quietId=cards.find(card=>card.title.includes(quietTitle)).id;
  const clock=offset=>new Date(Date.now()+offset*3_600_000).toISOString().slice(11,16);
  await runCli("rules","quiet",clock(-3),clock(3),"UTC");
  await open();await button("提醒").click();await page.getByRole("heading",{name:new RegExp(quietTitle)}).waitFor();
  const quietDb=new DatabaseSync(join(env.MINDER_HOME,"tasks","tasks.sqlite"),{readOnly:true});
  const gate=new DatabaseSync(join(env.MINDER_HOME,"firewall","state.sqlite"),{readOnly:true});
  try {
    await waitFor(()=>gate.prepare("SELECT owner FROM lease WHERE id=1 AND owner IS NOT NULL").get(),"No worker after restart");
    assert.equal(quietDb.prepare("SELECT eventId FROM native_notifications WHERE eventId=?").get(quietId),undefined);
    await runCli("rules","quiet","00:00","00:00","UTC");
    if(claims) await waitFor(()=>quietDb.prepare("SELECT eventId FROM native_notifications WHERE eventId=?").get(quietId),"The postponed notice was not claimed");
  } finally {quietDb.close();gate.close();}
  console.log(JSON.stringify({created:true,hiddenWindowReminder:true,nativeNotificationClaims:claims,
    nativeNotificationInHistory:nativeInHistory,quietReadyStayedInInbox:true,
    launchServicesReopen:true,commandQuit:true,rescheduled:true,withdrawn:true,restartCatchup:true,
    acceptedDraft:true,completedAfterRestart:true,duplicateCards:0}));
} finally {await close();}
