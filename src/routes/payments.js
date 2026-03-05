import express from "express";
import { collectPayment } from "../services/mesombService.js";
import { db } from "../config/firebase.js";

const router = express.Router();

router.post("/collect", async (req, res) => {
  try {
    const { phone, amount, userId } = req.body;
    const trxID = `EATA-${Date.now()}`;

    const response = await collectPayment({ phone, amount, trxID });

    await db.collection("transactions").doc(trxID).set({
      userId,
      phone,
      amount,
      status: "PENDING",
      createdAt: new Date(),
      providerResponse: response,
    });

    res.json({ success: true, trxID });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
