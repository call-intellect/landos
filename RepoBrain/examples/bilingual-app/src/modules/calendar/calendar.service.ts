import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Календарь и события.
export class CalendarService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('calendar.list'); return []; }
  create(input: unknown): void { this.logger.log('calendar.create'); }
}
