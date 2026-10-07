// T14：测试库与开发库隔离 —— npm pretest 钩子（node --env-file=.env 加载环境变量）
// 流程：解析 TEST_DATABASE_URL -> 库不存在则在 docker PG 的 postgres 维护库中 CREATE DATABASE
// -> 以 DATABASE_URL=TEST_DATABASE_URL 执行 prisma migrate deploy。
// 全程幂等，重复运行无副作用；绝不回退到开发库。

import { spawnSync } from "node:child_process";

// 本地 docker-compose 的 PG 容器名（见 README「启动步骤」）
const PG_CONTAINER = "skilltraining-postgres";
const MAINTENANCE_DB = "postgres";

function fail(message: string): never {
  console.error(`[prepare-test-db] 失败：${message}`);
  process.exit(1);
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 同步执行命令；可执行文件缺失时给出可读错误 */
function run(command: string, args: string[], options: { shell?: boolean; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
  });
  if (result.error) {
    fail(`无法执行 ${command}：${result.error.message}（请确认 Docker Desktop 已启动）`);
  }
  return result as RunResult;
}

/** 在容器内执行 psql（返回 stdout；失败由调用方按 status 处理） */
function psql(pgUser: string, args: string[]): RunResult {
  return run("docker", ["exec", PG_CONTAINER, "psql", "-U", pgUser, "-d", MAINTENANCE_DB, ...args]);
}

function main(): void {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    fail("缺少 TEST_DATABASE_URL 环境变量。请在 .env 中配置（可参考 .env.example），测试必须在独立测试库运行，禁止回退开发库。");
  }

  let pgUser: string;
  let testDbName: string;
  try {
    const url = new URL(testDatabaseUrl);
    pgUser = decodeURIComponent(url.username);
    testDbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    fail(`TEST_DATABASE_URL 不是合法的连接串：${testDatabaseUrl}`);
  }
  if (!pgUser || !testDbName) {
    fail("TEST_DATABASE_URL 缺少用户名或库名。");
  }

  // 1. 判断测试库是否存在（psql -lqt 列出全部库，首列即库名）
  const list = psql(pgUser, ["-lqt"]);
  if (list.status !== 0) {
    fail(`无法连接容器 ${PG_CONTAINER} 的 PostgreSQL：${list.stderr.trim()}\n请先执行 docker compose up -d。`);
  }
  const exists = list.stdout
    .split("\n")
    .some((line) => line.split("|")[0]?.trim() === testDbName);

  // 2. 不存在则在 postgres 维护库中创建（幂等）
  if (exists) {
    console.log(`[prepare-test-db] 测试库 ${testDbName} 已存在，跳过创建。`);
  } else {
    const create = psql(pgUser, ["-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${testDbName}"`]);
    if (create.status !== 0) {
      fail(`创建测试库 ${testDbName} 失败：${create.stderr.trim()}`);
    }
    console.log(`[prepare-test-db] 已创建测试库 ${testDbName}。`);
  }

  // 3. 对测试库应用全部迁移（migrate deploy 本身幂等）
  console.log(`[prepare-test-db] 对 ${testDbName} 执行 prisma migrate deploy ...`);
  const migrateEnv = { ...process.env, DATABASE_URL: testDatabaseUrl };
  // Windows 下 npx 是 .cmd 脚本，需经 shell 执行；整条命令作为单字符串传入（避免 DEP0190）
  const migrate =
    process.platform === "win32"
      ? run("npx prisma migrate deploy", [], { shell: true, env: migrateEnv })
      : run("npx", ["prisma", "migrate", "deploy"], { env: migrateEnv });
  process.stdout.write(migrate.stdout);
  process.stderr.write(migrate.stderr);
  if (migrate.status !== 0) {
    fail(`prisma migrate deploy 失败（exit ${migrate.status}）。`);
  }
  console.log("[prepare-test-db] 测试库已就绪。");
}

main();
