import type { PrismaClient } from "@prisma/client";
import { withUserTransaction } from "@/server/lib/user-transaction";
import { getPackAvailabilityInTransaction } from "./availability";
import {
  abandonPackInTransaction, createPackInTransaction, getActivePackInTransaction, getPackInTransaction,
} from "./lifecycle";
import { openPackItemInTransaction, type PackClockOptions } from "./opening";

export { abandonPackInTransaction, createPackInTransaction, getActivePackInTransaction, getPackInTransaction } from "./lifecycle";
export { openPackItemInTransaction } from "./opening";
export { getPackAvailabilityInTransaction } from "./availability";

export function getPackAvailability(db: PrismaClient, userId: string, dimensions: readonly string[]) {
  return withUserTransaction(db, userId, context => getPackAvailabilityInTransaction(context, dimensions));
}

export function createPack(db: PrismaClient, userId: string, dimension: string) {
  return withUserTransaction(db, userId, context => createPackInTransaction(context, dimension));
}

export function getActivePack(db: PrismaClient, userId: string) {
  return withUserTransaction(db, userId, getActivePackInTransaction);
}

export function getPack(db: PrismaClient, userId: string, packId: string) {
  return withUserTransaction(db, userId, context => getPackInTransaction(context, packId));
}

export function openPackItem(db: PrismaClient, userId: string, packId: string, orderIndex: number, options?: PackClockOptions) {
  return withUserTransaction(db, userId, context => openPackItemInTransaction(context, packId, orderIndex, options));
}

export function abandonPack(db: PrismaClient, userId: string, packId: string, options: { confirmed: boolean }) {
  return withUserTransaction(db, userId, context => abandonPackInTransaction(context, packId, options));
}
