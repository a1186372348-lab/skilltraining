/**
 * prompt 模板渲染器（T28 / D31 切片 1：prompt 文件化）。
 *
 * 模板为纯文本数据（可入库、可哈希、可 diff），插值点写作 {{slot}}——
 * 双花括号与 prompt 正文中的 JSON 示例（单花括号）不冲突；
 * 渲染确定性逐字替换，缺失插值参数快速失败（防静默产出残缺 prompt）。
 */

/** 一组 prompt 模板（system / user 两条消息的模板文本；静态内容即无插值点的模板） */
export interface PromptTemplatePair {
  system: string;
  user: string;
}

const SLOT_PATTERN = /\{\{(\w+)\}\}/g;

/** 渲染模板：逐字替换 {{slot}}；模板声明了 slots 中不存在的插值点 → 抛错（快速失败） */
export function renderPromptTemplate(template: string, slots: Record<string, string>): string {
  return template.replace(SLOT_PATTERN, (match, key: string) => {
    if (!(key in slots)) {
      throw new Error(`prompt 模板缺少插值参数：${key}`);
    }
    return slots[key];
  });
}

/** 提取模板中的插值点列表（DB 内容结构校验用） */
export function templateSlotsOf(template: string): string[] {
  return [...template.matchAll(SLOT_PATTERN)].map((match) => match[1]);
}
