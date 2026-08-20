import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Отправка коротких сообщений.
export class SmsService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('sms.list'); return []; }
  create(input: unknown): void { this.logger.log('sms.create'); }
}
