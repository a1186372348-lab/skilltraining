# AGENTS.md — skilltraining 项目开发指南

> 本文件是 AI 代理在本仓库工作的入口契约：先读这里建立整体认识，再按「文档路由」渐进读取需要的上下文。
> 修改本文件中的任何规范前，必须先取得用户确认。

---

## 1. 项目目标

**自适应产品经理训练平台（MVP / V1）**：每天通过一个真实产品问题训练产品判断力，让 AI 随长期交互越来越了解用户，持续指出真正需要提升的方向——不是题库，不是 AI 老师，而是一套长期、自适应的产品判断力训练系统。

- 目标用户：初级产品经理、转岗 PM、承担产品职责的非正式 PM（第一阶段不服务完全零基础用户）。
- 核心闭环：今日案例 → 作答 → 渐进提示（5 层，扣独立系数）→ AI 总监追问 → 终答 → 按 Rubric 评分 → 能力画像更新 → 反馈页。
- 需求唯一事实源：根目录 [`Prd.md`](Prd.md)（V1 锁定版）；锁定决策 D1~D27 全文与变更时间线见 [`maps/changelog.md`](maps/changelog.md)。

## 2. 架构概览

单仓 Next.js（App Router）+ TypeScript 应用：页面与 API Route Handlers 同仓，服务端领域逻辑集中在 `server/modules/`，PostgreSQL + Prisma 持久化，AI 能力经自建网关接入小米 MiMo（OpenAI 兼容 API）。

| 层 | 选型 |
|---|---|
| 框架 / UI | Next.js 16（App Router）+ React 19 + Tailwind CSS 4 |
| 数据库 | PostgreSQL（本地 docker-compose，宿主机端口 5433）+ Prisma |
| AI 接入 | `server/ai/` 自建网关，MiMo `mimo-v2.6-pro`，OpenAI 兼容 API |
| 输入验证 | zod（所有 API 边界必须 schema 验证，快速失败） |
| 认证 | 邮箱魔法链接（users + auth_identities 可扩展身份模型） |
| 题库内容 | YAML 文件（Git 管理）+ 脚本导入 DB，内容可评审、可 diff |
| 测试 | Vitest（node 环境），测试与源码同目录 |

### 目录布局

```
skilltraining/
├─ app/                        # Next.js App Router 页面与 API
│  ├─ page.tsx                 # P1 首页仪表盘
│  ├─ today/                   # P3 今日训练（三栏工作台）
│  ├─ profile/                 # P2 能力画像（3D 网络图）
│  ├─ history/                 # P5 训练历史
│  ├─ settings/                # P6 我的
│  ├─ baseline/                # 基线测评流程（注册后首次必做）
│  ├─ onboarding/              # 初始画像问卷
│  ├─ login/                   # 魔法链接登录
│  ├─ _dashboard/  _shared/    # 页面共享组件与视图模型（下划线前缀 = 非路由目录）
│  └─ api/                     # Route Handlers：auth / training / dashboard / profile / history / feedback-survey
├─ server/
│  ├─ modules/                 # 领域模块：auth training scoring selection profile content dashboard baseline feedback history
│  ├─ ai/                      # AI 网关：mimo-client.ts（MiMo 客户端）、followup.ts（追问生成）
│  ├─ lib/                     # 跨模块服务端工具：api-response.ts（统一响应封装）、prisma.ts（客户端单例）
│  └─ db.ts                    # PrismaClient 入口
├─ prisma/                     # schema.prisma 与 migrations
├─ content/questions/          # 题库 YAML（draft/ 为草稿区）
├─ scripts/                    # 运维脚本：内容校验/导入、测试库准备、MiMo 用量报告、评分校准等
├─ prototypes/                 # 视觉基准 HTML（只读，禁止修改；原型 B 为前端样式参照）
├─ docs/                       # 计划方案、评审、决策前材料
├─ maps/                       # 长期文档：changelog.md（决策记录+变更时间线）、architecture.md（架构）、features.md（功能参考）
└─ task/                       # 可执行任务包（T 编号）与验收证据
```

### 关键业务规则（速查，细节以 Prd.md §1.5 为准）

- `有效能力得分 = 原始表现分 × 独立完成系数`，系数 = `max(0.6, 1 − 0.1×首答前提示次数 − 0.05×追问阶段提示次数)`（BR-1/BR-2）。
- 案例背景五要素每字段必须携带真实来源引用（`{text, citations[]}`），无来源论断不得入库（BR-8 / D18）。
- 8 个能力一级维度；维度分 = 历史有效分简单平均；允许「未知」状态（BR-6）。
- 每次训练反馈必须输出一个具体可行动的「最需要优化的问题」，禁止泛泛结论（BR-7）。

## 3. 代码风格指南

