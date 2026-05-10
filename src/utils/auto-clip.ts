import browser from './browser-polyfill';
import { Template, Property } from '../types/types';
import { loadSettings, generalSettings, incrementStat } from './storage-utils';
import { loadTemplates } from '../managers/template-manager';
import { initializeTriggers, findMatchingTemplate } from './triggers';
import { ContentResponse } from './content-extractor';
import { compileTemplate } from './template-compiler';
import { generateFrontmatter, formatPropertyValue } from './shared';
import { unescapeValue } from './string-utils';
import { isBlankPage, isRestrictedUrl } from './active-tab-manager';
import { collectTemplatePromptVariables } from './prompt-variables';
import {
	AutoClipDedupeRecord,
	autoClipUrlMatchesPatterns,
	buildAutoClipDownloadFilename,
	createAutoClipNoteName,
	createAutoClipDedupeKey,
	isAutoClipRecordFresh,
	normalizeAutoClipUrl
} from './auto-clip-rules';

const AUTO_CLIP_HISTORY_KEY = 'autoClipHistory';
const AUTO_CLIP_STATUS_KEY = 'autoClipLastStatus';
const MAX_HISTORY_RECORDS = 1000;
const MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const autoClipTimers = new Map<number, ReturnType<typeof setTimeout>>();
const inFlightAutoClips = new Set<string>();

type AutoClipHistory = Record<string, AutoClipDedupeRecord>;

async function setAutoClipStatus(status: string, details: Record<string, any> = {}): Promise<void> {
	try {
		await browser.storage.local.set({
			[AUTO_CLIP_STATUS_KEY]: {
				at: new Date().toISOString(),
				status,
				...details
			}
		});
	} catch {
		// Status recording should never affect clipping.
	}
}

export async function getAutoClipStatus(): Promise<any> {
	const result = await browser.storage.local.get(AUTO_CLIP_STATUS_KEY);
	return result[AUTO_CLIP_STATUS_KEY];
}

async function autoClipDebugLog(...args: any[]): Promise<void> {
	try {
		const result = await browser.storage.local.get('autoClipDebug');
		if (result.autoClipDebug) {
			console.info('[Obsidian Clipper][AutoClip]', ...args);
		}
	} catch {
		// Logging should never affect clipping.
	}
}

function isAutoClipCandidateUrl(url: string | undefined): url is string {
	if (!url) return false;
	return (url.startsWith('http://') || url.startsWith('https://'))
		&& !isBlankPage(url)
		&& !isRestrictedUrl(url);
}

function getPropertyTypeMap(): Record<string, string> {
	return generalSettings.propertyTypes.reduce((types, propertyType) => {
		types[propertyType.name] = propertyType.type;
		return types;
	}, {} as Record<string, string>);
}

async function injectContentScriptForAutoClip(tabId: number): Promise<void> {
	if (browser.scripting) {
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['content.js']
		});
	} else {
		await browser.tabs.executeScript(tabId, { file: 'content.js' });
	}

	for (let i = 0; i < 8; i++) {
		try {
			await browser.tabs.sendMessage(tabId, { action: 'ping' });
			return;
		} catch {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}

	throw new Error('Content script did not respond after injection');
}

async function ensureContentScriptForAutoClip(tabId: number): Promise<void> {
	try {
		await browser.tabs.sendMessage(tabId, { action: 'ping' });
	} catch {
		await injectContentScriptForAutoClip(tabId);
	}
}

async function sendDirectExtractRequest(tabId: number): Promise<ContentResponse> {
	await ensureContentScriptForAutoClip(tabId);
	const response = await browser.tabs.sendMessage(tabId, {
		action: 'getPageContent',
		includeInitializedContent: true
	}) as ContentResponse & { success?: boolean; error?: string };

	if (response && 'success' in response && !response.success && response.error) {
		throw new Error(response.error);
	}
	if (response?.content) {
		return response;
	}
	throw new Error('No content received from page');
}

