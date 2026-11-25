import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Firewall } from "@minder/core-firewall";
import { TaskStore } from "../lib/tasks.js";

const exec=promisify(execFile);
const bin=fileURLToPath(new URL("../lib/bin.js",import.meta.url));
const parent=resolve(".minder-dev","task-checks");
await mkdir(parent,{recursive:true});

test("委托持久化、两个时间点去重、跨工作区隔离、完成和改期",async()=>{
  const dir=await mkdtemp(join(parent,"session-")),home=join(dir,"state"),root=join(dir,"papers"),other=join(dir,"notes");
  await Promise.all([mkdir(root),mkdir(other)]);
  const earlier=new Date(Date.now()-120_000).toISOString(),later=new Date(Date.now()+86400_000).toISOString();
  let store=new TaskStore(home,root);
  const alternate=new TaskStore(home,other),fw=new Firewall(join(home,"firewall"));
  try {
    fw.configure({quietStart:"00:00",quietEnd:"00:00",cooldownMinutes:0});
    const input={title:"跟进投稿",notes:"看一下附件",nextStep:"检查补充材料",dueAt:later,followUpAt:earlier};
    const task=store.create(input,"session-and-message");
    assert.equal(store.create(input,"session-and-message").id,task.id);
    assert.throws(()=>store.create({...input,followUpAt:"2026-11-25T09:00:00"}),/时区/);
    assert.throws(()=>store.create({...input,followUpAt:"2026-02-30T09:00:00Z"}),/无效/);
    assert.throws(()=>alternate.get(task.id),/当前资料目录/);
    assert.deepEqual(alternate.list(),[]);
    store.close(); store=new TaskStore(home,root);
    assert.deepEqual(store.get(task.id),task);
    assert.equal(store.dispatchDue(fw),1); assert.equal(store.dispatchDue(fw),0);
    let first=store.inbox(fw)[0].events[0];
    assert.match(first.title,/跟进投稿/);
    assert.match(first.action.text,new RegExp(task.id));
    assert.deepEqual(alternate.claimNotifications(fw),[]);
    assert.deepEqual(store.claimNotifications(fw).map(item=>item.id),[first.id]);
    store.close(); store=new TaskStore(home,root);
    assert.deepEqual(store.claimNotifications(fw),[]);
    assert.deepEqual(alternate.inbox(fw),[]);
    assert.throws(()=>alternate.accept(fw,first.id,first.revision),/其他资料目录/);
    const rescheduled=store.update(task.id,{followUpAt:later},1);
    assert.equal(rescheduled.revision,2); assert.deepEqual(store.inbox(fw),[]);
    assert.equal(fw.get(first.id).status,"superseded");
    assert.throws(()=>store.accept(fw,first.id,first.revision),/失效/);
    assert.throws(()=>store.update(task.id,{notes:"过时的客户端"},1),/重新查看/);
    const revised=store.update(task.id,{followUpAt:earlier,dueAt:earlier},2);
    const cards=store.inbox(fw).flatMap(g=>g.events);
    assert.equal(cards.length,1);assert.match(cards[0].title,/委托已到期/);
    assert.match(store.accept(fw,cards[0].id,cards[0].revision).text,/当前进度/);
    assert.equal(store.list("open").length,1);
    const done=store.complete(task.id,revised.revision);
    assert.deepEqual(store.complete(task.id,revised.revision),done);
    assert.equal(done.status,"completed");
    assert.deepEqual(store.list("open"),[]);assert.equal(store.list("completed").length,1);
    assert.deepEqual(store.inbox(fw),[]);assert.throws(()=>store.update(task.id,{title:"修改"},done.revision),/完成/);
    const another=store.create({title:"检查租约",dueAt:earlier});
    const before=store.inbox(fw).flatMap(g=>g.events);
    assert.equal(before.length,1);
    store.complete(another.id,1);
    assert.deepEqual(store.inbox(fw),[]);
    assert.equal(fw.get(before[0].id).status,"superseded");
  } finally {store.close();alternate.close();fw.close();}
});

test("免打扰时保留待派发的委托，静默时段结束后只通知一次",async()=>{
  const dir=await mkdtemp(join(parent,"quiet-")),home=join(dir,"state");
  const store=new TaskStore(home,dir),fw=new Firewall(join(home,"firewall"));
  try {
    const now=Date.now(), clock=ms=>new Date(ms).toISOString().slice(11,16);
    fw.configure({quietStart:clock(now-120000),quietEnd:clock(now+120000),timezone:"UTC"});
    store.create({title:"确认会议时间",dueAt:new Date(now-1000).toISOString()});
    assert.deepEqual(store.inbox(fw),[]);assert.deepEqual(store.claimNotifications(fw),[]);
    assert.equal(fw.list("pending").length,1);
    fw.configure({quietStart:"00:00",quietEnd:"00:00"});
    assert.equal(store.inbox(fw)[0].events.length,1);assert.equal(store.claimNotifications(fw).length,1);
    assert.equal(store.claimNotifications(fw).length,0);
  } finally {store.close();fw.close();}
});

test("真实 CLI 重启和并发检查只产生一张提醒",async()=>{
  const dir=await mkdtemp(join(parent,"cli-")),root=join(dir,"documents"),home=join(dir,"state");
  await mkdir(root);
  const env={...process.env,MINDER_HOME:home};
  const cli=async(...args)=>JSON.parse((await exec(process.execPath,[bin,...args],{cwd:root,env})).stdout);
  await cli("init","--root",await realpath(root),"--provider","ollama","--model","local","--no-verify");
  await cli("rules","quiet","00:00","00:00","UTC");
  const due=new Date(Date.now()-60000).toISOString();
  const item=await cli("tasks","add","准备答辩","--due",due,"--next-step","检查材料");
  assert.equal((await cli("tasks","show",item.id)).nextStep,"检查材料");
  const reads=await Promise.all([cli("tasks","check"),cli("tasks","check")]);
  assert.equal(reads[0][0].id,reads[1][0].id);
  assert.equal((await cli("audit")).filter(e=>e.status==="ready").length,1);
  await cli("tasks","update",item.id,"--revision","1","--due","none");
  assert.deepEqual(await cli("inbox"),[]);
  await cli("tasks","complete",item.id);
  assert.equal((await cli("tasks","list","--status","completed"))[0].id,item.id);
});
