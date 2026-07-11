// The app has no signup UI - these are the only accounts permitted to log in.
// Each account's password is seeded explicitly (see seed/seedUsers.js) rather
// than derived from the email, since these don't follow a fixed convention.
const ALLOWED_USERS = [
  { email: 'kannan@askantech.com', name: 'Kannan', password: 'kannan@bni123' },
  { email: 'grspondy@gmail.com', name: 'GRS Pondy', password: 'grspondy@bni123' },
];

module.exports = { ALLOWED_USERS };
