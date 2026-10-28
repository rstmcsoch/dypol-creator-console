#!/usr/bin/env node
/**
 * Generate the ADMIN_PASSWORD_HASH secret value.
 * Usage: node scripts/hash-password.js 'your-strong-password'
 *
 * The hash is stored ONLY as a Cloudflare Pages secret. The plaintext
 * password is never stored anywhere by the console.
 */
const crypto = require('crypto');

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Usage: node scripts/hash-password.js \'<password >= 8 chars>\'');
  process.exit(1);
}
const iterations = 100000;
const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
console.log(`pbkdf2$${iterations}$${salt.toString('hex')}$${hash.toString('hex')}`);
