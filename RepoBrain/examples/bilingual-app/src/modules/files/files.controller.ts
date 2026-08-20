import { FilesService } from './files.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «files».
export class FilesController {
  constructor(private readonly service: FilesService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
