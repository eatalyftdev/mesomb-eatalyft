import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { PaymentOperation } from "@hachther/mesomb";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ==============================
// 🔐 Initialize MeSomb Client
// ==============================

const mesomb = new PaymentOperation({
  applicationKey: process.env.MESOMB_APP_KEY,
  accessKey: process.env.MESOMB_ACCESS_KEY,
  secretKey: process.env.MESOMB_SECRET_KEY,
});

// ==============================
// 🔧 Generic Payment Handler
// ==============================

const handlePayment = async (req, res, serviceType) => {
  try {
    const { phone, amount, operator, userId, referenceId } = req.body;

    // ✅ Always generate unique reference & nonce
    const transactionRef = referenceId
      ? `${referenceId}-${Date.now()}-${uuidv4()}` // append unique suffix
      : `EATALYFT-${serviceType}-${Date.now()}-${uuidv4()}`;

    const nonce = uuidv4();

    const response = await mesomb.makeCollect({
      payer: phone,
      amount,
      service: operator, // MTN or ORANGE
      currency: "XAF",
      country: "CM",
      customer: {
        firstName: "EataLyft",
        lastName: serviceType,
        email: "support@eatalyft.com",
      },
      products: [
        {
          name: `${serviceType} Payment`,
          category: serviceType,
          quantity: 1,
          amount,
        },
      ],
      location: {
        town: "Bamenda",
        region: "North-West",
        country: "CM",
      },
      reference: transactionRef,
      nonce: nonce, // 🔑 unique per transaction
    });

    // Optional: store transaction in DB here for idempotency check
    // await Payment.create({ userId, transactionRef, amount, status: "pending" });

    return res.json({
      success: response.isOperationSuccess(),
      transactionId: response.transactionId,
      reference: transactionRef,
    });

  } catch (error) {
    console.error(`${serviceType} Payment Error:`, error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ==============================
// 🚕 RIDE PAYMENT
// ==============================

app.post("/api/pay/ride", (req, res) =>
  handlePayment(req, res, "Ride")
);

// ==============================
// 🍔 FOOD PAYMENT
// ==============================

app.post("/api/pay/food", (req, res) =>
  handlePayment(req, res, "Food")
);

// ==============================
// 📦 PARCEL PAYMENT
// ==============================

app.post("/api/pay/parcel", (req, res) =>
  handlePayment(req, res, "Parcel")
);

// ==============================
// 💳 WALLET FUNDING
// ==============================

app.post("/api/pay/wallet", (req, res) =>
  handlePayment(req, res, "Wallet")
);

// ==============================
// 🔄 REFUND (Optional)
// ==============================

app.post("/api/refund", async (req, res) => {
  try {
    const { transactionId } = req.body;
    const result = await mesomb.refund(transactionId);

    return res.json({
      success: true,
      result,
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================
// 🔔 WEBHOOK ENDPOINT
// ==============================

app.post("/api/webhook", async (req, res) => {
  try {
    const payload = req.body;

    console.log("Webhook Received:", payload);

    if (payload.status === "SUCCESS") {
      const reference = payload.reference;

      // 🔥 Update Firestore or DB:
      // - Mark ride/food/parcel paid
      // - If wallet → increase balance
      // - Log transaction
      console.log("Payment Successful:", reference);
    }

    return res.status(200).send("OK");

  } catch (error) {
    console.error("Webhook Error:", error);
    return res.status(500).send("Error");
  }
});

// ==============================
// 🔎 GET TRANSACTION STATUS
// ==============================

app.get("/api/transaction/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const result = await mesomb.getTransactions([id]);
    return res.json(result);

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================

app.listen(process.env.PORT, () => {
  console.log(`🚀 EataLyft Payment Engine Running on ${process.env.PORT}`);
});
