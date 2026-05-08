/**
 * Shared Hono environment + app context.
 *
 * Stash everything that handlers commonly need (db, signing key, config)
 * onto `c.var.app` via a single middleware. This keeps individual handler
 * signatures clean.
 */

import type { Database } from "./db/index.js";
import type { Config } from "./config.js";
import type { SigningKey } from "./license/keys.js";

export interface AppContext {
  db: Database;
  signingKey: SigningKey;
  config: Config;
}

export interface AppEnv {
  Variables: { app: AppContext };
}
