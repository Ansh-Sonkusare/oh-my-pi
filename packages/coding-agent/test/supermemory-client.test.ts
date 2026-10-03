import { describe, expect, it } from "bun:test";
import { SupermemoryClient, SupermemoryError } from "@oh-my-pi/pi-coding-agent/supermemory/client";

interface RecordedRequest {
	method: string | undefined;
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

const AUTH_HEADERS = { authorization: "Bearer sm_test_key", "content-type": "application/json" };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Client wired to an injected fetch that records every request and replays `responses` in order. */
function clientFor(...responses: Response[]): { client: SupermemoryClient; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const queue = [...responses];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			requests.push({
				method: init?.method,
				url: String(input),
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			const response = queue.shift();
			if (!response) throw new Error("no response queued");
			return response;
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const client = new SupermemoryClient({
		apiKey: "sm_test_key",
		apiUrl: "https://api.supermemory.test/",
		fetch: fetchMock,
	});
	return { client, requests };
}

async function failureOf(call: Promise<unknown>): Promise<SupermemoryError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof SupermemoryError) return error;
		throw error;
	}
	throw new Error("expected the call to reject");
}

describe("SupermemoryClient.search", () => {
	it("posts a hybrid search with the caller's limit and threshold", async () => {
		const { client, requests } = clientFor(jsonResponse({ results: [] }));

		await client.search("preferred indent", "omp_user_abc", { limit: 5, threshold: 0.6 });

		expect(requests).toEqual([
			{
				method: "POST",
				url: "https://api.supermemory.test/v4/search",
				headers: AUTH_HEADERS,
				body: {
					q: "preferred indent",
					containerTag: "omp_user_abc",
					limit: 5,
					threshold: 0.6,
					searchMode: "hybrid",
				},
			},
		]);
	});

	it("leaves limit and threshold out of the body when not given", async () => {
		const { client, requests } = clientFor(jsonResponse({ results: [] }));

		await client.search("anything", "omp_user_abc");

		expect(requests[0]?.body).toStrictEqual({ q: "anything", containerTag: "omp_user_abc", searchMode: "hybrid" });
	});

	it("maps memory hits, chunk-only hits with their document id, and bare hits", async () => {
		const { client } = clientFor(
			jsonResponse({
				results: [
					{
						id: "mem_1",
						memory: "Prefers tabs",
						chunk: "shadowed by the memory text",
						similarity: 0.91,
						updatedAt: "2026-01-02T03:04:05Z",
						documents: [{ id: "doc_1" }],
					},
					{
						id: "chunk_2",
						chunk: "raw chunk text",
						similarity: 0.7,
						documents: [{ id: "doc_2" }, { id: "doc_3" }],
					},
					{ id: "bare_3", similarity: 0.6 },
				],
			}),
		);

		const hits = await client.search("indent", "omp_user_abc");

		expect(hits).toEqual([
			{
				id: "mem_1",
				documentId: "doc_1",
				text: "Prefers tabs",
				similarity: 0.91,
				updatedAt: "2026-01-02T03:04:05Z",
			},
			{ id: "chunk_2", documentId: "doc_2", text: "raw chunk text", similarity: 0.7 },
			{ id: "bare_3", text: "", similarity: 0.6 },
		]);
	});

	it("returns no hits when the response has no results field", async () => {
		const { client } = clientFor(jsonResponse({}));

		expect(await client.search("indent", "omp_user_abc")).toEqual([]);
	});

	it("throws a SupermemoryError carrying the HTTP status and server message on non-2xx", async () => {
		const { client } = clientFor(jsonResponse({ error: "invalid api key" }, 401));

		const error = await failureOf(client.search("indent", "omp_user_abc"));

		expect(error.status).toBe(401);
		expect(error.message).toContain("invalid api key");
	});

	it("wraps transport failures in a SupermemoryError without a status", async () => {
		const { client } = clientFor();

		const error = await failureOf(client.search("indent", "omp_user_abc"));

		expect(error.status).toBeUndefined();
		expect(error.message).toContain("no response queued");
	});
});

