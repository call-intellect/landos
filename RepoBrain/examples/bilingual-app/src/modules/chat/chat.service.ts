import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Обмен сообщениями между пользователями.
export class ChatService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('chat.list'); return []; }
  create(input: unknown): void { this.logger.log('chat.create'); }
}
