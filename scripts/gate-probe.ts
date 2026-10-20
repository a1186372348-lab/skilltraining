// 追问闸门探针（T35 / D37）：验证 AI 是否真正逐条做「是否追问」的判定，而非形同虚设。
// 用法：
//   node --env-file=.env scripts/gate-probe.ts --recent [N=20]
//     分布监测：从开发库读最近 N 条含 gate_decision 判定记录的会话（关联题目取案例标题），
//     逐行打印时间 / 案例 / 判定（追问·跳过）/ 判定理由 / 追问轮数，末尾给判定分布汇总；
//     若全部为同一判定，输出警示「闸门可能形同虚设，未产生区分」。
//   node --env-file=.env scripts/gate-probe.ts --live
//     思考链核查：对内置一强一弱两条样例首答（同一道题，精简自 B1 抖音扩张题）
//     真实调用 DeepSeek 走追问闸门全链路（buildFollowupMessages → chatCompletion →
//     parseFollowupGateOutput），打印每条的 reasoning_content 全文、解析判定、
//     判定理由与生成的追问（如有）。
//     ★ 产生少量真实 token 消耗（2 次调用，deepseek-flash）——仅人工核查时运行。
// 备注：
//   - 密钥只经 --env-file=.env 注入，绝不打印；判定理由属内部审计数据，仅打印到运维终端。
//   - gate_decision 解析在脚本内联而非复用 server/modules/training/today-view.ts——
//     该模块内部为无扩展名相对导入，plain node 直跑 TS 无法解析
//     （同 dev-trigger-feedback.ts 的处理方式）；followup.ts / client.ts 均为
//     带扩展名相对导入，可安全复用。
import { prisma } from "../server/lib/prisma.ts";
import { createAiClientFromEnv } from "../server/ai/client.ts";
import { buildFollowupMessages, parseFollowupGateOutput } from "../server/ai/followup.ts";

const mode = process.argv[2]?.trim();

/* ============================== 内联：gate_decision 解析（与 today-view 同口径） ============================== */

interface GateDecision {
  shouldFollowup: boolean;
  reason: string;
  decidedAt: string;
}

function parseGateDecisionInline(raw: unknown): GateDecision | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { type?: unknown; shouldFollowup?: unknown; reason?: unknown; decidedAt?: unknown };
    if (record.type !== "gate_decision") continue;
    if (typeof record.shouldFollowup !== "boolean") return null;
    return {
      shouldFollowup: record.shouldFollowup,
      reason: typeof record.reason === "string" ? record.reason : "",
      decidedAt: typeof record.decidedAt === "string" ? record.decidedAt : "",
    };
  }
  return null;
}

function countFollowupRoundsInline(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.filter(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { round?: unknown }).round === "number" &&
      typeof (item as { question?: unknown }).question === "string",
  ).length;
}

/* ============================== --recent：判定分布监测 ============================== */

async function runRecent(take: number): Promise<void> {
  const rows = await prisma.trainingSession.findMany({
    where: { followups: { path: ["0", "type"], equals: "gate_decision" } },
    include: { question: { select: { caseTitle: true } } },
    orderBy: { firstSubmittedAt: "desc" },
    take,
  });
  if (rows.length === 0) {
    console.log("未找到任何 gate_decision 判定记录（闸门上线后的会话才会产生，可先跑 --live 验证链路）。");
    return;
  }
  console.log(`最近 ${rows.length} 条追问闸门判定：\n`);
  let askCount = 0;
  let skipCount = 0;
  for (const row of rows) {
    const decision = parseGateDecisionInline(row.followups);
    if (!decision) continue;
    const rounds = countFollowupRoundsInline(row.followups);
    const when = (decision.decidedAt || row.firstSubmittedAt?.toISOString() || "").slice(0, 16).replace("T", " ");
    if (decision.shouldFollowup) {
      askCount += 1;
      console.log(`[${when}] ${row.question.caseTitle} | 判定：追问（${rounds} 轮）| ${decision.reason}`);
    } else {
      skipCount += 1;
      console.log(`[${when}] ${row.question.caseTitle} | 判定：跳过 | ${decision.reason}`);
    }
  }
  console.log(`\n分布汇总：追问 ${askCount} / 跳过 ${skipCount}（共 ${askCount + skipCount} 条）`);
  if (askCount + skipCount > 0 && (askCount === 0 || skipCount === 0)) {
    console.warn("⚠ 警示：全部为同一判定——闸门可能形同虚设，未产生区分，请用 --live 核查思考链或复核判定 prompt。");
  }
}

/* ============================== --live：思考链核查（真实 AI 调用） ============================== */

