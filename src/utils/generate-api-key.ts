import * as crypto from "crypto";
import * as bcrypt from "bcryptjs";

/**
 * Generate a secure random API key
 */

function generateApiKey(): { key: string; secret: string } {
  // Generate a public API key (readable but secure)
  const key = `sk_${crypto.randomBytes(16).toString("hex")}`;

  // Generate a longer secret key
  const secret = crypto.randomBytes(32).toString("base64");

  return { key, secret };
}

/**
 * Helper function to create an API key for a tenant
 */

export async function generateApiKeyData(name: string, expiryDays = 365) {
  const { key, secret } = generateApiKey();

  // Hash the secret before storing
  const hashedSecret = await bcrypt.hash(secret, 10);

  // Calculate expiry date (if applicable)
  const expiresAt = expiryDays
    ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
    : null;

  return {
    key,
    hashedSecret,
    name,
    expiresAt,
    rawSecret: secret, // Only returned at creation time
  };
}
