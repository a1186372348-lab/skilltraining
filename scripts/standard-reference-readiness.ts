import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStandardReferences, type StandardReport } from "../server/modules/content/standard-references.ts";
import { loadQuestionDirectory } from "../server/modules/content/load-questions.ts";

export const STANDARD_REFERENCE_IDS = ["B3", "B5", "B7", "B10", "B12", "B14", "B16", "B17"] as const;
export function runReadiness(args: string[], report: StandardReport): { code: number; message: string } {
  if (args.some(arg => arg !== "--structure") || args.length > 1) return { code: 1, message: "参数无效" };
  const structure = args.includes("--structure");
  const issues = structure ? report.structuralIssues : [...report.structuralIssues, ...report.readinessIssues];
  return { code: issues.length ? 1 : 0, message: issues.length ? issues.join("\n") : structure ? "结构有效（不代表已批准）" : "标准角色就绪" };
}
export function main(args: string[]): number {
  const questions = loadQuestionDirectory(path.resolve("content/questions"));
  const known = new Set(questions.flatMap(question => question.content ? [question.content.id] : []));
  const report = loadStandardReferences(
    path.resolve("content/standard-references"),
    path.resolve("task/evidence/standard-reference-approvals"),
    STANDARD_REFERENCE_IDS,
    known,
  );
  const result = runReadiness(args, report);
  console.log(result.message); return result.code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
