// 题库校验命令：对 content/questions/**/*.yaml 输出逐题校验报告
// 用法：npm run content:validate [目录]（默认 content/questions）；任一题不通过时退出码为 1
import path from "node:path";

import { formatValidationReport, loadQuestionDirectory } from "../server/modules/content/load-questions.ts";

const dir = path.resolve(process.argv[2] ?? "content/questions");
const results = loadQuestionDirectory(dir);
console.log(formatValidationReport(results));

if (results.some((r) => !r.ok)) {
  process.exitCode = 1;
}
