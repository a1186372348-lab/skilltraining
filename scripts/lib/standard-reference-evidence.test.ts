import { describe, expect, it } from "vitest";
import { standardReferenceEvidence } from "./standard-reference-evidence";

describe("标准材料报告证据", () => {
  it("空范围不就绪，不将材料声明为模型输入", () => {
    const result = standardReferenceEvidence({ structuralIssues: [], readinessIssues: [], summary: [] }, []);
    expect(result.ready).toBe(false);
    expect(result.modelInputUsed).toBe(false);
  });
  it("草稿未就绪且摘要不含正文或路径", () => {
    const result = standardReferenceEvidence({ structuralIssues: [], readinessIssues: ["B3 尚未批准"], summary: [{ questionId: "B3", id: "r1", declaredStatus: "draft", approvalVerified: false, contentHash: "a".repeat(64), approvalId: null }] }, ["B3"]);
    expect(result).toMatchObject({ ready: false, modelInputUsed: false });
    expect(result.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("正文");
  });
  it("仅齐备并核验的审批摘要才能就绪", () => {
    const summary = [{ questionId: "B3", id: "r1", declaredStatus: "approved" as const, approvalVerified: true, contentHash: "b".repeat(64), approvalId: "ok" }];
    expect(standardReferenceEvidence({ structuralIssues: [], readinessIssues: [], summary }, ["B3"]).ready).toBe(true);
    expect(standardReferenceEvidence({ structuralIssues: [], readinessIssues: [], summary }, ["B3", "B5"]).ready).toBe(false);
  });
});
