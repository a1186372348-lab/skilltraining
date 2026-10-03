import { describe, expect, it, vi } from "vitest";

import {
  importQuestions,
  toQuestionUpsertArgs,
  type QuestionImportClient,
  type QuestionUpsertArgs,
} from "./import-questions.ts";
import { questionUuid } from "./question-id.ts";
import { questionContentSchema, type QuestionContent } from "./question-schema.ts";

// 测试用合法内容（经 schema 解析，保证类型即运行时结构）
function makeContent(id: string): QuestionContent {
  return questionContentSchema.parse({
    id,
    title: `题目 ${id}`,
    case_title: `案例 ${id}`,
    case_background: {
      product: { text: "p", citations: [1] },
      audience: { text: "a", citations: [1] },
      scenario: { text: "s", citations: [2] },
      features: { text: "f", citations: [1, 2] },
      status: { text: "c", citations: [2] },
    },
    case_sources: [
      { id: 1, title: "来源一", publisher: "官方", url: "https://example.com/s1" },
      { id: 2, title: "来源二", publisher: "媒体", url: "https://example.com/s2" },
    ],
    main_question: "问？",
    ability_tags: ["问题定义", "用户理解"],
    difficulty: "挑战",
    rubric: {
      dimensions: {
        问题定义: ["一", "二", "三"],
        用户理解: ["一", "二", "三"],
      },
      forbidden_leaks: ["x"],
    },
    hint_tree: [1, 2, 3, 4, 5].map((level) => ({
      level,
      stage: `阶段${level}`,
      question: `${level}？`,
    })),
    materials: {
      core: [
        { title: "t1", source: "s1", url: "https://example.com/1", summary: "m1" },
        { title: "t2", source: "s2", url: "https://example.com/2", summary: "m2" },
      ],
      extended: [
        { title: "t3", source: "s3", url: "https://example.com/3", summary: "m3" },
        { title: "t4", source: "s4", url: "https://example.com/4", summary: "m4" },
        { title: "t5", source: "s5", url: "https://example.com/5", summary: "m5" },
      ],
    },
    uncertainty: ["未核实数据"],
    status: "draft",
  });
}

// mock Prisma：记录 upsert 入参，$transaction 逐个执行收集的 promise
function makeMockClient() {
  const upsert = vi.fn((args: QuestionUpsertArgs) => Promise.resolve(args));
  const client: QuestionImportClient = {
    question: { upsert },
    $transaction: vi.fn(async (ops: PromiseLike<unknown>[]) => Promise.all(ops)),
  };
  return { client, upsert };
}

describe("toQuestionUpsertArgs：YAML 内容到 questions 表行的映射", () => {
  it("按内容 id 生成确定性主键，字段逐一映射", () => {
    const content = makeContent("Q01");
    const args = toQuestionUpsertArgs(content);
    const expectedId = questionUuid("Q01");
    expect(args.where).toEqual({ id: expectedId });
    expect(args.create).toMatchObject({
      id: expectedId,
      caseTitle: "案例 Q01",
      caseBackground: content.case_background,
      mainQuestion: "问？",
      abilityTags: ["问题定义", "用户理解"],
      difficulty: 4, // 挑战 -> 4
      rubric: content.rubric,
      hintTree: content.hint_tree,
      materials: content.materials,
      status: "draft",
    });
    // update 与 create 同内容：重复导入覆盖为最新内容且幂等
    expect(args.update).toEqual(args.create);
    // uncertainty 不并入 rubric（评分细则结构与下游评分契约保持一致）
    expect(JSON.stringify(args.create.rubric)).not.toContain("未核实数据");
  });

  it("无 uncertainty 时 case_background 与 case_sources 原样并入 jsonb 落库", () => {
    const content = makeContent("Q01");
    delete content.uncertainty;
    const args = toQuestionUpsertArgs(content);
    // T13 / BR-8：case_sources 并入 case_background jsonb（R6 预留扩展），
    // 不新增表字段；历史/今日视图从同一 jsonb 中读取，保证归档会话也能回放来源
    expect(args.create.caseBackground).toEqual({
      ...content.case_background,
      case_sources: content.case_sources,
    });
  });

  it("uncertainty 随题目一起落库（并入结构化内容，不丢失评审信息）", () => {
    const content = makeContent("Q01");
    const args = toQuestionUpsertArgs(content);
    const flat = JSON.stringify(args.create);
    expect(flat).toContain("未核实数据");
    // uncertainty 与 case_sources 并存于 case_background jsonb（各自键互不干扰）
    expect(args.create.caseBackground).toEqual({
      ...content.case_background,
      case_sources: content.case_sources,
      uncertainty: content.uncertainty,
    });
  });
});

describe("importQuestions：幂等批量导入", () => {
  it("逐题 upsert，整批放在一个事务里（失败整体回滚）", async () => {
    const { client, upsert } = makeMockClient();
    const contents = [makeContent("Q01"), makeContent("Q02"), makeContent("Q03")];
    const summary = await importQuestions(contents, client);
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({
      imported: 3,
      ids: [questionUuid("Q01"), questionUuid("Q02"), questionUuid("Q03")],
    });
  });

  it("重复导入同一批：仍按同一主键 upsert，不产生新记录", async () => {
    const { client, upsert } = makeMockClient();
    const contents = [makeContent("Q01")];
    await importQuestions(contents, client);
    await importQuestions(contents, client);
    expect(upsert).toHaveBeenCalledTimes(2);
    const firstWhere = upsert.mock.calls[0][0].where;
    const secondWhere = upsert.mock.calls[1][0].where;
    expect(secondWhere).toEqual(firstWhere);
  });

  it("空批次不触碰数据库", async () => {
    const { client, upsert } = makeMockClient();
    const summary = await importQuestions([], client);
    expect(upsert).not.toHaveBeenCalled();
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(summary).toEqual({ imported: 0, ids: [] });
  });

  it("事务失败时错误向上抛出（不写半截数据由调用方感知）", async () => {
    const { client } = makeMockClient();
    client.$transaction = vi.fn(async () => {
      throw new Error("连接中断");
    });
    await expect(importQuestions([makeContent("Q01")], client)).rejects.toThrow("连接中断");
  });
});