- **语言**：TypeScript 严格模式；内部实现与注释可用中文，标识符用英文。
- **文件组织**：按领域/功能组织，不按文件类型。单文件典型 200~400 行，上限 800 行；函数小于 50 行；嵌套不超过 4 层。
- **模块分层**：页面（`app/`）只负责渲染与交互 → 调用 `app/api/` Route Handler → 委托 `server/modules/` 领域服务 → Prisma 持久化。Route Handler 内不写业务逻辑。
- **服务端模块形态**（参照 `server/modules/auth/`）：`service.ts`（业务编排）、`repository.ts`（数据访问）、`schemas.ts`（zod 校验）、`errors.ts`、`index.ts`（公开入口）；私有函数不跨模块导出。
- **页面形态**（参照 `app/baseline/`）：`page.tsx` + 组件 + `view-model.ts`（纯函数视图模型）+ `api.ts`（前端请求封装）。
- **API 响应**：统一使用 `server/lib/api-response.ts` 的 `jsonOk(data)` / `jsonError(status, code, message)`，成功 `{ success: true, data }`，失败 `{ success: false, error: { code, message } }`。
- **错误处理**：每一层处理错误，绝不静默吞掉；UI 给用户友好信息，服务端记录详细上下文；错误信息与日志不得泄露密钥或敏感数据。
- **受控状态变更**：不修改函数参数、外部传入对象或共享业务状态；跨模块传递数据用新副本表达变化。
- **路径别名**：`@/*` 指向仓库根（与 tsconfig、vitest 配置一致）。
- 检查命令：`npm run lint`、`npm run typecheck`，提交前必须全部通过。

## 4. 测试指南

- 测试框架 Vitest（node 环境），测试文件与源码同目录：`*.test.ts`（单元）、`*.integration.test.ts`（集成，需要数据库）。
- **测试库隔离（T14）**：全部测试运行于独立库 `skilltraining_test`，与开发库隔离；`npm test` 的 pretest 钩子自动建库并执行 `prisma migrate deploy`，无需手工准备。
- 新增或修改业务逻辑必须同步补测试；覆盖率目标 ≥ 80%；纯函数（如 `view-model.ts`、`coefficient.ts`）优先单测。
- 运行测试前确保本地 PostgreSQL（docker-compose）已启动。

## 5. 项目风格指南（文档与协作）

- **文档语言**：中文；文档分三区，各区的准入、更新触发与渐进读取规则见各自 README，写作前必读：
  - [`docs/`](docs/README.md)：计划方案、评审、决策前材料（未实现的目标方案）。
  - [`maps/`](maps/README.md)：已实现的当前事实地图与长期治理文档；代码行为变化必须在同一变更中更新对应地图。
  - [`task/`](task/README.md)：可执行任务包与验收证据；不得写入会话进度或流水。
- 已实现的事实提炼进 `maps/`，不复制方案全文；过期内容修订或删除，不追加历史段落。
- 任务状态枚举：`PENDING / IN_PROGRESS / DONE / BLOCKED / REMOVED_BY_USER`；`DONE` 必须附完成证据。

## 6. 用户体验准则

- **视觉基准**：`prototypes/prototype-b-dashboard.html`（只读）。左侧深色侧边栏 + 主区浅灰底（`#F5F6F8`）白色卡片微阴影；主色蓝 `#2563EB`；系统黑体栈（PingFang SC / Microsoft YaHei / Noto Sans SC）；大字号数字突出分数。
- **组件语言**：卡片、横向能力条形图、趋势火花线、状态标签（稳定 / 样本较少 / ↑ 上升中）、分段进度条、空态虚线卡；追问以对话气泡呈现（AI「总监」头像 + 用户头像）。
- **产品语气**：训练页保留「总监陪练」的温度；「为什么练这题」的理由前置展示，让自适应价值显性化；所有反馈必须具体可行动（BR-7）。
- 训练页为三栏工作台（D23）：宽屏锁定视口、一屏零裁切、卡片按需内滚；窄屏降级纵向堆叠。
- 新增页面或组件前先对照原型 B 与既有页面（如 `app/_dashboard/`）的实现方式，保持设计语言一致。

## 7. 约束条件与策略（禁止事项）

- **绝不直接提交或推送到 `main` 分支**；任何 `git commit / push / reset / rebase` 等变更操作必须取得用户当次明确授权。
- **密钥一律走环境变量**（`.env`，不入库不入 Git）；`MIMO_API_KEY` 仅存服务端，禁止下发前端（Prd.md §3.5）；发现泄露立即轮换。
- **`prototypes/` 只读**，禁止修改；它是视觉基准而非代码来源。
- 所有用户输入必须经 zod schema 验证；数据库访问一律走 Prisma 参数化查询，禁止拼接 SQL。
- AI 调用、登录、发信等公网/高成本端点必须保留限流（参照 `server/modules/auth/rate-limiter.ts`、`server/modules/training/rate-limit.ts`）。
- 真实用户数据、数据库内容、密钥不得写入任何文档（含 `docs/`、`maps/`、`task/`）。
- 执行中若任务文档与当前代码事实冲突，立即停止并在方案层解决，不擅自推进。
- 不做范围外修改：不顺手重构无关代码、不新增未经要求的依赖。

