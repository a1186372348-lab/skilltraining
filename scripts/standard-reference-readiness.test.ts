import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dump, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { runReadiness } from "./standard-reference-readiness";

const ids = ["B3", "B5", "B7", "B10", "B12", "B14", "B16", "B17"];
type FixtureDoc = { question_id: string; references: { id: string; text: string; status: string; content_hash?: string; approval_id?: string }[] };

function withFixture(status: "draft" | "approved", run: (cwd: string) => void): void {
  const cwd = mkdtempSync(path.join(tmpdir(), "t28-readiness-"));
  try {
    mkdirSync(path.join(cwd, "content"), { recursive: true });
    for (const name of ["questions", "standard-references"]) {
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
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function runCli(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.resolve("scripts/standard-reference-readiness.ts"), ...args], {
    cwd, encoding: "utf8",
  });
}

describe("readiness CLI", () => {
  it("distinguishes structure from a genuinely approved synthetic summary", () => {
    const pending = { structuralIssues: [], readinessIssues: ["B3 未批准"], summary: [] };
    const approved = {
      structuralIssues: [], readinessIssues: [],
      summary: [{ questionId: "B3", id: "fixture", declaredStatus: "approved" as const,
        approvalVerified: true, contentHash: "a".repeat(64), approvalId: "fixture-approval" }],
    };
    expect(runReadiness([], pending).code).toBe(1);
    expect(runReadiness(["--structure"], pending).code).toBe(0);
    expect(runReadiness(["--bad"], pending).code).toBe(1);
    expect(runReadiness([], approved).code).toBe(0);
    expect(runReadiness(["--structure"], { ...approved, structuralIssues: ["错误"] }).code).toBe(1);
  });

  it.each(["draft", "approved"] as const)("checks a synthetic %s fixture through the actual CLI", (status) => {
    withFixture(status, (cwd) => {
      expect(runCli(cwd, "--structure").status).toBe(0);
      const result = runCli(cwd);
      expect(result.status).toBe(status === "draft" ? 1 : 0);
      expect(result.stdout).toContain(status === "draft" ? "未批准" : "标准角色就绪");
    });
  });
});
