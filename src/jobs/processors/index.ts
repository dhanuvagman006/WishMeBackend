import type { ProcessorModule } from '../worker-types.js';
import { module as maintenance } from './maintenance.js';
import { module as payments } from './payments.js';
import { module as reminders } from './reminders.js';
import { module as calls } from './calls.js';
import { module as content } from './content.js';
import { module as notifications } from './notifications.js';

export const modules: ProcessorModule[] = [maintenance, payments, reminders, calls, content, notifications];
