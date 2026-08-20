import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Внешние веб-хуки и их доставка.
export class WebhooksService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('webhooks.list'); return []; }
  create(input: unknown): void { this.logger.log('webhooks.create'); }
}
