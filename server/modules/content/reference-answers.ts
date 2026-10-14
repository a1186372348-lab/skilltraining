import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { load as loadYaml } from "js-yaml";
import { z } from "zod";

import { QUESTION_ID_PATTERN } from "./question-schema.ts";

// 评分样本契约（T33 / D31 扩展）：每题 1~4 份不同表现水平的评分样本
//（覆盖：不同立场的高质量答案 / 写得流畅但依据不足的答案 / 合理承认未知的答案），
// 供 T28 评分回归与双评审校准使用；AI 起草 + 人工评审修订。
// T33 校准 R3：quality 标签以人审定档为准（预设 high 只是编写意图），
// 人审后某题可以没有 high 样本，契约不再强制「每题至少 1 份 high」。
// 只入 Git 的 content/eval/（每题 <内容id>.yaml），不进 questions 表、不下发前端，
// 泄露口径与 rubric 同级管理；T28 在本契约之上扩展完整评测集契约（期望分数带等）

export const REVIEW_STATUS = ["draft", "approved"] as const;
export type ReviewStatus = (typeof REVIEW_STATUS)[number];

// 表现水平分层：high=高质量锚点 / medium / low（分层语义由 note 注明评审用途）
export const ANSWER_QUALITIES = ["high", "medium", "low"] as const;
export type AnswerQuality = (typeof ANSWER_QUALITIES)[number];

// 单份评分样本：正文 + 表现水平 + 可选评审用途注记（如「立场 B 高质量」「流畅但依据不足」「合理承认未知」）
export const answerSampleSchema = z.strictObject({
  text: z.string().trim().min(1, "答案正文不能为空"),
  quality: z.enum(ANSWER_QUALITIES),
  note: z.string().trim().min(1, "note 不能为空").optional(),
});
export type AnswerSample = z.infer<typeof answerSampleSchema>;

export const referenceAnswerSchema = z
  .strictObject({
    // 必须引用已存在的题目内容 id（存在性由 parseReferenceAnswerYaml 按题库集合校验）
    question_id: z
      .string()
      .regex(QUESTION_ID_PATTERN, "question_id 只能由字母、数字、连字符、下划线组成"),
    // 1~4 份不同表现水平的评分样本
    answers: z
      .array(answerSampleSchema)
      .min(1, "评分样本至少 1 份")
      .max(4, "评分样本至多 4 份"),
    review_status: z.enum(REVIEW_STATUS),
  })
  .superRefine((data, ctx) => {
    // 多份样本时 quality 不得全部相同（保证覆盖不同表现水平；单份样本天然满足）
    if (data.answers.length > 1 && new Set(data.answers.map((answer) => answer.quality)).size === 1) {
      ctx.addIssue({
        code: "custom",
        path: ["answers"],
        message: "同一题目的评分样本 quality 不得全部相同（需覆盖不同表现水平）",
      });
    }
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
