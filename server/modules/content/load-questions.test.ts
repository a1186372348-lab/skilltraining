import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findDuplicateIds,
  formatValidationReport,
  loadQuestionDirectory,
  parseQuestionYaml,
} from "./load-questions.ts";

// 最小合法 YAML 文本（T13 新契约：五字段 {text, citations[]} + case_sources）
const VALID_YAML = `
id: Q01
title: "测试题"
case_title: "案例"
case_background:
  product: { text: "p", citations: [1] }
  audience: { text: "a", citations: [1] }
  scenario: { text: "s", citations: [2] }
  features: { text: "f", citations: [1, 2] }
  status: { text: "c", citations: [2] }
case_sources:
  - { id: 1, title: "来源一", publisher: "官方", url: "https://example.com/s1" }
  - { id: 2, title: "来源二", publisher: "媒体", url: "https://example.com/s2" }
main_question: "问？"
ability_tags: ["问题定义", "用户理解"]
difficulty: 基础
rubric:
  dimensions:
    问题定义: ["一", "二", "三"]
    用户理解: ["一", "二", "三"]
  forbidden_leaks: ["x"]
hint_tree:
  - { level: 1, stage: "任务澄清", question: "1？" }
  - { level: 2, stage: "视角补充", question: "2？" }
  - { level: 3, stage: "反例/风险", question: "3？" }
  - { level: 4, stage: "取舍权衡", question: "4？" }
  - { level: 5, stage: "验证方式", question: "5？" }
materials:
  core:
    - { title: "t1", source: "s1", url: "https://example.com/1", summary: "m1" }
    - { title: "t2", source: "s2", url: "https://example.com/2", summary: "m2" }
  extended:
    - { title: "t3", source: "s3", url: "https://example.com/3", summary: "m3" }
    - { title: "t4", source: "s4", url: "https://example.com/4", summary: "m4" }
    - { title: "t5", source: "s5", url: "https://example.com/5", summary: "m5" }
status: draft
`;

describe("parseQuestionYaml：单文件解析与校验", () => {
  it("合法 YAML 解析成功并返回内容", () => {
    const r = parseQuestionYaml("q01.yaml", VALID_YAML);
    expect(r.ok).toBe(true);
    expect(r.content?.id).toBe("Q01");
    expect(r.issues).toEqual([]);
  });

  it("YAML 语法错误给出可读错误而非抛异常", () => {
    const r = parseQuestionYaml("bad.yaml", "id: Q01\n  缩进错误: [");
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues[0]).toContain("bad.yaml");
  });

  it("schema 违规给出带字段路径的可读错误", () => {
    const bad = VALID_YAML.replace('ability_tags: ["问题定义", "用户理解"]', 'ability_tags: ["问题定义"]');
    const r = parseQuestionYaml("q02.yaml", bad);
    expect(r.ok).toBe(false);
    expect(r.issues.some((m) => m.includes("ability_tags"))).toBe(true);
  });

  it("顶层不是对象被拒绝", () => {
    const r = parseQuestionYaml("q03.yaml", "- 这\n- 是\n- 数组\n");
    expect(r.ok).toBe(false);
  });
});

describe("loadQuestionDirectory：目录批量校验", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "content-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("递归收集 .yaml/.yml，忽略其他文件，逐题给出结果", () => {
    mkdirSync(path.join(dir, "draft"), { recursive: true });
    writeFileSync(path.join(dir, "draft", "a.yaml"), VALID_YAML);
    writeFileSync(path.join(dir, "b.yml"), VALID_YAML.replace("id: Q01", "id: Q02"));
    writeFileSync(path.join(dir, "README.md"), "# 不是题目");
    const results = loadQuestionDirectory(dir);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    // 结果按文件路径排序，报告稳定可 diff
    expect(results[0].file <= results[1].file).toBe(true);
  });

  it("目录不存在时抛出清晰错误", () => {
    expect(() => loadQuestionDirectory(path.join(dir, "不存在"))).toThrow(/目录不存在/);
  });
});

describe("formatValidationReport：逐题校验报告", () => {
  it("全部通过时输出通过摘要", () => {
    const results = [parseQuestionYaml("a.yaml", VALID_YAML)];
    const report = formatValidationReport(results);
    expect(report).toContain("a.yaml");
    expect(report).toMatch(/通过/);
  });

  it("失败题列出具体错误行", () => {
    const bad = parseQuestionYaml("bad.yaml", "id: Q01\nability_tags: []\n");
    const report = formatValidationReport([bad]);
    expect(report).toContain("bad.yaml");
    expect(report).toMatch(/失败|不通过/);
  });

  it("批次内重复 id 被检出（导入会互相覆盖，评审期必须拦截）", () => {
    const a = parseQuestionYaml("a.yaml", VALID_YAML);
    const b = parseQuestionYaml("b.yaml", VALID_YAML);
    expect(findDuplicateIds([a, b])).toHaveLength(1);
    const report = formatValidationReport([a, b]);
    expect(report).toContain("重复题目 id");
    expect(report).toMatch(/不通过/);
    const c = parseQuestionYaml("c.yaml", VALID_YAML.replace("id: Q01", "id: Q02"));
    expect(findDuplicateIds([a, c])).toEqual([]);
  });
  // T13 过渡期说明：真实 12 草案正由内容任务并行改写为新结构，
  // 全量校验由主代理以 npm run content:validate 终验；本模块测试一律使用内置 fixtures
});
