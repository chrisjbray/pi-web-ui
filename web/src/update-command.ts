/**
 * Build the chained shell command for updating pi components in a visible
 * terminal tab. The command depends on WHERE each component lives:
 *
 * - "package" (pi extensions, installed under <agentDir>/npm — e.g.
 *   ~/.pi/agent/npm): `pi update npm:<name>` is the ONLY command that updates
 *   the copy pi actually loads. A bare `npm i -g` installs to the npm global
 *   root instead, leaving the checked copy stale — the next update check would
 *   still report an update (the bug this kind split fixes).
 * - "git-extension" (git-source pi extensions, cloned under <agentDir>/git):
 *   `pi update git:<host>/<path>` — bare `<host>/<path>` fails (P1 TODO 14).
 * - "pi-core" / "webui" (globally installed via npm): `npm i -g <name>@latest`.
 *
 * Multiple targets are joined with `;` so a failing step never blocks the
 * rest. Pure — unit-tested.
 */
export interface UpdateTarget {
	name: string;
	kind: "webui" | "pi-core" | "package" | "git-extension";
	/** git-extension only: `host/path` shorthand; update with `pi update git:<host/path>` (bare fails). */
	source?: string;
}

export function buildUpdateCommand(targets: UpdateTarget[]): string {
	return targets
		.map((t) =>
			t.kind === "package"
				? `pi update npm:${t.name}`
				: t.kind === "git-extension"
					? `pi update git:${(t.source ?? t.name).replace(/^git:/, "")}`
					: `npm i -g ${t.name}@latest`,
		)
		.join("; ");
}