async function extractPageContentForAutoClip(tabId: number): Promise<ContentResponse | null> {
	try {
		return await sendDirectExtractRequest(tabId);
	} catch (firstError) {
		await autoClipDebugLog('First extraction attempt failed, reinjecting content script', {
			error: firstError instanceof Error ? firstError.message : String(firstError)
		});
		await injectContentScriptForAutoClip(tabId);
		return sendDirectExtractRequest(tabId);
	}
}

async function getAutoClipHistory(): Promise<AutoClipHistory> {
	const result = await browser.storage.local.get(AUTO_CLIP_HISTORY_KEY);
	return (result[AUTO_CLIP_HISTORY_KEY] || {}) as AutoClipHistory;
}

async function saveAutoClipHistory(history: AutoClipHistory): Promise<void> {
	const now = Date.now();
	const prunedEntries = Object.entries(history)
		.filter(([, record]) => now - record.clippedAt < MAX_HISTORY_AGE_MS)
		.sort(([, a], [, b]) => b.clippedAt - a.clippedAt)
		.slice(0, MAX_HISTORY_RECORDS);
	const prunedHistory = prunedEntries.reduce((records, [key, record]) => {
		records[key] = record;
		return records;
	}, {} as AutoClipHistory);

	await browser.storage.local.set({
		[AUTO_CLIP_HISTORY_KEY]: prunedHistory
	});
}

async function hasFreshAutoClipRecord(key: string): Promise<boolean> {
	const history = await getAutoClipHistory();
	return isAutoClipRecordFresh(history[key], generalSettings.autoClipSettings.dedupeHours);
}

async function recordAutoClip(key: string, record: AutoClipDedupeRecord): Promise<void> {
	const history = await getAutoClipHistory();
	history[key] = record;
	await saveAutoClipHistory(history);
}

async function eraseDownloadHistoryWhenComplete(downloadId: number): Promise<void> {
	if (!browser.downloads?.erase) {
		return;
	}

	const eraseHistory = async () => {
		try {
			await browser.downloads.erase({ id: downloadId });
		} catch (error) {
			console.warn('[Obsidian Clipper] Failed to erase auto-clip download history:', error);
		}
	};

	try {
		const existingItems = await browser.downloads.search({ id: downloadId });
		const existingItem = existingItems[0];
		if (existingItem?.state === 'complete') {
			await eraseHistory();
			return;
		}
	} catch {
		// If search is unavailable or transiently fails, fall back to onChanged.
	}

	const listener = (delta: browser.Downloads.OnChangedDownloadDeltaType) => {
		if (delta.id !== downloadId || delta.state?.current !== 'complete') {
			return;
		}

		browser.downloads.onChanged.removeListener(listener);
		eraseHistory();
	};

	browser.downloads.onChanged.addListener(listener);
}

