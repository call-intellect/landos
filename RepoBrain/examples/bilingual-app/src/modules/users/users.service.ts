import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Управление пользователями и их профилями.
export class UsersService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('users.list'); return []; }
  create(input: unknown): void { this.logger.log('users.create'); }
}
