import { ChatService } from './chat.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «chat».
export class ChatController {
  constructor(private readonly service: ChatService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
