import { describe, expect, it } from 'vitest';
import {
	autoClipUrlMatchesPatterns,
	buildAutoClipDownloadFilename,
	createAutoClipNoteName,
	createAutoClipDedupeKey,
	isAutoClipRecordFresh,
	normalizeAutoClipUrl,
	normalizeDownloadPath,
	parseAutoClipPatterns
} from './auto-clip-rules';

describe('auto-clip rules', () => {
	it('parses URL patterns from textarea content', () => {
		expect(parseAutoClipPatterns('https://example.com\n\n /news/ ')).toEqual([
			'https://example.com',
			'/news/'
		]);
		expect(parseAutoClipPatterns('')).toEqual(['*']);
	});

	it('matches wildcard, prefix, and regex URL patterns', () => {
		expect(autoClipUrlMatchesPatterns('https://example.com/article', ['*'])).toBe(true);
		expect(autoClipUrlMatchesPatterns('https://example.com/article', ['https://example.com'])).toBe(true);
		expect(autoClipUrlMatchesPatterns('https://example.com/article', ['/example\\.com\\/article/'])).toBe(true);
		expect(autoClipUrlMatchesPatterns('https://example.com/article', ['https://other.example'])).toBe(false);
	});

	it('normalizes URLs for dedupe keys by removing fragments', () => {
		expect(normalizeAutoClipUrl('https://example.com/a?b=1#section')).toBe('https://example.com/a?b=1');
		expect(createAutoClipDedupeKey('https://example.com/a#one', 'template-1')).toBe('template-1:https://example.com/a');
	});

	it('checks whether dedupe records are still fresh', () => {
		const now = 10_000;
		expect(isAutoClipRecordFresh(undefined, 24, now)).toBe(false);
		expect(isAutoClipRecordFresh({
			clippedAt: now - 1000,
			url: 'https://example.com',
			templateId: 'template-1'
		}, 1, now)).toBe(true);
		expect(isAutoClipRecordFresh({
			clippedAt: now - 2 * 60 * 60 * 1000,
			url: 'https://example.com',
			templateId: 'template-1'
		}, 1, now)).toBe(false);
		expect(isAutoClipRecordFresh({
			clippedAt: now - 1000,
			url: 'https://example.com',
			templateId: 'template-1'
		}, 0, now)).toBe(false);
	});

	it('normalizes download paths and filenames', () => {
		expect(normalizeDownloadPath('Clippings/../Articles//Today')).toBe('Clippings/Articles/Today');
		expect(buildAutoClipDownloadFilename('Clippings/Articles', 'An article')).toBe('Clippings/Articles/An article.md');
		expect(buildAutoClipDownloadFilename('', 'Already.md')).toBe('Already.md');
	});

	it('uses URL context when note titles are generic', () => {
		expect(createAutoClipNoteName('Search', 'https://deepwiki.com/org/repo/3-auto-save-functionality')).toBe(
			'deepwiki.com - repo - 3 auto save functionality'
		);
		expect(createAutoClipNoteName('Specific title', 'https://example.com/path')).toBe('Specific title');
		expect(createAutoClipNoteName('', 'https://example.com/')).toBe('example.com');
	});
});
