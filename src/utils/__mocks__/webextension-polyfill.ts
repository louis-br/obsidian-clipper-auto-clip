// Mock for webextension-polyfill in test environment
export const runtime = {
	getURL: (path: string) => `chrome-extension://mock-id/${path}`,
	sendMessage: async () => ({}),
	onMessage: {
		addListener: () => {},
		removeListener: () => {},
	},
};

export const storage = {
	local: {
		get: async () => ({}),
		set: async () => {},
	},
	sync: {
		get: async () => ({}),
		set: async () => {},
	},
};

export const tabs = {
	get: async () => ({}),
	query: async () => [],
	sendMessage: async () => ({}),
};

export const downloads = {
	download: async () => 1,
};

export const permissions = {
	contains: async () => true,
	request: async () => true,
};

export const i18n = {
	getMessage: (key: string) => key,
};

export default {
	runtime,
	storage,
	tabs,
	downloads,
	permissions,
	i18n,
};
