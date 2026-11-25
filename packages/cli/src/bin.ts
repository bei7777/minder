#!/usr/bin/env node
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { confirm, input, select } from "@inquirer/prompts";
import { openSnapshot } from "@minder/core-snapshot";
import { MemoryStore } from "@minder/core-memory";
import { Firewall, type Score } from "@minder/core-firewall";
import { atomicJSON, configuration, home, installed, setup, type Config } from "./config.js";
import { chat, openSession, verify } from "./session.js";
import { watch } from "./watch.js";
import { TaskStore, type TaskUpdate } from "./tasks.js";

const version = createRequire(import.meta.url)("../package.json").version as string;

const help = `Minder · 个人助手

minder                        终端工作台
minder init                   配置模型、资料目录并验证工具调用
  --root DIR --provider ollama|deepseek --model ID [--no-verify]
  --root DIR --provider-file FILE --provider ID --model ID [--no-verify]
minder chat | ask TEXT        打开会话或提交一条请求
minder tasks list [--status open|completed] | show ID
minder tasks add TITLE [--next-step TEXT] [--notes TEXT] [--due TIME] [--follow-up TIME]
minder tasks update ID [--revision N] [--title TEXT] [--next-step TEXT] [--notes TEXT] [--due TIME|none] [--follow-up TIME|none]
minder tasks complete ID [--revision N] | check
minder files [ID] | undo ID   查看文件差异、撤销事务
minder memory pending | search TEXT | diff SESSION | commit SESSION [KEY] | discard SESSION [KEY] | history | show ID | revert ID
minder inbox | accept ID REV  查看行动卡，接受草稿并记录回执
minder rules [quiet START END ZONE | source SOURCE SCORE]
minder audit [ID]             查看事件记录、评分依据与等待原因
minder permissions            查看模型、文件、草稿和监听权限
minder watch [--once] [--feed URL ...] [--score-model OLLAMA_MODEL]
minder doctor [--json] | verify

MINDER_HOME 指定私有数据目录。DEEPSEEK_API_KEY 可由环境传入。`;
const safe=(s:string)=>stripVTControlCharacters(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,"");
function output(value:unknown) {
  console.log(typeof value==="string"?safe(value):JSON.stringify(value,null,2));
}
function required(value:string|undefined,name:string) {
  if(!value?.trim()) throw new Error("需要参数 "+name);
  return value;
}
async function files(config:Config,id?:string,undo=false) {
  const manager=await openSnapshot({stateDir:join(home,"snapshot"),roots:[config.root]});
  try {
    if(undo) return await manager.undo(required(id,"事务 ID"));
    return id ? await manager.diff(id) : await manager.list();
  } finally { manager.close(); }
}
async function workbench(config:Config) {
  for(;;) {
    const action=await select({message:"Minder",choices:[
      {value:"chat",name:"对话"},{value:"tasks",name:"跟进委托"},{value:"files",name:"文件差异与撤销"},{value:"memory",name:"审阅记忆"},
      {value:"inbox",name:"行动收件箱"},{value:"rules",name:"提醒规则"},{value:"quit",name:"退出"}
    ]});
    if(action==="quit") return;
    if(action==="chat") { await chat(config); continue; }
    if(action==="tasks") {
      const tasks=new TaskStore(home,config.root);
      try {
        const task=await select({message:"选择委托",choices:[
          ...tasks.list("open").map(t=>({name:safe(t.title)+(t.nextStep?" · "+safe(t.nextStep):""),value:t.id})),
          {name:"创建委托",value:"new"},{name:"返回",value:"back"}]});
        if(task==="back") continue;
        if(task==="new") {
          const title=await input({message:"委托名称"}), nextStep=await input({message:"下一步"});
          const followUpAt=await input({message:"下次跟进时间（含时区的 ISO 时间，可留空）"});
          output(tasks.create({title,nextStep,followUpAt:followUpAt||null}));
        } else {
          const row=tasks.get(task);output(row);
          const action=await select({message:"操作",choices:["返回","修改跟进时间","标记完成"]});
          if(action==="标记完成") output(tasks.complete(row.id,row.revision));
          else if(action==="修改跟进时间") {
            const time=await input({message:"下次跟进时间（含时区的 ISO 时间，留空可取消）"});
            output(tasks.update(row.id,{followUpAt:time||null},row.revision));
          }
        }
      } finally {tasks.close();}
      continue;
    }
    if(action==="files") {
      const store=await openSnapshot({stateDir:join(home,"snapshot"),roots:[config.root]});
      try {
        const rows=await store.list();
        if(!rows.length) { output("尚无文件事务"); continue; }
        const id=await select({message:"选择事务",choices:rows.map(r=>({name:safe(r.label)+" · "+r.status+" · "+r.id,value:r.id}))});
        const diff=await store.diff(id);
        for(const file of diff.files) output(file.patch || file.kind+" "+file.path);
        if(diff.status==="committed" && await confirm({message:"撤销这次文件修改？",default:false})) output(await store.undo(id));
      } finally { store.close(); }
      continue;
    }
    if(action==="memory") {
      const db=new MemoryStore(join(home,"memory"));
      try {
        const sessions=db.pendingSessions();
        if(!sessions.length) { output("没有待审阅的记忆"); continue; }
        const sessionId=await select({message:"选择待审阅会话",choices:sessions.map(s=>({
          name:safe(s.id)+" · "+s.count+" 项",value:s.id
        }))});
        const changes=db.diff(sessionId);
        const keys=[...new Set(changes.map(c=>c.key))];
        const key=await select({message:"选择记忆条目",choices:keys.map(value=>({value,name:safe(value)}))});
        for(const change of changes.filter(c=>c.key===key)) {
          output(change.path+"\n\n原文\n"+(change.before ?? "（新增）")+"\n\n提议\n"+(change.after ?? "（归档）"));
        }
        const review=await select({message:"处理提议",choices:["保留待审","接受修改","拒绝修改"]});
        if(review==="接受修改") output(db.commit(sessionId,[key]));
        if(review==="拒绝修改") output(db.discard(sessionId,key));
      } finally { db.close(); }
      continue;
    }
    const db=new Firewall(join(home,"firewall"));
    const tasks=new TaskStore(home,config.root);
    try {
      if(action==="rules") {
        output(db.settings());
        const sourceId=await input({message:"来源标识（订阅 URL 或 dir:绝对路径）"});
        const score=await select<Score>({message:"优先级",choices:[1,2,3,4,5].map(n=>({value:n as Score,name:String(n)}))});
        output(db.configure({rules:[...db.settings().rules.filter(r=>r.sourceId!==sourceId),{sourceId,score}]}));
      } else {
        const groups=tasks.inbox(db);
        if(!groups.length) { output("目前没有需要处理的提醒"); continue; }
        const group=await select({message:"选择提醒",choices:groups.map(g=>({value:g,name:safe(g.title)+" · "+g.events.length}))});
        const item=group.events.length===1?group.events[0]:await select({message:"选择汇总事项",choices:group.events.map(e=>({name:safe(e.title),value:e}))});
        output(item.title+"\n"+item.summary);
        const draft=item.draftPreviewOnly ? db.get(item.id).action?.text : item.action.text;
        output("草稿\n"+required(draft,"草稿内容"));
        if(await confirm({message:safe(item.action?.label ?? "接受本地草稿")+"？",default:false})) {
          output(tasks.accept(db,item.id,item.revision));
        }
      }
    } finally { tasks.close(); db.close(); }
  }
}
async function main() {
  const {positionals:args,values}=parseArgs({allowPositionals:true,options:{
    help:{type:"boolean",short:"h"},json:{type:"boolean"},root:{type:"string"},model:{type:"string"},
    provider:{type:"string"},"provider-file":{type:"string"},"no-verify":{type:"boolean"},once:{type:"boolean"},feed:{type:"string",multiple:true},
    "score-model":{type:"string"},title:{type:"string"},notes:{type:"string"},"next-step":{type:"string"},
    due:{type:"string"},"follow-up":{type:"string"},revision:{type:"string"},status:{type:"string"}
  }});
  const command=args[0];
  const tty=Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if(values.help || command==="help" || (!command && !tty)) { output(help); return; }
  if(command==="init" || (!command && !await installed())) {
    const cfg=await setup({...values,providerFile:values["provider-file"]},tty);
    if(!values["no-verify"]) {await verify(cfg); cfg.verified=true;}
    await atomicJSON("config.json",cfg);
    output({home,...cfg});
    if(command==="init") return;
  }
  const cfg=await configuration();
  switch(command) {
    case undefined: return workbench(cfg);
    case "chat": return chat(cfg);
    case "ask": return chat(cfg,required(args.slice(1).join(" "),"请求"));
    case "verify":
      await verify(cfg); await atomicJSON("config.json",{...cfg,verified:true}); output("模型工具调用已验证"); return;
    case "doctor": {
      const host=await openSession(cfg);
      try {
        await host.session.bindExtensions({});
        output({version,node:process.version,home,root:cfg.root,model:cfg.model,
          verified:cfg.verified,tools:host.session.getActiveToolNames(),diagnostics:host.diagnostics});
      } finally { await host.dispose(); }
      return;
    }
    case "files": output(await files(cfg,args[1])); return;
    case "undo": output(await files(cfg,args[1],true)); return;
    case "tasks": {
      const tasks=new TaskStore(home,cfg.root);
      try {
        const changes:TaskUpdate={};
        if(values.title!==undefined) changes.title=values.title;
        if(values.notes!==undefined) changes.notes=values.notes;
        if(values["next-step"]!==undefined) changes.nextStep=values["next-step"];
        if(values.due!==undefined) changes.dueAt=values.due==="none"?null:values.due;
        if(values["follow-up"]!==undefined) changes.followUpAt=values["follow-up"]==="none"?null:values["follow-up"];
        switch(args[1]??"list") {
          case "add": output(tasks.create({...changes,title:required(args.slice(2).join(" "),"委托名称")}));break;
          case "list":
            if(values.status!==undefined && values.status!=="open" && values.status!=="completed") throw new Error("未知委托状态");
            output(tasks.list(values.status));break;
          case "show": output(tasks.get(required(args[2],"委托 ID")));break;
          case "update": case "complete": {
            const id=required(args[2],"委托 ID");
            const revision=values.revision===undefined?tasks.get(id).revision:Number(values.revision);
            output(args[1]==="update"?tasks.update(id,changes,revision):tasks.complete(id,revision));break;
          }
          case "check": {
            const firewall=new Firewall(join(home,"firewall"));
            try {output(tasks.inbox(firewall).flatMap(group=>group.events).filter(card=>card.sourceId===tasks.sourceId));}
            finally {firewall.close();}break;
          }
          default: throw new Error("未知的委托命令，请运行 minder --help");
        }
      } finally {tasks.close();}
      return;
    }
    case "watch": return watch(cfg,values.feed ?? [],Boolean(values.once),values["score-model"]);
    case "permissions":
      output({workspace:cfg.root,state:home,modelProvider:cfg.provider,model:cfg.model,
        writes:"受管文件工具，默认写前快照",largeFiles:"需要单独确认不可恢复操作",
        shell:"模型没有 Shell 工具",actionCards:"保存本地草稿和回执",notifications:"本机收件箱",
        feedAccess:"由用户选择订阅来源",background:"minder watch 进程运行期间监听"}); return;
    case "memory": {
      const db=new MemoryStore(join(home,"memory"));
      try {
        switch(args[1]) {
          case "history": output(db.history()); break;
          case "show": output(db.show(required(args[2],"修订标识"))); break;
          case "diff": output(db.diff(required(args[2],"会话标识"))); break;
          case "pending": output(db.pendingSessions()); break;
          case "commit": output(db.commit(required(args[2],"会话标识"),args[3]?[args[3]]:undefined)); break;
          case "discard": output(db.discard(required(args[2],"会话标识"),args[3])); break;
          case "revert": output(db.revert(required(args[2],"修订标识"))); break;
          case "search": output(db.search(required(args.slice(2).join(" "),"检索词"))); break;
          default: throw new Error("未知的记忆命令");
        }
      } finally { db.close(); }
      return;
    }
    case "rules": case "inbox": case "accept": case "audit": {
      const db=new Firewall(join(home,"firewall"));
      try {
        if(command==="audit") output(args[1]?db.explain(args[1]):db.list().map(e=>({id:e.id,source:e.sourceId,title:e.title,score:e.score,status:e.status,reason:e.reason})));
        else if(command==="inbox" || command==="accept") {
          const tasks=new TaskStore(home,cfg.root);
          try {output(command==="inbox"?tasks.inbox(db):tasks.accept(db,required(args[1],"卡片标识"),required(args[2],"修订标识")));}
          finally {tasks.close();}
        }
        else if(args[1]==="quiet") output(db.configure({quietStart:required(args[2],"开始时间"),quietEnd:required(args[3],"结束时间"),timezone:required(args[4],"时区")}));
        else if(args[1]==="source") {
          const sourceId=required(args[2],"来源");
          output(db.configure({rules:[...db.settings().rules.filter(r=>r.sourceId!==sourceId),{sourceId,score:Number(args[3]) as Score}]}));
        } else if(args[1]) throw new Error("未知的规则命令");
        else output(db.settings());
      } finally { db.close(); }
      return;
    }
    default: throw new Error("未知命令，请运行 minder --help");
  }
}
main().catch(error=>{console.error(safe(error instanceof Error?error.message:String(error)));process.exitCode=1;});
