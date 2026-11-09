// 追问泄露规则检查（T28 切片 4：追问质量三查之 ③不泄露 Rubric 要点，规则化自动执行，D31）。
// 检查对象为每份样本产出的追问与提示文本；返回结构化违规列表（空数组 = 全过）。
//
// 匹配口径（字面重合）：
// - 归一化：去除全部空白字符（含全角空格）与常见中英文标点、英文转小写后做子串匹配
//   （要点归一化后是文本归一化后的子串即命中）；
// - 归一化后不足 4 字的要点不参与匹配（过短子串误报率高，宁可漏报）；
// - 字数上限按码点计数，沿用现有 followup 输出惯例（prompt 硬性约束 4）：
//   追问 ≤120 字、提示 ≤80 字（边界等值放行）。

/** 字数上限（码点计）：现有 followup 输出惯例 */
export const FOLLOWUP_QUESTION_MAX_CHARS = 120;
export const FOLLOWUP_HINT_MAX_CHARS = 80;
/** 归一化后短于该长度的要点不参与子串匹配（防误报） */
export const MIN_POINT_CHARS = 4;

export interface LeakViolation {
  /** forbidden_leak=命中禁止泄露点 / rubric_point=命中 Rubric 要点 / *_too_long=超限 */
  kind: "forbidden_leak" | "rubric_point" | "question_too_long" | "hint_too_long";
  /** 违规文本角色：追问 / 提示 */
  role: "question" | "hint";
  /** 命中规则来源（要点原文或上限规则描述） */
  source: string;
  /** 违规摘录（截断） */
  excerpt: string;
  /** 长度类的实际值与上限 */
  actual?: number;
  limit?: number;
}

/** 归一化：去空白与常见中英文标点、英文小写（字面重合比对口径，见文件头注释） */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　，。、；：？！「」『』“”‘’（）()《》〈〉【】\[\]…—·,.;:!?'"'`-]/g, "");
}

function truncate(text: string, max = 40): string {
  const flat = text.replace(/\r?\n/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function codePointLength(text: string): number {
  return [...text].length;
}

export function checkFollowupLeak(input: {
  items: { role: "question" | "hint"; text: string }[];
  forbiddenLeaks: string[];
  rubricPoints: string[];
}): LeakViolation[] {
  const violations: LeakViolation[] = [];
  const points: { kind: LeakViolation["kind"]; source: string; normalized: string }[] = [
    ...input.forbiddenLeaks.map((source) => ({
      kind: "forbidden_leak" as const,
      source,
      normalized: normalize(source),
    })),
    ...input.rubricPoints.map((source) => ({
      kind: "rubric_point" as const,
      source,
      normalized: normalize(source),
    })),
  ].filter((p) => p.normalized.length >= MIN_POINT_CHARS);

  for (const item of input.items) {
    const text = item.text;
    const normalizedText = normalize(text);
    for (const point of points) {
      if (normalizedText.includes(point.normalized)) {
        violations.push({
          kind: point.kind,
          role: item.role,
          source: point.source,
          excerpt: truncate(text),
        });
      }
    }
    const limit = item.role === "question" ? FOLLOWUP_QUESTION_MAX_CHARS : FOLLOWUP_HINT_MAX_CHARS;
    const actual = codePointLength(text);
    if (actual > limit) {
      violations.push({
        kind: item.role === "question" ? "question_too_long" : "hint_too_long",
        role: item.role,
        source: `${item.role === "question" ? "追问" : "提示"}字数上限 ${limit} 字`,
        excerpt: truncate(text),
        actual,
        limit,
      });
    }
  }
  return violations;
}
