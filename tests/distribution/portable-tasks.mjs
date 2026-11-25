import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";

const delivery = process.cwd();
const cli = join(delivery, "node_modules", "@minder", "cli");
const version = JSON.parse(readFileSync(join(cli, "package.json"), "utf8")).version;
assert.equal(version, process.argv[2]);
if (!version.startsWith("0.1.")) {
  const area = mkdtempSync(join(delivery, "tasks-"));
  const documents = join(area, "documents");
  mkdirSync(documents);
  const env = {...process.env, MINDER_HOME: join(area, "state")};
  function command(...args) {
    return JSON.parse(execFileSync(process.execPath, [join(cli, "lib", "bin.js"), ...args], {
      cwd: documents, env, encoding: "utf8",
    }));
  }

  command("init", "--root", documents, "--provider", "ollama", "--model", "local", "--no-verify");
  const doctor = command("doctor", "--json");
  for (const tool of ["minder_list_files", "minder_task_list", "minder_task_create", "minder_task_update", "minder_task_complete"]) {
    assert.ok(doctor.tools.includes(tool), tool);
  }
  command("rules", "quiet", "00:00", "00:00", "UTC");
  const task = command("tasks", "add", "检查文档", "--next-step", "核对附件", "--follow-up", new Date(Date.now()-60000).toISOString());
  const [card] = command("tasks", "check");
  assert.equal(card.externalId, task.id);
  const future = new Date(Date.now()+86400000).toISOString();
  const updated = command("tasks", "update", task.id, "--revision", String(task.revision), "--follow-up", future);
  assert.equal(updated.followUpAt, future);
  assert.deepEqual(command("inbox"), []);
  command("tasks", "complete", task.id, "--revision", String(updated.revision));
  assert.equal(command("tasks", "show", task.id).status, "completed");
  console.log("Verified installed tools, persisted task, reminder, rescheduling and completion on", process.platform);
}