describe("SupermemoryClient.profile", () => {
	it("posts the container tag and optional query, returning static and dynamic facts", async () => {
		const { client, requests } = clientFor(
			jsonResponse({ profile: { static: ["Uses tabs"], dynamic: ["Working on the memory backend"] } }),
		);

		const profile = await client.profile("omp_project_demo_abc", "what is in progress");

		expect(profile).toEqual({ static: ["Uses tabs"], dynamic: ["Working on the memory backend"] });
		expect(requests).toEqual([
			{
				method: "POST",
				url: "https://api.supermemory.test/v4/profile",
				headers: AUTH_HEADERS,
				body: { containerTag: "omp_project_demo_abc", q: "what is in progress" },
			},
		]);
	});

	it("omits the query when not given and returns empty lists for a missing profile", async () => {
		const { client, requests } = clientFor(jsonResponse({}));

		const profile = await client.profile("omp_project_demo_abc");

		expect(profile).toEqual({ static: [], dynamic: [] });
		expect(requests[0]?.body).toStrictEqual({ containerTag: "omp_project_demo_abc" });
	});
});

describe("SupermemoryClient.add", () => {
	it("posts the document with its custom id and metadata, returning the new id", async () => {
		const { client, requests } = clientFor(jsonResponse({ id: "doc_9", status: "queued" }));

		const added = await client.add("User prefers tabs", "omp_user_abc", {
			customId: "session-42",
			metadata: { source: "omp", turns: 3, final: false },
		});

		expect(added).toEqual({ id: "doc_9" });
		expect(requests).toEqual([
			{
				method: "POST",
				url: "https://api.supermemory.test/v3/documents",
				headers: AUTH_HEADERS,
				body: {
					content: "User prefers tabs",
					containerTag: "omp_user_abc",
					customId: "session-42",
					metadata: { source: "omp", turns: 3, final: false },
				},
			},
		]);
	});

	it("sends only content and container tag when there are no options", async () => {
		const { client, requests } = clientFor(jsonResponse({ id: "doc_10" }));

		await client.add("note", "omp_user_abc");

		expect(requests[0]?.body).toStrictEqual({ content: "note", containerTag: "omp_user_abc" });
	});

	it("throws a SupermemoryError carrying the HTTP status on non-2xx", async () => {
		const { client } = clientFor(jsonResponse({ error: "quota exceeded" }, 429));

		const error = await failureOf(client.add("note", "omp_user_abc"));

		expect(error.status).toBe(429);
	});
});

describe("SupermemoryClient.forget", () => {
	it("deletes the memory by id and container tag", async () => {
		const { client, requests } = clientFor(new Response(null, { status: 204 }));

		await client.forget("mem_1", "omp_user_abc");

		expect(requests).toEqual([
			{
				method: "DELETE",
				url: "https://api.supermemory.test/v4/memories",
				headers: AUTH_HEADERS,
				body: { id: "mem_1", containerTag: "omp_user_abc" },
			},
		]);
	});

	it("falls back to deleting the document when the id is not a memory (404)", async () => {
		const { client, requests } = clientFor(
			jsonResponse({ error: "memory not found" }, 404),
			new Response(null, { status: 204 }),
		);

		await client.forget("chunk/7", "omp_user_abc");

		expect(requests).toEqual([
			{
				method: "DELETE",
				url: "https://api.supermemory.test/v4/memories",
				headers: AUTH_HEADERS,
				body: { id: "chunk/7", containerTag: "omp_user_abc" },
			},
			{
				method: "DELETE",
				url: "https://api.supermemory.test/v3/documents/chunk%2F7",
				headers: AUTH_HEADERS,
				body: undefined,
			},
		]);
	});

	it("does not retry as a document delete when the failure is not a 404", async () => {
		const { client, requests } = clientFor(jsonResponse({ error: "boom" }, 500));

		const error = await failureOf(client.forget("mem_1", "omp_user_abc"));

		expect(error.status).toBe(500);
		expect(requests).toHaveLength(1);
	});

	it("throws when the document fallback fails too", async () => {
		const { client } = clientFor(jsonResponse({}, 404), jsonResponse({ error: "document not found" }, 404));

		const error = await failureOf(client.forget("gone", "omp_user_abc"));

		expect(error.status).toBe(404);
		expect(error.message).toContain("/v3/documents/gone");
	});
});
