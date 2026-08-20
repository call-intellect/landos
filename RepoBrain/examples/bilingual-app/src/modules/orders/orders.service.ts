import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Оформление и обработка заказов.
export class OrdersService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('orders.list'); return []; }
  create(input: unknown): void { this.logger.log('orders.create'); }
}
