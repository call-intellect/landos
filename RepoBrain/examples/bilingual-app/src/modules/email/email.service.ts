import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Отправка электронной почты.
export class EmailService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('email.list'); return []; }
  create(input: unknown): void { this.logger.log('email.create'); }
}
