import { AnalyticsService } from './analytics.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «analytics».
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
