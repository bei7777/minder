import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Firewall, type ActionCard, type Decision } from "@minder/core-firewall";

export interface TaskInput {
  title: string;
  notes?: string;
  nextStep?: string;
  dueAt?: string | null;
  followUpAt?: string | null;
}
export type TaskUpdate = Partial<TaskInput>;
export interface Task {
  id: string; title: string; notes: string; nextStep: string;
  dueAt: string | null; followUpAt: string | null; status: "open" | "completed";
  createdAt: string; updatedAt: string; revision: number;
}
const publicFields = "id,title,notes,nextStep,dueAt,followUpAt,status,createdAt,updatedAt,revision";
const sourcePrefix = "minder:tasks:";

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || !/(Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error("委托时间需要包含时区的 ISO 日期和时间");
  const day = value.slice(0,10);
  if (new Date(day+"T00:00:00Z").toISOString().slice(0,10)!==day) throw new Error("委托日期无效");
  return new Date(value).toISOString();
}

function content(value: unknown, limit: number, required = false): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > limit || required && !value.trim())
    throw new Error("委托文本为空、过长或包含无效字符");
  return value.trim();
}
function values(input: TaskInput) {
  return {title:content(input.title,256,true), notes:content(input.notes??"",8000),
    nextStep:content(input.nextStep??"",2000), dueAt:timestamp(input.dueAt), followUpAt:timestamp(input.followUpAt)};
}

