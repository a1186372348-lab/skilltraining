import { createHash } from "node:crypto";

// 内容 id（如 Q01）到 questions 表主键（uuid）的确定性映射
// 用 RFC 4122 UUID v5（SHA-1，命名空间 + 名称）：同一内容 id 永远得到同一 uuid，
// 导入脚本据此按主键 upsert，重复执行幂等、不产生重复记录

// 本题库专用命名空间（随机生成一次后固定，勿改；改动等于换掉全部题目主键）
const CONTENT_NAMESPACE = "38f80d11-3d77-4949-a16a-88b583a74f0c";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// RFC 4122 §4.3：uuid = sha1(namespace_bytes + name)，置 version=5 与 variant 位
export function uuidV5(name: string, namespace: string): string {
  if (!UUID_RE.test(namespace)) {
    throw new Error(`非法 uuid 命名空间：${namespace}`);
  }
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const bytes = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 内容 id -> 数据库主键 uuid
export function questionUuid(contentId: string): string {
  return uuidV5(contentId, CONTENT_NAMESPACE);
}
