# 训练台 · 自适应产品经理训练平台

每天通过一个真实产品问题训练产品判断力，让 AI 随长期交互越来越了解用户。需求与架构见根目录 `Prd.md`（V1 锁定版）。

## 技术栈

- 应用框架：Next.js（App Router）+ TypeScript
- UI：Tailwind CSS
- 数据库：PostgreSQL 16（Docker）+ Prisma
- 测试：vitest
- AI 接入：DeepSeek（OpenAI 兼容 API，模型 `deepseek-flash`；密钥仅存服务端环境变量）

## 环境准备

- Node.js 24 + npm（不使用 pnpm）
- Docker Desktop（本地 PostgreSQL 容器）

## 启动步骤

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（复制模板后按需修改；.env 不提交仓库）
cp .env.example .env

# 3. 启动本地 PostgreSQL 16（容器名 skilltraining-postgres）
docker compose up -d

# 4. 执行数据库迁移（对空库创建全部 11 张表）
npm run db:migrate

# 5. 启动开发服务器
npm run dev
```

打开 http://localhost:3000 。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 生产构建 |
| `npm run start` | 启动生产服务器 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint 检查 |
| `npm run test` | 运行 vitest 测试 |
| `npm run db:migrate` | 开发环境执行 Prisma 迁移 |
| `npm run db:deploy` | 生产/部署环境应用迁移 |

合并前须通过：`npm run typecheck && npm run lint && npm run test && npm run build`。

## 目录结构

```
├─ app/                  # Next.js 页面（App Router）与 api/ Route Handlers
├─ server/
│  ├─ modules/           # 业务模块：selection 出题 / training 会话 / scoring 评分 / profile 画像 / content 题库
│  └─ ai/                # LLM 网关（追问生成、Rubric 评分；密钥不下发前端）
├─ prisma/               # schema 与 migrations（11 张表，见 Prd.md 3.4）
├─ content/questions/    # 题库 YAML（Git 管理，人工 + AI 半自动生产）
├─ scripts/              # 题库导入等脚本
├─ prototypes/           # 只读视觉基准（勿修改）
└─ docker-compose.yml    # 本地 PostgreSQL 16
```

## 注意事项

- **端口**：本机若已有原生 PostgreSQL 占用 5432，容器映射在宿主机 **5433**；`DATABASE_URL` 请使用 `127.0.0.1` 而非 `localhost`（Windows 下 `localhost` 可能解析到 IPv6，Docker 端口映射仅生效于 IPv4）。
- **密钥**：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 配置 DeepSeek 接入（AI 网关，OpenAI 兼容，模型 `deepseek-flash`）；严禁提交真实密钥。
- **测试隔离**：全部测试运行于独立库 `skilltraining_test`（`.env` 中的 `TEST_DATABASE_URL`），与开发库 `skilltraining` 完全隔离；`npm run test` 的 `pretest` 钩子自动完成建库与迁移（幂等，可重复执行），测试播种不会改动开发库数据。
- **类型生成**：`app/layout.tsx` 等使用的 `LayoutProps` 等路由类型由 Next 生成到 `.next/`（不提交仓库）；`npm run typecheck` 已内置 `next typegen`，全新克隆可直接运行。
- 本地开发数据库账号密码仅用于本机容器，禁止在生产环境复用。
