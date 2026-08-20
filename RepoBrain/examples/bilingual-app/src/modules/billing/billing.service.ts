import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Выставление счетов и обработка платежей.
export class BillingService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('billing.list'); return []; }
  create(input: unknown): void { this.logger.log('billing.create'); }
}
