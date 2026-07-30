export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}
