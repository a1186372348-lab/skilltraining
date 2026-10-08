import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  formatReferenceAnswerReport,
  loadReferenceAnswerDirectory,
  parseReferenceAnswerYaml,
  REVIEW_STATUS,
  referenceAnswerSchema,
} from "./reference-answers.ts";

const KNOWN_IDS = new Set(["Q01", "Q02", "B1"]);

function validAnswer() {
  return {
    question_id: "Q01",
    answers: ["参考答案正文。"],
    review_status: "draft",
  };
}

describe("标准答案最小契约（T33 / D31）", () => {
  it("锁定 review_status 枚举", () => {
    expect([...REVIEW_STATUS]).toEqual(["draft", "approved"]);
  });

  it("接受合法样本：1 份 draft 答案", () => {
    const r = parseReferenceAnswerYaml("Q01.yaml", "question_id: Q01\nanswers:\n  - 参考答案正文。\nreview_status: draft\n", KNOWN_IDS);
    expect(r.ok).toBe(true);
    expect(r.answer).toEqual(validAnswer());
  });

  it("接受 2 份答案与 approved 状态", () => {
    const r = referenceAnswerSchema.safeParse({
      question_id: "Q01",
      answers: ["答案一。", "答案二。"],
      review_status: "approved",
    });
    expect(r.success).toBe(true);
  });

  it("question_id 必须引用已存在的题目内容 id", () => {
    const raw = "question_id: Q99\nanswers:\n  - 正文。\nreview_status: draft\n";
    const r = parseReferenceAnswerYaml("Q99.yaml", raw, KNOWN_IDS);
    expect(r.ok).toBe(false);
    expect(r.issues.join("\n")).toContain("Q99");
    expect(r.issues.join("\n")).toContain("不存在");
  });

  it("answers 数量限定 1~2 份：0 份与 3 份均被拒绝", () => {
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), answers: [] }).success,
    ).toBe(false);
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), answers: ["一", "二", "三"] }).success,
    ).toBe(false);
  });

  it("答案正文空串或纯空白被拒绝（trim 后非空）", () => {
    expect(referenceAnswerSchema.safeParse({ ...validAnswer(), answers: [""] }).success).toBe(false);
    expect(referenceAnswerSchema.safeParse({ ...validAnswer(), answers: ["   "] }).success).toBe(
      false,
    );
  });

  it("review_status 枚举之外的值被拒绝", () => {
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), review_status: "published" }).success,
    ).toBe(false);
  });

  it("未知字段被拒绝（strictObject，防笔误静默通过）", () => {
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), score_band: [3, 4] }).success,
    ).toBe(false);
  });

  it("YAML 语法错误转可读 issue，不抛异常", () => {
    const r = parseReferenceAnswerYaml("Q01.yaml", "question_id: [未闭合\n", KNOWN_IDS);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain("YAML 语法错误");
  });

  it("schema 校验失败经 parseReferenceAnswerYaml 转出带路径的可读 issue", () => {
    const raw = "question_id: Q01\nanswers:\n  - 正文。\nreview_status: published\n";
    const r = parseReferenceAnswerYaml("Q01.yaml", raw, KNOWN_IDS);
    expect(r.ok).toBe(false);
    expect(r.answer).toBeNull();
    expect(r.issues.join("\n")).toContain("review_status");
  });

  it("YAML 不是对象（根路径校验失败）时 issue 路径标记为（根）", () => {
    const r = parseReferenceAnswerYaml("Q01.yaml", "- 数组项\n", KNOWN_IDS);
    expect(r.ok).toBe(false);
    expect(r.issues.join("\n")).toContain("(根)");
  });
});

describe("content/eval/ 目录加载校验（T33）", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ref-answers-"));
    tempDirs.push(dir);
    return dir;
  }

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录不存在时抛出可读错误", () => {
    expect(() => loadReferenceAnswerDirectory(path.join(tmpdir(), "不存在的目录-t33"), KNOWN_IDS)).toThrow(
      "目录不存在",
    );
  });

  it("空目录（无 yaml）返回空结果集", () => {
    expect(loadReferenceAnswerDirectory(makeTempDir(), KNOWN_IDS)).toEqual([]);
  });

  it("逐文件加载校验：合法与非法并存时各自出结果", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "Q01.yaml"),
      "question_id: Q01\nanswers:\n  - 正文一。\nreview_status: approved\n",
    );
    writeFileSync(path.join(dir, "Q77.yaml"), "question_id: Q77\nanswers:\n  - 正文。\nreview_status: draft\n");
    writeFileSync(path.join(dir, ".gitkeep"), "");

    const results = loadReferenceAnswerDirectory(dir, KNOWN_IDS);
    expect(results).toHaveLength(2);
    const byFile = Object.fromEntries(results.map((r) => [path.basename(r.file), r]));
    expect(byFile["Q01.yaml"].ok).toBe(true);
    expect(byFile["Q01.yaml"].answer?.review_status).toBe("approved");
    expect(byFile["Q77.yaml"].ok).toBe(false); // 引用了不存在的题目
  });

  it("递归收集子目录中的 .yml 文件", () => {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(
      path.join(dir, "nested", "Q02.yml"),
      "question_id: Q02\nanswers:\n  - 正文。\nreview_status: draft\n",
    );
    const results = loadReferenceAnswerDirectory(dir, KNOWN_IDS);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].answer?.question_id).toBe("Q02");
  });
});

describe("标准答案校验报告（T33）", () => {
  it("空结果集给出明确提示", () => {
    expect(formatReferenceAnswerReport([])).toContain("0");
  });

  it("全部通过时输出汇总通过行", () => {
    const r1 = parseReferenceAnswerYaml(
      "Q01.yaml",
      "question_id: Q01\nanswers:\n  - 正文。\nreview_status: draft\n",
      KNOWN_IDS,
    );
    const r2 = parseReferenceAnswerYaml(
      "Q02.yaml",
      "question_id: Q02\nanswers:\n  - 正文。\nreview_status: approved\n",
      KNOWN_IDS,
    );
    expect(formatReferenceAnswerReport([r1, r2])).toContain("全部 2 份标准答案校验通过");
  });

  it("通过与失败都出现在报告中，失败带 issue 明细", () => {
    const okResult = parseReferenceAnswerYaml(
      "Q01.yaml",
      "question_id: Q01\nanswers:\n  - 正文。\nreview_status: draft\n",
      KNOWN_IDS,
    );
    const badResult = parseReferenceAnswerYaml(
      "Q99.yaml",
      "question_id: Q99\nanswers:\n  - 正文。\nreview_status: draft\n",
      KNOWN_IDS,
    );
    const report = formatReferenceAnswerReport([okResult, badResult]);
    expect(report).toContain("Q01.yaml");
    expect(report).toContain("Q99.yaml");
    expect(report).toContain("1/2");
  });
});
