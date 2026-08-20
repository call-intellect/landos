import { LoggerService } from '../../common/logger.service.js';
export class LivekitService {
  constructor(private readonly logger: LoggerService) {}
  generateGuestToken(room: string): string {
    this.logger.log('tok');
    return 'guest.' + room;
  }
  canPublishAudioVideo(): boolean {
    return true;
  }
}