async function downloadMarkdownFile(content: string, filename: string): Promise<number | undefined> {
	if (!browser.downloads?.download) {
		throw new Error('Downloads API is not available in this browser.');
	}

	const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
	const url = URL.createObjectURL(blob);

	try {
		const downloadId = await browser.downloads.download({
			url,
			filename,
			saveAs: false,
			conflictAction: 'uniquify'
		});
		if (typeof downloadId === 'number') {
			eraseDownloadHistoryWhenComplete(downloadId);
		}
		return downloadId;
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}

async function compileAutoClipProperties(
	template: Template,
	variables: { [key: string]: string },
	tabId: number,
	currentUrl: string
): Promise<Property[]> {
	const propertyTypeMap = getPropertyTypeMap();

	return Promise.all((template.properties || []).map(async property => {
		const propertyType = propertyTypeMap[property.name] || 'text';
		const compiledValue = await compileTemplate(tabId, unescapeValue(property.value), variables, currentUrl);

		return {
			id: property.id,
			name: property.name,
			type: property.type,
			value: formatPropertyValue(compiledValue, propertyType, property.value)
		};
	}));
}

export async function autoClipTab(tabId: number, expectedUrl?: string): Promise<void> {
	await loadSettings();

	const tab = await browser.tabs.get(tabId);
	const currentUrl = tab.url;
	if (!isAutoClipCandidateUrl(currentUrl) || !generalSettings.autoClipSettings.enabled) {
		await setAutoClipStatus('skipped-disabled-or-unsupported-url', { tabId, currentUrl, enabled: generalSettings.autoClipSettings.enabled });
		await autoClipDebugLog('Skipping tab: disabled or unsupported URL', { tabId, currentUrl, enabled: generalSettings.autoClipSettings.enabled });
		return;
	}

	if (expectedUrl && normalizeAutoClipUrl(expectedUrl) !== normalizeAutoClipUrl(currentUrl)) {
		await setAutoClipStatus('skipped-url-changed', { expectedUrl, currentUrl });
		await autoClipDebugLog('Skipping tab: URL changed before delayed clip', { expectedUrl, currentUrl });
		return;
	}

	if (!autoClipUrlMatchesPatterns(currentUrl, generalSettings.autoClipSettings.urlPatterns)) {
		await setAutoClipStatus('skipped-url-pattern-mismatch', {
			currentUrl,
			patterns: generalSettings.autoClipSettings.urlPatterns
		});
		await autoClipDebugLog('Skipping tab: URL did not match auto-clip patterns', {
			currentUrl,
			patterns: generalSettings.autoClipSettings.urlPatterns
		});
		return;
	}

	const templates = await loadTemplates();
	if (templates.length === 0) {
		await setAutoClipStatus('skipped-no-templates', { currentUrl });
		await autoClipDebugLog('Skipping tab: no templates loaded', { currentUrl });
		return;
	}
	initializeTriggers(templates);

	await autoClipDebugLog('Extracting page content', { tabId, currentUrl });
	const extractedData = await extractPageContentForAutoClip(tabId);
	if (!extractedData?.initializedContent) {
		throw new Error('Unable to initialize page content for auto-clip.');
	}

	const template = await findMatchingTemplate(currentUrl, async () => extractedData.schemaOrgData) || templates[0];
	if (collectTemplatePromptVariables(template).length > 0) {
		await setAutoClipStatus('skipped-template-has-prompt-variables', { template: template.name, currentUrl });
		await autoClipDebugLog('Skipping tab: template contains prompt variables', { template: template.name, currentUrl });
		console.info(`[Obsidian Clipper] Auto-clip skipped "${template.name}" because it contains interpreter prompt variables.`);
		return;
	}

	const dedupeKey = createAutoClipDedupeKey(currentUrl, template.id);
	if (inFlightAutoClips.has(dedupeKey) || await hasFreshAutoClipRecord(dedupeKey)) {
		await setAutoClipStatus('skipped-duplicate-or-in-flight', { dedupeKey, currentUrl, template: template.name });
		await autoClipDebugLog('Skipping tab: fresh duplicate or clip already in flight', { dedupeKey, currentUrl, template: template.name });
		return;
	}

	inFlightAutoClips.add(dedupeKey);
	try {
		const variables = extractedData.initializedContent.currentVariables;
		const [compiledProperties, compiledNoteName, compiledPath, compiledContent] = await Promise.all([
			compileAutoClipProperties(template, variables, tabId, currentUrl),
			compileTemplate(tabId, template.noteNameFormat, variables, currentUrl),
			compileTemplate(tabId, template.path, variables, currentUrl),
			template.noteContentFormat
				? compileTemplate(tabId, template.noteContentFormat, variables, currentUrl)
				: Promise.resolve('')
		]);

		const frontmatter = generateFrontmatter(compiledProperties, getPropertyTypeMap());
		const fileContent = frontmatter + compiledContent;
		const noteName = compiledNoteName.trim()
			|| extractedData.initializedContent.noteName
			|| extractedData.title
			|| 'Untitled';
		const filename = buildAutoClipDownloadFilename(compiledPath, createAutoClipNoteName(noteName, currentUrl, extractedData.site));
		const downloadId = await downloadMarkdownFile(fileContent, filename);
		await setAutoClipStatus('downloaded', { filename, downloadId, currentUrl, template: template.name });
		await autoClipDebugLog('Downloaded auto-clip markdown', { filename, downloadId, currentUrl, template: template.name });

		await incrementStat('saveFile', template.vault, compiledPath, currentUrl, extractedData.title);
		await recordAutoClip(dedupeKey, {
			clippedAt: Date.now(),
			downloadId,
			filename,
			title: extractedData.title,
			url: normalizeAutoClipUrl(currentUrl),
			templateId: template.id
		});
	} finally {
		inFlightAutoClips.delete(dedupeKey);
	}
}

export async function scheduleAutoClipForTab(tabId: number, expectedUrl?: string): Promise<void> {
	await loadSettings();

	if (!generalSettings.autoClipSettings.enabled) {
		await setAutoClipStatus('not-scheduled-disabled', { tabId, expectedUrl });
		await autoClipDebugLog('Not scheduling: auto-clip disabled', { tabId, expectedUrl });
		return;
	}

	const tab = await browser.tabs.get(tabId);
	const currentUrl = expectedUrl || tab.url;
	if (!isAutoClipCandidateUrl(currentUrl)) {
		await setAutoClipStatus('not-scheduled-unsupported-url', { tabId, currentUrl });
		await autoClipDebugLog('Not scheduling: unsupported URL', { tabId, currentUrl });
		return;
	}

	if (!autoClipUrlMatchesPatterns(currentUrl, generalSettings.autoClipSettings.urlPatterns)) {
		await setAutoClipStatus('not-scheduled-url-pattern-mismatch', {
			tabId,
			currentUrl,
			patterns: generalSettings.autoClipSettings.urlPatterns
		});
		await autoClipDebugLog('Not scheduling: URL did not match patterns', {
			tabId,
			currentUrl,
			patterns: generalSettings.autoClipSettings.urlPatterns
		});
		return;
	}

	const existingTimer = autoClipTimers.get(tabId);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	const delayMs = Math.max(0, generalSettings.autoClipSettings.delayMs);
	await setAutoClipStatus('scheduled', { tabId, currentUrl, delayMs });
	await autoClipDebugLog('Scheduled auto-clip', { tabId, currentUrl, delayMs });
	const timer = setTimeout(() => {
		autoClipTimers.delete(tabId);
		autoClipTab(tabId, currentUrl).catch(error => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			setAutoClipStatus('failed', {
				tabId,
				currentUrl,
				error: errorMessage,
				hint: errorMessage.includes('Missing host permission')
					? 'Grant auto-clip site access in extension settings.'
					: undefined
			});
			console.error('[Obsidian Clipper] Auto-clip failed:', error);
		});
	}, delayMs);

	autoClipTimers.set(tabId, timer);
}

export async function debugAutoClipActiveTab(): Promise<{ success: boolean; status?: any; tab?: { id?: number; url?: string }; error?: string }> {
	try {
		await browser.storage.local.remove(AUTO_CLIP_HISTORY_KEY);
		const tabs = await browser.tabs.query({ active: true, currentWindow: true });
		const tab = tabs[0];
		if (!tab?.id) {
			await setAutoClipStatus('debug-no-active-tab');
			return { success: false, status: await getAutoClipStatus(), error: 'No active tab found' };
		}

		await setAutoClipStatus('debug-started', { tabId: tab.id, currentUrl: tab.url });
		await autoClipTab(tab.id, tab.url);
		return {
			success: true,
			status: await getAutoClipStatus(),
			tab: { id: tab.id, url: tab.url }
		};
	} catch (error) {
		await setAutoClipStatus('debug-failed', {
			error: error instanceof Error ? error.message : String(error)
		});
		return {
			success: false,
			status: await getAutoClipStatus(),
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
