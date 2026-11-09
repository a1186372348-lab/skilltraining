import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { z } from "zod";

const safeId = z.string().regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const textSchema = z.string().min(1).refine((value) => value.trim().length > 0);
const reference = z.discriminatedUnion("status", [
  z.strictObject({ id: safeId, text: textSchema, status: z.literal("draft") }),
  z.strictObject({
    id: safeId, text: textSchema, status: z.literal("approved"),
    content_hash: digest, approval_id: safeId,
  }),
]);
const document = z.strictObject({ question_id: safeId, references: z.array(reference).min(1).max(2) });
const approval = z.strictObject({
  record_id: safeId, question_id: safeId, reference_id: safeId,
  content_hash: digest, decision: z.literal("approved"),
});
export type StandardSummary = {
  questionId: string;
  id: string;
  declaredStatus: "draft" | "approved";
  approvalVerified: boolean;
  contentHash: string;
  approvalId: string | null;
};
export type StandardReport = {
  structuralIssues: string[];
  readinessIssues: string[];
  summary: StandardSummary[];
};
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function readContainedFile(root: string, name: string): string {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("invalid root");
  const target = path.join(root, name);
  const fileStat = lstatSync(target);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("invalid file");
  const base = realpathSync(root);
  const resolved = realpathSync(target);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("outside root");
  }
  return readFileSync(resolved, "utf8");
}

function verifyApproval(
  dir: string, questionId: string, ref: z.infer<typeof reference>, contentHash: string,
): string | null {
  if (ref.status === "draft") return `${questionId}/${ref.id} 未批准`;
  if (ref.content_hash !== contentHash) return `${questionId}/${ref.id} 正文哈希不匹配`;
  try {
    const parsed = approval.safeParse(JSON.parse(readContainedFile(dir, `${ref.approval_id}.json`)));
    if (!parsed.success) return `${questionId}/${ref.id} 审批记录无效`;
    const rec = parsed.data;
    const matches = rec.record_id === ref.approval_id && rec.question_id === questionId
      && rec.reference_id === ref.id && rec.content_hash === contentHash;
    return matches ? null : `${questionId}/${ref.id} 审批记录不匹配`;
  } catch {
    return `${questionId}/${ref.id} 审批记录缺失或无效`;
  }
}

export function loadStandardReferences(
  root: string, approvalsRoot: string, questionIds: readonly string[],
  knownQuestionIds: ReadonlySet<string> = new Set(["B3", "B5", "B7", "B10", "B12", "B14", "B16", "B17"]),
): StandardReport {
  const result: StandardReport = { structuralIssues: [], readinessIssues: [], summary: [] };
  if (!questionIds.length || new Set(questionIds).size !== questionIds.length) {
    result.structuralIssues.push("题目范围为空或重复");
    return result;
  }
  for (const questionId of questionIds) {
    if (!safeId.safeParse(questionId).success || !knownQuestionIds.has(questionId)) {
      result.structuralIssues.push("题号无效或不在题库");
      continue;
    }
    let raw: unknown;
    try {
      raw = load(readContainedFile(root, `${questionId}.yaml`));
    } catch {
      result.structuralIssues.push(`${questionId} 文件缺失或格式无效`);
      continue;
    }
    const parsed = document.safeParse(raw);
    if (!parsed.success || parsed.data.question_id !== questionId || new Set(parsed.data.references.map(r => r.id)).size !== parsed.data.references.length) {
      result.structuralIssues.push(`${questionId} 结构、题号或答案编号无效`);
      continue;
    }
    let approvedCount = 0;
    for (const ref of parsed.data.references) {
      const contentHash = hash(ref.text);
      const issue = verifyApproval(approvalsRoot, questionId, ref, contentHash);
      const verified = ref.status === "approved" && issue === null;
      if (ref.status === "approved" && issue) result.readinessIssues.push(issue);
      if (verified) approvedCount++;
      result.summary.push({
        questionId, id: ref.id, declaredStatus: ref.status, approvalVerified: verified,
        contentHash, approvalId: ref.status === "approved" ? ref.approval_id : null,
      });
    }
    if (approvedCount === 0) result.readinessIssues.push(`${questionId} 尚未批准或无有效标准答案`);
  }
  return result;
}
