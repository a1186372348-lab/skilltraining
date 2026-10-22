import path from "node:path";

import { defineConfig } from "vitest/config";

// vitest 配置：Node 环境跑服务端纯函数单测；别名与 tsconfig 的 "@/*" 保持一致
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // 项目暂存目录（gitignored）：.cache 下的调试脚本不是测试，不参与跑测（与 eslint 忽略口径一致）
    exclude: [".cache/**", "**/node_modules/**"],
  },
});
