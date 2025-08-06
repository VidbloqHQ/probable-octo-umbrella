// import { PrismaClient } from "@prisma/client";
// const globalForPrisma = global as unknown as { prisma?: PrismaClient };
// export const db = globalForPrisma.prisma || new PrismaClient();
// if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
import { PrismaClient } from "@prisma/client";
const globalForPrisma = global;
// Configure Prisma with optimized settings
export const db = globalForPrisma.prisma ||
    new PrismaClient({
        log: process.env.NODE_ENV === "development"
            ? ["query", "error", "warn"]
            : ["error"],
        // Add error formatting for better debugging
        errorFormat: process.env.NODE_ENV === "development" ? "pretty" : "minimal",
    });
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = db;
}
// Handle graceful shutdown
process.on("beforeExit", async () => {
    await db.$disconnect();
});
// Optional: Monitor connection pool health
if (process.env.NODE_ENV === "development") {
    setInterval(async () => {
        try {
            // This is a simple query to check connection health
            await db.$queryRaw `SELECT 1`;
        }
        catch (error) {
            console.error("Database health check failed:", error);
        }
    }, 30000); // Check every 30 seconds in development
}
// Export a helper to check if the database is connected
export async function isDatabaseConnected() {
    try {
        await db.$queryRaw `SELECT 1`;
        return true;
    }
    catch {
        return false;
    }
}
