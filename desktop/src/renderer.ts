import type { DesktopStatus, MemoryChange, ProviderChoice, Rules } from "./contracts.js";

const api = window.minder;
const pages = {chat:"对话",files:"文件记录",memory:"记忆审阅",inbox:"提醒",settings:"设置"};
type Page = keyof typeof pages;
type Turn = {role:"user"|"assistant"; text:string; tools:string[]};
function byId<T extends HTMLElement>(id:string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error("界面缺少元素 "+id);
  return element as T;
}
function el<K extends keyof HTMLElementTagNameMap>(tag:K, value="", className="") {
  const element = document.createElement(tag);
  if (value) element.textContent=value;
  if (className) element.className=className;
  return element;
}
const view=byId("content"), actions=byId("actions"), notice=byId("notice");
let page:Page="chat", generation=0;
let status:DesktopStatus, sending=false, draft="", activeTurn:Turn|undefined;
const turns:Turn[]=[];
let nextDetail=0;
function inform(message:string, failure=false) {
  notice.textContent=message; notice.hidden=!message; notice.classList.toggle("error",failure);
}
function report(err:unknown) { inform(err instanceof Error ? err.message : String(err),true); }
function button(text:string, handler:()=>void|Promise<void>, primary=false) {
  const b=el("button",text,primary?"primary":""); b.type="button";
  b.addEventListener("click",async()=>{
    b.disabled=true;
    try { await handler(); } catch(err) { report(err); } finally { b.disabled=false; }
  });
  return b;
}
function field(text:string, input:HTMLElement) {
  const label=el("label","","field"); label.append(el("span",text),input); return label;
}
function blank(heading:string, details:string) {
  const section=el("div","","blank"); section.append(el("h2",heading),el("p",details)); return section;
}
function stack(className="stack") { return el("div","",className); }
function choose(label:string, choices:string[], selected:string) {
  const select=el("select"); select.setAttribute("aria-label",label);
  for(const item of choices) select.add(new Option(item,item,false,selected===item));
  return select;
}
function localTime(value:number|string) { return new Date(value).toLocaleString("zh-CN",{hour12:false}); }
function nameOf(path:string) { return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path; }
function confirmAction(title:string, copy:string, verb:string):Promise<boolean> {
  const dialog=byId<HTMLDialogElement>("confirm-dialog");
  byId("dialog-title").textContent=title; byId("dialog-copy").textContent=copy; byId("dialog-yes").textContent=verb;
  dialog.returnValue="cancel";
  return new Promise(ok=>{ dialog.addEventListener("close",()=>ok(dialog.returnValue==="confirm"),{once:true}); dialog.showModal(); });
}
function refreshSidebar() {
  byId("workspace-name").textContent=status?.root ? nameOf(status.root) : "尚未选择资料目录";
  byId("workspace-name").title=status?.root ?? "";
}
async function navigate(target:Page) {
  const id=++generation;
  page=target; ++nextDetail;
  byId("title").textContent=pages[page]; actions.replaceChildren(); view.replaceChildren();
  view.className=target==="chat"?"chat":"";
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach(b=>{
    if(b.dataset.page===target) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current");
  });
  if(!status.configured && target!=="settings") {
    const empty=blank("选择资料目录和模型","完成设置后，即可在本机开始对话并审阅修改。");
    empty.append(button("打开设置",()=>navigate("settings"),true)); view.append(empty); return;
  }
  const current=()=>id===generation;
  if(target==="chat") renderChat();
  if(target==="files") await renderFiles(current);
  if(target==="memory") await renderMemory(current);
  if(target==="inbox") await renderInbox(current);
  if(target==="settings") await renderSettings(current);
}
function displayTurns() {
  const log=document.getElementById("chat-log");
  if(!log) return;
  const following=log.scrollHeight-log.clientHeight-log.scrollTop<72;
  if(!turns.length) { log.replaceChildren(blank("想在这个目录里做什么？",status.root)); return; }
  // 只刷新当前回答，保留前面消息的文本选择与滚动位置。
  if(!log.firstElementChild?.classList.contains("message")) log.replaceChildren();
  for(let n=Math.max(0,log.children.length-1);n<turns.length;n++) {
    const turn=turns[n]!;
    const item=el("article","","message "+turn.role);
    item.append(el("h3",turn.role==="user"?"你":"Minder"),el("p",turn.text || (sending?"正在处理…":"")));
    for(const tool of turn.tools) item.append(el("div",tool,"tool-line"));
    const existing=log.children[n];
    if(existing) existing.replaceWith(item); else log.append(item);
  }
  if(following) log.scrollTop=log.scrollHeight;
}
function renderChat() {
  view.replaceChildren(); actions.replaceChildren();
  const fresh=button("新对话",async()=>{
    await api.newChat(); turns.length=0; draft=""; activeTurn=undefined; await navigate("chat");
  });
  fresh.disabled=sending; actions.append(fresh);
  const log=el("div","","chat-log"); log.id="chat-log"; log.setAttribute("aria-label","对话记录");
  const box=el("div","","composer"), text=el("textarea");
  text.id="prompt"; text.placeholder="输入任务…"; text.setAttribute("aria-label","任务"); text.value=draft;
  text.addEventListener("input",()=>{draft=text.value;});
  const send=async()=>{
    if(sending || !draft.trim()) return;
    const prompt=draft.trim(); draft=""; sending=true; inform("");
    turns.push({role:"user",text:prompt,tools:[]});
    const response:Turn={role:"assistant",text:"",tools:[]}; activeTurn=response; turns.push(response);
    renderChat();
    try { await api.send(prompt); }
    catch(err) { report(err); if(!response.text) response.text="本次对话已结束。"; }
    finally { sending=false; activeTurn=undefined; if(page==="chat"){ renderChat(); byId("prompt").focus(); } }
  };
  text.onkeydown=e=>{if(!e.isComposing && (e.metaKey||e.ctrlKey)&&e.key==="Enter"){e.preventDefault();void send();}};
  const row=stack("action-row");
  row.append(el("span",status.model+" · ⌘ Return","hint"),
    sending?button("停止生成",()=>api.cancel()):button("发送",send,true));
  box.append(text,row); view.append(log,box); displayTurns();
}
function patch(text:string) {
  const block=el("div","","patch");
  for(const line of text.split("\n")) block.append(el("span",line,line.startsWith("+")&&!line.startsWith("+++")?"addition":line.startsWith("-")&&!line.startsWith("---")?"deletion":""));
  return block;
}
function listDetail<T>(items:T[], caption:(item:T)=>[string,string], render:(item:T,panel:HTMLElement)=>Promise<void>) {
  const layout=stack("review-layout"), list=stack("records"), detail=stack("sheet");
  layout.append(list,detail); view.append(layout);
  async function select(item:T, b:HTMLButtonElement) {
    const request=++nextDetail;
    for(const row of list.querySelectorAll("button")) row.setAttribute("aria-pressed",String(row===b));
    const panel=stack("stack");
    try { await render(item,panel); if(request===nextDetail && detail.isConnected) detail.replaceChildren(panel); }
    catch(err) { if(request===nextDetail) report(err); }
  }
  for(const item of items) {
    const [heading,meta]=caption(item), b=button("",()=>select(item,b)); b.className="record";
    b.append(el("strong",heading),el("small",meta)); list.append(b);
    if(list.childElementCount===1) void select(item,b);
  }
}
function refreshButton() { actions.append(button("刷新",()=>navigate(page))); }
const transactionNames:Record<string,string>={committed:"已提交",undone:"已撤销",aborted:"已放弃",staging:"正在暂存",committing:"正在提交",undoing:"正在撤销"};
async function renderFiles(current:()=>boolean) {
  refreshButton(); const rows=await api.files(); if(!current()) return;
  if(!rows.length){view.append(blank("尚无文件修改","助手通过受管工具完成的修改会出现在这里。"));return;}
  listDetail(rows,r=>[r.label,localTime(r.createdAt)+" · "+(transactionNames[r.status]??r.status)],async(r,panel)=>{
    const diff=await api.diff(r.id);
    panel.append(el("h2",r.label),el("div",localTime(r.createdAt),"stamp"));
    for(const f of diff.files) panel.append(el("h3",f.path,"record-title"),patch(f.patch||f.kind));
    if(diff.status==="committed") panel.append(button("撤销整项修改",async()=>{
      if(!await confirmAction("撤销这项事务？","将检查并恢复这次修改涉及的 "+diff.files.length+" 个文件。","撤销修改")) return;
      await api.undo(r.id); inform("文件修改已撤销"); await navigate("files");
    }));
  });
}
function memoryEntry(change:MemoryChange) {
  const section=stack(); section.append(el("h3",change.path,"record-title"));
  if(change.before!==null) section.append(el("small","原文","stamp"),el("p",change.before,"body-text"));
  if(change.after!==null) section.append(el("small","提案","stamp"),el("p",change.after,"body-text"));
  else section.append(el("p","提议归档这份记忆。")); return section;
}
async function renderMemory(current:()=>boolean) {
  refreshButton(); const sessions=await api.pending(); if(!current()) return;
  if(!sessions.length){view.append(blank("没有待审阅的记忆","助手提出的新事实和会话摘要将在这里等待确认。"));return;}
  listDetail(sessions,s=>[localTime(s.started),s.count+" 项待审阅"],async(s,panel)=>{
    const changes=await api.memoryDiff(s.id);
    for(const key of new Set(changes.map(c=>c.key))) {
      const section=stack("sheet"); section.append(el("h2",key,"record-title"));
      for(const change of changes.filter(c=>c.key===key)) section.append(memoryEntry(change));
      const row=stack("action-row");
      for(const [label,accept] of [["接受修改",true],["放弃提案",false]] as const) {
        row.append(button(label,async()=>{await api.review(s.id,key,accept);inform(accept?"已保存记忆修订":"已放弃这项提案");await navigate("memory");},accept));
      }
      section.append(row); panel.append(section);
    }
  });
}
async function renderInbox(current:()=>boolean) {
  refreshButton(); const groups=await api.inbox(); if(!current()) return;
  const records=groups.flatMap(g=>g.events.map(card=>({group:g.title,card})));
  if(!records.length){view.append(blank("目前没有需要处理的提醒","达到提醒条件的目录事件和订阅会出现在这里。"));return;}
  listDetail(records,r=>[r.card.title,r.card.score+" 分 · "+r.group],async({card},panel)=>{
    panel.append(el("h2",card.title),el("p",card.summary,"body-text"),el("div",card.sourceId,"readout"),
      el("h3",card.action.label),el("p",card.action.text,"body-text"));
    panel.append(button("接受草稿",async()=>{
      const receipt=await api.accept(card.id,card.revision);
      draft=receipt.text; inform("草稿已放入对话输入框，请审阅后发送。"); await navigate("chat");
    },true));
  });
}

