/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers the domain.
 */
import { register } from "../config/registry";
import type { Settings } from "../config/settings";

// Supermemory (https://supermemory.ai)
export const cfgSupermemoryApiKey = register({
	id: "supermemory.apiKey",
	env: "SUPERMEMORY_API_KEY",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Supermemory",
		label: "Supermemory API Key",
		description: "Bearer API key for the Supermemory service",
		condition: "supermemoryActive",
	},
});

export const cfgSupermemoryApiUrl = register({
	id: "supermemory.apiUrl",
	env: "SUPERMEMORY_API_URL",
	type: "string",
	default: "https://api.supermemory.ai",
	ui: {
		tab: "memory",
		group: "Supermemory",
		label: "Supermemory API URL",
		description: "Supermemory API base URL",
		condition: "supermemoryActive",
	},
});

export const cfgSupermemoryRecallLimit = register({
	id: "supermemory.recallLimit",
	type: "number",
	default: 5,
});

export const cfgSupermemoryThreshold = register({
	id: "supermemory.threshold",
	type: "number",
	default: 0.6,
});

export const cfgSupermemoryAutoRecall = register({
	id: "supermemory.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Supermemory",
		label: "Supermemory Auto Recall",
		description: "Recall relevant memories into the conversation automatically",
		condition: "supermemoryActive",
	},
});

export const cfgSupermemoryAutoRetain = register({
	id: "supermemory.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Supermemory",
		label: "Supermemory Auto Retain",
		description: "Save conversation memories automatically every N turns (supermemory.retainEveryNTurns)",
		condition: "supermemoryActive",
	},
});

export const cfgSupermemoryRetainEveryNTurns = register({
	id: "supermemory.retainEveryNTurns",
	type: "number",
	default: 3,
});

export interface SupermemoryConfig {
	apiKey?: string;
	apiUrl: string;
	recallLimit: number;
	threshold: number;
	autoRecall: boolean;
	autoRetain: boolean;
	retainEveryNTurns: number;
}

/** Resolve the Supermemory runtime config. `SUPERMEMORY_*` environment variables win through the setting handles. */
export function loadSupermemoryConfig(settings: Settings): SupermemoryConfig {
	return {
		apiKey: cfgSupermemoryApiKey.get(settings),
		apiUrl: cfgSupermemoryApiUrl.get(settings),
		recallLimit: cfgSupermemoryRecallLimit.get(settings),
		threshold: cfgSupermemoryThreshold.get(settings),
		autoRecall: cfgSupermemoryAutoRecall.get(settings),
		autoRetain: cfgSupermemoryAutoRetain.get(settings),
		retainEveryNTurns: cfgSupermemoryRetainEveryNTurns.get(settings),
	};
}

/** Whether there is an API key to authenticate with; every Supermemory request needs one. */
export function isSupermemoryConfigured(cfg: SupermemoryConfig): boolean {
	return Boolean(cfg.apiKey?.trim());
}
