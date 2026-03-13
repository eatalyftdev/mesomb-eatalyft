import express from "express";
import { collectPayment } from "../services/mesombService.js";
import { db } from "../config/firebase.js";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

router.post("/collect", async (req, res) => {
  try {
    const { phone, amount, userId, type } = req.body;
    const transactionRef = `EATALYFT-${type}-${Date.now()}-${uuidv4()}`;

    const response = await collectPayment({ phone, amount, transactionRef, service: "MTN" });

    await db.collection("transactions").doc(transactionRef).set({
      userId,
      phone,
      amount,
      type,
      status: "PENDING",
      createdAt: new Date(),
      providerResponse: response,
    });

    res.json({ success: true, transactionRef });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
