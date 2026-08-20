import { WebhooksService } from './webhooks.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «webhooks».
export class WebhooksController {
  constructor(private readonly service: WebhooksService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
