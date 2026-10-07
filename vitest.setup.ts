// vitest 全局 setup：加载 .env（与 Next 运行时行为对齐），供 PrismaClient 读取 DATABASE_URL。
// 文件不存在时静默跳过（CI 可直接注入真实环境变量）。
try {
  process.loadEnvFile();
} catch {
  // 无 .env 文件：依赖外部环境变量
}

// T14 测试库与开发库隔离：全部测试统一指向独立测试库 skilltraining_test，
// 避免播种/归档搅乱开发库（skilltraining）的预览数据。
// 本文件先于任何测试模块执行，因此在任何 PrismaClient 实例化之前覆盖
// DATABASE_URL 即对全部用例生效；缺失 TEST_DATABASE_URL 时直接报错，
// 绝不静默回退开发库。
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "缺少 TEST_DATABASE_URL 环境变量：测试必须在独立测试库运行，禁止回退开发库。" +
      "请在 .env 中配置（可参考 .env.example）；npm run test 的 pretest 钩子会自动建库与迁移。",
  );
}
process.env.DATABASE_URL = testDatabaseUrl;
