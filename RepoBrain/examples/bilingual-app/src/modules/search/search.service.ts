import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Полнотекстовый поиск по сущностям.
export class SearchService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('search.list'); return []; }
  create(input: unknown): void { this.logger.log('search.create'); }
}
