import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Отправка уведомлений пользователям.
export class NotificationsService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('notifications.list'); return []; }
  create(input: unknown): void { this.logger.log('notifications.create'); }
}
