import { CalendarService } from './calendar.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «calendar».
export class CalendarController {
  constructor(private readonly service: CalendarService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
