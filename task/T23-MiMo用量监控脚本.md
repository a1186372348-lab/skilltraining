# T23 MiMo 用量监控汇总脚本

状态：IN_PROGRESS（2026-10-07 立项，产品负责人在 D25⑥ 中选定"写监控汇总脚本"方案）

## 目标

提供一个零依赖的命令行脚本，输入包含 `ai.mimo.chat_completion` 审计事件的日志文件，输出 MiMo 调用的健康度汇总：调用量、成功率、按错误类型（timeout/failed）分布、重试率与重试次数分布、耗时统计（平均/最大）、token 用量统计（prompt/completion 的平均与峰值）。用于上线前建立"定期看一眼失败率"的监控习惯；判断标准沿用 D25⑤：token 观测峰值 × 约 2 倍余量校验预算上限。

## 范围外

- 实时告警、面板、持久化指标系统（V2 议题）；
- 非 ai.mimo.chat_completion 事件的解析（training.followup_generation_failed 等业务事件本次不汇总——审计事件已含 error 字段足够判读）；
- 修改任何服务端/前端运行时代码。

## 事实来源与前置依赖

- 审计事件形状：`server/ai/mimo-client.ts` chatCompletion 输出 `{"event":"ai.mimo.chat_completion","model","status","attempts","latencyMs","promptTokens"?,"completionTokens"?,"error"?}`（成功无 error；失败 error 为 "timeout" 或 "failed"）；
- 日志来源：dev 服务器任务输出文件、未来生产 stdout 采集文件；脚本按行扫描、容错非 JSON 行；
- 脚本惯例：`node --env-file=.env scripts/<name>.ts <参数>`（本脚本无需 env，但保持同一调用形态）；现有脚本参考 `scripts/scoring-calibration.ts`、`scripts/regen-followup.ts`。

## 受影响模块/数据/接口

- 新增：`scripts/mimo-usage-report.ts`（唯一交付物）；
- 可选配套：脚本头部的用法注释（输入日志路径，缺省提示如何找到 dev 日志）；不改 package.json（用 `node scripts/mimo-usage-report.ts <logfile>` 调用即可）；
- 无 schema、无依赖、无运行时改动。

## 可执行步骤（TDD）

1. 将「日志行解析 + 汇总计算」抽为纯函数（可测试）：输入多行文本，输出结构化汇总（总调用数、成功/失败数、按 error 类型分布、attempts 分布、latencyMs 平均/最大、promptTokens 与 completionTokens 的平均/最大、含 error 但 status=200 的"空内容"次数——该值是截空频率的关键指标）。
2. 单测覆盖：混合 JSON 行与非 JSON 行、成功与失败事件、缺 usage 字段的事件、空输入。
3. CLI 入口：读取参数指定的日志文件 → 调用纯函数 → 格式化输出（中文、对齐列、含判断提示：completion 峰值相对当前 4096 预算的余量倍数）。
4. 用当天真实 dev 日志实测一遍，把输出样例贴入本文件完成证据。

## 失败与回滚

- 纯新增脚本，删除即回滚；不影响任何运行时路径。

## 验收条件与完成证据

- 纯函数单测全绿；`npm run typecheck && npm run lint` 通过；
- 对真实 dev 日志运行输出合理汇总（贴样例）。

## 完成证据（2026-10-07）

- 交付：`scripts/lib/mimo-usage.ts`（纯函数 summarizeMimoUsage + formatMimoUsageReport）+ `scripts/mimo-usage-report.ts`（CLI）+ `scripts/lib/mimo-usage.test.ts`（15 用例）；vitest 默认 include 自动收录 scripts 测试。
- 门禁：66 文件 704 测试全绿（基线 689 + 新增 15）、typecheck、lint 通过。
- 真实日志实测（当日 dev 日志，3 条审计事件）：成功率 33.3%（timeout 1 / failed 1）、平均 attempts 3.00、截空 1 次、completion 峰值 1935 → 对 4096 预算余量 2.1 倍，脚本判定「健康」（D25⑤ 标准）；同日高负载特征（重试率 66.7%）被完整呈现，监控价值实证。
- 不一致说明：`missingUsage` 仅统计成功事件（失败事件本就不带 usage，计入会失真），报告行已注明。
