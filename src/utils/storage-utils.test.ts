import { describe, expect, it } from 'vitest';
import { loadSettings } from './storage-utils';

describe('storage settings', () => {
	it('uses the event-driven auto-clip trigger defaults', async () => {
		const settings = await loadSettings();

		expect(settings.autoClipSettings).toMatchObject({
			enabled: false,
			triggers: {
				pageLoad: true,
				tabClose: false,
				tabDiscard: false
			},
			urlPatterns: ['*'],
			delayMs: 3000,
			dedupeHours: 24
		});
	});
});
