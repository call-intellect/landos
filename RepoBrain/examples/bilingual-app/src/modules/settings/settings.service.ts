import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Пользовательские настройки.
export class SettingsService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('settings.list'); return []; }
  create(input: unknown): void { this.logger.log('settings.create'); }
}
