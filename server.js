require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const googleCreds = require('./google-credentials.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  PAYHERO_API_USERNAME,
  PAYHERO_API_PASSWORD,
  PAYHERO_CHANNEL_ID,
  PAYHERO_CALLBACK_URL,
  PORT = 3000
} = process.env;

const PAYHERO_BASE_URL = 'https://backend.payhero.co.ke/api/v2';

// Nodemailer transporter: authenticates as the SENDER gmail account
// (your second gmail, set via SENDER_EMAIL / SENDER_APP_PASSWORD in .env)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SENDER_EMAIL,
    pass: process.env.SENDER_APP_PASSWORD,
  },
});

// Google Sheets logging: authenticates as the service account (google-credentials.json)
// and appends a row to the donations sheet whenever a transaction resolves.
const sheetAuth = new JWT({
  email: googleCreds.client_email,
  key: googleCreds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const donationSheet = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, sheetAuth);

async function logDonationToSheet(data) {
  try {
    await donationSheet.loadInfo();
    const sheet = donationSheet.sheetsByIndex[0];
    await sheet.addRow({
      Reference: data.reference || '',
      Phone: data.phone || '',
      Amount: data.amount || '',
      MpesaReceipt: data.mpesaReceipt || '',
      Status: data.status || '',
      Message: data.message || '',
      Timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Failed to log donation to Google Sheet:', err.message);
  }
}

// In-memory transaction store, keyed by the "reference" PayHero returns
// when you initiate a push. Fine for a low-volume donation page; swap for
// Airtable/Sheets/a real DB if you want records to survive a restart.
const transactions = new Map();

function payheroAuthHeader() {
  const encoded = Buffer.from(`${PAYHERO_API_USERNAME}:${PAYHERO_API_PASSWORD}`).toString('base64');
  return `Basic ${encoded}`;
}

// PayHero's documented examples use local format (07XXXXXXXX / 01XXXXXXXX),
// not the 254-prefixed format Daraja itself wants. This normalizes to that.
function normalizePhoneLocal(input) {
  const raw = String(input || '').trim().replace(/\s+/g, '');
  if (/^[71]\d{8}$/.test(raw)) return '0' + raw;
  if (/^0[71]\d{8}$/.test(raw)) return raw;
  if (/^254[71]\d{8}$/.test(raw)) return '0' + raw.slice(3);
  return null;
}

function generateReference() {
  return 'DON-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Kick off an STK push via PayHero (which relays to Daraja using the
// till/paybill you registered in the PayHero portal as PAYHERO_CHANNEL_ID).
app.post('/stkpush', async (req, res) => {
  try {
    const phone = normalizePhoneLocal(req.body.phone);
    const amt = Math.round(Number(req.body.amount));
    const message = (req.body.message || '').toString().slice(0, 60);

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Invalid phone number' });
    }
    if (!amt || amt < 1) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const externalReference = generateReference();

    const payheroRes = await axios.post(
      `${PAYHERO_BASE_URL}/payments`,
      {
        amount: amt,
        phone_number: phone,
        channel_id: Number(PAYHERO_CHANNEL_ID),
        provider: 'm-pesa',
        external_reference: externalReference,
        customer_name: message ? message.slice(0, 20) : 'Donor',
        callback_url: PAYHERO_CALLBACK_URL
      },
      { headers: { Authorization: payheroAuthHeader(), 'Content-Type': 'application/json' } }
    );

    const { success, status, reference, CheckoutRequestID } = payheroRes.data;

    if (!success) {
      return res.status(400).json({ success: false, error: 'STK push rejected', detail: payheroRes.data });
    }

    // Store under both references so the callback can find it whichever
    // identifier PayHero echoes back.
    const record = {
      status: 'pending',
      phone,
      amount: amt,
      message,
      externalReference,
      payheroReference: reference,
      checkoutRequestId: CheckoutRequestID,
      payheroStatus: status,
      createdAt: new Date().toISOString()
    };
    transactions.set(externalReference, record);
    if (reference) transactions.set(reference, record);
    if (CheckoutRequestID) transactions.set(CheckoutRequestID, record);

    res.json({ success: true, reference: externalReference });
  } catch (err) {
    console.error('STK push error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'STK push failed' });
  }
});

// PayHero calls this once the transaction resolves. This URL must be
// publicly reachable over HTTPS (ngrok tunnel locally, real domain in prod).
//
// Confirmed real payload shape from a live test:
// {
//   "status": true,
//   "response": {
//     "MerchantRequestID", "CheckoutRequestID", "ResultCode", "Amount",
//     "MpesaReceiptNumber", "Phone", "ExternalReference", "Status",
//     "ResultDesc", "ServiceWalletBalance", "PaymentWalletBalance", "ChannelID"
//   },
//   "forward_url": ""
// }
app.post('/payhero/callback', (req, res) => {
  try {
    const data = req.body?.response || {};

    const externalReference = data.ExternalReference;
    const checkoutRequestId = data.CheckoutRequestID;
    const key = externalReference || checkoutRequestId;
    const record = transactions.get(key) || {};

    const isSuccess = data.ResultCode === 0 && data.Status === 'Success';

    const updated = isSuccess
      ? {
          ...record,
          status: 'success',
          mpesaReceipt: data.MpesaReceiptNumber,
          amount: data.Amount ?? record.amount,
          transactionDate: new Date().toISOString(),
          phone: data.Phone || record.phone
        }
      : {
          ...record,
          status: 'failed',
          resultDesc: data.ResultDesc || 'Payment not completed'
        };

    if (externalReference) transactions.set(externalReference, updated);
    if (checkoutRequestId) transactions.set(checkoutRequestId, updated);
    if (record.payheroReference) transactions.set(record.payheroReference, updated);

    logDonationToSheet({
      reference: externalReference,
      phone: updated.phone,
      amount: updated.amount,
      mpesaReceipt: updated.mpesaReceipt,
      status: updated.status,
      message: updated.message,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('Callback error:', err);
    res.sendStatus(500);
  }
});

// Frontend polls this using the "reference" returned by /stkpush.
app.get('/status/:reference', (req, res) => {
  const record = transactions.get(req.params.reference);
  if (!record) return res.status(404).json({ status: 'unknown' });
  res.json(record);
});

// Contact form route: receives form fields from the portfolio site and
// emails them to RECEIVER_EMAIL, sent via the SENDER_EMAIL gmail account.
app.post('/contact', async (req, res) => {
  const { first_name, last_name, email, project_type, message } = req.body;

  if (!first_name || !email || !message) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }

  const mailOptions = {
    from: `"rn.dev contact form" <${process.env.SENDER_EMAIL}>`,
    to: process.env.RECEIVER_EMAIL,
    replyTo: email,
    subject: `New inquiry: ${project_type || 'General'} — from ${first_name} ${last_name || ''}`,
    text: `Name: ${first_name} ${last_name || ''}\nEmail: ${email}\nProject type: ${project_type || 'Not specified'}\n\nMessage:\n${message}`,
    html: `
      <h2>New contact form submission</h2>
      <p><strong>Name:</strong> ${first_name} ${last_name || ''}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Project type:</strong> ${project_type || 'Not specified'}</p>
      <p><strong>Message:</strong></p>
      <p>${message.replace(/\n/g, '<br>')}</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to send email.' });
  }
});

app.listen(PORT, () => console.log(`M-Pesa donation server (PayHero) running on port ${PORT}`));