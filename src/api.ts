export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const body = await response.text();
  if (response.status === 404) throw new Error('The running backend does not have this API route. Restart the app with start.cmd or npm run dev to load the current backend.');
  if (!body) throw new Error(`FastAPI returned an empty response (${response.status}). Check port 3001.`);
  let value: any;
  try { value = JSON.parse(body); } catch { throw new Error(`FastAPI returned invalid JSON (${response.status}).`); }
  if (!response.ok) {
    const detail = Array.isArray(value.detail) ? value.detail.map((e: {msg: string})=>e.msg).join('; ') : value.detail;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return value as T;
}
