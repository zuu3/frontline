import { promises as fs } from "fs";
import { exportJWK, generateKeyPair, importJWK, JWK } from "jose";

type SigningKey = Awaited<ReturnType<typeof importJWK>>;

// Ed25519 signing key for access-token JWTs, persisted to disk so restarts
// don't invalidate every session (and the JWKS the game server fetches
// stays stable). Generated once on first boot.
const KEY_PATH = process.env.AUTH_KEY_PATH ?? "/root/.frontline-auth-key.json";

interface StoredKeyPair {
  publicKey: JWK;
  privateKey: JWK;
}

let cached: { privateKey: SigningKey; publicJwk: JWK } | null = null;

export async function loadOrCreateKeyPair(): Promise<{
  privateKey: SigningKey;
  publicJwk: JWK;
}> {
  if (cached) return cached;

  try {
    const raw = await fs.readFile(KEY_PATH, "utf-8");
    const stored = JSON.parse(raw) as StoredKeyPair;
    const privateKey = await importJWK(stored.privateKey, "EdDSA");
    cached = { privateKey, publicJwk: stored.publicKey };
    return cached;
  } catch {
    // No key on disk yet -- generate and persist.
  }

  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";

  const stored: StoredKeyPair = {
    publicKey: publicJwk,
    privateKey: privateJwk,
  };
  await fs.writeFile(KEY_PATH, JSON.stringify(stored), { mode: 0o600 });

  // Re-import through importJWK rather than using generateKeyPair's own
  // privateKey directly, so the cached value has one consistent type
  // regardless of which branch produced it.
  const reimported = await importJWK(privateJwk, "EdDSA");
  cached = { privateKey: reimported, publicJwk };
  return cached;
}
