import { SettingsService } from './settings.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «settings».
export class SettingsController {
  constructor(private readonly service: SettingsService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
