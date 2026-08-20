import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Аутентификация и сессии пользователей.
export class AuthService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('auth.list'); return []; }
  create(input: unknown): void { this.logger.log('auth.create'); }
}
