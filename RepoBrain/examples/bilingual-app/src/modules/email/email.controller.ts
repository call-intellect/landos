import { EmailService } from './email.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «email».
export class EmailController {
  constructor(private readonly service: EmailService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
