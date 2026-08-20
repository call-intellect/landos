import { LoggerService } from '../../common/logger.service.js';
import { ConfigService } from '../../common/config.service.js';
// Загрузка и хранение файлов.
export class FilesService {
  constructor(private readonly logger: LoggerService, private readonly config: ConfigService) {}
  list(): unknown[] { this.logger.log('files.list'); return []; }
  create(input: unknown): void { this.logger.log('files.create'); }
}
