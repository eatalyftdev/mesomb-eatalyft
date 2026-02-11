import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PaymentOperation } from "@hachther/mesomb";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/*
|--------------------------------------------------------------------------
| Initialize MeSomb Client
|--------------------------------------------------------------------------
*/
const client = new PaymentOperation({
  applicationKey: process.env.MESOMB_APP_KEY,
  accessKey: process.env.MESOMB_ACCESS_KEY,
  secretKey: process.env.MESOMB_SECRET_KEY,
});

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/
app.get("/", (req, res) => {
  res.json({ status: "EataLyft Payment API Running 🚀" });
});

/*
|--------------------------------------------------------------------------
| Collect Payment (Mobile Money)
|--------------------------------------------------------------------------
*/
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, service = "MTN" } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({
        error: "Phone and amount are required"
      });
    }

    const response = await client.makeCollect({
      payer: phone,
      amount,
      service, // MTN or ORANGE
      country: "CM",
      currency: "XAF"
    });

    res.json(response);

  } catch (error) {
    console.error("Payment Error:", error.message);
    res.status(500).json({
      error: error.message
    });
  }
});

/*
|--------------------------------------------------------------------------
| Get Transaction Status
|--------------------------------------------------------------------------
*/
app.get("/transactions/:id", async (req, res) => {
  try {
    const response = await client.getTransactions([req.params.id]);
    res.json(response);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/*
|--------------------------------------------------------------------------
| MeSomb Webhook
|--------------------------------------------------------------------------
*/
app.post("/webhook/mesomb", (req, res) => {
  try {
    const event = req.body;

    console.log("Webhook received:", event);

    /*
      TODO:
      - Validate webhook signature
      - Update Firebase wallet
      - Update ride status
    */

    res.sendStatus(200);

  } catch (error) {
    console.error("Webhook Error:", error);
    res.sendStatus(500);
  }
});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 EataLyft Payment Service running on port ${PORT}`);
});
