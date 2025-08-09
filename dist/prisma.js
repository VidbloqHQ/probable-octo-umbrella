import { PrismaClient } from "@prisma/client";
const globalForPrisma = global;
export const db = globalForPrisma.prisma ||
    new PrismaClient({
        log: process.env.NODE_ENV === "development"
            ? ["query", "error", "warn"]
            : ["error"],
        errorFormat: process.env.NODE_ENV === "development" ? "pretty" : "minimal",
        // Important for PgBouncer compatibility
        datasources: {
            db: {
                url: process.env.DATABASE_URL
            }
        }
    });
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = db;
}
// Handle graceful shutdown
process.on("beforeExit", async () => {
    await db.$disconnect();
});
// Health check with smaller interval for Supabase
if (process.env.NODE_ENV === "development") {
    setInterval(async () => {
        try {
            await db.$queryRaw `SELECT 1`;
        }
        catch (error) {
            console.error("Database health check failed:", error);
        }
    }, 60000); // Every 60 seconds
}
export async function isDatabaseConnected() {
    try {
        await db.$queryRaw `SELECT 1`;
        return true;
    }
    catch {
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
