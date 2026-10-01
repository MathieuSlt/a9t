import {
  ENV_JWT_SECRET,
  ENV_SUPABASE_SERVICE_ROLE_KEY,
  ENV_SUPABASE_URL,
  ENV_ALLOWED_ORIGINS,
  DEFAULT_PORT,
  ENV_PORT,
  ENV_METRICS_PORT,
  ENV_TRUST_PROXY,
} from "./constants.js";

/** Default port for /metrics (internal Docker scrape only). */
const DEFAULT_METRICS_PORT = 4011;

export interface EnvConfig {
  port: number;
  /** null = metrics HTTP server disabled */
  metricsPort: number | null;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  jwtSecret: string;
  allowedOrigins: string[];
  /** Reverse-proxy hops to trust (Express `trust proxy`); 0 = none */
  trustProxyHops: number;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

function getOptionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return value.trim();
}

function parsePort(): number {
  const raw = getOptionalEnv(ENV_PORT, String(DEFAULT_PORT));
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`Invalid ${ENV_PORT}: must be 1-65535`);
    process.exit(1);
  }
  return parsed;
}

function parseMetricsPort(mainPort: number): number | null {
  const raw = getOptionalEnv(ENV_METRICS_PORT, String(DEFAULT_METRICS_PORT));
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) {
    console.error(`Invalid ${ENV_METRICS_PORT}: must be 0-65535 (0 disables metrics server)`);
    process.exit(1);
  }
  if (parsed === 0) return null;
  if (parsed === mainPort) {
    console.error(
      `${ENV_METRICS_PORT} must differ from ${ENV_PORT} so /metrics is not exposed on the public MCP port`,
    );
    process.exit(1);
  }
  return parsed;
}

function parseTrustProxy(): number {
  const raw = getOptionalEnv(ENV_TRUST_PROXY, "0");
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 10) {
    console.error(`Invalid ${ENV_TRUST_PROXY}: must be a hop count 0-10`);
    process.exit(1);
  }
  return parsed;
}

/**
 * Load and validate environment configuration.
 * Exits process if required vars are missing or invalid.
 */
export function loadEnv(): EnvConfig {
  const jwtSecret = getRequiredEnv(ENV_JWT_SECRET);
  if (jwtSecret.length < 32) {
    console.error(`${ENV_JWT_SECRET} must be at least 32 characters`);
    process.exit(1);
  }

  const originsRaw = getOptionalEnv(ENV_ALLOWED_ORIGINS, "");
  const allowedOrigins = originsRaw
    ? originsRaw.split(",").map((o) => o.trim()).filter(Boolean)
    : [];

  const port = parsePort();

  return {
    port,
    metricsPort: parseMetricsPort(port),
    supabaseUrl: getRequiredEnv(ENV_SUPABASE_URL),
    supabaseServiceRoleKey: getRequiredEnv(ENV_SUPABASE_SERVICE_ROLE_KEY),
    jwtSecret,
    allowedOrigins,
    trustProxyHops: parseTrustProxy(),
  };
}
