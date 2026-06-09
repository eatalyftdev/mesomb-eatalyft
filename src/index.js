import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());

// ─── IMPORTANT: Mount the webhook router BEFORE express.json() ───────────
// The webhook route needs the raw body buffer for HMAC signature verification.
// express.raw() is applied inside the webhooks router itself (scoped).
import webhookRoutes from "./routes/webhooks.js";
app.use("/webhooks", webhookRoutes);

// ─── JSON middleware for all other routes ─────────────────────────────────
app.use(express.json());

import paymentRoutes from "./routes/payments.js";
app.use("/api/payments", paymentRoutes);

// ─── Health / discovery ───────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    service: "EataLyft Payment Microservice",
    version: "2.0.0",
    status:  "running",
    endpoints: {
      collect:      "POST /api/payments/collect",
      deposit:      "POST /api/payments/deposit",
      refund:       "POST /api/payments/refund",
      transactions: "GET  /api/payments/transactions?ids=id1,id2&source=MESOMB",
      checkTrx:     "GET  /api/payments/transactions/check?ids=id1,id2&source=MESOMB",
      appStatus:    "GET  /api/payments/status",
      webhook:      "POST /webhooks/mesomb",
    },
    config: {
      mesombConfigured:   !!(process.env.MESOMB_APPLICATION_KEY && process.env.MESOMB_ACCESS_KEY),
      webhookSecured:     !!process.env.MESOMB_WEBHOOK_SECRET,
      supabaseConfigured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      firebaseConfigured: !!process.env.FIREBASE_PROJECT_ID,
      livemode:           process.env.MESOMB_LIVEMODE !== "false",
    },
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "localhost", () =>
  console.log(`EataLyft Payment Engine running on port ${PORT}`)
);
