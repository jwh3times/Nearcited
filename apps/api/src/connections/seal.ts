/**
 * Sealing a connection's sign-in, so that only this Worker can open it
 * (docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md).
 *
 * AES-256-GCM with a fresh nonce each time. The connection's ID is authenticated with it, so a
 * sealed sign-in moved to another connection's row does not open.
 */

const VERSION = "v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/**
 * The key a deployment seals with, from its `CONNECTIONS_KEY` secret: 32 random bytes in base64.
 * Null where none is set, which switches connections off. Throws for a value that is not a key:
 * half a key is not a weaker one, it is a mistake to be told about.
 */
export async function sealingKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (!secret) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(secret.trim());
  } catch {
    throw new Error("CONNECTIONS_KEY is not base64.");
  }
  if (bytes.length !== 32) throw new Error("CONNECTIONS_KEY must be 32 bytes, in base64.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Seals a sign-in for one connection. What comes back is safe to store. */
export async function seal(key: CryptoKey, connectionId: string, signIn: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(connectionId) },
    key,
    encoder.encode(signIn),
  );
  return `${VERSION}.${toBase64(nonce)}.${toBase64(new Uint8Array(sealed))}`;
}

/**
 * Opens what `seal` made for the same connection. Throws when the key is another one, the text
 * was changed, or it was sealed for a different connection.
 */
export async function open(key: CryptoKey, connectionId: string, sealed: string): Promise<string> {
  const [version, nonce, body] = sealed.split(".");
  if (version !== VERSION || !nonce || !body) throw new Error("Not a sealed sign-in.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(nonce), additionalData: encoder.encode(connectionId) },
    key,
    fromBase64(body),
  );
  return decoder.decode(plain);
}
