import type { DesktopStatus, MemoryChange, ProviderChoice, Rules, Task, TaskInput } from "./contracts.js";
import DOMPurify from "dompurify";
import { marked } from "marked";

const api = window.minder;
const pages = {chat:"对话",files:"文件记录",memory:"记忆审阅",inbox:"提醒",settings:"设置",tasks:"委托"};
type Page = keyof typeof pages;
type Part = {kind:"text"; text:string} | {kind:"tool"; id:string; name:string; state:"运行中"|"完成"|"失败"};
type Turn = {role:"user"; text:string} | {role:"assistant"; parts:Part[]};
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
let status:DesktopStatus, sending=false, draft="", activeTurn:Extract<Turn,{role:"assistant"}>|undefined;
const workspaceDrafts=new Map<string,string>();
const turns:Turn[]=[];
let nextDetail=0;
let noticeTimer: number | undefined;
type SettingsTab = "connection" | "rules" | "extensions";
let settingsTab: SettingsTab = "connection";
let previousPage:Exclude<Page,"settings">="chat";
function inform(message:string, failure=false) {
  window.clearTimeout(noticeTimer);
  notice.textContent=message; notice.hidden=!message; notice.classList.toggle("error",failure);
  if(message && !failure) noticeTimer=window.setTimeout(()=>{notice.hidden=true;},5500);
}
function report(err:unknown) { inform(err instanceof Error ? err.message : String(err),true); }
function button(text:string, handler:()=>void|Promise<void>, primary=false, pendingText?:string) {
  const b=el("button",text,primary?"primary":""); b.type="button";
  b.addEventListener("click",async()=>{
    b.disabled=true;
    if(pendingText) {b.textContent=pendingText;b.setAttribute("aria-busy","true");}
    try { await handler(); } catch(err) { report(err); } finally {
      b.disabled=false;
      if(pendingText) {b.textContent=text;b.removeAttribute("aria-busy");}
    }
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
  if(page!=="settings") previousPage=page;
  page=target; ++nextDetail;
  byId("title").textContent=pages[page]; actions.replaceChildren(); view.replaceChildren();
  view.className=target==="chat"?"chat":"";
  view.scrollTop=0;
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
  if(target==="tasks") await renderTasks(current);
  if(target==="inbox") await renderInbox(current);
  if(target==="settings") await renderSettings(current);
}
function markdown(text:string) {
  const prose=el("div","","markdown-body");
  const html=marked.parse(text,{async:false,gfm:true});
  const content=DOMPurify.sanitize(html,{
    ALLOWED_TAGS:["p","br","hr","strong","em","del","blockquote","ul","ol","li","pre","code",
      "h1","h2","h3","h4","h5","h6","table","thead","tbody","tr","th","td","a"],
    ALLOWED_ATTR:["href","start"], ALLOW_DATA_ATTR:false, ALLOW_ARIA_ATTR:false, RETURN_DOM_FRAGMENT:true,
  });
  for(const anchor of content.querySelectorAll("a")) {
    const target=URL.parse(anchor.getAttribute("href") ?? "");
    if(!target || !["https:","http:"].includes(target.protocol) || target.username || target.password) {
      anchor.replaceWith(...anchor.childNodes);
    } else {anchor.title=target.href;}
  }
  prose.append(content);
  return prose;
}
let homeRequest=0;
async function refreshHomeTasks() {
  const section=document.getElementById("home-followups");
  if(!section || page!=="chat" || turns.length || !status.configured) return;
  const request=++homeRequest, root=status.root;
  const result=await api.homeTasks();
  if(!section.isConnected || request!==homeRequest || root!==status.root) return;
  if(result.root!==root || !result.tasks.length) {section.hidden=true;section.replaceChildren();return;}
  const signature=JSON.stringify(result.tasks.map(task=>[task.id,task.revision]));
  if(!section.hidden && section.dataset.revisions===signature) return;
  section.dataset.revisions=signature;
  const heading=el("h3","待跟进的委托");
  const links=result.tasks.map(task=>{
    const link=button("",()=>bringTaskIntoChat(task.id));
    link.className="home-followup";link.setAttribute("aria-label","继续跟进 "+task.title);
    link.append(el("strong",task.title));
    const earliest=[task.dueAt,task.followUpAt].filter((at):at is string=>at!==null).sort()[0];
    const timing=earliest?(earliest===task.dueAt?"截止 ":"跟进 ")+localTime(earliest):"";
    if(task.nextStep || timing) link.append(el("small",[task.nextStep,timing].filter(Boolean).join(" · ")));
    return link;
  });
  section.replaceChildren(heading,...links);section.hidden=false;
}
function displayTurns() {
  const log=document.getElementById("chat-log");
  if(!log) return;
  const following=log.scrollHeight-log.clientHeight-log.scrollTop<72;
  if(!turns.length) {
    const welcome=blank("想在这个目录里做什么？",status.root);
    welcome.classList.add("chat-welcome");
    const mark=document.createElementNS("http://www.w3.org/2000/svg","svg");
    mark.setAttribute("viewBox","0 0 32 32");mark.setAttribute("class","welcome-mark");mark.setAttribute("aria-hidden","true");
    const shape=document.createElementNS(mark.namespaceURI,"use");
    shape.setAttribute("href","#mark");mark.append(shape);welcome.prepend(mark);
    const upcoming=el("section","","home-followups");
    upcoming.id="home-followups";upcoming.hidden=true;upcoming.setAttribute("aria-label","待跟进的委托");
    log.replaceChildren(welcome,upcoming);void refreshHomeTasks().catch(report);return;
  }
  // 只刷新当前回答，保留前面消息的文本选择与滚动位置。
  if(!log.firstElementChild?.classList.contains("message")) log.replaceChildren();
  for(let n=Math.max(0,log.children.length-1);n<turns.length;n++) {
    const turn=turns[n]!;
    const item=el("article","","message "+turn.role);
    item.append(el("h3",turn.role==="user"?"你":"Minder"));
    if(turn.role==="user") item.append(el("p",turn.text));
    else {
      if(!turn.parts.length) item.append(el("p",sending?"正在处理…":"本次回答已停止。"));
      for(const part of turn.parts) {
        if(part.kind==="text") item.append(markdown(part.text));
        else item.append(el("div",part.name+" · "+part.state,"tool-line"));
      }
    }
    const existing=log.children[n];
    if(existing) existing.replaceWith(item); else log.append(item);
  }
  if(following) log.scrollTop=log.scrollHeight;
}
let frame=0;
function scheduleTranscript() {
  if(!frame && page==="chat") frame=requestAnimationFrame(()=>{frame=0;displayTurns();});
}
function renderChat() {
  const previousLog=document.getElementById("chat-log");
  const scrollOffset=previousLog && previousLog.scrollHeight-previousLog.clientHeight-previousLog.scrollTop>72
    ? previousLog.scrollTop : undefined;
  view.replaceChildren(); actions.replaceChildren();
  const fresh=button("新对话",async()=>{
    await api.newChat(); turns.length=0; activeTurn=undefined; await navigate("chat");
  });
  fresh.disabled=sending; actions.append(fresh);
  view.classList.toggle("empty-chat",!turns.length);
  const log=el("div","","chat-log"); log.id="chat-log"; log.setAttribute("aria-label","对话记录");
  log.addEventListener("click",event=>{
    const anchor=event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if(!anchor) return;
    event.preventDefault();void api.openWebLink(anchor.href).catch(report);
  });
  const box=el("div","","composer"), text=el("textarea");
  text.id="prompt"; text.rows=2; text.placeholder="给 Minder 发送消息…"; text.setAttribute("aria-label","任务"); text.value=draft;
  const send=async()=>{
    if(sending || !draft.trim()) return;
    const prompt=draft.trim(); draft=""; sending=true; inform("");
    turns.push({role:"user",text:prompt});
    const response:Turn={role:"assistant",parts:[]}; activeTurn=response; turns.push(response);
    renderChat();
    try { await api.send(prompt); }
    catch(err) { report(err);response.parts.push({kind:"text",text:"这次请求未完成。"}); }
    finally { sending=false; activeTurn=undefined; if(page==="chat"){ renderChat(); byId("prompt").focus(); } }
  };
  text.onkeydown=e=>{
    if(e.key==="Enter" && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode!==229) {
      e.preventDefault();void send();
    }
  };
  const row=stack("action-row");
  const model=button(status.model,()=>{settingsTab="connection";return navigate("settings");});
  model.className="composer-model";model.title="模型与目录设置";
  const submit=sending ? button("停止生成",()=>api.cancel()) : button("发送",send,true);
  submit.classList.add(sending?"composer-stop":"composer-submit");
  submit.title=sending?"停止当前回答":"发送消息（Enter）";
  const meta=stack("composer-meta");meta.append(model,el("span","Shift + Enter 换行","hint"));
  function syncComposer() { if(!sending) submit.disabled=!text.value.trim(); }
  text.addEventListener("input",()=>{draft=text.value;syncComposer();});
  row.append(meta,submit);
  box.append(text,row); view.append(log,box); syncComposer();displayTurns();
  if(scrollOffset!==undefined) log.scrollTop=scrollOffset;
  else if(turns.length) log.scrollTop=log.scrollHeight;
}
function patch(text:string) {
  const block=el("div","","patch");
  for(const line of text.split("\n")) block.append(el("span",line,line.startsWith("+")&&!line.startsWith("+++")?"addition":line.startsWith("-")&&!line.startsWith("---")?"deletion":""));
  return block;
}
function listDetail<T>(items:T[], caption:(item:T)=>[string,string], render:(item:T,panel:HTMLElement)=>Promise<void>|void, preferred?:(item:T)=>boolean) {
  const layout=stack("review-layout"), list=stack("records"), detail=stack("sheet");
  layout.append(list,detail); view.append(layout);
  async function select(item:T, b:HTMLButtonElement) {
    const request=++nextDetail;
    for(const row of list.querySelectorAll("button")) row.setAttribute("aria-pressed",String(row===b));
    const panel=stack("stack");
    try { await render(item,panel); if(request===nextDetail && detail.isConnected) detail.replaceChildren(panel); }
    catch(err) { if(request===nextDetail) report(err); }
  }
  const initial=preferred ? items.find(preferred) ?? items[0] : items[0];
  for(const item of items) {
    const [heading,meta]=caption(item), b=button("",()=>select(item,b)); b.className="record";
    b.append(el("strong",heading),el("small",meta)); list.append(b);
    if(item===initial) void select(item,b);
  }
}
function refreshButton() { actions.append(button("刷新",()=>navigate(page))); }

let taskFilter:Task["status"]="open", selectedTask="";
async function composeFollowUp(text:string) {
  draft=draft.trim()?draft+"\n\n"+text:text;
  await navigate("chat");byId("prompt").focus();
}
async function bringTaskIntoChat(id:string) {
  const current=generation,root=status.root;
  const task=(await api.tasks()).find(candidate=>candidate.id===id && candidate.status==="open");
  if(current!==generation || root!==status.root) return;
  if(!task) {await navigate(page);inform("这项委托已更新，请查看当前待跟进的事项。");return;}
  const context=["请继续跟进这项委托。",task.title,task.nextStep && "下一步："+task.nextStep,
    task.followUpAt && "跟进时间："+localTime(task.followUpAt),task.dueAt && "截止时间："+localTime(task.dueAt),
    task.notes,"委托编号："+task.id].filter(Boolean).join("\n");
  await composeFollowUp(context);
}
function taskDate(value:string|null) {
  const input=el("input");input.type="datetime-local";input.step="any";
  if(value) {
    const date=new Date(value);
    input.value=new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,-1);
  }
  const original=input.value;
  function iso():string|null {
    if(!input.value) return null;
    if(input.value===original && value) return value;
    const date=new Date(input.value);
    if(!Number.isFinite(date.getTime()) || date.getTime()-date.getTimezoneOffset()*60_000!==input.valueAsNumber)
      throw new Error("请选择所在时区有效的日期和时间");
    return date.toISOString();
  }
  return {input,iso};
}
function taskEditor(task?:Task) {
  const dialog=el("dialog","","task-editor"), form=el("form","","stack");
  const heading=el("h2",task?"编辑委托":"新建委托");heading.id="task-editor-title";
  dialog.setAttribute("aria-labelledby",heading.id);
  const title=el("input"), next=el("textarea"), notes=el("textarea");
  title.required=true;title.maxLength=256;next.maxLength=2000;notes.maxLength=8000;
  title.value=task?.title??"";next.value=task?.nextStep??"";notes.value=task?.notes??"";
  next.rows=2;notes.rows=2;
  const follow=taskDate(task?.followUpAt??null), due=taskDate(task?.dueAt??null);
  const dates=stack("columns");dates.append(field("跟进时间",follow.input),field("截止时间",due.input));
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timing=el("p","以上时间使用 "+zone+"。","task-schedule-note");
  const error=el("p","","task-form-error");error.setAttribute("role","alert");error.hidden=true;
  const row=stack("action-row end"), submit=el("button",task?"保存更改":"创建委托","primary");submit.type="submit";
  row.append(button("取消",()=>dialog.close()),submit);
  form.append(heading,field("委托名称",title),field("下一步",next),dates,timing,field("备注",notes),error,row);
  let saving=false;
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    if(saving) return;
    saving=true;form.inert=true;form.setAttribute("aria-busy","true");submit.textContent="正在保存…";
    try {
      const input:TaskInput={title:title.value.trim(),nextStep:next.value.trim(),notes:notes.value.trim(),
        followUpAt:follow.iso(),dueAt:due.iso()};
      const result=task ? await api.updateTask(task.id,input,task.revision) : await api.createTask(input);
      selectedTask=result.id;taskFilter=result.status;dialog.close();
      await navigate("tasks");inform(task?"委托已更新":"委托已创建");
      void loadInbox().catch(report);
    } catch(err) {
      error.textContent=err instanceof Error?err.message:String(err);error.hidden=false;
    } finally {saving=false;form.inert=false;form.removeAttribute("aria-busy");submit.textContent=task?"保存更改":"创建委托";}
  });
  dialog.addEventListener("cancel",event=>{if(saving)event.preventDefault();});
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});
  dialog.append(form);document.body.append(dialog);dialog.showModal();title.focus();
}
async function renderTasks(current:()=>boolean) {
  actions.append(button("新建委托",()=>taskEditor(),true));refreshButton();
  const tasks=await api.tasks();if(!current()) return;
  const filters=el("nav","","settings-tabs task-filters");filters.setAttribute("aria-label","委托状态");
  for(const [key,label] of [["open","待跟进"],["completed","已完成"]] as const) {
    const tab=button(label,()=>{taskFilter=key;return navigate("tasks");});
    tab.setAttribute("aria-pressed",String(taskFilter===key));filters.append(tab);
  }
  view.append(filters,el("p","关闭窗口后，Minder 会继续检查委托。退出应用期间到期的委托，会在下次启动时进入提醒流程。","task-delivery-note"));
  const visible=tasks.filter(task=>task.status===taskFilter);
  if(!visible.length) {
    view.append(taskFilter==="open"?blank("尚无待跟进的委托","可以创建委托，或在对话中告诉 Minder 需要跟进的事项和时间。"):
      blank("尚无已完成的委托","你标记完成的事项会保存在这里。"));
    return;
  }
  listDetail(visible,task=>[task.title,task.status==="completed"?"已完成":
    task.followUpAt?"跟进 · "+localTime(task.followUpAt):task.dueAt?"截止 · "+localTime(task.dueAt):"尚未安排时间"],(task,panel)=>{
    selectedTask=task.id;
    panel.append(el("h2",task.title,"record-title"));
    if(task.nextStep) panel.append(el("h3","下一步"),el("p",task.nextStep,"body-text"));
    const facts=el("dl","","task-facts");
    for(const [label,value] of [["跟进时间",task.followUpAt],["截止时间",task.dueAt]] as const) {
      facts.append(el("dt",label),el("dd",value?localTime(value):"未设置"));
    }
    panel.append(facts);
    if(task.notes) panel.append(el("h3","备注"),el("p",task.notes,"body-text"));
    if(task.status==="completed") return;
    const controls=stack("action-row");
    controls.append(button("编辑委托",()=>taskEditor(task)),button("带入对话",()=>bringTaskIntoChat(task.id)),button("标记完成",async()=>{
      if(!await confirmAction("完成这项委托？",task.title,"确认完成")) return;
      await api.completeTask(task.id,task.revision);taskFilter="completed";
      await navigate("tasks");inform("委托已完成");void loadInbox().catch(report);
    },true));panel.append(controls);
  },task=>task.id===selectedTask);
}
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
let selectedCard="", inboxRequest=0;
async function loadInbox() {
  const request=++inboxRequest;
  const groups=await api.inbox();
  if(request===inboxRequest) {
    const count=groups.reduce((total,group)=>total+group.events.length,0), badge=byId("inbox-count");
    badge.hidden=count===0;badge.textContent=String(count);badge.title=count+" 个待处理提醒";
  }
  return groups;
}
async function renderInbox(current:()=>boolean) {
  refreshButton(); const groups=await loadInbox(); if(!current()) return;
  const records=groups.flatMap(g=>g.events.map(card=>({group:g.title,card})));
  if(!records.length){view.append(blank("目前没有需要处理的提醒","达到提醒条件的目录事件和订阅会出现在这里。"));return;}
  listDetail(records,r=>[r.card.title,r.card.score+" 分 · "+r.group],async({card},panel)=>{
    selectedCard=card.id;
    panel.append(el("h2",card.title),el("p",card.summary,"body-text"),el("div",card.sourceId,"readout"),
      el("h3",card.action.label),el("p",card.action.text,"body-text"));
    panel.append(button("接受草稿",async()=>{
      const receipt=await api.accept(card.id,card.revision);
      await composeFollowUp(receipt.text);inform("草稿已放入对话输入框，请审阅后发送。");await loadInbox();
    },true));
  },r=>r.card.id===selectedCard);
}

