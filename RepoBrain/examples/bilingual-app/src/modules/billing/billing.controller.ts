import { BillingService } from './billing.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «billing».
export class BillingController {
  constructor(private readonly service: BillingService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
