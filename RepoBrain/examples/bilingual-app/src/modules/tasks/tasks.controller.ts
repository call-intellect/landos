import { TasksService } from './tasks.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «tasks».
export class TasksController {
  constructor(private readonly service: TasksService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
