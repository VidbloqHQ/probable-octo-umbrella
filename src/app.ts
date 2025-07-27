import express, { Request, Response } from "express";
import { createServer } from "http";
import cors from "cors";
import {
  TenantRouter,
  UserRouter,
  StreamRouter,
  AgendaRouter,
  PaymentRouter,
  PollRouter,
  ParticipantRouter,
  QuizRouter,
  TenantMeRouter,
  ProgramRouter
} from "./routes/index.js";
import { beaconHandler, authenticateTenant } from "./middlewares/index.js";
import { startEnhancedReconciliationJob } from "./services/participantReconciliation.js";
import createSocketServer from "./websocket.js";

const app = express();
const PORT = 8001;
const httpServer = createServer(app);

export const wss = createSocketServer(httpServer);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// const corsOptions = {
//   origin: function (
//     origin: string | undefined,
//     callback: (err: Error | null, allow?: boolean) => void
//   ) {
//     // Always allow preflight requests from any origin
//     // The actual API requests will be filtered by the tenant auth middleware
//     callback(null, true);
//   },
//   methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
//   allowedHeaders: [
//     "Content-Type",
//     "x-api-key",
//     "x-api-secret",
//     "Authorization",
//   ],
//   credentials: true,
//   maxAge: 86400, // Cache preflight response for 24 hours
// };

// app.use(cors(corsOptions));

app.use((req: Request, res: Response, next) => {
  const origin = req.headers.origin;
  
  // Set CORS headers for all requests
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-api-key,x-api-secret,Authorization,Origin,X-Requested-With,Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(beaconHandler);
// app.options('*', cors(corsOptions));
// Add body logging middleware for debugging
app.use((req: Request, res: Response, next) => {
  // console.log(req)
  // console.log(`Request received: ${req.method} ${req.url}`);
  next();
});

// Start the enhanced reconciliation job
startEnhancedReconciliationJob();

app.use("/tenant", TenantRouter.default);

app.use(authenticateTenant);
app.use("/tenant/me", TenantMeRouter.default);
app.use("/user", UserRouter.default);
app.use("/stream", StreamRouter.default);
app.use("/pay", PaymentRouter.default);
app.use("/agenda", AgendaRouter.default);
app.use("/poll", PollRouter.default);
app.use("/participant", ParticipantRouter.default);
app.use("/quiz", QuizRouter.default);
app.use("/program", ProgramRouter.default);

app.all("*", (req: Request, res: Response) => {
  res.status(404).json({ error: `Route ${req.originalUrl} not found` });
});

httpServer.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});