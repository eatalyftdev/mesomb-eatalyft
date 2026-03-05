import express from "express";
import { db } from "../config/firebase.js";

const router = express.Router();

router.post("/mesomb", async (req, res) => {
  try {
    const payload = req.body;

    // ⚠️ Always respond fast
    res.status(200).send("OK");

    const trxID = payload.trxID;

    const transactionRef = db.collection("transactions").doc(trxID);
    const doc = await transactionRef.get();

    if (!doc.exists) return;

    const transaction = doc.data();

    // Prevent duplicate processing
    if (transaction.status === "SUCCESS") return;

    if (payload.status === "SUCCESS") {

      await db.runTransaction(async (t) => {
        const userRef = db.collection("users").doc(transaction.userId);

        const userDoc = await t.get(userRef);
        const currentBalance = userDoc.data()?.balance || 0;

        t.update(userRef, {
          balance: currentBalance + transaction.amount
        });

        t.update(transactionRef, {
          status: "SUCCESS",
          updatedAt: new Date(),
          webhookPayload: payload
        });
      });
    }

  } catch (err) {
    console.error("Webhook error:", err);
  }
});

export default router;
