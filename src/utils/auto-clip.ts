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
const PAGE_CHANGE_REFRESH_DELAY_MS = 2000;

const pageLoadTimers = new Map<number, ReturnType<typeof setTimeout>>();
const snapshotRefreshTimers = new Map<number, ReturnType<typeof setTimeout>>();
const autoClipSnapshots = new Map<number, AutoClipSnapshot>();
const inFlightAutoClips = new Set<string>();
const inFlightSnapshotRefreshes = new Set<number>();

export type AutoClipTrigger = 'pageLoad' | 'tabClose' | 'tabDiscard' | 'pageChange' | 'debug';

type AutoClipHistory = Record<string, AutoClipDedupeRecord>;

interface AutoClipSnapshot {
	content: string;
	filename: string;
	tabId: number;
	templateId: string;
	templateName: string;
	title?: string;
	url: string;
	vault?: string;
	path?: string;
	createdAt: number;
}

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

function hasSnapshotTriggers(): boolean {
	return generalSettings.autoClipSettings.triggers.tabClose
		|| generalSettings.autoClipSettings.triggers.tabDiscard;
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

function cacheAutoClipSnapshot(snapshot: AutoClipSnapshot): void {
	autoClipSnapshots.set(snapshot.tabId, snapshot);
}

function clearAutoClipTimers(tabId: number): void {
	const pageLoadTimer = pageLoadTimers.get(tabId);
	if (pageLoadTimer) {
		clearTimeout(pageLoadTimer);
		pageLoadTimers.delete(tabId);
	}

	const snapshotTimer = snapshotRefreshTimers.get(tabId);
	if (snapshotTimer) {
		clearTimeout(snapshotTimer);
		snapshotRefreshTimers.delete(tabId);
	}
}

function clearAutoClipTabState(tabId: number): void {
	clearAutoClipTimers(tabId);
	autoClipSnapshots.delete(tabId);
	inFlightSnapshotRefreshes.delete(tabId);
}

async function buildAutoClipSnapshot(
	tabId: number,
	expectedUrl: string | undefined,
	trigger: AutoClipTrigger
): Promise<AutoClipSnapshot | null> {
	await loadSettings();

	const tab = await browser.tabs.get(tabId);
	const currentUrl = trigger === 'pageChange' && expectedUrl ? expectedUrl : tab.url;
	if (!isAutoClipCandidateUrl(currentUrl) || !generalSettings.autoClipSettings.enabled) {
		await setAutoClipStatus('skipped-disabled-or-unsupported-url', { tabId, trigger, currentUrl, enabled: generalSettings.autoClipSettings.enabled });
		await autoClipDebugLog('Skipping snapshot: disabled or unsupported URL', { tabId, trigger, currentUrl, enabled: generalSettings.autoClipSettings.enabled });
		return null;
	}

	if (expectedUrl && trigger !== 'pageChange' && normalizeAutoClipUrl(expectedUrl) !== normalizeAutoClipUrl(currentUrl)) {
		await setAutoClipStatus('skipped-url-changed', { tabId, trigger, expectedUrl, currentUrl });
		await autoClipDebugLog('Skipping snapshot: URL changed before refresh', { tabId, trigger, expectedUrl, currentUrl });
		return null;
	}

	if (!autoClipUrlMatchesPatterns(currentUrl, generalSettings.autoClipSettings.urlPatterns)) {
		await setAutoClipStatus('skipped-url-pattern-mismatch', {
			tabId,
			trigger,
			currentUrl,
			patterns: generalSettings.autoClipSettings.urlPatterns
		});
		await autoClipDebugLog('Skipping snapshot: URL did not match auto-clip patterns', {
			tabId,
			trigger,
			currentUrl,
			patterns: generalSettings.autoClipSettings.urlPatterns
		});
		return null;
	}

	const templates = await loadTemplates();
	if (templates.length === 0) {
		await setAutoClipStatus('skipped-no-templates', { tabId, trigger, currentUrl });
		await autoClipDebugLog('Skipping snapshot: no templates loaded', { tabId, trigger, currentUrl });
		return null;
	}
	initializeTriggers(templates);

	await autoClipDebugLog('Extracting page content for snapshot', { tabId, trigger, currentUrl });
	const extractedData = await extractPageContentForAutoClip(tabId);
	if (!extractedData?.initializedContent) {
		throw new Error('Unable to initialize page content for auto-clip.');
	}

	const template = await findMatchingTemplate(currentUrl, async () => extractedData.schemaOrgData) || templates[0];
	if (collectTemplatePromptVariables(template).length > 0) {
		await setAutoClipStatus('skipped-template-has-prompt-variables', { tabId, trigger, template: template.name, currentUrl });
		await autoClipDebugLog('Skipping snapshot: template contains prompt variables', { tabId, trigger, template: template.name, currentUrl });
		console.info(`[Obsidian Clipper] Auto-clip skipped "${template.name}" because it contains interpreter prompt variables.`);
		return null;
	}

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
	const content = frontmatter + compiledContent;
	const noteName = compiledNoteName.trim()
		|| extractedData.initializedContent.noteName
		|| extractedData.title
		|| 'Untitled';
	const filename = buildAutoClipDownloadFilename(compiledPath, createAutoClipNoteName(noteName, currentUrl, extractedData.site));

	return {
		content,
		filename,
		tabId,
		templateId: template.id,
		templateName: template.name,
		title: extractedData.title,
		url: normalizeAutoClipUrl(currentUrl),
		vault: template.vault,
		path: compiledPath,
		createdAt: Date.now()
	};
}

async function refreshAutoClipSnapshot(tabId: number, expectedUrl: string | undefined, trigger: AutoClipTrigger): Promise<void> {
	if (inFlightSnapshotRefreshes.has(tabId)) {
		await setAutoClipStatus('snapshot-refresh-skipped-in-flight', { tabId, trigger, expectedUrl });
		return;
	}

	inFlightSnapshotRefreshes.add(tabId);
	try {
		const snapshot = await buildAutoClipSnapshot(tabId, expectedUrl, trigger);
		if (snapshot) {
			cacheAutoClipSnapshot(snapshot);
			await setAutoClipStatus('snapshot-updated', {
				tabId,
				trigger,
				currentUrl: snapshot.url,
				template: snapshot.templateName,
				filename: snapshot.filename
			});
			await autoClipDebugLog('Updated auto-clip snapshot', { tabId, trigger, url: snapshot.url, template: snapshot.templateName, filename: snapshot.filename });
		}
	} finally {
		inFlightSnapshotRefreshes.delete(tabId);
	}
}

function scheduleSnapshotRefresh(
	tabId: number,
	expectedUrl: string | undefined,
	trigger: AutoClipTrigger,
	delayMs = PAGE_CHANGE_REFRESH_DELAY_MS
): void {
	const existingTimer = snapshotRefreshTimers.get(tabId);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	const timer = setTimeout(() => {
		snapshotRefreshTimers.delete(tabId);
		refreshAutoClipSnapshot(tabId, expectedUrl, trigger).catch(error => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			setAutoClipStatus('snapshot-refresh-failed', {
				tabId,
				trigger,
				expectedUrl,
				error: errorMessage,
				hint: errorMessage.includes('Missing host permission')
					? 'Grant auto-clip site access in extension settings.'
					: undefined
			});
			console.error('[Obsidian Clipper] Auto-clip snapshot refresh failed:', error);
		});
	}, Math.max(0, delayMs));

	snapshotRefreshTimers.set(tabId, timer);
}

