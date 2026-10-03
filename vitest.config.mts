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
  },
});
