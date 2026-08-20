import { ReportsService } from './reports.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «reports».
export class ReportsController {
  constructor(private readonly service: ReportsService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
