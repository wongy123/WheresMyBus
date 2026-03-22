import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api.js';

export default function StopsIndex() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch('stops/search', { q: query });
        setResults(data.data || []);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Stops</h1>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by stop name or ID…"
        className="w-full border border-gray-300 rounded px-3 py-2 mb-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {loading && <p className="text-gray-500 text-sm">Searching…</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {results.length > 0 && (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded bg-white">
          {results.map((stop) => (
            <li key={stop.stop_id}>
              <Link
                to={`/stops/${stop.stop_id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-blue-50"
              >
                <span className="text-gray-400 text-xs font-mono w-14 shrink-0">{stop.stop_id}</span>
                <span className="text-sm">{stop.stop_name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {query.length >= 2 && !loading && results.length === 0 && (
        <p className="text-gray-500 text-sm">No stops found.</p>
      )}
    </div>
  );
}