## 8. 仓库规范（Git 工作流）

- **分支命名**：`feat/T<编号>-<短描述>`（如 `feat/T21-extra-practice`）、`fix/<短描述>`、`docs/<短描述>`、`chore/<短描述>`；任务相关工作尽量携带 T 编号以便追溯。
- **工作流**：从 `main` 切功能分支 → 小步提交 → 完成后经用户确认再合并回 `main`；保持 `main` 始终可构建、可测试。
- **提交信息**：Conventional Commits（`feat: / fix: / docs: / chore: / test: / refactor:`），中文描述，涉及任务包时在末尾标注（如 `（T13）`）；参照现有 `git log` 风格。
- 提交前必须通过：`npm run lint`、`npm run typecheck`、`npm test`。

## 9. 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动开发服务器（需先启动本地 PostgreSQL） |
| `npm run build` / `npm start` | 生产构建 / 启动 |
| `npm run lint` | ESLint 检查 |
| `npm run typecheck` | 类型检查（含 next typegen） |
| `npm test` | 全部测试（pretest 自动准备隔离测试库） |
| `npm run db:migrate` | 开发库执行 Prisma 迁移 |
| `npm run content:validate` | 校验题库 YAML 契约 |
| `npm run content:import` | 题库 YAML 导入数据库 |
| `docker compose up -d` | 启动本地 PostgreSQL（端口 5433） |
| `/sync-docs` | Kimi 斜杠命令：分析未提交改动，按下方 DoD 同步 maps/ 文档并仅提交文档变更（项目级 Skill，见 `.kimi-code/skills/sync-docs/SKILL.md`） |

**命令文档治理规则**：本表只保留日常高频命令。随着脚本增多，完整命令手册（含各运维脚本用法、测试细则、环境与故障诊断）独立为 `maps/commands.md` 长期维护；届时本表保留高频项并链接过去，命令细节不堆回本文件。新增脚本时优先更新命令手册而非本表。

**文档同步完成定义（DoD）**：任何模块、API、数据契约、页面行为或功能入口的改动，必须在同一变更中同步对应长期文档事实，改动才算完成：

- 架构、分层、模块职责或交互方式变化 → 更新 [`maps/architecture.md`](maps/architecture.md)；
- 功能行为、用户入口或支撑模块变化 → 更新 [`maps/features.md`](maps/features.md) 对应小节；
- 每次合并到 main、发布或文档治理变化 → 在 [`maps/changelog.md`](maps/changelog.md) 变更时间线追加条目；
- 新锁定决策 → 全文追加到 [`maps/changelog.md`](maps/changelog.md)「决策记录」章节，其余文档只引用 D 编号。

未完成文档同步的改动一律视为未结束，不得汇报为「已完成」。日常同步使用 `/sync-docs` 一键执行「检查改动 → 更新文档 → 提交文档变更」流程：命令只提交文档文件，代码仍须通过检查后由用户自行提交。

## 10. 文档路由（大型上下文渐进读取）

本文件不内联大文档内容。需要以下上下文时，先用关键词/章节标题定位，再只读命中章节：

| 需要什么 | 去哪里 | 读取方式 |
|---|---|---|
| 产品需求、业务规则（BR）、页面清单 | [`Prd.md`](Prd.md) | 按章节号定位（§1.5 业务规则、§2 设计、§3 架构、§4 验收） |
| 已锁定决策全文（D1~D27）与项目演进时间线 | [`maps/changelog.md`](maps/changelog.md) | 按 D 编号 / 日期 / T 编号搜索 |
| 已实现模块/API/数据事实 | [`maps/`](maps/README.md)（地图陆续补齐） | 先在入口定位目标文档，再搜索章节 |
| 架构、模块职责、组件交互 | [`maps/architecture.md`](maps/architecture.md) | 按模块名或流程名搜索 |
| 功能概览、入口与支撑模块（改功能/修 bug 前定位） | [`maps/features.md`](maps/features.md) | 按 F 编号或功能名搜索 |
| 当前任务范围、验收、依赖 | [`task/`](task/README.md) 中对应 T 文件 | 任务文件完整读取，其引用的地图仍渐进读取 |
| 方案与决策前材料 | [`docs/`](docs/README.md) | 先搜索关键词，只读命中章节 |
| 完整命令手册、测试细则 | `maps/commands.md`（命令增多后建立） | 同上 |

全文读取仅限：文档维护、审计，或用户明确要求。
