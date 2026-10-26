import type { NextConfig } from "next";
const config: NextConfig = { serverExternalPackages: ["@prisma/client", "bullmq", "ioredis"] };
export default config;
