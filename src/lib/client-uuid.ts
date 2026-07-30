type ClientCrypto = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
};

export function createClientUuid(
  clientCrypto: ClientCrypto | undefined = globalThis.crypto,
): string {
  if (typeof clientCrypto?.randomUUID === "function") {
    return clientCrypto.randomUUID();
  }
  if (typeof clientCrypto?.getRandomValues !== "function") {
    throw new Error("Secure random values are unavailable.");
  }

  const bytes = clientCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
