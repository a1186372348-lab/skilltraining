# T32 安全专项审查

结论：**PASS**。当前复核快照未发现阻断 T32 交付的认证、授权、结果提前揭晓、输入边界或敏感输出问题。

审查日期：2026-11-03
审查方式：只读源码、测试与脱敏验证证据；未操作数据库、API、Docker、Git、模型或浏览器。
适用范围：T32 本轮增量及其直接公开结果出口。工作区其他历史改动不据此宣称已审完。

## 一、审查中发现并已修复的问题

### SR-01（高，已修复）：周计划接口可绕过基线统一揭晓

初审发现以下公开出口未使用统一结果门禁：

- `GET /api/plans/current` 可在八个主题维度已有分、但低置信度加深题尚未完成时生成并返回含 `startScore`、`targetScore` 和当前分理由的计划；已有计划还会直接返回。
- `GET /api/plans/review` 可返回或生成含 `startScore`、`latestScore`、`scoreChange` 的回顾，并可能写入快照和归档计划。
- `POST /api/plans/reject` 可返回含分数的计划并修改状态。

现实现已在三处任何计划读取或写入前调用 `assertAbilityResultsVisible`，未完成基线统一返回 `409 BASELINE_REQUIRED`；非门禁异常继续抛出，不会误放行：

- `app/api/plans/current/handler.ts:30`：门禁先于计划读取/生成。
- `app/api/plans/review/handler.ts:28`：门禁先于回顾读取、快照生成和归档。
- `app/api/plans/reject/handler.ts:52`：门禁先于计划状态写入。

隔离测试证据验证了“八维均非 NULL + 活动加深题”时：不创建计划、不写回顾快照、不归档、不改变拒绝状态；完成标记写入后恢复正常。定向验证记录为 `.cache/v2-core-20261103/validation/v2_core_20261103_afd77d8d7407-target.log`，结果为 8 个文件、32 个用例通过；配套结果声明测试库为 `skilltraining_test`、schema 已核对、迁移与源码在测试期间未变化。

## 二、公开分数与反馈出口核对

| 出口 | 结果 | 可复核证据 |
|---|---|---|
| 首页 `GET /api/dashboard` | 通过。读取能力分、最近诊断前整页执行只读门禁；未完成基线返回 409，查询异常不会降级为可见。 | `server/modules/dashboard/service.ts:92`；`app/api/dashboard/route.ts` |
| 训练大厅 `GET /api/training/hub` | 通过。基线历史须本人、完成标记非空且存在参与证据；条件在数据库查询中先过滤，再排序并 `take 20`。日常历史按冻结契约保持原行为。 | `server/modules/training/hub-view.ts:201-204` |
| 历史详情 `GET /api/history/:id` | 通过。会话 id 与本人可见条件在同一查询中组合；未完成、预留、他人或不存在均为 404。题目只取白名单，不查询 `rubric`、`hintTree` 或未释放提示。 | `server/modules/history/repository.ts:23-61` |
| 能力画像 `GET /api/profile/ability` | 通过。本人存在任何未完成基线会话时整页 409；从无基线会话的旧用户保留访问。近期置信度按本人、同一维度、同一 Score 行读取，0 有效，非法值/NULL 降级为 NULL。 | `server/modules/profile/ability-page.ts:200-241` |
| 训练反馈 `GET /api/training/:id/feedback` | 通过。本人可见性查询发生在懒评分触发前；未完成基线、预留或越权均 404，不能安排或调用评分。对外错误采用固定安全文案。 | `server/modules/feedback/view.ts:70-101`；`app/api/training/[id]/feedback/handler.ts` |
| 周计划 current/review/reject | 通过。SR-01 的三处门禁均早于任何计划结果读取或状态写入。 | 三个 `app/api/plans/*/handler.ts` 上述行号 |
| 基线状态 `GET /api/training/baseline` | 通过。未完成阶段仅返回题目进度白名单；数值画像预览只在完整序列评分完成后装配。服务端内部待评分会话 id 不下发。 | `server/modules/baseline/service.ts:283-303`；`server/modules/baseline/schemas.ts` |
| 评分通知 `GET /api/training/score-notifications` | 通过。明确排除基线题，且不返回分值或评语。 | `server/modules/training/score-notifications.ts` |
| 单会话工作台与今日训练 | 通过。响应不含评分字段；基线会话由独立入口承接，题面视图不下发评分细则或未释放提示。 | `app/api/training/[id]/route.ts`；`server/modules/training/today-view.ts` |

