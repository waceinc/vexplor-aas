import { InMemoryStore } from '@aas/store';
import { describeStore, describeStoreFilters } from './conformance.js';

describeStore('InMemoryStore', async () => new InMemoryStore());
describeStoreFilters('InMemoryStore', async () => new InMemoryStore());