function rulesEditor(rules:Rules) {
  const section=stack("sheet"); section.append(el("h2","免打扰时段"));
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
  },true,"正在保存…"));
  section.append(el("h3","来源优先级"),list,controls); return section;
}
function connectionSettings(current:()=>boolean) {
  const settings=stack("sheet connection-panel");
  const title=status.configured?"工作区连接":"连接 Minder"; settings.append(el("h2",title));
  let root=status.root, selection:ProviderChoice|null=null, provider=status.provider, model=status.model;
  const rootRow=stack("preference-row"), rootLabel=stack("preference-label");
  const rootText=el("p",root || "选择允许助手读取与修改的目录。","readout");
  rootLabel.append(el("h3","资料目录"),rootText);
  rootRow.append(rootLabel,button("选择目录…",async()=>{
    const chosen=await api.chooseWorkspace(); if(chosen){root=chosen;rootText.textContent=chosen;sync();}
  }));settings.append(rootRow);
  const method=el("select");
  method.add(new Option("已有供应商配置文件","external",false,status.external||!status.configured));
  method.add(new Option("本机 Ollama","ollama",false,status.configured&&!status.external));
  method.add(new Option("DeepSeek","deepseek",false,status.configured&&!status.external&&status.provider==="deepseek"));
  const modelFields=stack("stack");
  const controls=stack("action-row settings-actions"), state=el("span","","hint verification-status");
  const savedStatus=status;
  const dirty=()=>root!==savedStatus.root || provider!==savedStatus.provider || model!==savedStatus.model ||
    (method.value==="external")!==savedStatus.external || (method.value==="external" && selection!==null);
  let checking=false, saving=false;
  const save=button("保存设置",async()=>{
    if(sending) throw new Error("请等待当前任务完成后再修改连接。");
    saving=true;sync();
    try {
      const result=await api.configure({root,provider,model,external:method.value==="external",
        ...(method.value==="external" && selection?{providerSelectionId:selection.selectionId}:{})});
      if(result.changedConnection) {
        turns.length=0;activeTurn=undefined;selectedTask="";selectedCard="";taskFilter="open";
        if(status.root!==result.root) {
          if(draft) workspaceDrafts.set(status.root,draft);else workspaceDrafts.delete(status.root);
          draft=workspaceDrafts.get(result.root)??"";
        }
      }
      status=result;refreshSidebar();
      if(current()) {
        await navigate("chat");byId("prompt").focus();inform("设置已保存，可以开始对话");
        void loadInbox().catch(report);
      } else if(result.changedConnection) await navigate(page);
    } finally {saving=false;}
  },true,"正在保存…");
  const check=button("验证模型连接",async()=>{
    checking=true;sync();
    try {
      status=await api.verify();
      if(current()) {state.textContent="工具调用已验证";inform("模型已完成真实文件读取");}
    } finally {checking=false;sync();}
  },false,"正在验证…");
  function sync() {
    const ready=Boolean(root && provider && model);
    save.disabled=!ready || checking || saving || sending;
    check.disabled=!status.configured || dirty() || checking || saving || sending;
    state.textContent=checking?"正在通过模型读取测试文件…":dirty()&&status.configured?"更改保存后可验证连接":
      status.verified?"工具调用已验证":status.configured?"尚未验证工具调用":"";
  }
  const modelNames:Record<string,string>={ollama:status.provider==="ollama"?status.model:"",
    deepseek:status.provider==="deepseek"?status.model:"deepseek-chat"};
  function showModelFields() {
    modelFields.replaceChildren();
    if(method.value!=="external") {
      const mode=method.value, input=el("input"); input.value=modelNames[mode]??"";
      input.placeholder=mode==="ollama"?"输入已安装的 Ollama 模型名":"输入 DeepSeek 模型名";
      model=input.value; provider=mode; input.oninput=()=>{model=input.value.trim();modelNames[mode]=model;sync();};
      modelFields.append(field("模型名称",input));
      if(mode==="deepseek") modelFields.append(el("p","使用 Minder 终端版已保存的 DeepSeek 凭据或 DEEPSEEK_API_KEY。","readout"));
      sync();return;
    }
    if(!selection && status.external) {provider=status.provider;model=status.model;}
    if(!selection && !status.external){provider="";model="";}
    const file=button("选择供应商 JSON…",async()=>{
      const chosen=await api.chooseProvider(); if(!chosen) return;
      selection=chosen; provider=chosen.providers[0]?.id??""; model=""; showModelFields();
    });
    const fileRow=stack("preference-row"), fileLabel=stack("preference-label");
    const display=selection?.name ?? (status.external?provider+" / "+model:"请选择资料目录外的 Pi 供应商配置文件。");
    fileLabel.append(el("h3","供应商配置"),el("p",display,"readout"));
    fileRow.append(fileLabel,file);modelFields.append(fileRow);
    if(!selection) {sync();return;}
    const providers=selection.providers;
    const providerSelect=choose("供应商",providers.map(p=>p.id),provider);
    function models() {
      provider=providerSelect.value;
      const ids=providers.find(p=>p.id===provider)?.models??[];
      const models=choose("模型",ids,ids.includes(model)?model:ids[0]??""); model=models.value;
      models.onchange=()=>{model=models.value;sync();}; return field("模型",models);
    }
    const modelPicker=stack(); modelPicker.append(models()); providerSelect.onchange=()=>{modelPicker.replaceChildren(models());sync();};
    modelFields.append(field("供应商",providerSelect),modelPicker);sync();
  }
  method.onchange=showModelFields; showModelFields(); settings.append(field("连接方式",method),modelFields);
  controls.append(save);if(status.configured) controls.append(check,state);
  settings.append(controls);return settings;
}
function capabilities() {
  const section=stack("sheet"); section.append(el("h2","内置 Pi 扩展"));
  for(const [name,description,target] of [
    ["文件快照","记录助手修改前后的文件内容。可查看差异并撤销一次任务的文件修改。","files"],
    ["白盒记忆","审阅助手提出的长期事实和短期状态；接受后保存为本地 Markdown。","memory"],
    ["注意力防火墙","按规则归档普通事件，重要提醒附带一份可以带回对话的行动草稿。","inbox"],
  ] as const) {
    const row=stack("capability-row"), label=stack("preference-label");
    label.append(el("h3",name),el("p",description,"readout"));
    row.append(label,button("打开"+pages[target],()=>navigate(target)));section.append(row);
  }
  section.append(el("p","DSH 插件提供相同的三项能力，供 DeepSeek Harness 独立安装。","readout"));
  const {desktop,cli,packaged}=status.versions;
  section.append(el("p","桌面版 "+desktop+(packaged?"":"（开发环境）")+" · CLI "+cli,"readout"));
  return section;
}
async function renderSettings(current:()=>boolean) {
  if(status.configured) actions.append(button("返回"+pages[previousPage],()=>navigate(previousPage)));
  const layout=stack("settings"), tabs=el("nav","","settings-tabs"), panel=stack("settings-pane");
  tabs.setAttribute("aria-label","设置分类");layout.append(tabs,panel);view.append(layout);
  const connection=connectionSettings(current);
  async function show(tab:SettingsTab) {
    settingsTab=tab;view.scrollTop=0;panel.replaceChildren();
    for(const item of tabs.querySelectorAll("button")) item.setAttribute("aria-pressed",String(item.dataset.tab===tab));
    if(tab==="connection") {panel.append(connection);return;}
    if(tab==="extensions") {panel.append(capabilities());return;}
    if(!status.configured) {
      panel.append(blank("先选择资料目录","保存工作区连接后，即可设置这个目录的提醒规则。"));return;
    }
    panel.setAttribute("aria-busy","true");
    try {
      const rules=await api.rules();
      if(current() && settingsTab===tab) panel.replaceChildren(rulesEditor(rules));
    } finally {panel.removeAttribute("aria-busy");}
  }
  for(const [key,name] of [["connection","模型与目录"],["rules","提醒规则"],["extensions","内置能力"]] as const) {
    const item=button(name,()=>show(key));item.dataset.tab=key;tabs.append(item);
  }
  await show(settingsTab);
}
for(const b of document.querySelectorAll<HTMLButtonElement>("[data-page]")) {
  b.addEventListener("click",()=>{if(status){inform("");void navigate(b.dataset.page as Page).catch(report);}});
}
window.addEventListener("keydown",e=>{
  if(e.isComposing || !status) return;
  if(document.querySelector("dialog[open]")) return;
  if(e.key==="Escape" && page==="settings" && status.configured && !document.querySelector("dialog[open]")) {
    e.preventDefault();void navigate(previousPage).catch(report);return;
  }
  if(e.metaKey && e.key===",") {e.preventDefault();void navigate("settings").catch(report);return;}
  if(!e.metaKey || e.altKey || !/^[1-6]$/.test(e.key)) return;
  e.preventDefault();void navigate((Object.keys(pages) as Page[])[Number(e.key)-1]!).catch(report);
});
const toggle=byId<HTMLButtonElement>("sidebar-toggle");
function setSidebar(collapsed:boolean) {
  document.body.classList.toggle("sidebar-collapsed",collapsed);
  toggle.setAttribute("aria-expanded",String(!collapsed));
  toggle.setAttribute("aria-label",collapsed?"展开侧栏":"收起侧栏");toggle.title=toggle.getAttribute("aria-label")!;
}
setSidebar(localStorage.getItem("minder:sidebar")==="collapsed");
toggle.addEventListener("click",()=>{
  const collapsed=!document.body.classList.contains("sidebar-collapsed");
  setSidebar(collapsed);localStorage.setItem("minder:sidebar",collapsed?"collapsed":"open");
});
const unsubscribe=api.onEvent(event=>{
  if(event.type==="changed" || event.type==="inbox-changed") void refreshHomeTasks().catch(report);
  if(event.type==="open-inbox") {
    selectedCard=event.id;
    if(status?.configured) void navigate("inbox").catch(report);
  } else if(event.type==="inbox-changed" && status?.configured) {
    if(page==="inbox") void navigate("inbox").catch(report);
    else void loadInbox().catch(report);
  } else if(event.type==="delta" && activeTurn && event.text) {
    const tail=activeTurn.parts.at(-1);
    if(tail?.kind==="text") tail.text+=event.text;
    else activeTurn.parts.push({kind:"text",text:event.text});
    scheduleTranscript();
  }
  else if(event.type==="tool" && activeTurn){
    const state=event.phase==="start"?"运行中":event.failed?"失败":"完成";
    const tool=activeTurn.parts.find(part=>part.kind==="tool" && part.id===event.id);
    if(tool?.kind==="tool") tool.state=state;
    else activeTurn.parts.push({kind:"tool",id:event.id,name:event.name,state});
    scheduleTranscript();
  }
});
window.addEventListener("pagehide",unsubscribe,{once:true});
window.addEventListener("focus",()=>void refreshHomeTasks().catch(report));
window.setInterval(()=>{if(!document.hidden) void refreshHomeTasks().catch(report);},15_000);
async function start() {
  status=await api.status(); refreshSidebar(); await navigate(status.configured?(selectedCard?"inbox":"chat"):"settings");
  if(status.configured) void loadInbox().catch(report);
  if(status.configurationIssue) inform(status.configurationIssue,true);
}
void start().catch(report);
