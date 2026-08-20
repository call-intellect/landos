import { NotificationsService } from './notifications.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «notifications».
export class NotificationsController {
  constructor(private readonly service: NotificationsService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
