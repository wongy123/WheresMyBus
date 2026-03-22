import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiFetch } from '../api.js';
import RouteBadge from '../components/RouteBadge.jsx';

export default function RouteDetail() {
  const { routeId } = useParams();
  const [route, setRoute] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch(`routes/${routeId}`)
      .then(setRoute)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [routeId]);

  if (loading) return <p className="text-gray-500">Loading…</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!route) return null;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <RouteBadge route={route} />
        <h1 className="text-2xl font-bold">{route.route_long_name}</h1>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-6 max-w-sm">
        <dt className="text-gray-500">Route ID</dt>
        <dd className="font-mono">{route.route_id}</dd>
        {route.route_desc && (
          <>
            <dt className="text-gray-500">Description</dt>
            <dd>{route.route_desc}</dd>
          </>
        )}
      </dl>

      <Link
        to={`/timetable/route/${route.route_id}`}
        className="inline-block bg-blue-700 text-white px-4 py-2 rounded hover:bg-blue-800 text-sm"
      >
        View Timetable
      </Link>
    </div>
  );
}
