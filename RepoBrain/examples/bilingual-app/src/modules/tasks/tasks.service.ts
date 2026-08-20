import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Задачи и их статусы.
export class TasksService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('tasks.list'); return []; }
  create(input: unknown): void { this.logger.log('tasks.create'); }
}
