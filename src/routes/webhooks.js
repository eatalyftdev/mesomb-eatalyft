import express from "express";
import { db } from "../config/firebase.js";

const router = express.Router();

/**
 * POST /webhooks/mesomb
 *
 * MeSomb sends a webhook when a payment status changes.
 * Configure this URL in your MeSomb application dashboard.
 *
 * Payload from MeSomb:
 *   reference  {string}  - Your trxID set during collect
 *   status     {string}  - 'SUCCESS' | 'FAILED' | 'PENDING'
 *   id         {string}  - MeSomb transaction ID
 *   amount     {number}  - Transaction amount
 *   service    {string}  - MTN | ORANGE | AIRTEL
 */
router.post("/mesomb", async (req, res) => {
  res.status(200).send("OK");

  try {
    const payload = req.body;
    console.log("Webhook received:", JSON.stringify(payload));

    const reference = payload.reference;
    if (!reference) {
      console.error("Webhook missing reference field");
      return;
    }

    if (!db) {
      console.warn("Firestore not configured — skipping transaction update for:", reference);
      return;
    }

    const transactionRef = db.collection("transactions").doc(reference);
    const doc = await transactionRef.get();

    if (!doc.exists) {
      console.warn(`No Firestore record found for reference: ${reference}`);
      return;
    }

    const transaction = doc.data();

    if (transaction.status === "SUCCESS") {
      console.log(`Transaction ${reference} already marked SUCCESS — skipping duplicate webhook`);
      return;
    }

    await db.runTransaction(async (t) => {
      const updates = {
        status: payload.status,
        updatedAt: new Date(),
        mesombTransactionId: payload.id || transaction.mesombTransactionId,
        webhookPayload: payload,
      };

      if (payload.status === "SUCCESS" && transaction.type === "Wallet") {
        const userRef = db.collection("users").doc(transaction.userId);
        const userDoc = await t.get(userRef);
        const currentBalance = userDoc.exists ? userDoc.data()?.balance || 0 : 0;
        t.set(userRef, { balance: currentBalance + transaction.amount }, { merge: true });
        console.log(`Wallet topped up for user ${transaction.userId}: +${transaction.amount}`);
      }

      t.update(transactionRef, updates);
      console.log(`Transaction ${reference} updated to status: ${payload.status}`);
    });
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
});

export default router;
