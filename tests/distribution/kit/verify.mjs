import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";

const release = JSON.parse(readFileSync(new URL("./release.json",import.meta.url),"utf8"));
assert.equal(release.packages.length,10);
for (const pkg of release.packages) {
  assert.match(pkg.file,/^tarballs\/[A-Za-z0-9-]+\.tgz$/);
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(new URL(pkg.file,import.meta.url))) hash.update(chunk);
  assert.equal("sha512-"+hash.digest("base64"),pkg.integrity,pkg.name);
  console.log(pkg.name,pkg.version,"OK");
}
