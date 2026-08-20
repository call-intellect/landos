import { LoggerService } from './common/logger.service.js';
import { ConfigService } from './common/config.service.js';
import { UsersService } from './modules/users/users.service.js';
import { BillingService } from './modules/billing/billing.service.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { OrdersService } from './modules/orders/orders.service.js';
import { ChatService } from './modules/chat/chat.service.js';
import { SearchService } from './modules/search/search.service.js';
import { FilesService } from './modules/files/files.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { TeamsService } from './modules/teams/teams.service.js';
import { ProjectsService } from './modules/projects/projects.service.js';
import { TasksService } from './modules/tasks/tasks.service.js';
import { CalendarService } from './modules/calendar/calendar.service.js';
import { EmailService } from './modules/email/email.service.js';
import { SmsService } from './modules/sms/sms.service.js';
import { WebhooksService } from './modules/webhooks/webhooks.service.js';
import { AnalyticsService } from './modules/analytics/analytics.service.js';
import { ReportsService } from './modules/reports/reports.service.js';
import { SettingsService } from './modules/settings/settings.service.js';
// Корневой модуль приложения: собирает все сервисы вместе.
export class AppModule {}
