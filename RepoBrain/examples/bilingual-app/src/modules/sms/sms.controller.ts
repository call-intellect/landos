import { SmsService } from './sms.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «sms».
export class SmsController {
  constructor(private readonly service: SmsService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
