import { ProjectsService } from './projects.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «projects».
export class ProjectsController {
  constructor(private readonly service: ProjectsService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
