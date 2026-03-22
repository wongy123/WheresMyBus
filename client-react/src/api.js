const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

export async function apiFetch(path, params = {}) {
  const url = new URL(`${BASE_URL}/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, v);
    }
  });
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}
