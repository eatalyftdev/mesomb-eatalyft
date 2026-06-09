  import express from "express";
  import dotenv from "dotenv";
  import cors from "cors";

  import paymentRoutes from "./routes/payments.js";
  import webhookRoutes from "./routes/webhooks.js";

  dotenv.config();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use("/api/payments", paymentRoutes);
  app.use("/webhooks", webhookRoutes);

  app.get("/", (req, res) => {
    res.json({
      service: "EataLyft Payment Microservice",
      status: "running",
      endpoints: {
        collect:        "POST /api/payments/collect",
        deposit:        "POST /api/payments/deposit",
        refund:         "POST /api/payments/refund",
        transactions:   "GET  /api/payments/transactions?ids=id1,id2&source=MESOMB",
        checkTrx:       "GET  /api/payments/transactions/check?ids=id1,id2&source=MESOMB",
        appStatus:      "GET  /api/payments/status",
        webhook:        "POST /webhooks/mesomb",
      },
    });
  });

  // ==============================
  // 🚀 START SERVER
  // ==============================

  const PORT = process.env.PORT || 8080;

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 EataLyft Payment Engine running on ${PORT}`);
  });
