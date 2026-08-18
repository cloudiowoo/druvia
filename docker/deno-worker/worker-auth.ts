export const WORKER_SECRET_HEADER = "x-druvia-worker-secret";
export const MIN_WORKER_SECRET_BYTES = 32;

export function assertWorkerSecret(workerSecret: string | undefined): string {
  if (
    typeof workerSecret !== "string"
    || new TextEncoder().encode(workerSecret).byteLength < MIN_WORKER_SECRET_BYTES
  ) {
    throw new Error("DENO_WORKER_SECRET must contain at least 32 UTF-8 bytes");
  }
  return workerSecret;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

export async function verifyWorkerSecret(
  configuredSecret: string,
  suppliedSecret: string | null,
): Promise<boolean> {
  const expectedDigest = await sha256(configuredSecret);
  const suppliedDigest = await sha256(suppliedSecret ?? "");
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= expectedDigest[index] ^ suppliedDigest[index];
  }
  return difference === 0;
}
