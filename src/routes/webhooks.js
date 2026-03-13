import express from "express";
import { db } from "../config/firebase.js";

const router = express.Router();

router.post("/mesomb", async (req, res) => {
  try {
    const payload = req.body;
    console.log("Webhook Received:", payload);

    // 🔔 Respond fast
    res.status(200).send("OK");

    const transactionRefId = payload.reference; // unify with reference from payment
    if (!transactionRefId) {
      console.error("Webhook missing reference");
      return;
    }

    const transactionRef = db.collection("transactions").doc(transactionRefId);
    const doc = await transactionRef.get();
    if (!doc.exists) return;

    const transaction = doc.data();
    if (transaction.status === "SUCCESS") return; // prevent double-processing

    if (payload.status === "SUCCESS") {
      await db.runTransaction(async (t) => {
        const userRef = db.collection("users").doc(transaction.userId);
        const userDoc = await t.get(userRef);
        const currentBalance = userDoc.data()?.balance || 0;

        // update balance for wallet payments, mark others as paid
        let updates = { status: "SUCCESS", updatedAt: new Date(), webhookPayload: payload };
        if (transaction.type === "Wallet") {
          t.update(userRef, { balance: currentBalance + transaction.amount });
        }

        t.update(transactionRef, updates);
        console.log(`Transaction ${transactionRefId} updated successfully`);
      });
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

export default router;
