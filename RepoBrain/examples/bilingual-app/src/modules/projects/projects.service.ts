import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Проекты и их настройки.
export class ProjectsService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('projects.list'); return []; }
  create(input: unknown): void { this.logger.log('projects.create'); }
}
