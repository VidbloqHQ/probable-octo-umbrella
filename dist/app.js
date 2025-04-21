import express from "express";
import { createServer } from "http";
import cors from "cors";
import { TenantRouter, UserRouter, StreamRouter, AgendaRouter, PaymentRouter, PollRouter, ParticipantRouter, QuizRouter, } from "./routes/index.js";
import { authenticateTenant } from "./middlewares/tenant-auth.middleware.js";
import createSocketServer from "./websocket.js";
const app = express();
const PORT = 8001;
const httpServer = createServer(app);
export const wss = createSocketServer(httpServer);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const corsOptions = {
    origin: function (origin, callback) {
        // Always allow preflight requests from any origin
        // The actual API requests will be filtered by the tenant auth middleware
        callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: [
        "Content-Type",
        "x-api-key",
        "x-api-secret",
        "Authorization",
    ],
    credentials: true,
    maxAge: 86400, // Cache preflight response for 24 hours
};
app.use(cors(corsOptions));
// Add body logging middleware for debugging
app.use((req, res, next) => {
    // console.log(req)
    next();
});
app.use("/tenant", TenantRouter.default.publicRoutes);
app.use("/tenant/me", TenantRouter.default.protectedRoutes);
app.use(authenticateTenant);
app.use("/user", UserRouter.default);
app.use("/stream", StreamRouter.default);
app.use("/pay", PaymentRouter.default);
app.use("/agenda", AgendaRouter.default);
app.use("/poll", PollRouter.default);
app.use("/participant", ParticipantRouter.default);
app.use("/quiz", QuizRouter.default);
app.all("*", (req, res) => {
    res.status(404).json({ error: `Route ${req.originalUrl} not found` });
});
httpServer.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
// api routes
// create a new tenant - give api key, access and secret key
// get all tenants
// get a tenant by id
// create a new user
// get all users under a tenant
// get a user by userId
// endpoints for tenant admin to login into dashboard
// {
//   "tenant": {
//     "id": "cm9oshzk0000001uyjw63y658",
//     "name": null,
//     "createdAt": "2025-04-19T22:28:27.840Z"
//   },
//   "apiKey": {
//     "id": "cm9osi037000201uydvtkd17q",
//     "name": "Default API Key",
//     "key": "sk_387e8a3efac84f8f7605d189aadb63dc",
//     "secret": "CPGri+uKDyVxt4L76yIz50PVdSpinI5jSBzjAOaGVnM=",
//     "createdAt": "2025-04-19T22:28:28.531Z",
//     "expiresAt": "2026-04-19T22:28:28.529Z"
//   }
// }
