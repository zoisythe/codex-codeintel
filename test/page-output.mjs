// Reconstruct documented field fragments for assertions; production callers may
// simply consume each bounded page without reconstructing the entire payload.
export async function completeOutput(first, nextPage) {
	if (!first?.structuredContent?.paged) return first;
	const output = {};
	let page = first;
	for (;;) {
		const data = page.structuredContent;
		for (const [key, value] of Object.entries(data)) if (!["items", "total", "next", "paged"].includes(key)) output[key] = value;
		for (const item of data.items) {
			const path = [];
			for (const match of item.field.slice("result".length).matchAll(/\[("(?:\\.|[^"\\])*"|\d+)\]/g)) path.push(JSON.parse(match[1]));
			if (!path.length) { Object.assign(output, item.value); continue; }
			let target = output;
			for (let index = 0; index < path.length - 1; index++) target = target[path[index]] ??= typeof path[index + 1] === "number" ? [] : {};
			const key = path.at(-1);
			if ("text" in item) target[key] = (target[key] ?? "") + item.text;
			else target[key] = item.value;
		}
		if (!data.next || !/^(view|detail):/.test(String(data.next.cursor))) {
			if (data.next) output.next = data.next;
			return { ...first, structuredContent: output };
		}
		page = await nextPage(data.next);
		if (page.isError && !page.structuredContent?.paged) return page;
	}
}
