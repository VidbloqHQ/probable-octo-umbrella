import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

// import { PrismaClient } from "@prisma/client";

// const globalForPrisma = global as unknown as { prisma?: PrismaClient };

// const prismaClientSingleton = () => {
//   return new PrismaClient({
//     datasources: {
//       db: {
//         url: process.env.DATABASE_URL,
//       },
//     },
//     log: 
//       process.env.NODE_ENV === "development" 
//         ? ["query", "error", "warn"] 
//         : ["error"],
//     errorFormat: "minimal",
//   });
// };

// export const db = globalForPrisma.prisma ?? prismaClientSingleton();

// if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

// // Graceful shutdown
// if (process.env.NODE_ENV === "production") {
//   process.on("beforeExit", async () => {
//     await db.$disconnect();
//   });
// }