export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly workspace: string;
  readonly sourceId: string;
  constructor(private readonly home: string, root: string) {
    this.workspace=resolve(root);
    this.sourceId=sourcePrefix+createHash("sha256").update(this.workspace).digest("hex");
    const dir=join(home,"tasks");
    mkdirSync(dir,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(join(dir,"tasks.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, requestKey TEXT,
        title TEXT NOT NULL, notes TEXT NOT NULL, nextStep TEXT NOT NULL, dueAt TEXT, followUpAt TEXT,
        status TEXT NOT NULL CHECK(status IN ('open','completed')), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        revision INTEGER NOT NULL, deadlineSent INTEGER NOT NULL DEFAULT 0, followUpSent INTEGER NOT NULL DEFAULT 0,
        cardRevision TEXT, withdrawn INTEGER NOT NULL DEFAULT 0, UNIQUE(workspace,requestKey)
      );
      CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks(workspace,status);
      CREATE TABLE IF NOT EXISTS native_notifications (eventId TEXT PRIMARY KEY);
    `);
  }
  private transaction<T>(action:()=>T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result=action(); this.db.exec("COMMIT"); return result;
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private read(id:string): Task {
    const row=this.db.prepare(`SELECT ${publicFields} FROM tasks WHERE workspace=? AND id=?`).get(this.workspace,id);
    if (!row) throw new Error("当前资料目录中没有这项委托");
    return row as unknown as Task;
  }
  get(id:string) { return this.read(id); }
  list(status?:Task["status"]): Task[] {
    if(status!==undefined && status!=="open" && status!=="completed") throw new Error("委托状态无效");
    return this.db.prepare(`SELECT ${publicFields} FROM tasks WHERE workspace=? AND (? IS NULL OR status=?)
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
      COALESCE(MIN(COALESCE(followUpAt,dueAt),COALESCE(dueAt,followUpAt)),'9999'),createdAt,id`)
      .all(this.workspace,status??null,status??null) as unknown as Task[];
  }
  create(input:TaskInput,requestKey?:string): Task {
    const data=values(input), now=new Date().toISOString();
    return this.transaction(()=>{
      if(requestKey) {
        const found=this.db.prepare("SELECT id FROM tasks WHERE workspace=? AND requestKey=?").get(this.workspace,requestKey);
        if(found) return this.read(String(found.id));
      }
      const id=randomUUID();
      this.db.prepare(`INSERT INTO tasks(id,workspace,requestKey,title,notes,nextStep,dueAt,followUpAt,status,createdAt,updatedAt,revision)
        VALUES(?,?,?,?,?,?,?,?,'open',?,?,1)`).run(id,this.workspace,requestKey??null,data.title,data.notes,data.nextStep,
          data.dueAt,data.followUpAt,now,now);
      return this.read(id);
    });
  }
  private editable(id:string,version:number):Task {
    const row=this.read(id);
    if(row.revision!==version) throw new Error("委托已经更新，请重新查看后再操作");
    if(row.status!=="open") throw new Error("这项委托已经完成");
    return row;
  }
  update(id:string,fields:TaskUpdate,expectedRevision:number):Task {
    if(!Object.keys(fields).length || Object.keys(fields).some(key=>!["title","notes","nextStep","dueAt","followUpAt"].includes(key)))
      throw new Error("请选择要修改的委托字段");
    const task=this.transaction(()=>{
      const old=this.editable(id,expectedRevision), data=values({...old,...fields});
      if(data.title===old.title && data.notes===old.notes && data.nextStep===old.nextStep &&
        data.dueAt===old.dueAt && data.followUpAt===old.followUpAt) return old;
      this.db.prepare(`UPDATE tasks SET title=?,notes=?,nextStep=?,dueAt=?,followUpAt=?,updatedAt=?,revision=revision+1,
        deadlineSent=CASE WHEN dueAt IS ? THEN deadlineSent ELSE 0 END,
        followUpSent=CASE WHEN followUpAt IS ? THEN followUpSent ELSE 0 END,
        withdrawn=CASE WHEN cardRevision IS NOT NULL THEN 1 ELSE withdrawn END, cardRevision=NULL WHERE workspace=? AND id=?`)
        .run(data.title,data.notes,data.nextStep,data.dueAt,data.followUpAt,new Date().toISOString(),data.dueAt,data.followUpAt,this.workspace,id);
      return this.read(id);
    });
    this.flushWithdrawals();
    return task;
  }
  complete(id:string,expectedRevision:number):Task {
    const task=this.transaction(()=>{
      const old=this.read(id);
      if(old.status==="completed" && (old.revision===expectedRevision || old.revision===expectedRevision+1)) return old;
      this.editable(id,expectedRevision);
      this.db.prepare(`UPDATE tasks SET status='completed',updatedAt=?,revision=revision+1,
        withdrawn=CASE WHEN cardRevision IS NOT NULL THEN 1 ELSE withdrawn END, cardRevision=NULL WHERE workspace=? AND id=?`)
        .run(new Date().toISOString(),this.workspace,id);
      return this.read(id);
    });
    this.flushWithdrawals();
    return task;
  }
  private flushWithdrawals() {
    if(!this.db.prepare("SELECT 1 FROM tasks WHERE workspace=? AND withdrawn=1 LIMIT 1").get(this.workspace)) return;
    const firewall=new Firewall(join(this.home,"firewall"));
    try { this.dispatchDue(firewall); } finally { firewall.close(); }
  }
  dispatchDue(firewall:Firewall):number {
    const now=new Date().toISOString();
    // 先在委托库串行确定事件，收件箱按固定修订去重，进程中断后可重放。
    return this.transaction(()=>{
      const rows=this.db.prepare(`SELECT id,title,nextStep,revision,withdrawn,
        CASE WHEN dueAt<=? AND deadlineSent=0 THEN dueAt END AS deadline,
        CASE WHEN followUpAt<=? AND followUpSent=0 THEN followUpAt END AS followUp
        FROM tasks WHERE workspace=? AND (withdrawn=1 OR (status='open' AND
        ((dueAt<=? AND deadlineSent=0) OR (followUpAt<=? AND followUpSent=0))))`).all(now,now,this.workspace,now,now);
      let count=0;
      for(const row of rows) {
        const id=String(row.id), title=String(row.title);
        if(row.withdrawn) {
          firewall.ingest({sourceId:this.sourceId,externalId:id,revision:"withdraw:"+row.revision,occurredAt:now,
            kind:"task-withdrawn",title,summary:"委托已更新，原提醒已撤回。",score:1});
          this.db.prepare("UPDATE tasks SET withdrawn=0 WHERE id=?").run(id);
        }
        const active=this.read(id);
        if(active.status!=="open" || (!row.deadline && !row.followUp)) continue;
        const deadline=Boolean(row.deadline && (!row.followUp || row.deadline>=row.followUp));
        const kind=deadline?"deadline":"follow-up", revision=kind+":"+row.revision;
        const label=deadline?"委托已到期":"委托需要跟进", at=String(deadline?row.deadline:row.followUp);
        firewall.ingest({sourceId:this.sourceId,externalId:id,revision,occurredAt:at,kind:"task:"+kind,
          title:label+" · "+title,summary:label+"。 "+(row.nextStep||"请查看当前进度。"),score:5,
          action:{label:"查看委托进度",text:"请查看委托 "+id+"「"+title+"」的当前进度和下一步。"}});
        this.db.prepare(`UPDATE tasks SET cardRevision=?, deadlineSent=MAX(deadlineSent,?),followUpSent=MAX(followUpSent,?)
          WHERE id=?`).run(revision,Number(Boolean(row.deadline)),Number(Boolean(row.followUp)),id);
        count++;
      }
      return count;
    });
  }
  private visible(card:Decision):boolean {
    if(!card.sourceId.startsWith(sourcePrefix)) return true;
    if(card.sourceId!==this.sourceId) return false;
    return !!this.db.prepare("SELECT 1 FROM tasks WHERE workspace=? AND id=? AND cardRevision=? AND status='open'")
      .get(this.workspace,card.externalId,card.revision);
  }
  inbox(firewall:Firewall) {
    this.dispatchDue(firewall);
    firewall.dispatchDue();
    return firewall.inbox().map(group=>({...group,events:group.events.filter(card=>this.visible(card))})).filter(g=>g.events.length);
  }
  claimNotifications(firewall:Firewall):ActionCard[] {
    return this.transaction(()=>{
      const claimed:ActionCard[]=[];
      const insert=this.db.prepare("INSERT OR IGNORE INTO native_notifications VALUES(?)");
      for(const card of firewall.list("ready")) {
        if(card.sourceId!==this.sourceId || card.score!==5 || !this.visible(card)) continue;
        if(insert.run(card.id).changes) claimed.push(card);
      }
      return claimed;
    });
  }
  accept(firewall:Firewall,id:string,revision:string) {
    return this.transaction(()=>{
      if(!this.visible(firewall.get(id))) throw new Error("这份提醒已失效或属于其他资料目录");
      return firewall.accept(id,revision);
    });
  }
  close() { this.db.close(); }
}
