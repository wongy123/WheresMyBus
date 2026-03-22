import { useState, useEffect } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { apiFetch } from '../api.js';
import RouteBadge from '../components/RouteBadge.jsx';
import DelayBadge from '../components/DelayBadge.jsx';
import Pagination from '../components/Pagination.jsx';

const DURATION_OPTIONS = [30, 60, 90, 120];

export default function StopTimetable() {
  const { stopId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = parseInt(searchParams.get('page') || '1', 10);
  const duration = parseInt(searchParams.get('duration') || '60', 10);
  const limit = parseInt(searchParams.get('limit') || '20', 10);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch(`stops/${stopId}/timetable`, { page, limit, duration })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [stopId, page, limit, duration]);

  function setParam(key, value) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    if (key !== 'page') next.set('page', '1');
    setSearchParams(next);
  }

  return (
    <div>
      <div className="mb-1 text-gray-400 text-sm font-mono">{stopId}</div>
      <h1 className="text-2xl font-bold mb-4">
        {data?.stop_name || stopId} — Timetable
      </h1>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-sm text-gray-600">Window:</label>
        {DURATION_OPTIONS.map((d) => (
          <button
            key={d}
            onClick={() => setParam('duration', d)}
            className={`px-3 py-1 rounded border text-sm ${
              duration === d
                ? 'bg-blue-700 text-white border-blue-700'
                : 'border-gray-300 hover:bg-gray-100'
            }`}
          >
            {d} min
          </button>
        ))}
        <Link
          to={`/stops/${stopId}`}
          className="ml-auto text-sm text-blue-600 hover:underline"
        >
          Stop info
        </Link>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading…</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}

      {data && data.data && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="py-2 pr-4">Time</th>
                  <th className="py-2 pr-4">Route</th>
                  <th className="py-2 pr-4">Headsign</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((dep, i) => (
                  <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 pr-4 font-mono text-xs">
                      {dep.estimated_departure || dep.scheduled_departure}
                    </td>
                    <td className="py-2 pr-4">
                      {dep.route ? <RouteBadge route={dep.route} /> : dep.route_id}
                    </td>
                    <td className="py-2 pr-4">{dep.trip_headsign}</td>
                    <td className="py-2">
                      <DelayBadge delay={dep.delay} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.data.length === 0 && (
            <p className="text-gray-500 text-sm mt-4">No departures in this window.</p>
          )}
          <Pagination page={page} totalPages={data.pagination?.pageCount || 1} />
        </>
      )}
    </div>
  );
}
