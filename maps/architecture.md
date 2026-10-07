# 架构地图（maps/architecture.md）

> 文档类型：已实现事实地图——架构与组件交互
> 负责范围：当前代码可证明的技术架构、分层、模块职责与主要组件交互方式
> 事实来源：`Prd.md` §3（设计蓝图）+ 仓库实际代码结构；与代码冲突时以代码为准
> 更新触发：新增/删除模块、模块职责变化、分层或数据流变化、技术选型变化——必须在同一变更中更新本文件，否则该改动不算完成

## 1. 技术架构总览

单仓 Next.js 16（App Router）+ TypeScript 应用：页面与 API Route Handlers 同仓，领域逻辑集中于 `server/modules/`，PostgreSQL + Prisma 持久化，AI 能力经自建网关接入小米 MiMo（OpenAI 兼容 API，模型 `mimo-v2.6-pro`）。

| 层 | 选型 | 关键约束 |
|---|---|---|
| 框架 / UI | Next.js 16 + React 19 + Tailwind CSS 4 | 页面只负责渲染与交互，不写业务逻辑 |
| API 层 | `app/api/` Route Handlers | 入参必须 zod 验证；响应统一走 `server/lib/api-response.ts`（`jsonOk` / `jsonError`） |
| 领域层 | `server/modules/` | 业务编排（service）与数据访问（repository）分离 |
| 数据层 | PostgreSQL + Prisma | 本地 docker-compose，宿主机端口 5433；一律参数化查询 |
| AI 层 | `server/ai/` 自建网关 | `MIMO_API_KEY` 仅存服务端，禁止下发前端；调用需限流与审计 |
| 内容层 | YAML 题库（`content/questions/`）+ 导入脚本 | 内容 Git 管理，可评审、可 diff、可回滚 |
| 认证 | 邮箱魔法链接（users + auth_identities） | 无密码存储；身份模型可扩展 |
| 测试 | Vitest（node 环境） | 独立测试库 `skilltraining_test`，与开发库隔离（T14） |

## 2. 分层与依赖方向

```
页面（app/ 各路由）
  → API 层（app/api/，zod 验证 + 统一响应封装）
    → 领域模块（server/modules/*，service → repository）
      → Prisma（server/db.ts / server/lib/prisma.ts）→ PostgreSQL
      → AI 网关（server/ai/*）→ MiMo 开放平台
```

- 依赖方向自上而下，领域模块不反向依赖页面或 Route Handler。
- 跨模块共享的服务端工具只放 `server/lib/`；模块私有函数不跨模块导出。

## 3. 领域模块职责（server/modules/）

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `auth` | 魔法链接登录、会话签发与校验、登录限流、邮件投递 | `service.ts` `session.ts` `token.ts` `rate-limiter.ts` `mailer.ts` |
| `training` | 训练会话状态机、渐进提示记录、独立完成系数、今日题视图、单会话工作台视图、产品训练大厅视图（T25）、加练、评分完成通知 | `state-machine.ts` `coefficient.ts` `today-view.ts` `hub-view.ts` `service.ts` |
| `scoring` | 按 Rubric 调 AI 评分、有效分计算、评分校准 | `rubric-scorer.ts` `calibration.ts` `service.ts` |
| `selection` | 自适应出题 v0.1（探索期/强化期两阶段选题） | — |
| `profile` | 能力画像读写（8 维度分数、观察次数、提示依赖特征） | — |
| `content` | 题库 YAML 读取与契约校验 | — |
| `baseline` | 基线测评流程（注册后首次必做，2 题覆盖 8 维） | — |
| `dashboard` | 首页仪表盘数据聚合；「当前训练」卡复用 `training` 的 `getCurrentTrainingCard`（T26 / D28②，单一事实源） | — |
| `feedback` | 训练后感知问卷 | — |
| `history` | 训练回放详情查询（T25 起仅详情——历史列表已由 training 大厅视图承接） | — |

AI 网关（`server/ai/`）：`mimo-client.ts`（MiMo OpenAI 兼容客户端）、`followup.ts`（AI 总监追问生成）。

## 4. 主要组件交互

### 4.1 今日训练主链路

打开今日训练 → `selection` 按画像选题 → 渲染训练页（三栏工作台）→ 用户逐级请求提示（记录次数与时间，回传当前系数）→ 首次提交（提示按钮消失）→ AI 网关生成总监追问（1~2 轮）→ 最终提交 → `scoring` 按 Rubric 评分 → `有效分 = 原始分 × 独立完成系数` → `profile` 更新画像 → 跳转反馈页 → 存感知问卷。详见 `Prd.md` §3.2 图 1。

### 4.2 自适应出题 v0.1

存在未知维度 → 探索期优先覆盖未知维度；否则 → 强化期取最低分弱项，叠加提示依赖特征；过滤已练与近期同类案例；匹配兴趣与难度；首次训练优先熟悉产品案例（D11）。详见 `Prd.md` §3.2 图 2。

### 4.3 基线测评

新用户完成初始画像问卷后强制进入（D19）：2 道综合题覆盖 8 维，复用训练闭环组件（`app/baseline/` + `BaselineFlow` 轮询推进，不跳反馈页），结果作为画像初始值，完成后解锁日常训练。

### 4.4 内容管线

YAML 题库（`content/questions/`，案例五要素每字段带 `{text, citations[]}` 来源引用，BR-8）→ `npm run content:validate` 契约校验 → `npm run content:import` 同步入库。

## 5. 基础设施

- 本地数据库：`docker-compose.yml`（PostgreSQL，宿主机 5433；Windows 下连接串用 `127.0.0.1`）。
- 测试隔离：`npm test` 的 pretest 钩子自动建 `skilltraining_test` 并执行 `prisma migrate deploy`。
- 部署目标（未实施）：云服务器 + Docker + Nginx + 云 RDS（D15）。
