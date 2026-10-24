import { randomBytes, scrypt } from 'node:crypto';

// A password hash in the stored form M5 verifies, `scrypt$<N>$<r>$<p>$<salt>$<hash>` (base64url, 64-byte key, NFKC
// password), so prepare.ts can seed sign-ins without importing the API. The parameters travel with the hash, so this
// uses cheaper ones than the API's own; every journey's sign-in proves the API still accepts the form.
const N = 2 ** 14;
const R = 8;
const P = 1;

export function storedPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, 64, { N, r: R, p: P }, (error, key) =>
      error
        ? reject(error)
        : resolve(
            ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$'),
          ),
    ),
  );
}
