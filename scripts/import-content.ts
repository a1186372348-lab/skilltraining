// 题库导入命令：校验 -> 按题 id upsert 导入 questions 表（幂等）
// 用法：npm run content:import [目录]（默认 content/questions）
// 失败与回滚（T02）：任一题校验不通过则整批取消、数据库不写入；导入为单事务，失败整体回滚
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import {
  importQuestions,
  type QuestionImportClient,
} from "../server/modules/content/import-questions.ts";
import { formatValidationReport, loadQuestionDirectory } from "../server/modules/content/load-questions.ts";
import type { QuestionContent } from "../server/modules/content/question-schema.ts";

const dir = path.resolve(process.argv[2] ?? "content/questions");
const results = loadQuestionDirectory(dir);
console.log(formatValidationReport(results));

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} 题校验未通过，本次导入整批取消，数据库未写入。`);
  process.exit(1);
}

const contents = results
  .map((r) => r.content)
  .filter((c): c is QuestionContent => c !== null);

const prisma = new PrismaClient();
try {
  // PrismaClient 结构满足 QuestionImportClient（upsert + 数组事务），此处仅做类型对齐
  const summary = await importQuestions(contents, prisma as unknown as QuestionImportClient);
  console.log(`\n导入完成：${summary.imported} 题已按题 id upsert（重复执行幂等，不产生重复记录）。`);
} finally {
  await prisma.$disconnect();
}
