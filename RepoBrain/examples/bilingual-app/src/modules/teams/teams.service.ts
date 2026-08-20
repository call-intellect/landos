import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Команды и участники.
export class TeamsService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('teams.list'); return []; }
  create(input: unknown): void { this.logger.log('teams.create'); }
}
