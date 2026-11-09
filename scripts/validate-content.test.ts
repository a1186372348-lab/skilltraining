import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dump, load } from "js-yaml";
import { expect, it } from "vitest";

const ids = ["B3", "B5", "B7", "B10", "B12", "B14", "B16", "B17"];
type FixtureDoc = { references: { id: string; text: string; status: string; content_hash?: string; approval_id?: string }[] };

it.each(["draft", "approved"] as const)("content validation reports synthetic %s readiness independently of structure", (status) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "t28-content-"));
  try {
    mkdirSync(path.join(cwd, "content"), { recursive: true });
    for (const name of ["questions", "eval", "standard-references"]) {
      cpSync(path.resolve("content", name), path.join(cwd, "content", name), { recursive: true });
    }
    const approvals = path.join(cwd, "task/evidence/standard-reference-approvals");
    mkdirSync(approvals, { recursive: true });
    for (const id of ids) {
      const file = path.join(cwd, "content/standard-references", `${id}.yaml`);
      const doc = load(readFileSync(file, "utf8")) as FixtureDoc;
      for (const ref of doc.references) {
        ref.status = status;
        delete ref.content_hash;
        delete ref.approval_id;
        if (status === "approved") {
          const hash = createHash("sha256").update(ref.text).digest("hex");
          const approvalId = `fixture-${ref.id}`;
          ref.content_hash = hash;
          ref.approval_id = approvalId;
          writeFileSync(path.join(approvals, `${approvalId}.json`), JSON.stringify({
            record_id: approvalId, question_id: id, reference_id: ref.id,
            content_hash: hash, decision: "approved",
          }));
        }
      }
      writeFileSync(file, dump(doc));
    }
    const result = spawnSync(process.execPath, [path.resolve("scripts/validate-content.ts")], { cwd, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("标准参考答案结构有效");
    expect(result.stdout).toContain(status === "draft" ? "尚未批准，标准角色未就绪" : "标准角色就绪");
    if (status === "approved") expect(result.stdout).not.toContain("尚未批准，标准角色未就绪");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
