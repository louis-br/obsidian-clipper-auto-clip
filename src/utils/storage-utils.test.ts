import { afterEach, describe, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import { loadSettings } from './storage-utils';
import { DEFAULT_AUTO_CLIP_FILENAME_TEMPLATE } from './auto-clip-rules';

describe('storage settings', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

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
			filenameTemplate: DEFAULT_AUTO_CLIP_FILENAME_TEMPLATE,
			delayMs: 3000,
			dedupeHours: 24
		});
	});

	it('trims a stored auto-clip filename template', async () => {
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValueOnce({
			auto_clip_settings: {
				filenameTemplate: '  {{domain|safe_name}} - {{title|safe_name}}  '
			}
		});

		const settings = await loadSettings();

		expect(settings.autoClipSettings.filenameTemplate).toBe('{{domain|safe_name}} - {{title|safe_name}}');
	});

	it('falls back to the default auto-clip filename template when the stored value is blank', async () => {
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValueOnce({
			auto_clip_settings: {
				filenameTemplate: '   '
			}
		});

		const settings = await loadSettings();

		expect(settings.autoClipSettings.filenameTemplate).toBe(DEFAULT_AUTO_CLIP_FILENAME_TEMPLATE);
	});
});
