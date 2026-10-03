// vitest 全局 setup：加载 .env（与 Next 运行时行为对齐），供 PrismaClient 读取 DATABASE_URL。
// 文件不存在时静默跳过（CI 可直接注入真实环境变量）。
try {
  process.loadEnvFile();
} catch {
  // 无 .env 文件：依赖外部环境变量
}
