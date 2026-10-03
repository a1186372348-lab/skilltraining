import { questionUuid } from "./question-id.ts";
import { DIFFICULTY_TO_INT, type QuestionContent } from "./question-schema.ts";

// 题库导入：校验通过的内容按题 id upsert 进 questions 表
// 幂等设计：主键由内容 id 确定性生成（questionUuid），重复导入只是覆盖同一行
// 事务设计：整批一个事务，任一失败全部回滚，不写半截数据（T02 失败与回滚约定）

export interface QuestionUpsertArgs {
  where: { id: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

// PrismaClient 的最小结构子集：业务代码只依赖该接口，测试可用纯 mock 替代真实数据库
export interface QuestionImportClient {
  question: { upsert: (args: QuestionUpsertArgs) => Promise<unknown> };
  $transaction: (ops: Promise<unknown>[]) => Promise<unknown>;
}

export interface ImportSummary {
  imported: number; // 本次 upsert 的题目数
  ids: string[]; // 落库主键（uuid）列表
}

// YAML 内容 -> questions 表 upsert 入参
// 字段映射对齐 prisma/schema.prisma 的 Question 模型：
// 难度标签转 Int（2/3/4）；case_sources（T13/BR-8）与 uncertainty 并入 case_background jsonb
//（R6：jsonb 预留扩展；不新增表字段，今日/历史视图从同一 jsonb 读取，归档会话原样兼容）
export function toQuestionUpsertArgs(content: QuestionContent): QuestionUpsertArgs {
  const id = questionUuid(content.id);
  const row: Record<string, unknown> = {
    id,
    caseTitle: content.case_title,
    caseBackground: {
      ...content.case_background,
      case_sources: content.case_sources,
      ...(content.uncertainty ? { uncertainty: content.uncertainty } : {}),
    },
    mainQuestion: content.main_question,
    abilityTags: content.ability_tags,
    difficulty: DIFFICULTY_TO_INT[content.difficulty],
    rubric: content.rubric,
    hintTree: content.hint_tree,
    materials: content.materials,
    status: content.status,
  };
  // create 与 update 同内容：首次插入与重复导入结果一致（以最新 YAML 为准）
  return { where: { id }, create: row, update: row };
}

// 批量导入：整批 upsert 放进一个事务；空批次不触碰数据库
export async function importQuestions(
  contents: QuestionContent[],
  client: QuestionImportClient,
): Promise<ImportSummary> {
  if (contents.length === 0) {
    return { imported: 0, ids: [] };
  }
  const ops = contents.map((content) => client.question.upsert(toQuestionUpsertArgs(content)));
  await client.$transaction(ops);
  return { imported: contents.length, ids: contents.map((c) => questionUuid(c.id)) };
}
