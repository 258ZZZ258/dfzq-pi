/** Attempt all independently owned resources, including after synchronous failures.
 * Concurrent/repeated callers observe the same completion (and the same failure).
 * Each resource must provide its own bounded cleanup; this does not kill arbitrary JS.
 */
export function disposeOnce(actions: Array<() => void | Promise<void>>): () => Promise<void> {
	let completion: Promise<void> | undefined;
	return () => {
		completion ??= Promise.resolve().then(async () => {
			const settled = await Promise.allSettled(actions.map((action) => Promise.resolve().then(action)));
			const failures = settled.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Multiple resource cleanups failed");
		});
		return completion;
	};
}
