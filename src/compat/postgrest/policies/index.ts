/** Every table policy and RPC exposed on /rest/v1. A table missing here is not reachable. */
import type { RpcDefinition, TablePolicy } from '../policy.js';
import * as accounts from './accounts.js';
import * as celebrities from './celebrities.js';
import * as content from './content.js';
import * as hub from './hub.js';

export const allPolicies: TablePolicy[] = [...accounts.tables, ...celebrities.tables, ...content.tables, ...hub.tables];

export const allRpcs: RpcDefinition[] = [...accounts.rpcs, ...celebrities.rpcs, ...content.rpcs, ...hub.rpcs];
