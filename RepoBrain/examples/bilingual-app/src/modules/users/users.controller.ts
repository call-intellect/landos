import { UsersService } from './users.service.js';
import { LoggerService } from '../../common/logger.service.js';
// HTTP-контроллер модуля «users».
export class UsersController {
  constructor(private readonly service: UsersService, private readonly logger: LoggerService) {}
  index(): unknown[] { return this.service.list(); }
}
