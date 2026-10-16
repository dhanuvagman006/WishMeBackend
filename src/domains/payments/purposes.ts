/** Registers the payment purposes each domain owns (wallet deposits and plans are built into Payments). */
import type { Deps } from '../../deps.js';
import { register as celebrities } from './purposes/celebrities.js';
import { register as content } from './purposes/content.js';

export function registerPaymentPurposes(deps: Deps): void {
  celebrities(deps);
  content(deps);
}
