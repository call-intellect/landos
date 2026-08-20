/**
 * Application configuration loaded from environment variables with safe
 * defaults. This module has no dependencies so it can be imported anywhere.
 */

export interface AppConfig {
  env: "development" | "test" | "production";
  port: number;
  crm: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  defaultCountryCode: string;
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config: AppConfig = {
  env: (process.env.NODE_ENV as AppConfig["env"]) ?? "development",
  port: readNumber(process.env.PORT, 3000),
  crm: {
    baseUrl: process.env.CRM_BASE_URL ?? "https://crm.example.com/api",
    apiKey: process.env.CRM_API_KEY ?? "local-development-key",
    timeoutMs: readNumber(process.env.CRM_TIMEOUT_MS, 5000),
  },
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE ?? "1",
};

export function isProduction(): boolean {
  return config.env === "production";
}
