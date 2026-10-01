import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf-8")
);

export const SERVER_VERSION: string = pkg.version;
export const SERVER_NAME = "a9t";

/** Default HTTP server port */
export const DEFAULT_PORT = 4010;

/** Env var names */
export const ENV_PORT = "PORT";
/** Internal Prometheus scrape port (0 = disabled). Not routed through Traefik. */
export const ENV_METRICS_PORT = "METRICS_PORT";
export const ENV_SUPABASE_URL = "SUPABASE_URL";
export const ENV_SUPABASE_SERVICE_ROLE_KEY = "SUPABASE_SERVICE_ROLE_KEY";
export const ENV_JWT_SECRET = "JWT_SECRET";
export const ENV_ALLOWED_ORIGINS = "ALLOWED_ORIGINS";
/** Number of reverse-proxy hops to trust for client IPs (e.g. 1 behind Traefik). */
export const ENV_TRUST_PROXY = "TRUST_PROXY";
