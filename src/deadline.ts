// Detach a waiter without cancelling the operation owned by the service.
export function waitWithSignal<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