async function downloadAutoClipSnapshot(snapshot: AutoClipSnapshot, trigger: AutoClipTrigger): Promise<void> {
	await loadSettings();

	const dedupeKey = createAutoClipDedupeKey(snapshot.url, snapshot.templateId);
	if (inFlightAutoClips.has(dedupeKey) || await hasFreshAutoClipRecord(dedupeKey)) {
		await setAutoClipStatus('skipped-duplicate-or-in-flight', {
			tabId: snapshot.tabId,
			trigger,
			dedupeKey,
			currentUrl: snapshot.url,
			template: snapshot.templateName
		});
		await autoClipDebugLog('Skipping download: fresh duplicate or clip already in flight', {
			tabId: snapshot.tabId,
			trigger,
			dedupeKey,
			currentUrl: snapshot.url,
			template: snapshot.templateName
		});
		return;
	}

	inFlightAutoClips.add(dedupeKey);
	try {
		const downloadId = await downloadMarkdownFile(snapshot.content, snapshot.filename);
		await setAutoClipStatus('downloaded', {
			tabId: snapshot.tabId,
			trigger,
			filename: snapshot.filename,
			downloadId,
			currentUrl: snapshot.url,
			template: snapshot.templateName
		});
		await autoClipDebugLog('Downloaded auto-clip markdown', {
			tabId: snapshot.tabId,
			trigger,
			filename: snapshot.filename,
			downloadId,
			currentUrl: snapshot.url,
			template: snapshot.templateName
		});

		await incrementStat('saveFile', snapshot.vault, snapshot.path, snapshot.url, snapshot.title);
		await recordAutoClip(dedupeKey, {
			clippedAt: Date.now(),
			downloadId,
			filename: snapshot.filename,
			title: snapshot.title,
			url: snapshot.url,
			templateId: snapshot.templateId
		});
	} finally {
		inFlightAutoClips.delete(dedupeKey);
	}
}

export async function autoClipTab(tabId: number, expectedUrl?: string, trigger: AutoClipTrigger = 'debug'): Promise<void> {
	const snapshot = await buildAutoClipSnapshot(tabId, expectedUrl, trigger);
	if (!snapshot) {
		return;
	}
	cacheAutoClipSnapshot(snapshot);
	await downloadAutoClipSnapshot(snapshot, trigger);
}

