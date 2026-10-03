/**
 * Supermemory backend behavioural contract.
 *
 * Drives `supermemoryBackend` through a fake session that exposes `subscribe`, with the REST
 * client spied on its prototype so no request leaves the process. A retain starts synchronously
 * inside the `agent_end` dispatch, so assertions right after `emit` need no waiting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { releaseSupermemorySession, supermemoryBackend } from "@oh-my-pi/pi-coding-agent/supermemory/backend";
import { SupermemoryClient, SupermemoryError, type SupermemoryHit } from "@oh-my-pi/pi-coding-agent/supermemory/client";
import { supermemoryProjectTag, supermemoryUserTag } from "@oh-my-pi/pi-coding-agent/supermemory/tags";

const GITHUB_TOKEN = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");

interface FakeEntry {
	role: "user" | "assistant";
	text: string;
}

interface FakeSession {
	sessionId: string;
	settings: Settings;
	sessionManager: { getEntries(): unknown[]; getCwd(): string };
	subscribe(listener: AgentSessionEventListener): () => void;
	emit(event: Parameters<AgentSessionEventListener>[0]): void;
	listenerCount(): number;
}

function makeFakeSession(deps: {
	settings: Settings;
	sessionId?: string;
	cwd?: string;
	entries?: FakeEntry[];
}): FakeSession {
	const listeners = new Set<AgentSessionEventListener>();
	const entries = deps.entries ?? [];
	return {
		sessionId: deps.sessionId ?? "sess-1",
		settings: deps.settings,
		sessionManager: {
			getEntries: () =>
				entries.map((e, i) => ({
					id: `e${i}`,
					parentId: i === 0 ? null : `e${i - 1}`,
					timestamp: new Date(0).toISOString(),
					type: "message" as const,
					message:
						e.role === "user"
							? { role: "user" as const, content: e.text, timestamp: 0 }
							: {
									role: "assistant" as const,
									content: [{ type: "text" as const, text: e.text }],
									model: "x",
									provider: "x",
									api: "x",
									stopReason: "end_turn" as const,
									timestamp: 0,
								},
				})),
			getCwd: () => deps.cwd ?? "/tmp",
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit(event) {
			// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
			for (const listener of [...listeners]) listener(event);
		},
		listenerCount: () => listeners.size,
	};
}

function makeSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({ "memory.backend": "supermemory", "supermemory.apiKey": "sm-test-key", ...overrides });
}

async function startBackend(session: FakeSession, settings: Settings, taskDepth = 0): Promise<void> {
	await supermemoryBackend.start({
		session: session as never,
		settings,
		modelRegistry: {} as never,
		agentDir: "/tmp",
		taskDepth,
	});
}

function endTurn(session: FakeSession): void {
	session.emit({ type: "agent_end", messages: [] });
}

function recall(session: FakeSession, prompt: string, signal?: AbortSignal) {
	return supermemoryBackend.beforeAgentStartPrompt?.(session as never, prompt, signal);
}

function instructions(session: FakeSession, settings: Settings) {
	return supermemoryBackend.buildDeveloperInstructions("/tmp", settings, session as never);
}

function operationContext(settings?: Settings) {
	return { agentDir: "/tmp", cwd: "/tmp", session: settings ? ({ settings } as never) : undefined };
}

function hit(fields: Partial<SupermemoryHit> & Pick<SupermemoryHit, "id" | "text">): SupermemoryHit {
	return { similarity: 0.8, ...fields };
}

function spyClient() {
	return {
		add: vi.spyOn(SupermemoryClient.prototype, "add").mockResolvedValue({ id: "doc-1" }),
		profile: vi.spyOn(SupermemoryClient.prototype, "profile").mockResolvedValue({ static: [], dynamic: [] }),
		search: vi.spyOn(SupermemoryClient.prototype, "search").mockResolvedValue([]),
	};
}

let savedEnv: { key?: string; url?: string };

beforeEach(() => {
	resetSettingsForTest();
	savedEnv = { key: process.env.SUPERMEMORY_API_KEY, url: process.env.SUPERMEMORY_API_URL };
	delete process.env.SUPERMEMORY_API_KEY;
	delete process.env.SUPERMEMORY_API_URL;
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	for (const [name, value] of [
		["SUPERMEMORY_API_KEY", savedEnv.key],
		["SUPERMEMORY_API_URL", savedEnv.url],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("memory.backend selection", () => {
	it("resolves supermemory from the setting", async () => {
		expect(await resolveMemoryBackend(makeSettings())).toBe(supermemoryBackend);
	});
});

describe("supermemoryBackend.start", () => {
	it("stays inert without an API key", async () => {
		const client = spyClient();
		const settings = makeSettings({ "supermemory.apiKey": "" });
		const session = makeFakeSession({ settings, entries: [{ role: "user", text: "hello" }] });

		await startBackend(session, settings);
		endTurn(session);

		expect(session.listenerCount()).toBe(0);
		expect(await recall(session, "hello")).toBeUndefined();
		expect(client.profile).not.toHaveBeenCalled();
		expect(client.add).not.toHaveBeenCalled();
	});

	it("does nothing for subagents", async () => {
		const client = spyClient();
		const settings = makeSettings({ "supermemory.retainEveryNTurns": 1 });
		const session = makeFakeSession({ settings, entries: [{ role: "user", text: "hello" }] });

		await startBackend(session, settings, 1);
		endTurn(session);

		expect(session.listenerCount()).toBe(0);
		expect(await recall(session, "hello")).toBeUndefined();
		expect(client.search).not.toHaveBeenCalled();
		expect(client.add).not.toHaveBeenCalled();
	});

	it("skips the retain subscription when autoRetain is off but still recalls", async () => {
		const client = spyClient();
		client.search.mockResolvedValue([hit({ id: "m1", text: "prefers tabs" })]);
		const settings = makeSettings({ "supermemory.autoRetain": false });
		const session = makeFakeSession({ settings });

		await startBackend(session, settings);

		expect(session.listenerCount()).toBe(0);
		expect((await recall(session, "format this"))?.context).toContain("prefers tabs");
	});

	it("retains the transcript to the project container on every Nth settled turn", async () => {
		const client = spyClient();
		const settings = makeSettings({ "supermemory.retainEveryNTurns": 2 });
		const entries: FakeEntry[] = [];
		const session = makeFakeSession({ settings, sessionId: "sess-7", cwd: "/tmp", entries });
		await startBackend(session, settings);

		entries.push({ role: "user", text: "first question" }, { role: "assistant", text: "first answer" });
		endTurn(session);
		expect(client.add).not.toHaveBeenCalled();

		// A continuation (retry, compaction, reminder) is not a settled turn.
		session.emit({ type: "agent_end", messages: [], isTerminal: false });
		expect(client.add).not.toHaveBeenCalled();

		entries.push({ role: "user", text: "second question" }, { role: "assistant", text: "second answer" });
		endTurn(session);

		expect(client.add).toHaveBeenCalledTimes(1);
		expect(client.add).toHaveBeenCalledWith(
			"[user] first question\n[assistant] first answer\n[user] second question\n[assistant] second answer",
			supermemoryProjectTag("/tmp"),
			{ customId: "omp_session_sess-7", metadata: { source: "omp", sessionId: "sess-7" } },
		);
	});

	it("never retains recalled-memory blocks or credentials", async () => {
		const client = spyClient();
		const settings = makeSettings({ "supermemory.retainEveryNTurns": 1 });
		const session = makeFakeSession({
			settings,
			entries: [
				{ role: "user", text: `deploy <memories>\nold recall\n</memories> with ${GITHUB_TOKEN}` },
				{ role: "assistant", text: "<supermemory>stale recall</supermemory>Done." },
			],
		});
		await startBackend(session, settings);

		endTurn(session);

		const content = client.add.mock.calls[0]?.[0] ?? "";
		expect(content).not.toContain("old recall");
		expect(content).not.toContain("stale recall");
		expect(content).not.toContain(GITHUB_TOKEN);
		expect(content).toContain("[REDACTED]");
		expect(content).toContain("[assistant] Done.");
	});

	it("keeps only the newest 100k characters of a long transcript", async () => {
		const client = spyClient();
		const settings = makeSettings({ "supermemory.retainEveryNTurns": 1 });
		const session = makeFakeSession({
			settings,
			entries: [
				{ role: "user", text: "x".repeat(120_000) },
				{ role: "assistant", text: "FINAL ANSWER" },
			],
		});
		await startBackend(session, settings);

		endTurn(session);

		const content = client.add.mock.calls[0]?.[0] ?? "";
		expect(content).toHaveLength(100_000);
		expect(content.endsWith("[assistant] FINAL ANSWER")).toBe(true);
	});

	it("keeps retaining after a failed retain", async () => {
		const client = spyClient();
		client.add
			.mockRejectedValueOnce(new SupermemoryError("POST /v3/documents failed (500): boom", 500))
			.mockResolvedValue({ id: "doc-2" });
		const settings = makeSettings({ "supermemory.retainEveryNTurns": 1 });
		const session = makeFakeSession({ settings, entries: [{ role: "user", text: "hello there" }] });
		await startBackend(session, settings);

		endTurn(session);
		endTurn(session);

		expect(client.add).toHaveBeenCalledTimes(2);
	});

	it("keeps turn and recall progress across a restart without double-subscribing", async () => {
		const client = spyClient();
		const settings = makeSettings({ "supermemory.retainEveryNTurns": 2 });
		const session = makeFakeSession({ settings, entries: [{ role: "user", text: "hello there" }] });
		await startBackend(session, settings);
		endTurn(session);
		expect((await recall(session, "hello there"))?.commit()).toBe(true);

		await startBackend(session, settings);
		expect(session.listenerCount()).toBe(1);
		endTurn(session);
		expect(client.add).toHaveBeenCalledTimes(1);

		client.search.mockClear();
		expect(await recall(session, "and again")).toBeUndefined();
		expect(client.search).not.toHaveBeenCalled();
	});

	it("releaseSupermemorySession drops the subscription and recalled context", async () => {
		const client = spyClient();
		client.search.mockResolvedValue([hit({ id: "m1", text: "prefers tabs" })]);
		const settings = makeSettings({ "supermemory.retainEveryNTurns": 1 });
		const session = makeFakeSession({ settings, entries: [{ role: "user", text: "hello there" }] });
		await startBackend(session, settings);
		expect((await recall(session, "format this"))?.commit()).toBe(true);
		expect(await instructions(session, settings)).toContain("prefers tabs");

		releaseSupermemorySession(session as never);
		endTurn(session);

		expect(session.listenerCount()).toBe(0);
		expect(client.add).not.toHaveBeenCalled();
		expect(await instructions(session, settings)).toBeUndefined();
		expect(await recall(session, "format this")).toBeUndefined();
	});
});

describe("supermemoryBackend.beforeAgentStartPrompt", () => {
	it("recalls profile and deduped hits on the first prompt, then not again once committed", async () => {
		const client = spyClient();
		client.profile.mockResolvedValue({ static: ["Senior engineer"], dynamic: ["Building memory backends"] });
		client.search.mockImplementation(async (_query, tag) =>
			tag === supermemoryUserTag()
				? [hit({ id: "shared", text: "prefers tabs" }), hit({ id: "u2", text: "uses bun" })]
				: [hit({ id: "shared", text: "prefers tabs" }), hit({ id: "p1", text: "repo uses biome" })],
		);
		const settings = makeSettings();
		const session = makeFakeSession({ settings, cwd: "/tmp" });
		await startBackend(session, settings);
		const signal = new AbortController().signal;

		const prepared = await recall(session, "  how do I format?  ", signal);

		const searchOptions = { limit: 5, threshold: 0.6, signal };
		expect(client.profile).toHaveBeenCalledWith(supermemoryUserTag(), "how do I format?", signal);
		expect(client.search).toHaveBeenCalledWith("how do I format?", supermemoryUserTag(), searchOptions);
		expect(client.search).toHaveBeenCalledWith("how do I format?", supermemoryProjectTag("/tmp"), searchOptions);
		const context = prepared?.context ?? "";
		expect(context.startsWith("<memories>")).toBe(true);
		expect(context.endsWith("</memories>")).toBe(true);
		expect(context).toContain("## User profile\n- Senior engineer");
		expect(context).toContain("## Recent context\n- Building memory backends");
		expect(context).toContain("## Relevant user memories\n- prefers tabs\n- uses bun");
		expect(context).toContain("## Relevant project memories\n- repo uses biome");
		expect(context.match(/prefers tabs/g)).toHaveLength(1);

		expect(await instructions(session, settings)).toBeUndefined();
		expect(prepared?.commit()).toBe(true);
		expect(await instructions(session, settings)).toBe(context);

		client.search.mockClear();
		expect(await recall(session, "next question")).toBeUndefined();
		expect(client.search).not.toHaveBeenCalled();
	});

	it("starts over for a new session id and drops the previous recall", async () => {
		const client = spyClient();
		client.search.mockResolvedValue([hit({ id: "m1", text: "prefers tabs" })]);
		const settings = makeSettings();
		const session = makeFakeSession({ settings });
		await startBackend(session, settings);
		expect((await recall(session, "first prompt"))?.commit()).toBe(true);

		session.sessionId = "sess-2";

		expect(await instructions(session, settings)).toBeUndefined();
		client.search.mockClear();
		expect((await recall(session, "first prompt of the new session"))?.context).toContain("prefers tabs");
		expect(client.search).toHaveBeenCalled();
	});

	it("rejects a commit when the session changed while the recall was in flight", async () => {
		const client = spyClient();
		client.search.mockResolvedValue([hit({ id: "m1", text: "prefers tabs" })]);
		const settings = makeSettings();
		const session = makeFakeSession({ settings });
		await startBackend(session, settings);
		const prepared = await recall(session, "format this");

		session.sessionId = "sess-2";

		expect(prepared?.commit()).toBe(false);
		expect(await instructions(session, settings)).toBeUndefined();
		client.search.mockClear();
		expect(await recall(session, "format this")).toBeDefined();
		expect(client.search).toHaveBeenCalled();
	});

	it("returns nothing and retries on the next prompt when every request fails", async () => {
		const client = spyClient();
		client.profile.mockRejectedValue(new SupermemoryError("POST /v4/profile failed (503): down", 503));
		client.search.mockRejectedValue(new SupermemoryError("POST /v4/search failed (503): down", 503));
		const settings = makeSettings();
		const session = makeFakeSession({ settings });
		await startBackend(session, settings);

		expect(await recall(session, "format this")).toBeUndefined();

		client.profile.mockResolvedValue({ static: ["Senior engineer"], dynamic: [] });
		client.search.mockResolvedValue([]);
		expect((await recall(session, "format this"))?.context).toContain("Senior engineer");
	});

	it("delivers what succeeded when only some requests fail", async () => {
		const client = spyClient();
		client.profile.mockRejectedValue(new SupermemoryError("POST /v4/profile failed (500): boom", 500));
		client.search.mockImplementation(async (_query, tag) =>
			tag === supermemoryUserTag() ? [hit({ id: "u1", text: "prefers tabs" })] : [],
		);
		const settings = makeSettings();
		const session = makeFakeSession({ settings });
		await startBackend(session, settings);

		const context = (await recall(session, "format this"))?.context ?? "";

		expect(context).toContain("## Relevant user memories\n- prefers tabs");
		expect(context).not.toContain("## User profile");
	});

	it("commits an empty successful recall so later prompts skip the network", async () => {
		const client = spyClient();
		const settings = makeSettings();
		const session = makeFakeSession({ settings });
		await startBackend(session, settings);

		const prepared = await recall(session, "format this");

		expect(prepared).toBeDefined();
		expect(prepared?.context).toBeUndefined();
		expect(prepared?.commit()).toBe(true);
		client.search.mockClear();
		expect(await recall(session, "format that")).toBeUndefined();
		expect(client.search).not.toHaveBeenCalled();
	});

	it("makes no request when autoRecall is off or the prompt is blank", async () => {
		const client = spyClient();
		const off = makeSettings({ "supermemory.autoRecall": false });
		const offSession = makeFakeSession({ settings: off });
		await startBackend(offSession, off);
		expect(await recall(offSession, "format this")).toBeUndefined();

		const on = makeSettings();
		const onSession = makeFakeSession({ settings: on });
		await startBackend(onSession, on);
		expect(await recall(onSession, "   ")).toBeUndefined();

		expect(client.profile).not.toHaveBeenCalled();
		expect(client.search).not.toHaveBeenCalled();
	});
});

describe("supermemoryBackend.search", () => {
	it("merges user and project hits by similarity, dedupes by id, and applies the limit", async () => {
		const client = spyClient();
		client.search.mockImplementation(async (_query, tag) =>
			tag === supermemoryUserTag()
				? [
						hit({ id: "a", documentId: "doc-a", text: "A", similarity: 0.7, updatedAt: "2026-01-01T00:00:00Z" }),
						hit({ id: "dup", text: "dup", similarity: 0.5 }),
					]
				: [
						hit({ id: "b", text: "B", similarity: 0.9 }),
						hit({ id: "dup", text: "dup", similarity: 0.5 }),
						hit({ id: "c", text: "C", similarity: 0.6 }),
					],
		);
		const signal = new AbortController().signal;

		const result = await supermemoryBackend.search?.(operationContext(makeSettings()), "q", { limit: 3, signal });

		expect(client.search).toHaveBeenCalledWith("q", supermemoryUserTag(), { limit: 3, threshold: 0.6, signal });
		expect(client.search).toHaveBeenCalledWith("q", supermemoryProjectTag("/tmp"), {
			limit: 3,
			threshold: 0.6,
			signal,
		});
		expect(result?.count).toBe(3);
		expect(result?.items).toEqual([
			{ id: "b", content: "B", source: "project", timestamp: undefined, score: 0.9 },
			{ id: "doc-a", content: "A", source: "user", timestamp: "2026-01-01T00:00:00Z", score: 0.7 },
			{ id: "c", content: "C", source: "project", timestamp: undefined, score: 0.6 },
		]);
	});

	it("works without a session by reading the global settings", async () => {
		const client = spyClient();
		await Settings.init({ inMemory: true, cwd: "/tmp", overrides: { "supermemory.apiKey": "sm-test-key" } });

		const result = await supermemoryBackend.search?.(operationContext(), "q");

		expect(result).toMatchObject({ backend: "supermemory", count: 0, items: [] });
		expect(client.search).toHaveBeenCalledTimes(2);
	});

	it("throws on API failure and when no key is configured", async () => {
		const client = spyClient();
		client.search.mockRejectedValue(new SupermemoryError("POST /v4/search failed (401): bad key", 401));

		await expect(supermemoryBackend.search?.(operationContext(makeSettings()), "q")).rejects.toThrow("401");
		await expect(
			supermemoryBackend.search?.(operationContext(makeSettings({ "supermemory.apiKey": "" })), "q"),
		).rejects.toThrow("not configured");
	});
});

describe("supermemoryBackend.save", () => {
	it("stores redacted content in the project container and reports the id", async () => {
		const client = spyClient();
		client.add.mockResolvedValue({ id: "doc-9" });

		const result = await supermemoryBackend.save?.(operationContext(makeSettings()), {
			content: `  deploy token ${GITHUB_TOKEN} lives in vault  `,
			context: "infra",
			source: "learn",
		});

		expect(result).toEqual({ backend: "supermemory", stored: 1, ids: ["doc-9"] });
		const [content, tag, options] = client.add.mock.calls[0] ?? [];
		expect(content).toContain("[REDACTED]");
		expect(content).not.toContain(GITHUB_TOKEN);
		expect(tag).toBe(supermemoryProjectTag("/tmp"));
		expect(options?.metadata).toEqual({ source: "learn", context: "infra" });
	});

	it("stores nothing for blank content and throws on API failure", async () => {
		const client = spyClient();

		const blank = await supermemoryBackend.save?.(operationContext(makeSettings()), { content: "   " });
		expect(blank).toMatchObject({ stored: 0 });
		expect(client.add).not.toHaveBeenCalled();

		client.add.mockRejectedValue(new SupermemoryError("POST /v3/documents failed (500): boom", 500));
		await expect(supermemoryBackend.save?.(operationContext(makeSettings()), { content: "fact" })).rejects.toThrow(
			"boom",
		);
	});
});

describe("supermemoryBackend.status", () => {
	it("reports the scope tags when configured and goes inactive without a key", async () => {
		const active = await supermemoryBackend.status?.(operationContext(makeSettings()));
		expect(active).toMatchObject({
			backend: "supermemory",
			active: true,
			writable: true,
			searchable: true,
			retainBank: supermemoryProjectTag("/tmp"),
			recallBanks: [supermemoryUserTag(), supermemoryProjectTag("/tmp")],
		});

		const inactive = await supermemoryBackend.status?.(operationContext(makeSettings({ "supermemory.apiKey": "" })));
		expect(inactive).toMatchObject({ active: false, writable: false, searchable: false });
	});
});

describe("supermemoryBackend.enqueue and clear", () => {
	it("enqueue retains immediately regardless of cadence and surfaces API failures", async () => {
		const client = spyClient();
		const settings = makeSettings({ "supermemory.retainEveryNTurns": 3 });
		const session = makeFakeSession({
			settings,
			sessionId: "sess-4",
			entries: [{ role: "user", text: "remember this" }],
		});
		await startBackend(session, settings);
		endTurn(session);
		expect(client.add).not.toHaveBeenCalled();

		await supermemoryBackend.enqueue("/tmp", "/tmp", session as never);

		expect(client.add).toHaveBeenCalledTimes(1);
		expect(client.add.mock.calls[0]?.[2]).toMatchObject({ customId: "omp_session_sess-4" });

		client.add.mockRejectedValueOnce(new SupermemoryError("POST /v3/documents failed (500): boom", 500));
		await expect(supermemoryBackend.enqueue("/tmp", "/tmp", session as never)).rejects.toThrow("boom");
	});

	it("clear refuses rather than claiming server-side memories were wiped", async () => {
		await expect(supermemoryBackend.clear("/tmp", "/tmp")).rejects.toThrow();
	});
});
