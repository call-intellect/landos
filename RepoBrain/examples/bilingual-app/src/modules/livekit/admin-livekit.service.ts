import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Административные операции над комнатами видеосвязи: создание, удаление, статистика.
export class AdminLivekitService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  listRooms(): string[] { return []; }
  deleteRoom(id: string): void { this.logger.log('delete room ' + id); }
}
