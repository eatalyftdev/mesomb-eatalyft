---
name: Async collect mode
description: Why production makeCollect must use asynchronous mode
---

`makeCollect` should use `mode: 'asynchronous'` in production. In synchronous mode the Express handler blocks waiting for the mobile operator to respond (can be 30+ seconds, times out). In asynchronous mode the MeSomb API acknowledges immediately with PENDING status, then POSTs the final result to the webhook.

**Why:** Blocking on operator response causes HTTP timeouts in the main Eatalyft app and double-charge risk if the client retries. Async mode + webhook is the correct and documented production pattern.

**How to apply:** collectPayment() defaults to `mode: 'asynchronous'`. Save a PENDING record to Supabase immediately after makeCollect returns, then let the webhook update it to SUCCESS/FAILED.
