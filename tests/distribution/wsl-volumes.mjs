import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSnapshot } from "../../../pi-minder/packages/core-snapshot/lib/index.js";

const [linux, windows] = process.argv.slice(2);
assert.notEqual(statSync(linux).dev, statSync(windows).dev, "Expected distinct mounted filesystems");
for (const [documents, history] of [[linux, windows], [windows, linux]]) {
  const root = mkdtempSync(join(documents, "documents-"));
  const stateDir = mkdtempSync(join(history, "history-"));
  const file = join(root, "資料.bin");
  const before = Buffer.from([0, 42, 255]);
  const after = Buffer.from([128, 0, 33, 255]);
  writeFileSync(file, before, { mode: 0o640 });
  const initialMode = statSync(file).mode & 0o777;
  const manager = await openSnapshot({ roots: [root], stateDir });
  try {
    const tx = await manager.begin("Cross-volume binary file");
    await tx.write(file, after);
    const diff = await tx.commit();
    assert.match(diff.files[0].patch, /Binary/);
    assert.deepEqual(readFileSync(file), after);
    writeFileSync(file, "external change");
    await assert.rejects(manager.undo(tx.id), { code: "CONFLICT" });
    assert.equal(readFileSync(file, "utf8"), "external change");
    writeFileSync(file, after);
    assert.equal((await manager.undo(tx.id)).status, "undone");
    assert.deepEqual(readFileSync(file), before);
    assert.equal(statSync(file).mode & 0o777, initialMode);
  } finally { manager.close(); }
  console.log("Verified cross-volume undo", { root, stateDir });
}
