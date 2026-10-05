const env = require('../config/env');
const { maskPhone } = require('./phone');

// Saptel DLT SMS gateway - same request format as the Zyfoo platform's
// Saptel provider (src/modules/auth-otp/lib/providers/saptel.ts).
const SAPTEL_URL = 'https://sapteleservices.com/SMS_API/sendsms.php';

function isSmsConfigured() {
  return Boolean(env.saptelApiKey && env.saptelSender && env.saptelTid && env.saptelTemplate);
}

// Sends the login code by SMS. The message is the DLT-registered template
// with only {otp} filled in - the rest must stay byte-identical to what's
// registered under SAPTEL_TID, or the telco silently drops the SMS.
//
// Without the SAPTEL_* settings in .env nothing is sent - the code is
// printed in this server's terminal instead, so login can still be tested.
async function sendOtpSms(phone, code) {
  if (!isSmsConfigured()) {
    console.log(`[otp] DEV MODE (Saptel not configured) - login code for ${phone}: ${code}`);
    return;
  }

  const message = env.saptelTemplate.replace(/\{otp\}/gi, code).replace(/\{#var#\}/gi, code);
  // Built with encodeURIComponent exactly like the Zyfoo adapter (spaces as
  // %20, parentheses left as-is) rather than URLSearchParams (spaces as '+',
  // parentheses escaped), so the text reaching the telco is byte-identical
  // to the DLT template that's known to deliver.
  const url =
    `${SAPTEL_URL}` +
    `?apikey=${encodeURIComponent(env.saptelApiKey)}` +
    `&mobile=${encodeURIComponent(phone)}` +
    `&sendername=${encodeURIComponent(env.saptelSender)}` +
    `&message=${encodeURIComponent(message)}` +
    `&routetype=${encodeURIComponent(env.saptelRouteType)}` +
    `&tid=${encodeURIComponent(env.saptelTid)}`;

  // Saptel's server occasionally times out or drops the connection, so a
  // failed attempt is retried once before giving up.
  let body;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
      break;
    } catch (err) {
      console.error(`[otp] Saptel send attempt ${attempt} failed for ${maskPhone(phone)}: ${err.message}`);
      if (attempt === 2) throw new Error('SMS_SEND_FAILED');
    }
  }

  // Saptel answers 200 even for some rejections, so the raw reply is logged
  // to diagnose an SMS that never arrives.
  console.log(`[otp] Saptel SMS to ${maskPhone(phone)} - gateway response: ${body.trim()}`);
}

module.exports = { sendOtpSms, isSmsConfigured };
