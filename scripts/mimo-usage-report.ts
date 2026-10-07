// MiMo 用量监控汇总脚本（T23）：按行扫描日志中的 ai.mimo.chat_completion 审计事件，
// 输出调用量 / 成功率 / 错误分布 / 重试 / 耗时 / token 用量 / 截空的健康度汇总。
// 用法：
//   node scripts/mimo-usage-report.ts <日志文件>
// 日志来源：dev 服务器任务输出文件、生产 stdout 采集文件；非 JSON 行自动跳过，无需环境变量。
// 退出码：参数缺失或文件不可读 → 1；正常输出 → 0
import { readFileSync } from "node:fs";

import { formatMimoUsageReport, summarizeMimoUsage } from "./lib/mimo-usage.ts";

const USAGE = "用法：node scripts/mimo-usage-report.ts <日志文件路径>";

const logfile = process.argv[2];
if (!logfile) {
  console.error(`缺少日志文件参数。\n${USAGE}`);
  process.exit(1);
}

let logText: string;
try {
  logText = readFileSync(logfile, "utf8");
} catch {
  console.error(`无法读取日志文件：${logfile}（文件不存在或不可读）\n${USAGE}`);
  process.exit(1);
}

console.log(formatMimoUsageReport(summarizeMimoUsage(logText)));
