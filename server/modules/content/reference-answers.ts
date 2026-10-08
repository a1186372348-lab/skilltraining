import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { load as loadYaml } from "js-yaml";
import { z } from "zod";

import { QUESTION_ID_PATTERN } from "./question-schema.ts";

// 标准答案最小契约（T33 / D31）：每题 1~2 份参考答案 + 评审状态，AI 起草 + 人工评审修订。
// 只入 Git 的 content/eval/（每题 <内容id>.yaml），不进 questions 表、不下发前端，
// 泄露口径与 rubric 同级管理；T28 在本契约之上扩展完整评测集契约（期望分数带等）

export const REVIEW_STATUS = ["draft", "approved"] as const;
export type ReviewStatus = (typeof REVIEW_STATUS)[number];

export const referenceAnswerSchema = z.strictObject({
  // 必须引用已存在的题目内容 id（存在性由 parseReferenceAnswerYaml 按题库集合校验）
  question_id: z
    .string()
    .regex(QUESTION_ID_PATTERN, "question_id 只能由字母、数字、连字符、下划线组成"),
  // 1~2 份完整可参考作答
  answers: z
    .array(z.string().trim().min(1, "答案正文不能为空"))
    .min(1, "标准答案至少 1 份")
    .max(2, "标准答案至多 2 份"),
  review_status: z.enum(REVIEW_STATUS),
});

export type ReferenceAnswer = z.infer<typeof referenceAnswerSchema>;

export interface ReferenceAnswerFileResult {
  file: string; // 文件路径
  ok: boolean; // 是否通过校验
  answer: ReferenceAnswer | null; // 通过时为解析后的标准答案
  issues: string[]; // 未通过时的可读错误列表
}

function formatIssuePath(segments: PropertyKey[]): string {
  return segments.length === 0 ? "(根)" : segments.map(String).join(".");
}

// 解析并校验单份标准答案 YAML；question_id 必须命中题库中已存在的内容 id。
// 任何失败都转成可读错误，不抛异常（与 load-questions 同风格）
export function parseReferenceAnswerYaml(
  file: string,
  raw: string,
  knownQuestionIds: ReadonlySet<string>,
): ReferenceAnswerFileResult {
  let data: unknown;
  try {
    data = loadYaml(raw);
  } catch (error) {
    const firstLine = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { file, ok: false, answer: null, issues: [`${file}: YAML 语法错误：${firstLine}`] };
  }
  const parsed = referenceAnswerSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${file}: ${formatIssuePath(issue.path)} — ${issue.message}`,
    );
    return { file, ok: false, answer: null, issues };
  }
  if (!knownQuestionIds.has(parsed.data.question_id)) {
    return {
      file,
      ok: false,
      answer: null,
      issues: [
        `${file}: question_id "${parsed.data.question_id}" 不存在于题库（标准答案必须引用已存在的题目内容 id）`,
      ],
    };
  }
  return { file, ok: true, answer: parsed.data, issues: [] };
}

// 递归收集目录下全部 .yaml/.yml 文件（路径排序，保证报告稳定可 diff）
function collectYamlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectYamlFiles(full));
    } else if (/\.ya?ml$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// 校验 content/eval/ 目录下全部标准答案，逐份返回结果；目录不存在时抛错（与题目目录一致）
export function loadReferenceAnswerDirectory(
  dir: string,
  knownQuestionIds: ReadonlySet<string>,
): ReferenceAnswerFileResult[] {
  if (!existsSync(dir)) {
    throw new Error(`目录不存在：${dir}`);
  }
  return collectYamlFiles(dir)
    .sort()
    .map((file) => parseReferenceAnswerYaml(file, readFileSync(file, "utf8"), knownQuestionIds));
}

// 逐份校验报告（供 CLI 直接打印）
export function formatReferenceAnswerReport(results: ReferenceAnswerFileResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    if (r.ok) {
      lines.push(`[通过] ${r.file}`);
    } else {
      lines.push(`[失败] ${r.file}`, ...r.issues.map((issue) => `    - ${issue}`));
    }
  }
  if (results.length === 0) {
    lines.push("标准答案：目录下暂无答案文件（0 份）");
    return lines.join("\n");
  }
  const failedCount = results.filter((r) => !r.ok).length;
  if (failedCount === 0) {
    lines.push(`全部 ${results.length} 份标准答案校验通过`);
  } else {
    lines.push(`${failedCount}/${results.length} 份标准答案校验不通过`);
  }
  return lines.join("\n");
}
