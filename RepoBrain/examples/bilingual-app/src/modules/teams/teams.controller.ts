import { TeamsService } from './teams.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «teams».
export class TeamsController {
  constructor(private readonly service: TeamsService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
