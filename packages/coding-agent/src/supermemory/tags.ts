/**
 * Supermemory container tags. A tag is the only scoping primitive the API offers, so the user tag
 * holds cross-project preferences and the project tag holds repo-local facts.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

/** Per-OS-user tag, stable across projects. */
export function supermemoryUserTag(): string {
	const digest = new Bun.CryptoHasher("sha256").update(os.userInfo().username).digest("hex");
	return `omp_user_${digest.slice(0, 16)}`;
}

/**
 * Per-repository tag. Every linked worktree resolves to the primary checkout root, so they share
 * one tag; outside a repository the resolved `cwd` stands in for the root.
 */
export function supermemoryProjectTag(cwd: string): string {
	const root = vcs.repo(cwd)?.primaryRoot() ?? path.resolve(cwd);
	const name = path
		.basename(root)
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "_");
	const digest = new Bun.CryptoHasher("sha256").update(root).digest("hex");
	return `omp_project_${name}_${digest.slice(0, 16)}`;
}
