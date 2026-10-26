import { PrismaClient } from "@prisma/client";
const shared = globalThis as unknown as { devhubPrisma?: PrismaClient };
export const db = shared.devhubPrisma ?? new PrismaClient({ log: ["error", "warn"] });
if (process.env.NODE_ENV !== "production") shared.devhubPrisma = db;
