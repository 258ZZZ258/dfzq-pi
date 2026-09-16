/** Offline binary checklist. Labels must be authored independently, never inferred from predictions. */
export interface ComparisonLabel {
	previousId: string;
	currentId: string;
	sameProblem: boolean;
}

export function evaluateComparisonLabels(labels: readonly ComparisonLabel[], predictions: readonly ComparisonLabel[]) {
	if (!labels.length) throw new Error("Independent labels are required");
	const key = (row: ComparisonLabel) => JSON.stringify([row.previousId, row.currentId]);
	if (new Set(labels.map(key)).size !== labels.length) throw new Error("Duplicate independent labels");
	const items = labels.map((label) => {
		const matches = predictions.filter((row) => key(row) === key(label));
		return { ...label, value: matches.length === 1 && matches[0]!.sameProblem === label.sameProblem ? 1 : 0 };
	});
	const unexpected = predictions.filter((row) => !labels.some((label) => key(label) === key(row)));
	const passed = items.filter((item) => item.value === 1).length;
	return { items, passed, total: items.length, unexpected, accepted: passed === items.length && !unexpected.length };
}
