import { sanitizeFileName } from './string-utils';

export interface AutoClipDedupeRecord {
	clippedAt: number;
	downloadId?: number;
	filename?: string;
	title?: string;
	url: string;
	templateId: string;
}

export function parseAutoClipPatterns(value: string): string[] {
	const patterns = value
		.split(/\r?\n/)
		.map(pattern => pattern.trim())
		.filter(Boolean);

	return patterns.length > 0 ? patterns : ['*'];
}

export function normalizeAutoClipUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = '';
		return parsed.href;
	} catch {
		return url.split('#')[0];
	}
}

export function autoClipUrlMatchesPatterns(url: string, patterns: string[]): boolean {
	const normalizedPatterns = patterns.map(pattern => pattern.trim()).filter(Boolean);
	if (normalizedPatterns.length === 0) return true;

	return normalizedPatterns.some(pattern => {
		if (pattern === '*') {
			return true;
		}

		if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
			try {
				return new RegExp(pattern.slice(1, -1)).test(url);
			} catch (error) {
				console.error(`Invalid auto-clip URL pattern: ${pattern}`, error);
				return false;
			}
		}

		return url.startsWith(pattern);
	});
}

export function createAutoClipDedupeKey(url: string, templateId: string): string {
	return `${templateId}:${normalizeAutoClipUrl(url)}`;
}

export function isAutoClipRecordFresh(record: AutoClipDedupeRecord | undefined, dedupeHours: number, now = Date.now()): boolean {
	if (!record || dedupeHours <= 0) return false;
	const dedupeMs = dedupeHours * 60 * 60 * 1000;
	return now - record.clippedAt < dedupeMs;
}

export function normalizeDownloadPath(path: string): string {
	return path
		.split(/[\\/]+/)
		.map(segment => segment.trim())
		.filter(segment => segment !== '' && segment !== '.' && segment !== '..')
		.map(segment => sanitizeFileName(segment))
		.filter(Boolean)
		.join('/');
}

export function buildAutoClipDownloadFilename(path: string, noteName: string): string {
	const sanitizedNoteName = sanitizeFileName(noteName || 'Untitled');
	const fileName = sanitizedNoteName.toLowerCase().endsWith('.md')
		? sanitizedNoteName
		: `${sanitizedNoteName}.md`;
	const normalizedPath = normalizeDownloadPath(path);

	return normalizedPath ? `${normalizedPath}/${fileName}` : fileName;
}

export function createAutoClipNoteName(noteName: string, url: string, site?: string): string {
	const trimmedName = noteName.trim();
	if (!isGenericNoteName(trimmedName)) {
		return trimmedName;
	}

	const urlName = createNameFromUrl(url, site);
	return urlName || trimmedName || 'Untitled';
}

function isGenericNoteName(noteName: string): boolean {
	const normalized = noteName.trim().toLowerCase();
	return normalized === ''
		|| normalized === 'untitled'
		|| normalized === 'home'
		|| normalized === 'index'
		|| normalized === 'search'
		|| normalized === 'page';
}

function createNameFromUrl(url: string, site?: string): string {
	try {
		const parsed = new URL(url);
		const host = (site || parsed.hostname.replace(/^www\./, '')).trim();
		const pathParts = parsed.pathname
			.split('/')
			.map(part => decodeURIComponent(part.trim()))
			.filter(Boolean)
			.slice(-2)
			.map(formatUrlSegment)
			.filter(Boolean);

		if (pathParts.length > 0) {
			return [host, pathParts.join(' - ')].filter(Boolean).join(' - ');
		}

		const query = parsed.searchParams.get('q') || parsed.searchParams.get('query') || parsed.searchParams.get('search');
		if (query) {
			return [host, formatUrlSegment(query)].filter(Boolean).join(' - ');
		}

		return host;
	} catch {
		return '';
	}
}

function formatUrlSegment(segment: string): string {
	return segment
		.replace(/\.[a-z0-9]{1,6}$/i, '')
		.replace(/[-_]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
