import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db";

import { importQuestions, type QuestionImportClient } from "./import-questions.ts";
import { questionUuid } from "./question-id.ts";
import { questionContentSchema, type QuestionContent } from "./question-schema.ts";

// 集成测试：importQuestions 直连本地 PostgreSQL 隔离测试库（T14：skilltraining_test，
// 由 vitest.setup.ts 将 DATABASE_URL 指向 TEST_DATABASE_URL；pretest 自动建库与迁移）。
// 数据库不可达时整组跳过，避免 CI/无 Docker 环境误报。

// 测试用合法内容工厂（经 schema 解析，保证类型即运行时结构；domain 为 T33 必填契约字段）
function makeContent(id: string, domain: string): QuestionContent {
  return questionContentSchema.parse({
    id,
    title: `题目 ${id}`,
    case_title: `案例 ${id}`,
    case_background: {
      product: { text: "p", citations: [1] },
      audience: { text: "a", citations: [1] },
      scenario: { text: "s", citations: [1] },
      features: { text: "f", citations: [1] },
      status: { text: "c", citations: [1] },
    },
    case_sources: [{ id: 1, title: "来源", publisher: "官方", url: "https://example.com/s" }],
    main_question: "问？",
    ability_tags: ["问题定义", "用户理解"],
    difficulty: "中等",
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
    status: "draft",
    domain,
  });
}

async function isDbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const dbReady = await isDbReachable();

describe.skipIf(!dbReady)("importQuestions（真实数据库集成 / T33 domain）", () => {
  const contentIds = ["T33IT01", "T33IT02"];
  const uuids = contentIds.map((id) => questionUuid(id));

  afterAll(async () => {
    await prisma.question.deleteMany({ where: { id: { in: uuids } } });
    await prisma.$disconnect();
  });

  it("含 domain 的题目 upsert 落库，可按主键回读", async () => {
    const summary = await importQuestions(
      [makeContent("T33IT01", "工具/效率"), makeContent("T33IT02", "内容/社交")],
      prisma as unknown as QuestionImportClient,
    );
    expect(summary.imported).toBe(2);

    const row1 = await prisma.question.findUnique({ where: { id: questionUuid("T33IT01") } });
    const row2 = await prisma.question.findUnique({ where: { id: questionUuid("T33IT02") } });
    expect(row1?.domain).toBe("工具/效率");
    expect(row2?.domain).toBe("内容/社交");
  });

  it("重复导入幂等：同一主键覆盖更新不产生重复行，domain 以最新 YAML 为准", async () => {
    await importQuestions([makeContent("T33IT01", "工具/效率")], prisma as unknown as QuestionImportClient);
    await importQuestions([makeContent("T33IT01", "办公协同")], prisma as unknown as QuestionImportClient);

    const rows = await prisma.question.findMany({ where: { id: questionUuid("T33IT01") } });
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe("办公协同");
  });
});