统一条件位于 `server/modules/baseline/result-visibility.ts`：

- `visibleTrainingResultsWhere(userId)` 将本人约束覆盖所有 OR 分支；基线还要求 `baselineCompletedAt != null` 和激活、作答、提示、评分或有效状态之一。
- `assertAbilityResultsVisible` 只读判断“本人存在基线会话且画像完成标记为空”；无基线会话旧用户放行。查询失败原样抛出，符合失败关闭要求；未调用会写入或自愈的 `getBaselineStatus`。

## 三、其他安全控制

- **认证与令牌**：所有相关 API 先通过签名、过期校验后的 HttpOnly 会话 cookie 解析当前用户；生产 cookie 启用 Secure，SameSite=Lax。资源读取均以服务端解析的用户 id 过滤，不接受客户端 userId。
- **首登降级**：仅 `UserProfile.findUnique` 失败被隔离为首页落点，日志不记录异常对象或用户信息；认证核销、令牌签发以及后续基线状态异常未被吞掉。该分支仍会设置会话 cookie。
- **输入验证**：历史和反馈会话 id 使用 UUID schema；计划拒绝动作使用 zod 判别白名单；数据库访问使用 Prisma 结构化条件，未发现 SQL、命令、路径或文件注入面。
- **输出隐私**：历史、训练大厅、画像和反馈均显式选择/映射字段；未发现 `rubric`、评分 prompt、未释放提示、密钥、堆栈或原始 AI/数据库错误进入 API 响应。置信度只返回 0～100 整数或 NULL，不跨会话借值或求未定义平均。
- **限流**：反馈懒评分接口保留按登录用户的 AI 端点限流；认证限流、魔法链接单次核销和安全 cookie 行为未被本轮降级。

## 四、非阻断残余风险（本轮前已存在）

1. **中等：基线状态轮询可补触发高成本评分，但没有独立端点限流。** `GET /api/training/baseline` 依赖进程内 inflight 去重和评分幂等；在多实例并发或持续失败下仍可能放大第三方调用成本。该行为不是 T32 新增，建议后续增加用户级、跨实例可共享的限流或租约，不要求在本轮扩改。
2. **低：部分服务端日志记录原始错误对象或 message。** `server/modules/scoring/trigger.ts` 会记录后台评分原始错误对象，`server/modules/dashboard/service.ts` 会记录卡片加载错误 message。API 对外已脱敏，但日志侧仍建议后续改为错误类别、状态码和内部关联 id 的结构化白名单，避免供应商或数据库异常文本进入日志。

上述两项不改变本次 PASS：它们不是 T32 引入，也不构成当前已确认的越权或结果提前揭晓路径。

## 五、复核快照哈希

以下文件若后续发生变化，本结论对应部分需重新复核：

```text
3ced79f245bc164eaefbff690d7b1b768946d609337b6c468f6932a7dd685130  server/modules/baseline/result-visibility.ts
6cd3610e63d958f1a00cadf431b330f0bc62d90ff5132c6da45393ae3162b7c7  server/modules/training/hub-view.ts
862840093e1048b28eb80201185db53dd36ebf6cf15d1afe2ec9b8e4ebe64d56  server/modules/history/repository.ts
63aaf1cd29992ad9730e4f246dfbba91e086c42ed8711ebbc786f4e92375b038  server/modules/feedback/view.ts
e672f49f343a13e90a43efa2ced7f7d13befc92b99e0199ca797a5d3a45f71b4  server/modules/profile/ability-page.ts
2c0455759bfe239e3c32150c821f053b1796d9ea57f08908ce1135aab1fa7630  server/modules/dashboard/service.ts
9fda1ff1ceb6fa2cbfae96bf908610e9771c7710014d688b35b66923cc1b83a8  server/modules/auth/post-login.ts
f493d70436aa2ee08b3f0668a32c58be70d69113ccae04a4617122ca2816a088  server/modules/scoring/service.ts
8448af0e2077c2a9df2dff7af2ed99c46e8bd9557b0cb7c52698715fed25f9a3  app/api/plans/current/handler.ts
2b78276909b3c299ce73112890a0417c3b6c52bd5d8c60326cf2d536b091dc7e  app/api/plans/review/handler.ts
ec190f275d4306d3537d599002ef55c9126510ade33670ffc1e31b109eb90b64  app/api/plans/reject/handler.ts
```
