/** Reject known title-only placeholders; this is not proof that other facts are sufficient. */
export function isTitleOnlyFact(text: string, title: string): boolean {
	const normalize = (value: string) => value.replace(/[\s，。：“”「」『』、,.:;；"']/gu, "");
	const fact = normalize(text);
	const heading = normalize(title);
	if (!fact) return true;
	if (!heading) return false;
	const remainder = fact
		.replace(/^(?:(?:上一次|上次|前次|本次)?审计发现)?(?:营业部)?(?:存在)?/u, "")
		.replace(/问题$/u, "");
	return fact === heading || remainder === heading.replace(/问题$/u, "");
}
