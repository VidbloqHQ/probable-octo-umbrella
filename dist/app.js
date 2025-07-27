import express from "express";
import { createServer } from "http";
import { TenantRouter, UserRouter, StreamRouter, AgendaRouter, PaymentRouter, PollRouter, ParticipantRouter, QuizRouter, TenantMeRouter, ProgramRouter } from "./routes/index.js";
import { beaconHandler, authenticateTenant } from "./middlewares/index.js";
import { startEnhancedReconciliationJob } from "./services/participantReconciliation.js";
import createSocketServer from "./websocket.js";
const app = express();
const PORT = 8001;
const httpServer = createServer(app);
export const wss = createSocketServer(httpServer);
// IMPORTANT: Set up CORS BEFORE any other middleware
app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Set CORS headers for all requests
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,PATCH,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,x-api-key,x-api-secret,Authorization,Origin,X-Requested-With,Accept');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '86400');
    // Handle preflight OPTIONS requests immediately
    if (req.method === 'OPTIONS') {
        console.log(`Handling OPTIONS request for: ${req.url}`);
        return res.sendStatus(200);
    }
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(beaconHandler);
// Add body logging middleware for debugging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url} - Origin: ${req.headers.origin}`);
    next();
});
// Start the enhanced reconciliation job
startEnhancedReconciliationJob();
// Routes that don't require authentication
app.use("/tenant", TenantRouter.default);
// Apply authentication middleware to protected routes
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
app.all("*", (req, res) => {
    res.status(404).json({ error: `Route ${req.originalUrl} not found` });
});
httpServer.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
