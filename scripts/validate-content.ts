// 题库校验命令：对 content/questions/**/*.yaml 输出逐题校验报告
// 用法：npm run content:validate [目录]（默认 content/questions）；任一题不通过时退出码为 1
// T33 追加：覆盖矩阵报告（只报告不拦截，达标核对属评审动作）+ content/eval/ 标准答案契约校验
//（标准答案契约失败同样计入退出码）
import path from "node:path";

import { buildCoverageMatrix, formatCoverageReport } from "../server/modules/content/coverage-matrix.ts";
import { formatValidationReport, loadQuestionDirectory } from "../server/modules/content/load-questions.ts";
import {
  formatReferenceAnswerReport,
  loadReferenceAnswerDirectory,
} from "../server/modules/content/reference-answers.ts";

const dir = path.resolve(process.argv[2] ?? "content/questions");
const results = loadQuestionDirectory(dir);
console.log(formatValidationReport(results));

// 覆盖矩阵报告（T33：维度 × 难度 × 领域分布 + 每维度日常题达标缺口；只报告不拦截）
console.log(`\n${formatCoverageReport(buildCoverageMatrix(results))}`);

// 标准答案契约校验（T33 / D31：question_id 必须引用题库中已存在的内容 id）
const knownQuestionIds = new Set(
  results.map((r) => r.content?.id).filter((id): id is string => id !== undefined),
);
const answerResults = loadReferenceAnswerDirectory(
  path.resolve("content/eval"),
  knownQuestionIds,
);
console.log(`\n${formatReferenceAnswerReport(answerResults)}`);

if (results.some((r) => !r.ok) || answerResults.some((r) => !r.ok)) {
  process.exitCode = 1;
}
