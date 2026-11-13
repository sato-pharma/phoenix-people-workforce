// The string PostgreSQL stores for a SCRAM-SHA-256 password (RFC 5802, RFC 7677). Computing it here means
// the plain password never reaches the database, its logs or a statement history: `alter role … password`
// stores a value of this shape as it is.

import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

const hmac = (key, text) => createHmac("sha256", key).update(text).digest();

/** The two keys a server keeps for one password. */
export function scramKeys(password, salt, iterations = 4096) {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  return {
    serverKey: hmac(salted, "Server Key"),
    storedKey: createHash("sha256").update(hmac(salted, "Client Key")).digest(),
  };
}

/** `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, as pg_authid holds it. */
export function scramVerifier(password, salt, iterations = 4096) {
  const { serverKey, storedKey } = scramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
