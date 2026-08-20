/**
 * HTTP server entry point. Boots the express app on the configured port.
 */

import { createApp } from "./app.js";
import { config } from "./common/config.js";
import { logger } from "./common/logger.js";

export function startServer(): void {
  const app = createApp();
  app.listen(config.port, () => {
    logger.info("server started", { port: config.port, env: config.env });
  });
}

// Start only when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  startServer();
}
