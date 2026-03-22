import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api.js';
import RouteBadge from '../components/RouteBadge.jsx';

export default function RoutesIndex() {
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
        const data = await apiFetch('routes/search', { q: query });
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
      <h1 className="text-2xl font-bold mb-4">Routes</h1>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by route number or name…"
        className="w-full border border-gray-300 rounded px-3 py-2 mb-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {loading && <p className="text-gray-500 text-sm">Searching…</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {results.length > 0 && (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded bg-white">
          {results.map((route) => (
            <li key={route.route_id}>
              <Link
                to={`/routes/${route.route_id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-blue-50"
              >
                <RouteBadge route={route} />
                <span className="text-sm">{route.route_long_name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {query.length >= 2 && !loading && results.length === 0 && (
        <p className="text-gray-500 text-sm">No routes found.</p>
      )}
    </div>
  );
}
