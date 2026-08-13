import { randomInt } from 'node:crypto';

const ALPHANUMERIC =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** CSPRNG alphanumeric password safe for copy/paste and shell quoting. */
export function generatePassword(length = 16): string {
  if (length < 1) {
    throw new Error('Password length must be at least 1');
  }

  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
  }
  return result;
}