export async function scheduleAutoClipForTab(tabId: number, expectedUrl?: string): Promise<void> {
	await loadSettings();

	const tab = await browser.tabs.get(tabId);
	const currentUrl = expectedUrl || tab.url;
	if (!generalSettings.autoClipSettings.enabled) {
		await setAutoClipStatus('not-scheduled-disabled', { tabId, currentUrl });
		await autoClipDebugLog('Not scheduling: auto-clip disabled', { tabId, currentUrl });
		clearAutoClipTimers(tabId);
		return;
	}

	if (!isAutoClipCandidateUrl(currentUrl)) {
		await setAutoClipStatus('not-scheduled-unsupported-url', { tabId, currentUrl });
		await autoClipDebugLog('Not scheduling: unsupported URL', { tabId, currentUrl });
		clearAutoClipTabState(tabId);
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
		clearAutoClipTabState(tabId);
		return;
	}

	clearAutoClipTimers(tabId);

	const delayMs = Math.max(0, generalSettings.autoClipSettings.delayMs);
	const { pageLoad } = generalSettings.autoClipSettings.triggers;
	const shouldPrepareSnapshot = hasSnapshotTriggers();

	if (!pageLoad && !shouldPrepareSnapshot) {
		await setAutoClipStatus('not-scheduled-no-triggers', { tabId, currentUrl });
		await autoClipDebugLog('Not scheduling: no auto-clip triggers enabled', { tabId, currentUrl });
		return;
	}

	await setAutoClipStatus('scheduled', { tabId, currentUrl, delayMs, triggers: generalSettings.autoClipSettings.triggers });
	await autoClipDebugLog('Scheduled auto-clip', { tabId, currentUrl, delayMs, triggers: generalSettings.autoClipSettings.triggers });

	if (pageLoad) {
		const timer = setTimeout(() => {
			pageLoadTimers.delete(tabId);
			autoClipTab(tabId, currentUrl, 'pageLoad').catch(error => {
				const errorMessage = error instanceof Error ? error.message : String(error);
				setAutoClipStatus('failed', {
					tabId,
					trigger: 'pageLoad',
					currentUrl,
					error: errorMessage,
					hint: errorMessage.includes('Missing host permission')
						? 'Grant auto-clip site access in extension settings.'
						: undefined
				});
				console.error('[Obsidian Clipper] Auto-clip failed:', error);
			});
		}, delayMs);
		pageLoadTimers.set(tabId, timer);
		return;
	}

	if (shouldPrepareSnapshot) {
		scheduleSnapshotRefresh(tabId, currentUrl, 'pageLoad', delayMs);
	}
}

export async function handleAutoClipPageChanged(tabId: number, url?: string): Promise<void> {
	await loadSettings();

	if (!generalSettings.autoClipSettings.enabled || !hasSnapshotTriggers()) {
		return;
	}

	const currentUrl = url || (await browser.tabs.get(tabId)).url;
	if (!isAutoClipCandidateUrl(currentUrl)
		|| !autoClipUrlMatchesPatterns(currentUrl, generalSettings.autoClipSettings.urlPatterns)) {
		return;
	}

	await setAutoClipStatus('snapshot-refresh-scheduled', { tabId, trigger: 'pageChange', currentUrl });
	scheduleSnapshotRefresh(tabId, currentUrl, 'pageChange');
}

export async function handleAutoClipTabRemoved(tabId: number): Promise<void> {
	await loadSettings();

	clearAutoClipTimers(tabId);
	if (!generalSettings.autoClipSettings.enabled || !generalSettings.autoClipSettings.triggers.tabClose) {
		autoClipSnapshots.delete(tabId);
		return;
	}

	const snapshot = autoClipSnapshots.get(tabId);
	autoClipSnapshots.delete(tabId);
	if (!snapshot) {
		await setAutoClipStatus('skipped-missing-snapshot', { tabId, trigger: 'tabClose' });
		await autoClipDebugLog('Skipping tab-close auto-clip: no snapshot cached', { tabId });
		return;
	}

	await downloadAutoClipSnapshot(snapshot, 'tabClose');
}

export async function handleAutoClipTabDiscarded(tabId: number): Promise<void> {
	await loadSettings();

	if (!generalSettings.autoClipSettings.enabled || !generalSettings.autoClipSettings.triggers.tabDiscard) {
		return;
	}

	const snapshot = autoClipSnapshots.get(tabId);
	if (!snapshot) {
		await setAutoClipStatus('skipped-missing-snapshot', { tabId, trigger: 'tabDiscard' });
		await autoClipDebugLog('Skipping tab-discard auto-clip: no snapshot cached', { tabId });
		return;
	}

	await downloadAutoClipSnapshot(snapshot, 'tabDiscard');
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
		await autoClipTab(tab.id, tab.url, 'debug');
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
