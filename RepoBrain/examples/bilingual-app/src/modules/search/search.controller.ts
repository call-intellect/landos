import { SearchService } from './search.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «search».
export class SearchController {
  constructor(private readonly service: SearchService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
