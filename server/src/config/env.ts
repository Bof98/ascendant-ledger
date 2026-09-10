import { z } from 'zod';
import path from 'node:path';

/**
 * Environment configuration.
 *
 * Everything the container needs is read once, validated once, and frozen. A bad
 * value fails at boot with a readable message rather than surfacing as a strange
 * runtime error later.
 *
 * DATA_DIR is the single most important setting: it is the directory bind-mounted
 * from the NAS, and it holds the SQLite database plus its WAL sidecar files. It
 * must never point inside the container's ephemeral filesystem.
 */

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Directory holding the SQLite database. Must be a persistent volume. */
  DATA_DIR: z.string().min(1).default('./data'),
  /** Database filename inside DATA_DIR. */
  DATABASE_FILENAME: z.string().min(1).default('ascendant-ledger.db'),

  /** Single-user login. Off by default; turn on before exposing via a proxy. */
  AUTH_ENABLED: booleanish.default('false'),
  /** Required when AUTH_ENABLED is true. */
  SESSION_SECRET: z.string().min(32).optional(),
  /** First-boot credentials used only to seed app_users when auth is enabled. */
  ADMIN_USERNAME: z.string().min(1).max(80).optional(),
  ADMIN_PASSWORD: z.string().min(12).max(256).optional(),

  /** Upload guards. The setting in app_settings may lower these, never raise them. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26_214_400), // 25 MiB
  MAX_FILES_PER_BATCH: z.coerce.number().int().positive().max(100).default(20),

  /** Set to true only when running behind a reverse proxy you control. */
  TRUST_PROXY: booleanish.default('false'),

  /** Optional connection to the existing Flask capture/strategy service. */
  OPERATIONS_URL: z.string().url().optional(),
  /** Read-only database containing this realm's saved captures. Explicit opt-in. */
  OPERATIONS_DB_PATH: z.string().min(1).optional(),
  /** Existing Playwright session, read-only, used only for official CSV GETs. */
  CSV_STORAGE_STATE_PATH: z.string().min(1).optional(),
  CSV_COMPANY_ID: z.coerce.number().int().positive().optional(),
  CSV_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(60_000),
  CAPTURE_SYNC_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
  OPERATIONS_REALM: z.enum(['magnates', 'entrepreneurs']).default('magnates'),
  OPERATIONS_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  /** Same-origin path to the original console, including its trailing slash. */
  OPERATIONS_CONSOLE_PATH: z.string().regex(/^\/(?!\/)[a-zA-Z0-9/_-]*\/$/).default('/simcompanies-classic/'),
});

type RawEnv = z.infer<typeof EnvSchema>;

export interface AppConfig extends RawEnv {
  /** Absolute path to the SQLite file, derived from DATA_DIR + DATABASE_FILENAME. */
  databasePath: string;
  isProduction: boolean;
}

function build(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  if (Boolean(env.CSV_STORAGE_STATE_PATH) !== Boolean(env.CSV_COMPANY_ID)) throw new Error('CSV_STORAGE_STATE_PATH and CSV_COMPANY_ID must be configured together');
  if (env.CSV_STORAGE_STATE_PATH && !env.OPERATIONS_DB_PATH) throw new Error('CSV downloads require OPERATIONS_DB_PATH to follow accounting page captures');
  if (env.OPERATIONS_DB_PATH && !env.OPERATIONS_URL) throw new Error('OPERATIONS_DB_PATH requires OPERATIONS_URL for realm verification');

  if (env.OPERATIONS_URL) {
    const url = new URL(env.OPERATIONS_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('OPERATIONS_URL must be an HTTP(S) base URL without credentials, query, or fragment.');
    }
  }

  if (env.AUTH_ENABLED && !env.SESSION_SECRET) {
    throw new Error(
      'AUTH_ENABLED is true but SESSION_SECRET is unset. ' +
        'Generate one with: openssl rand -base64 48',
    );
  }

  const dataDir = path.resolve(env.DATA_DIR);

  return Object.freeze({
    ...env,
    databasePath: path.join(dataDir, env.DATABASE_FILENAME),
    DATA_DIR: dataDir,
    isProduction: env.NODE_ENV === 'production',
  });
}

export const config: AppConfig = build(process.env);
export { build as buildConfig };
