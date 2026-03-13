import { PaymentOperation } from "@hachther/mesomb";

const client = new PaymentOperation({
  applicationKey: process.env.MESOMB_APP_KEY,
  accessKey: process.env.MESOMB_ACCESS_KEY,
  secretKey: process.env.MESOMB_SECRET_KEY,
});

export async function collectPayment({ phone, amount, transactionRef, service }) {
  return await client.makeCollect({
    payer: phone,
    amount,
    currency: "XAF",
    country: "CM",
    service: service || "MTN",
    reference: transactionRef,
  });
}
