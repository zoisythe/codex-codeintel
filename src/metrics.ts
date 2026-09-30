const samples = new Map<string, number[]>();
export async function measured<T>(name: string, action: () => Promise<T>): Promise<T> {
	const start = performance.now();
	try {
		return await action();
	} finally {
		const values = samples.get(name) ?? [];
		values.push(performance.now() - start);
		if (values.length > 128) values.shift();
		samples.set(name, values);
	}
}
export function timings(): unknown {
	return Object.fromEntries(
		[...samples].map(([name, values]) => {
			const sorted = [...values].sort((a, b) => a - b);
			return [
				name,
				{
					count: values.length,
					medianMs: sorted[Math.floor(sorted.length / 2)],
					p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
				},
			];
		}),
	);
}
