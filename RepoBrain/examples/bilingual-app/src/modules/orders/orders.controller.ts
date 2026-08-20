import { OrdersService } from './orders.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «orders».
export class OrdersController {
  constructor(private readonly service: OrdersService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
