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
  res.send("Mesomb Payment Microservice Running 🚀");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
