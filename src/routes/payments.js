import express from "express";
import {
  collectPayment,
  depositPayment,
  refundTransaction,
  getTransactions,
  checkTransactions,
  getApplicationStatus,
} from "../services/mesombService.js";
import { db } from "../config/firebase.js";
import { requireInternalServiceKey } from "../middleware/internalServiceAuth.js";

const router = express.Router();

/**
 * POST /api/payments/collect
 *
 * Collect money from a customer's mobile money account.
 * Uses asynchronous mode by default — the final status arrives via webhook.
 * An initial PENDING record is saved to Supabase immediately.
 *
 * Body:
 *   phone       {string}  - Customer phone number (e.g. '677000000')
 *   amount      {number}  - Amount in XAF
 *   service     {string}  - 'MTN' | 'ORANGE' | 'AIRTEL'
 *   type        {string}  - 'Ride' | 'Food' | 'Parcel' | 'Wallet' (used as reference prefix)
 *   userId      {string}  - (optional) Your internal user ID
 *   trxID       {string}  - (optional) Your order/booking ID — if omitted, auto-generated
 *   mode        {string}  - (optional) 'asynchronous' (default) | 'synchronous'
 *   customer    {object}  - (optional) { firstName, lastName, email, town, region, country }
 */
router.post("/collect", requireInternalServiceKey, async (req, res) => {
  try {
    const { phone, amount, service, type, userId, trxID: bodyTrxID, mode, customer } = req.body;

    if (!phone || !service || !type || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: "Required fields: phone, service, type, and a positive numeric amount",
      });
    }

    // trxID becomes the `reference` in all MeSomb webhook events — use your order ID here
    const trxID = bodyTrxID || `EATALYFT-${type.toUpperCase()}-${Date.now()}`;
    const numericAmount = Number(amount);

    // Persist before the provider call so a fast webhook always finds a record.
    if (db) {
      await db.collection("transactions").doc(trxID).set({
        userId: userId || null,
        phone,
        amount: numericAmount,
        type,
        serviceType: type,
        service,
        status: "processing",
        trxID,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { merge: true });
    }

    const { response, paymentId, opSuccess, txnSuccess } = await collectPayment({
          phone,
          amount: numericAmount,
          service,
          type,
      trxID,
      userId,
      mode: mode || "asynchronous",
      customer: customer || undefined,
    });

    // Optionally log to Firestore as well (for apps still using Firebase)
    if (db) {
      await db.collection("transactions").doc(trxID).set({
        userId: userId || null,
        phone,
        amount: numericAmount,
        type,
        serviceType: type,
        service,
        status: response.transaction?.status || "PENDING",
        trxID,
        mesombTransactionId: response.transaction?.pk || null,
        updatedAt: new Date(),
      }, { merge: true });
    }

    return res.json({
      success:            opSuccess,
      transactionSuccess: txnSuccess,
      trxID,
      paymentId,
      status:             response.transaction?.status || "PENDING",
      transactionId:      response.transaction?.pk    || null,
    });
  } catch (error) {
    console.error("Collect payment error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/payments/deposit
 *
 * Deposit (disburse) money into a customer's mobile money account (payout).
 * An initial PENDING record is saved to Supabase immediately.
 *
 * Body:
 *   phone    {string}  - Recipient phone number
 *   amount   {number}  - Amount in XAF
 *   service  {string}  - 'MTN' | 'ORANGE' | 'AIRTEL'
 *   userId   {string}  - (optional) Your internal user ID
 *   trxID    {string}  - (optional) Your payout reference ID
 */
router.post("/deposit", requireInternalServiceKey, async (req, res) => {
  try {
    const { phone, amount, service, userId, trxID: bodyTrxID } = req.body;

    if (!phone || !amount || !service) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: phone, amount, service",
      });
    }

    const trxID = bodyTrxID || `EATALYFT-DEPOSIT-${Date.now()}`;

    const { response, paymentId, opSuccess, txnSuccess } = await depositPayment({
      phone,
      amount,
      service,
      trxID,
      userId,
    });

    if (db) {
      await db.collection("transactions").doc(trxID).set({
        userId:             userId || null,
        phone,
        amount,
        type:               "Deposit",
        service,
        status:             response.transaction?.status || "PENDING",
        trxID,
        mesombTransactionId: response.transaction?.pk   || null,
        createdAt:          new Date(),
      });
    }

    return res.json({
      success:            opSuccess,
      transactionSuccess: txnSuccess,
      trxID,
      paymentId,
      status:             response.transaction?.status || "PENDING",
      transactionId:      response.transaction?.pk    || null,
    });
  } catch (error) {
    console.error("Deposit payment error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/payments/refund
 *
 * Refund a transaction.
 *
 * Body:
 *   transactionId  {string}  - The MeSomb transaction pk to refund
 *   amount         {number}  - (optional) Partial refund amount; omit for full refund
 */
router.post("/refund", requireInternalServiceKey, async (req, res) => {
  try {
    const { transactionId, amount } = req.body;

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: transactionId",
      });
    }

    const response = await refundTransaction(transactionId, amount);

    return res.json({
      success:            response.isOperationSuccess(),
      transactionSuccess: response.isTransactionSuccess(),
      status:             response.transaction?.status,
      transactionId:      response.transaction?.pk,
    });
  } catch (error) {
    console.error("Refund error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/payments/transactions?ids=id1,id2&source=MESOMB
 *
 * Retrieve transactions by their IDs.
 *
 * Query params:
 *   ids     {string}  - Comma-separated transaction IDs
 *   source  {string}  - 'MESOMB' (default) or 'EXTERNAL' (your system IDs)
 */
router.get("/transactions", async (req, res) => {
  try {
    const { ids, source } = req.query;

    if (!ids) {
      return res.status(400).json({
        success: false,
        error: "Missing required query param: ids (comma-separated)",
      });
    }

    const idList       = ids.split(",").map((id) => id.trim()).filter(Boolean);
    const transactions = await getTransactions(idList, source || "MESOMB");

    return res.json({ success: true, transactions });
  } catch (error) {
    console.error("Get transactions error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/payments/transactions/check?ids=id1,id2&source=MESOMB
 *
 * Check / validate transactions by their IDs.
 */
router.get("/transactions/check", async (req, res) => {
  try {
    const { ids, source } = req.query;

    if (!ids) {
      return res.status(400).json({
        success: false,
        error: "Missing required query param: ids (comma-separated)",
      });
    }

    const idList       = ids.split(",").map((id) => id.trim()).filter(Boolean);
    const transactions = await checkTransactions(idList, source || "MESOMB");

    return res.json({ success: true, transactions });
  } catch (error) {
    console.error("Check transactions error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/payments/status
 *
 * Get MeSomb application status and current balances.
 */
router.get("/status", async (req, res) => {
  try {
    const application = await getApplicationStatus();
    return res.json({ success: true, application });
  } catch (error) {
    console.error("Get status error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