function rulesEditor(rules:Rules) {
  const section=stack("sheet"); section.append(el("h2","提醒规则"));
  const columns=stack("columns"), start=el("input"), end=el("input"), zone=el("input");
  start.type=end.type="time"; start.value=rules.quietStart; end.value=rules.quietEnd; zone.value=rules.timezone;
  columns.append(field("免打扰开始",start),field("免打扰结束",end)); section.append(columns,field("时区",zone));
  const list=stack("stack");
  function addRule(source="",score=5,bypass=false) {
    const line=stack("rule-row"), name=el("input"), priority=el("select"), urgent=el("input");
    name.value=source; name.placeholder="dir:目录绝对路径 或订阅 URL"; name.setAttribute("aria-label","事件来源");
    priority.setAttribute("aria-label","优先级"); for(let n=1;n<=5;n++) priority.add(new Option(n+" 分",String(n),false,n===score));
    urgent.type="checkbox"; urgent.checked=bypass; const label=el("label"); label.append(urgent,document.createTextNode("免打扰时提醒"));
    line.append(name,priority,label,button("移除",()=>line.remove())); list.append(line);
  }
  rules.rules.forEach(r=>addRule(r.sourceId,r.score,r.bypassQuiet));
  const controls=stack("action-row"); controls.append(button("添加来源",()=>addRule()),button("保存提醒规则",async()=>{
    const entries=[...list.querySelectorAll<HTMLElement>(".rule-row")].map(row=>({
      sourceId:row.querySelector("input")!.value.trim(),
      score:Number(row.querySelector("select")!.value) as Rules["rules"][number]["score"],
      bypassQuiet:row.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked
    }));
    await api.saveRules({...rules,quietStart:start.value,quietEnd:end.value,timezone:zone.value.trim(),rules:entries});
    inform("提醒规则已保存");
  },true));
  section.append(el("h3","来源优先级"),list,controls); return section;
}
async function renderSettings(current:()=>boolean) {
  const layout=stack("settings"), settings=stack("sheet"); layout.append(settings); view.append(layout);
  const title=status.configured?"模型与资料目录":"连接 Minder"; settings.append(el("h2",title));
  let root=status.root, selection:ProviderChoice|null=null, provider=status.provider, model=status.model;
  const rootText=el("p",root || "选择允许助手读取与修改的目录。","readout");
  settings.append(el("h3","资料目录"),rootText,button("选择目录…",async()=>{
    const chosen=await api.chooseWorkspace(); if(chosen){root=chosen;rootText.textContent=chosen;}
  }));
  const method=el("select");
  method.add(new Option("已有供应商配置文件","external",false,status.external||!status.configured));
  method.add(new Option("本机 Ollama","ollama",false,status.configured&&!status.external));
  const modelFields=stack("stack");
  function showModelFields() {
    modelFields.replaceChildren();
    if(method.value==="ollama") {
      const input=el("input"); input.value=status.configured&&!status.external?status.model:""; input.placeholder="输入已安装的 Ollama 模型名";
      model=input.value; provider="ollama"; input.oninput=()=>{model=input.value.trim();};
      modelFields.append(field("模型名称",input)); return;
    }
    if(!selection && status.external) {provider=status.provider;model=status.model;}
    if(!selection && !status.external){provider="";model="";}
    const file=button("选择供应商 JSON…",async()=>{
      const chosen=await api.chooseProvider(); if(!chosen) return;
      selection=chosen; provider=chosen.providers[0]?.id??""; model=""; showModelFields();
    });
    modelFields.append(file);
    if(!selection) {modelFields.append(el("p",status.external?provider+" / "+model:"请选择资料目录外的 Pi 供应商配置文件。","readout"));return;}
    modelFields.append(el("p",selection.name,"readout"));
    const providers=selection.providers;
    const providerSelect=choose("供应商",providers.map(p=>p.id),provider);
    function models() {
      provider=providerSelect.value;
      const ids=providers.find(p=>p.id===provider)?.models??[];
      const models=choose("模型",ids,ids.includes(model)?model:ids[0]??""); model=models.value;
      models.onchange=()=>{model=models.value;}; return field("模型",models);
    }
    const modelPicker=stack(); modelPicker.append(models()); providerSelect.onchange=()=>{modelPicker.replaceChildren(models());};
    modelFields.append(field("供应商",providerSelect),modelPicker);
  }
  method.onchange=showModelFields; showModelFields(); settings.append(field("连接方式",method),modelFields);
  const controls=stack("action-row");
  controls.append(button("保存设置",async()=>{
    if(sending) throw new Error("请等待当前任务完成后再修改连接。");
    if(!root || !model || !provider) throw new Error("请选择资料目录、供应商和模型。");
    status=await api.configure({root,provider,model,external:method.value==="external"});
    turns.length=0; draft="";refreshSidebar();inform("已保存配置");await navigate("settings");
  },true));
  if(status.configured) {
    controls.append(button("验证模型连接",async()=>{status=await api.verify();inform("模型已完成真实文件读取");await navigate("settings");}));
    controls.append(el("span",status.verified?"工具调用已验证":"尚未验证工具调用","hint"));
  }
  settings.append(controls);
  if(status.configured) {
    const rules=await api.rules(); if(current()) layout.append(rulesEditor(rules));
  }
}
for(const b of document.querySelectorAll<HTMLButtonElement>("[data-page]")) {
  b.addEventListener("click",()=>{inform("");void navigate(b.dataset.page as Page).catch(report);});
}
window.addEventListener("keydown",e=>{
  if(!e.metaKey || e.altKey || !/^[1-5]$/.test(e.key)) return;
  e.preventDefault();void navigate((Object.keys(pages) as Page[])[Number(e.key)-1]!).catch(report);
});
const unsubscribe=api.onEvent(event=>{
  if(event.type==="delta" && activeTurn){activeTurn.text+=event.text;displayTurns();}
  else if(event.type==="tool" && activeTurn){
    if(event.phase==="start") activeTurn.tools.push(event.name+" · 运行中");
    else {
      const label=event.name+" · "+(event.failed?"失败":"完成");
      const n=activeTurn.tools.lastIndexOf(event.name+" · 运行中");
      if(n>=0) activeTurn.tools[n]=label; else activeTurn.tools.push(label);
    }
    displayTurns();
  }
});
window.addEventListener("pagehide",unsubscribe,{once:true});
async function start() {
  status=await api.status(); refreshSidebar(); await navigate(status.configured?"chat":"settings");
}
void start().catch(report);
