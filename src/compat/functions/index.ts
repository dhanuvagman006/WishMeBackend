/** Every edge-function replacement served on /functions/v1/<name>. */
import type { FunctionDef } from './registry.js';
import { functions as auth } from './handlers/auth.js';
import { functions as payments } from './handlers/payments.js';
import { functions as messaging } from './handlers/messaging.js';
import { functions as contentAi } from './handlers/content-ai.js';
import { functions as audio } from './handlers/audio.js';
import { functions as voice } from './handlers/voice.js';
import { functions as travel } from './handlers/travel.js';

export const allFunctions: FunctionDef[] = [...auth, ...payments, ...messaging, ...contentAi, ...audio, ...voice, ...travel];
