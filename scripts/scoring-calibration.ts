// 评分校准回归脚本（R1）：对内置固定样例跑评分，输出分数漂移报告
// ※ 已被 scripts/prompt-regression.ts 统一回归门槛取代（T28 / D31 切片 2）；本脚本 3 例内置骨架保留为离线冒烟。
// 用法：
//   node scripts/scoring-calibration.ts          # mock 模式（默认）：确定性桩评分，离线验证报告管线
//   node scripts/scoring-calibration.ts --live   # 真实模式：经 AI 网关（DeepSeek）评分（密钥经环境变量读取，人工触发）
// 退出码：任一维度分数漂出期望分数带 → 1（回归失败）；全部带内 → 0
import {
  CALIBRATION_SAMPLES,
  createMockScorer,
  formatCalibrationReport,
  runCalibration,
  type CalibrationScorer,
} from "../server/modules/scoring/calibration.ts";
import { scoreWithRubric } from "../server/modules/scoring/rubric-scorer.ts";

const live = process.argv.includes("--live");
const mode = live ? "live" : "mock";

// 真实模式：走 AI 网关（DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY 经 process.env 读取，不打印）；
// mock 模式：确定性桩评分，离线可跑
const scorer: CalibrationScorer = live
  ? (input) => scoreWithRubric(input)
  : createMockScorer();

const report = await runCalibration(CALIBRATION_SAMPLES, scorer, { mode });
console.log(formatCalibrationReport(report));

if (!report.passed) {
  console.error("\n存在分数漂移出期望分数带的维度，评分回归未通过。");
  process.exit(1);
}
