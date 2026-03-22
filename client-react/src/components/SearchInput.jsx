import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api.js';

export default function SearchInput({ type, placeholder }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (query.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const endpoint = type === 'stop' ? 'stops/search' : 'routes/search';
        const data = await apiFetch(endpoint, { q: query });
        setSuggestions(data.data || []);
        setOpen(true);
      } catch {
        setSuggestions([]);
      }
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [query, type]);

  function handleSelect(item) {
    setOpen(false);
    setQuery('');
    if (type === 'stop') {
      navigate(`/stops/${item.stop_id}`);
    } else {
      navigate(`/routes/${item.route_id}`);
    }
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder || (type === 'stop' ? 'Search stops…' : 'Search routes…')}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-10 w-full bg-white border border-gray-200 rounded shadow mt-1 max-h-60 overflow-y-auto">
          {suggestions.map((item) => {
            const id = type === 'stop' ? item.stop_id : item.route_id;
            const label =
              type === 'stop'
                ? `${item.stop_id} — ${item.stop_name}`
                : `${item.route_short_name || item.route_id} — ${item.route_long_name || ''}`;
            return (
              <li
                key={id}
                onMouseDown={() => handleSelect(item)}
                className="px-3 py-2 text-sm cursor-pointer hover:bg-blue-50"
              >
                {label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