/** 内置样例题（精简自 B1 抖音扩张题；主测维度 = abilityTags[0] = 问题定义） */
const PROBE_INPUT_BASE = {
  mainQuestion:
    "抖音以短视频信息流为绝对主形态起家，2021 年前后连续长出图文、搜索、电商与本地生活。请选定一次扩张，回到它对应的具体用户场景，界定抖音彼时要解决的问题：说清问题的对象、发生的场景、目标差距、处理边界与判断依据。",
  rubric: {
    dimensions: {
      问题定义: [
        "界定对象与场景：明确指出问题落在哪类用户身上、发生在什么使用路径的哪个环节，而非笼统说「满足更多需求」。",
        "目标差距结构：当前状态 / 期望状态 / 断点三段齐备且互相咬合，断点落到形态或链路层面。",
        "处理边界与判断依据：说明定义适用范围、不承诺解决什么，并给出可检验的判据或案例事实支撑。",
      ],
    },
    forbidden_leaks: ["视频搜索月活超 5.5 亿这一关键证据", "「从kill time到满足主动需求」的定性结论"],
  },
  primaryDimension: "问题定义",
};

const PROBE_ANSWERS = [
  {
    label: "强答案（预期：判定跳过或高压线边缘——要点覆盖完整、证据链闭环）",
    firstAnswer:
      "我选搜索扩张。对象：带着明确目的找攻略、查商品、找店的用户；场景：他们在抖音刷到相关内容后产生主动查询意图，路径是「刷到→想了解更多」，断点在于单列沉浸式信息流只支持被动消费，站内无法完成主动检索，只能跳去百度/小红书完成、流量外溢。目标差距：当前只能反复刷等算法投喂，期望是就地搜索即得，断点是缺少检索入口与可索引的内容池。边界：该定义解释搜索与图文（图文提升可检索信息密度），不承诺解释电商（那是交易链路问题）。判据：若搜索月活与搜索后停留显著高于纯消费用户则成立；若搜索量长期低迷则推翻。",
  },
  {
    label: "弱答案（预期：判定追问——无对象场景、无证据、无边界）",
    firstAnswer: "我觉得抖音扩张就是为了满足用户更多需求，用户需要更多内容形式，体验更好，所以这是必然的趋势。",
  },
];

async function runLive(): Promise<void> {
  console.log("思考链核查：对内置一强一弱两条首答真实调用 DeepSeek（deepseek-flash，2 次调用，产生少量 token 消耗）……\n");
  const client = createAiClientFromEnv();
  let askCount = 0;
  let skipCount = 0;
  for (const sample of PROBE_ANSWERS) {
    console.log("=".repeat(72));
    console.log(`【${sample.label}】`);
    console.log(`首答：${sample.firstAnswer}\n`);
    const messages = buildFollowupMessages({ ...PROBE_INPUT_BASE, firstAnswer: sample.firstAnswer });
    const result = await client.chatCompletion({
      messages,
      temperature: 0.3,
      maxCompletionTokens: 4096,
      responseFormat: { type: "json_object" },
    });
    console.log("— reasoning_content（思考链全文）—");
    console.log(result.reasoningContent ?? "（供应商未返回 reasoning_content）");
    const gate = parseFollowupGateOutput(result.content);
    console.log("\n— 解析结果 —");
    console.log(`判定：${gate.shouldFollowup ? "追问" : "跳过"}`);
    console.log(`判定理由：${gate.reason}`);
    if (gate.shouldFollowup) {
      askCount += 1;
      gate.followups.forEach((draft, index) => {
        console.log(`追问${index + 1}：${draft.question}`);
        console.log(`  提示：${draft.hint || "（无）"}`);
      });
    } else {
      skipCount += 1;
    }
    console.log("");
  }
  console.log("=".repeat(72));
  console.log(`分布汇总：追问 ${askCount} / 跳过 ${skipCount}`);
  if (askCount === 0 || skipCount === 0) {
    console.warn("⚠ 警示：两条样例得到同一判定——强弱答案未被区分，闸门可能形同虚设，请复核判定 prompt 从紧表述。");
  } else {
    console.log("✓ 强弱答案得到不同判定，闸门在本组样例上产生了区分。");
  }
}

/* ============================== 入口 ============================== */

if (mode === "--recent") {
  const take = Number(process.argv[3]) || 20;
  await runRecent(take);
  await prisma.$disconnect();
} else if (mode === "--live") {
  await runLive();
  await prisma.$disconnect();
} else {
  console.error("用法：");
  console.error("  node --env-file=.env scripts/gate-probe.ts --recent [N=20]   判定分布监测（只读开发库）");
  console.error("  node --env-file=.env scripts/gate-probe.ts --live            思考链核查（真实调用 DeepSeek，产生少量 token 消耗）");
  process.exit(1);
}
