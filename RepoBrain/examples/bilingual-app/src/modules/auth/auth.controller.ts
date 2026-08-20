import { AuthService } from './auth.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «auth».
export class AuthController {
  constructor(private readonly service: AuthService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
