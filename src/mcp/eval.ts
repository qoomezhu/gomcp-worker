export function getEvaluateValue<T = unknown>(response: any): T | undefined {
  return response?.result?.result?.value as T | undefined;
}
