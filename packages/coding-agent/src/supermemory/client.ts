/**
 * Minimal Supermemory REST client: hybrid search, profile, document upsert and delete.
 * Hand-rolled over `fetch` so the transport is injectable in tests.
 */
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const DEFAULT_TIMEOUT_MS = 15_000;

export interface SupermemoryHit {
	id: string;
	/** Source document of the hit; the only id `/v3/documents/{id}` accepts when a chunk hit is forgotten. */
	documentId?: string;
	text: string;
	similarity: number;
	updatedAt?: string;
}

export class SupermemoryError extends Error {
	status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "SupermemoryError";
		this.status = status;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal?.aborted) {
		reject(signal.reason);
		return promise;
	}
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal!.reason);
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

interface SearchResponse {
	results?: {
		id: string;
		memory?: string;
		chunk?: string;
		similarity: number;
		updatedAt?: string;
		documents?: { id: string }[];
	}[];
}

interface ProfileResponse {
	profile?: { static?: string[]; dynamic?: string[] };
}

export class SupermemoryClient {
	readonly #apiKey: string;
	readonly #apiUrl: string;
	readonly #fetch: typeof fetch | undefined;
	readonly #timeoutMs: number;
	readonly #retryDelaysMs: number[];

	constructor(opts: {
		apiKey: string;
		apiUrl: string;
		fetch?: typeof fetch;
		timeoutMs?: number;
		retryDelaysMs?: number[];
	}) {
		this.#apiKey = opts.apiKey;
		this.#apiUrl = opts.apiUrl.replace(/\/+$/, "");
		this.#fetch = opts.fetch;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	}

	/** Hybrid (memory + document chunk) search inside one container tag. */
	async search(
		q: string,
		containerTag: string,
		opts: { limit?: number; threshold?: number; signal?: AbortSignal } = {},
	): Promise<SupermemoryHit[]> {
		const response = await this.#request<SearchResponse>(
			"POST",
			"/v4/search",
			{ q, containerTag, limit: opts.limit, threshold: opts.threshold, searchMode: "hybrid" },
			opts.signal,
		);
		return (response.results ?? []).map(result => ({
			id: result.id,
			documentId: result.documents?.[0]?.id,
			text: result.memory ?? result.chunk ?? "",
			similarity: result.similarity,
			updatedAt: result.updatedAt,
		}));
	}

	async profile(
		containerTag: string,
		q?: string,
		signal?: AbortSignal,
	): Promise<{ static: string[]; dynamic: string[] }> {
		const response = await this.#request<ProfileResponse>("POST", "/v4/profile", { containerTag, q }, signal);
		return { static: response.profile?.static ?? [], dynamic: response.profile?.dynamic ?? [] };
	}

	/** Ingest a document; a repeated `customId` replaces the earlier document instead of duplicating it. */
	async add(
		content: string,
		containerTag: string,
		opts: { customId?: string; metadata?: Record<string, string | number | boolean>; signal?: AbortSignal } = {},
	): Promise<{ id: string }> {
		const response = await this.#request<{ id: string }>(
			"POST",
			"/v3/documents",
			{ content, containerTag, customId: opts.customId, metadata: opts.metadata },
			opts.signal,
		);
		return { id: response.id };
	}

	/**
	 * Delete a memory. Hybrid search also returns document chunks whose id is not a memory id:
	 * the memory endpoint answers those with 404, so retry as a document delete.
	 * A 409 means the server is still processing the document; the delete is retried with backoff.
	 */
	async forget(id: string, containerTag: string, signal?: AbortSignal): Promise<void> {
		try {
			await this.#deleteRetrying409("/v4/memories", { id, containerTag }, signal);
		} catch (err) {
			if (!(err instanceof SupermemoryError) || err.status !== 404) throw err;
			await this.#deleteRetrying409(`/v3/documents/${encodeURIComponent(id)}`, undefined, signal);
		}
	}

	async #deleteRetrying409(path: string, body: unknown, signal?: AbortSignal): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			try {
				await this.#request("DELETE", path, body, signal);
				return;
			} catch (err) {
				if (!(err instanceof SupermemoryError) || err.status !== 409 || attempt >= this.#retryDelaysMs.length)
					throw err;
			}
			await sleep(this.#retryDelaysMs[attempt]!, signal);
		}
	}

	async #request<T>(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
		const init: RequestInit = {
			method,
			headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
			signal: withTimeoutSignal(this.#timeoutMs, signal),
		};
		if (body !== undefined) init.body = JSON.stringify(body);

		let response: Response;
		try {
			response = await (this.#fetch ?? fetch)(`${this.#apiUrl}${path}`, init);
		} catch (err) {
			const reason = isTimeoutError(err)
				? `timed out after ${Math.round(this.#timeoutMs / 1000)}s`
				: err instanceof Error
					? err.message
					: String(err);
			throw new SupermemoryError(`${method} ${path} failed: ${reason}`);
		}

		const text = await response.text();
		if (!response.ok) {
			throw new SupermemoryError(`${method} ${path} failed (${response.status}): ${text}`, response.status);
		}
		return (text ? JSON.parse(text) : {}) as T;
	}
}
