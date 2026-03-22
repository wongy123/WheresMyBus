import { useState, useEffect } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { apiFetch } from '../api.js';
import RouteBadge from '../components/RouteBadge.jsx';
import DelayBadge from '../components/DelayBadge.jsx';
import Pagination from '../components/Pagination.jsx';

const DURATION_OPTIONS = [30, 60, 90, 120];

export default function RouteTimetable() {
  const { routeId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = parseInt(searchParams.get('page') || '1', 10);
  const duration = parseInt(searchParams.get('duration') || '60', 10);
  const limit = parseInt(searchParams.get('limit') || '20', 10);
  const direction = parseInt(searchParams.get('direction') || '0', 10);

  const [data, setData] = useState(null);
  const [route, setRoute] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiFetch(`routes/${routeId}`).then(setRoute).catch(() => {});
  }, [routeId]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch(`routes/${routeId}/upcoming`, { page, limit, duration, direction })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [routeId, page, limit, duration, direction]);

  function setParam(key, value) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    if (key !== 'page') next.set('page', '1');
    setSearchParams(next);
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {route && <RouteBadge route={route} />}
        <h1 className="text-2xl font-bold">
          {route?.route_long_name || routeId} — Timetable
        </h1>
        <Link
          to={`/routes/${routeId}`}
          className="ml-auto text-sm text-blue-600 hover:underline"
        >
          Route info
        </Link>
      </div>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-sm text-gray-600">Direction:</label>
        <button
          onClick={() => setParam('direction', 0)}
          className={`px-3 py-1 rounded border text-sm ${
            direction === 0
              ? 'bg-blue-700 text-white border-blue-700'
              : 'border-gray-300 hover:bg-gray-100'
          }`}
        >
          Outbound (0)
        </button>
        <button
          onClick={() => setParam('direction', 1)}
          className={`px-3 py-1 rounded border text-sm ${
            direction === 1
              ? 'bg-blue-700 text-white border-blue-700'
              : 'border-gray-300 hover:bg-gray-100'
          }`}
        >
          Inbound (1)
        </button>

        <span className="text-gray-300">|</span>

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
                  <th className="py-2 pr-4">Stop</th>
                  <th className="py-2 pr-4">Headsign</th>
                  <th className="py-2 pr-4">Leg</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((trip, i) => (
                  <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 pr-4 font-mono text-xs">
                      {trip.estimated_departure || trip.scheduled_departure}
                    </td>
                    <td className="py-2 pr-4">
                      <Link
                        to={`/stops/${trip.stop_id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {trip.stop_name || trip.stop_id}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{trip.trip_headsign}</td>
                    <td className="py-2 pr-4 text-xs text-gray-500">
                      {trip.stop_sequence != null ? `Stop ${trip.stop_sequence}` : ''}
                    </td>
                    <td className="py-2">
                      <DelayBadge delay={trip.delay} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.data.length === 0 && (
            <p className="text-gray-500 text-sm mt-4">No trips in this window.</p>
          )}
          <Pagination page={page} totalPages={data.pagination?.pageCount || 1} />
        </>
      )}
    </div>
  );
}
