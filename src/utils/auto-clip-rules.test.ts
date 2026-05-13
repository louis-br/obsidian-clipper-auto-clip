import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AUTO_CLIP_FILENAME_TEMPLATE,
	MAX_AUTO_CLIP_FILENAME_BASENAME_LENGTH,
	autoClipUrlMatchesPatterns,
	buildAutoClipDownloadFilename,
	createAutoClipNoteName,
	createAutoClipDedupeKey,
	isAutoClipRecordFresh,
	normalizeAutoClipUrl,
	normalizeDownloadPath,
	parseAutoClipPatterns
} from './auto-clip-rules';
import { compileTemplate } from './template-compiler';

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

	it('builds filenames from the default filename template and keeps folders from the template path', async () => {
		const compiledFilename = await compileTemplate(0, DEFAULT_AUTO_CLIP_FILENAME_TEMPLATE, {
			'{{date}}': '2026-05-13T10:30:45',
			'{{site}}': 'Example: Site?',
			'{{title}}': 'AC/DC: "Back in Black" Review? [2026]'
		}, 'https://example.com/articles/review');

		expect(compiledFilename).toBe('2026-05-13 10-30-45 - Example Site - ACDC Back in Black Review 2026');
		expect(buildAutoClipDownloadFilename('Clippings/Articles', compiledFilename)).toBe(
			'Clippings/Articles/2026-05-13 10-30-45 - Example Site - ACDC Back in Black Review 2026.md'
		);
	});

	it('does not append a second markdown extension to templated filenames', () => {
		expect(buildAutoClipDownloadFilename('Clippings', '2026-05-13 - Example - Article.md')).toBe(
			'Clippings/2026-05-13 - Example - Article.md'
		);
	});

	it('caps long auto-clip filename basenames before adding the markdown extension', () => {
		const filename = buildAutoClipDownloadFilename('', 'a'.repeat(400));
		expect(filename).toBe(`${'a'.repeat(MAX_AUTO_CLIP_FILENAME_BASENAME_LENGTH)}.md`);
	});
});
