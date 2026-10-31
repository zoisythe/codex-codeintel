export function supportsNode(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) return false;
	const major = Number(match[1]),
		minor = Number(match[2]);
	return (major === 24 && minor >= 20) || (major === 26 && minor >= 13);
}
