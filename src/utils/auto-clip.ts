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
import {
	AutoClipDedupeRecord,
	DEFAULT_AUTO_CLIP_FILENAME_TEMPLATE,
	autoClipUrlMatchesPatterns,
	buildAutoClipDownloadFilename,
	createAutoClipNoteName,
	createAutoClipDedupeKey,
	isAutoClipRecordFresh,
	normalizeAutoClipUrl
} from './auto-clip-rules';

const AUTO_CLIP_HISTORY_KEY = 'autoClipHistory';
const MAX_HISTORY_RECORDS = 1000;
const MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_CHANGE_REFRESH_DELAY_MS = 2000;
const DOWNLOAD_HISTORY_ERASE_TIMEOUT_MS = 5 * 60 * 1000;
const PROMPT_VARIABLE_PATTERN = /{{(?:prompt:)?"[\s\S]*?"(?:\|.*?)?}}/;

const pageLoadTimers = new Map<number, ReturnType<typeof setTimeout>>();
const snapshotRefreshTimers = new Map<number, ReturnType<typeof setTimeout>>();
const snapshotRefreshVersions = new Map<number, number>();
const autoClipSnapshots = new Map<number, AutoClipSnapshot>();
const inFlightAutoClips = new Set<string>();

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

function autoClipUsesPromptVariables(template: Template, filenameTemplate: string): boolean {
	const values = [
		filenameTemplate,
		template.noteNameFormat,
		template.path,
		template.noteContentFormat,
		template.context,
		...(template.properties || []).map(property => property.value)
	];

	return values.some(value => Boolean(value && PROMPT_VARIABLE_PATTERN.test(value)));
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
	} catch {
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

	if (!browser.downloads.onChanged?.addListener) {
		return;
	}

	let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
	const listener = (delta: browser.Downloads.OnChangedDownloadDeltaType) => {
		if (delta.id !== downloadId || !delta.state?.current) {
			return;
		}

		browser.downloads.onChanged.removeListener(listener);
		if (cleanupTimeout) {
			clearTimeout(cleanupTimeout);
		}
		if (delta.state.current === 'complete') {
			eraseHistory();
		}
	};

	browser.downloads.onChanged.addListener(listener);
	cleanupTimeout = setTimeout(() => {
		browser.downloads.onChanged.removeListener(listener);
	}, DOWNLOAD_HISTORY_ERASE_TIMEOUT_MS);
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
	snapshotRefreshVersions.delete(tabId);
}

