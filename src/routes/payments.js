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

const router = express.Router();

/**
 * POST /api/payments/collect
 *
 * Collect money from a customer's mobile money account.
 *
 * Body:
 *   phone       {string}  - Customer phone number (e.g. '677000000')
 *   amount      {number}  - Amount in XAF
 *   service     {string}  - 'MTN' | 'ORANGE' | 'AIRTEL'
 *   type        {string}  - Payment type label: 'Ride' | 'Food' | 'Parcel' | 'Wallet'
 *   userId      {string}  - (optional) Your user ID for Firestore logging
 *   mode        {string}  - (optional) 'synchronous' | 'asynchronous' (default: synchronous)
 */
router.post("/collect", async (req, res) => {
  try {
    const { phone, amount, service, type, userId, mode } = req.body;

    if (!phone || !amount || !service || !type) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: phone, amount, service, type",
      });
    }

    const trxID = `EATALYFT-${type.toUpperCase()}-${Date.now()}`;

    const customer = {
      firstName: "EataLyft",
      lastName: type,
      email: "eatapay@eatalyft.com",
    };

    const location = {
      town: "Bamenda",
      region: "North-West",
      country: "CM",
    };

    const products = [
      {
        name: `${type} Payment`,
        category: type,
        quantity: 1,
        amount,
      },
    ];

    const response = await collectPayment({
      phone,
      amount,
      service,
      trxID,
      customer,
      location,
      products,
      mode: mode || "synchronous",
    });

    const result = {
      success: response.isOperationSuccess(),
      transactionSuccess: response.isTransactionSuccess(),
      trxID,
      status: response.transaction?.status,
      transactionId: response.transaction?.pk,
    };

    if (db) {
      await db.collection("transactions").doc(trxID).set({
        userId: userId || null,
        phone,
        amount,
        type,
        service,
        status: response.transaction?.status || "PENDING",
        trxID,
        mesombTransactionId: response.transaction?.pk || null,
        createdAt: new Date(),
      });
    }

    return res.json(result);
  } catch (error) {
    console.error("Collect payment error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/payments/deposit
 *
 * Deposit (disburse) money into a customer's mobile money account (payout).
 *
 * Body:
 *   phone    {string}  - Recipient phone number
 *   amount   {number}  - Amount in XAF
 *   service  {string}  - 'MTN' | 'ORANGE' | 'AIRTEL'
 *   userId   {string}  - (optional) Your user ID
 */
router.post("/deposit", async (req, res) => {
  try {
    const { phone, amount, service, userId } = req.body;

    if (!phone || !amount || !service) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: phone, amount, service",
      });
    }

    const trxID = `EATALYFT-DEPOSIT-${Date.now()}`;

    const response = await depositPayment({ phone, amount, service, trxID });

    const result = {
      success: response.isOperationSuccess(),
      transactionSuccess: response.isTransactionSuccess(),
      trxID,
      status: response.transaction?.status,
      transactionId: response.transaction?.pk,
    };

    if (db) {
      await db.collection("transactions").doc(trxID).set({
        userId: userId || null,
        phone,
        amount,
        type: "Deposit",
        service,
        status: response.transaction?.status || "PENDING",
        trxID,
        mesombTransactionId: response.transaction?.pk || null,
        createdAt: new Date(),
      });
    }

    return res.json(result);
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
 *   transactionId  {string}  - The MeSomb transaction ID to refund
 *   amount         {number}  - (optional) Partial refund amount; omit for full refund
 */
router.post("/refund", async (req, res) => {
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
      success: response.isOperationSuccess(),
      transactionSuccess: response.isTransactionSuccess(),
      status: response.transaction?.status,
      transactionId: response.transaction?.pk,
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

    const idList = ids.split(",").map((id) => id.trim()).filter(Boolean);
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

    const idList = ids.split(",").map((id) => id.trim()).filter(Boolean);
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
