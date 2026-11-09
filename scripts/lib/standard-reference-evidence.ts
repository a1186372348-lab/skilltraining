import { createHash } from "node:crypto";
import type { StandardReport } from "../../server/modules/content/standard-references.ts";

export function standardReferenceEvidence(report: StandardReport, questionIds: readonly string[]) {
  const questions = [...questionIds].sort();
  const summary = report.summary.map((item) => ({
    questionId: item.questionId,
    id: item.id,
    declaredStatus: item.declaredStatus,
    approvalVerified: item.approvalVerified,
    contentHash: item.contentHash,
    approvalId: item.approvalId,
  })).sort((a, b) =>
    a.questionId.localeCompare(b.questionId) || a.id.localeCompare(b.id),
  );
  const structuralIssues = [...report.structuralIssues].sort();
  const readinessIssues = [...report.readinessIssues].sort();
  const ready = questions.length > 0 && new Set(questions).size === questions.length
    && structuralIssues.length === 0 && readinessIssues.length === 0
    && questions.every((question) => summary.some((item) => item.questionId === question
      && item.declaredStatus === "approved" && item.approvalVerified));
  const snapshot = { questions, summary, structuralIssues, readinessIssues };
  return {
    ...snapshot,
    ready,
    modelInputUsed: false as const,
    snapshotHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  };
}
