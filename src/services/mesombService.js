import { PaymentOperation } from "@hachther/mesomb";

const client = new PaymentOperation({
  applicationKey: process.env.MESOMB_APPLICATION_KEY,
  accessKey: process.env.MESOMB_ACCESS_KEY,
  secretKey: process.env.MESOMB_SECRET_KEY,
});

export async function collectPayment({ phone, amount, trxID }) {
  return await client.makeCollect({
    payer: phone,
    amount,
    currency: "XAF",
    country: "CM",
    service: "MTN", // or ORANGE
    trxID
  });
}
