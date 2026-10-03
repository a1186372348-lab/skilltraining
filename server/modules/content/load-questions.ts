import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { load as loadYaml } from "js-yaml";

import { questionContentSchema, type QuestionContent } from "./question-schema.ts";

// 题库 YAML 加载与逐题校验：纯函数解析（可测）+ 目录遍历
// 校验命令与导入脚本共用本模块，保证「校验通过」与「允许导入」是同一道门槛

export interface QuestionFileResult {
  file: string; // 文件路径
  ok: boolean; // 是否通过校验
  content: QuestionContent | null; // 通过时为解析后的题目内容
  issues: string[]; // 未通过时的可读错误列表
}

function formatIssuePath(segments: PropertyKey[]): string {
  return segments.length === 0 ? "(根)" : segments.map(String).join(".");
}

// 解析并校验单个 YAML 文本；任何失败都转成可读错误，不抛异常
export function parseQuestionYaml(file: string, raw: string): QuestionFileResult {
  let data: unknown;
  try {
    data = loadYaml(raw);
  } catch (error) {
    const firstLine = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { file, ok: false, content: null, issues: [`${file}: YAML 语法错误：${firstLine}`] };
  }
  const parsed = questionContentSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${file}: ${formatIssuePath(issue.path)} — ${issue.message}`,
    );
    return { file, ok: false, content: null, issues };
  }
  return { file, ok: true, content: parsed.data, issues: [] };
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

// 校验目录下全部题目，逐题返回结果
export function loadQuestionDirectory(dir: string): QuestionFileResult[] {
  if (!existsSync(dir)) {
    throw new Error(`目录不存在：${dir}`);
  }
  return collectYamlFiles(dir)
    .sort()
    .map((file) => parseQuestionYaml(file, readFileSync(file, "utf8")));
}

// 批次级检查：不同文件出现相同内容 id（会导致导入互相覆盖，必须在评审期拦截）
export function findDuplicateIds(results: QuestionFileResult[]): string[] {
  const seen = new Map<string, string>();
  const duplicated = new Set<string>();
  for (const r of results) {
    if (!r.content) continue;
    const first = seen.get(r.content.id);
    if (first !== undefined) {
      duplicated.add(`${r.content.id}（${first} 与 ${r.file}）`);
    } else {
      seen.set(r.content.id, r.file);
    }
  }
  return [...duplicated].sort();
}

// 逐题校验报告（供 CLI 直接打印）
export function formatValidationReport(results: QuestionFileResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    if (r.ok) {
      lines.push(`[通过] ${r.file}`);
    } else {
      lines.push(`[失败] ${r.file}`, ...r.issues.map((issue) => `    - ${issue}`));
    }
  }
  const duplicated = findDuplicateIds(results);
  if (duplicated.length > 0) {
    lines.push("[失败] 存在重复题目 id：", ...duplicated.map((d) => `    - ${d}`));
  }
  const failedCount = results.filter((r) => !r.ok).length;
  if (failedCount === 0 && duplicated.length === 0) {
    lines.push(`全部 ${results.length} 题校验通过`);
  } else {
    lines.push(`${failedCount}/${results.length} 题校验不通过${duplicated.length > 0 ? "，另有重复 id" : ""}`);
  }
  return lines.join("\n");
}
