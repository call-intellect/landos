import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Сбор и агрегация метрик.
export class AnalyticsService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('analytics.list'); return []; }
  create(input: unknown): void { this.logger.log('analytics.create'); }
}
