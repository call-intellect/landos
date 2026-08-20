import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Формирование отчётов.
export class ReportsService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('reports.list'); return []; }
  create(input: unknown): void { this.logger.log('reports.create'); }
}
