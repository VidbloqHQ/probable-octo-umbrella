import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

// Create singleton with optimized pool settings
const prismaClientSingleton = () => {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" 
      ? ["error", "warn"] 
      : ["error"],
    errorFormat: process.env.NODE_ENV === "development" ? "pretty" : "minimal",
  });
};

export const db = globalForPrisma.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

// Handle graceful shutdown
process.on("beforeExit", async () => {
  await db.$disconnect();
});

process.on("SIGTERM", async () => {
  await db.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await db.$disconnect();
  process.exit(0);
});

export async function isDatabaseConnected(): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// import { PrismaClient } from "@prisma/client";

// const globalForPrisma = global as unknown as { prisma?: PrismaClient };

// // Configure Prisma with optimized settings
// export const db =
//   globalForPrisma.prisma ||
//   new PrismaClient({
//     log: process.env.NODE_ENV === "development" 
//       ? ["query", "error", "warn"] 
//       : ["error"],
//     // Add error formatting for better debugging
//     errorFormat: process.env.NODE_ENV === "development" ? "pretty" : "minimal",
//   });

// if (process.env.NODE_ENV !== "production") {
//   globalForPrisma.prisma = db;
// }

// // Handle graceful shutdown - THIS IS THE ONLY PLACE WHERE $disconnect() SHOULD BE
// process.on("beforeExit", async () => {
//   await db.$disconnect();
// });

// // Optional: Monitor connection pool health
// if (process.env.NODE_ENV === "development") {
//   setInterval(async () => {
//     try {
//       // This is a simple query to check connection health
//       await db.$queryRaw`SELECT 1`;
//     } catch (error) {
//       console.error("Database health check failed:", error);
//     }
//   }, 30000); // Check every 30 seconds in development
// }

// // Export a helper to check if the database is connected
// export async function isDatabaseConnected(): Promise<boolean> {
//   try {
//     await db.$queryRaw`SELECT 1`;
//     return true;
//   } catch {
//     return false;
//   }
// }