// Every phone number in this app (allowedUsers.json, members.json, User
// documents, OTP records) is stored as a bare 10-digit Indian mobile number
// - no "+91", spaces or dashes - so the same person always matches no matter
// how the number was typed. Accepts the common ways a number gets written
// ("98765 43210", "+91-9876543210", "09876543210") and returns null for
// anything that isn't a valid Indian mobile number (10 digits starting 6-9).
function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

// For logs only - never print a full number to the console.
function maskPhone(phone) {
  if (!phone) return '(no phone)';
  return `${phone.slice(0, 2)}******${phone.slice(-2)}`;
}

module.exports = { normalizePhone, maskPhone };