async function buildAutoClipSnapshot(
	tabId: number,
	expectedUrl: string | undefined
): Promise<AutoClipSnapshot | null> {
	await loadSettings();

	const tab = await browser.tabs.get(tabId);
	const currentUrl = tab.url;
	if (!isAutoClipCandidateUrl(currentUrl) || !generalSettings.autoClipSettings.enabled) {
		return null;
	}

	if (expectedUrl && normalizeAutoClipUrl(expectedUrl) !== normalizeAutoClipUrl(currentUrl)) {
		return null;
	}

	if (!autoClipUrlMatchesPatterns(currentUrl, generalSettings.autoClipSettings.urlPatterns)) {
		return null;
	}

	const templates = await loadTemplates();
	if (templates.length === 0) {
		return null;
	}
	initializeTriggers(templates);

	const extractedData = await extractPageContentForAutoClip(tabId);
	if (!extractedData?.initializedContent) {
		throw new Error('Unable to initialize page content for auto-clip.');
	}
	if (normalizeAutoClipUrl((await browser.tabs.get(tabId)).url || '') !== normalizeAutoClipUrl(currentUrl)) {
		return null;
	}

	const template = await findMatchingTemplate(currentUrl, async () => extractedData.schemaOrgData) || templates[0];
	const filenameTemplate = generalSettings.autoClipSettings.filenameTemplate.trim() || DEFAULT_AUTO_CLIP_FILENAME_TEMPLATE;
	if (autoClipUsesPromptVariables(template, filenameTemplate)) {
		return null;
	}

	const variables = extractedData.initializedContent.currentVariables;
	const [compiledProperties, compiledFilenameTemplate, compiledNoteName, compiledPath, compiledContent] = await Promise.all([
		compileAutoClipProperties(template, variables, tabId, currentUrl),
		compileTemplate(tabId, filenameTemplate, variables, currentUrl),
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
	const filenameBase = compiledFilenameTemplate.trim() || createAutoClipNoteName(noteName, currentUrl, extractedData.site);
	const filename = buildAutoClipDownloadFilename(compiledPath, filenameBase);

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

async function refreshAutoClipSnapshot(
	tabId: number,
	expectedUrl: string | undefined,
	version: number
): Promise<void> {
	const snapshot = await buildAutoClipSnapshot(tabId, expectedUrl);
	if (snapshotRefreshVersions.get(tabId) !== version) {
		return;
	}
	if (snapshot) {
		cacheAutoClipSnapshot(snapshot);
	} else if (expectedUrl) {
		autoClipSnapshots.delete(tabId);
	}
}

function scheduleSnapshotRefresh(
	tabId: number,
	expectedUrl: string | undefined,
	delayMs = PAGE_CHANGE_REFRESH_DELAY_MS
): void {
	const existingTimer = snapshotRefreshTimers.get(tabId);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	const version = (snapshotRefreshVersions.get(tabId) ?? 0) + 1;
	snapshotRefreshVersions.set(tabId, version);

	const timer = setTimeout(() => {
		snapshotRefreshTimers.delete(tabId);
		refreshAutoClipSnapshot(tabId, expectedUrl, version).catch(error => {
			console.error('[Obsidian Clipper] Auto-clip snapshot refresh failed:', error);
		});
	}, Math.max(0, delayMs));

	snapshotRefreshTimers.set(tabId, timer);
}

async function downloadAutoClipSnapshot(snapshot: AutoClipSnapshot): Promise<void> {
	await loadSettings();

	const dedupeKey = createAutoClipDedupeKey(snapshot.url, snapshot.templateId);
	if (inFlightAutoClips.has(dedupeKey) || await hasFreshAutoClipRecord(dedupeKey)) {
		return;
	}

	inFlightAutoClips.add(dedupeKey);
	try {
		const downloadId = await downloadMarkdownFile(snapshot.content, snapshot.filename);

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

export async function autoClipTab(tabId: number, expectedUrl?: string): Promise<void> {
	const snapshot = await buildAutoClipSnapshot(tabId, expectedUrl);
	if (!snapshot) {
		return;
	}
	cacheAutoClipSnapshot(snapshot);
	await downloadAutoClipSnapshot(snapshot);
}

export async function scheduleAutoClipForTab(tabId: number, expectedUrl?: string): Promise<void> {
	await loadSettings();

	const tab = await browser.tabs.get(tabId);
	const currentUrl = expectedUrl || tab.url;
	if (!generalSettings.autoClipSettings.enabled) {
		clearAutoClipTabState(tabId);
		return;
	}

	if (!isAutoClipCandidateUrl(currentUrl)) {
		clearAutoClipTabState(tabId);
		return;
	}

	if (!autoClipUrlMatchesPatterns(currentUrl, generalSettings.autoClipSettings.urlPatterns)) {
		clearAutoClipTabState(tabId);
		return;
	}

	clearAutoClipTimers(tabId);

	const delayMs = Math.max(0, generalSettings.autoClipSettings.delayMs);
	const { pageLoad } = generalSettings.autoClipSettings.triggers;
	const shouldPrepareSnapshot = hasSnapshotTriggers();

	if (!pageLoad && !shouldPrepareSnapshot) {
		return;
	}

	if (pageLoad) {
		const timer = setTimeout(() => {
			pageLoadTimers.delete(tabId);
			autoClipTab(tabId, currentUrl).catch(error => {
				console.error('[Obsidian Clipper] Auto-clip failed:', error);
			});
		}, delayMs);
		pageLoadTimers.set(tabId, timer);
		return;
	}

	if (shouldPrepareSnapshot) {
		scheduleSnapshotRefresh(tabId, currentUrl, delayMs);
	}
}

export async function handleAutoClipUrlChanged(tabId: number, url?: string): Promise<void> {
	await loadSettings();

	if (!generalSettings.autoClipSettings.enabled || !hasSnapshotTriggers()) {
		clearAutoClipTabState(tabId);
		return;
	}

	const currentUrl = url || (await browser.tabs.get(tabId)).url;
	if (!isAutoClipCandidateUrl(currentUrl)
		|| !autoClipUrlMatchesPatterns(currentUrl, generalSettings.autoClipSettings.urlPatterns)) {
		clearAutoClipTabState(tabId);
		return;
	}

	clearAutoClipTimers(tabId);
	autoClipSnapshots.delete(tabId);
	scheduleSnapshotRefresh(tabId, currentUrl);
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
		return;
	}

	await downloadAutoClipSnapshot(snapshot);
}

export async function handleAutoClipTabDiscarded(tabId: number): Promise<void> {
	await loadSettings();

	if (!generalSettings.autoClipSettings.enabled || !generalSettings.autoClipSettings.triggers.tabDiscard) {
		return;
	}

	const snapshot = autoClipSnapshots.get(tabId);
	if (!snapshot) {
		return;
	}

	await downloadAutoClipSnapshot(snapshot);
}
