const LOOPBACK_HOSTNAME = "127.0.0.1";
const LOCAL_NETWORK_HOSTNAME = "0.0.0.0";

export function resolveE2EServerHostname(value) {
  const hostname = value?.trim() || LOOPBACK_HOSTNAME;
  if (
    hostname !== LOOPBACK_HOSTNAME &&
    hostname !== LOCAL_NETWORK_HOSTNAME
  ) {
    throw new Error(
      "E2E_HOSTNAME must be 127.0.0.1 or 0.0.0.0.",
    );
  }
  return hostname;
}
