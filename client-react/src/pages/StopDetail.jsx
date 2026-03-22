import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiFetch } from '../api.js';

export default function StopDetail() {
  const { stopId } = useParams();
  const [stop, setStop] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch(`stops/${stopId}`)
      .then(setStop)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [stopId]);

  if (loading) return <p className="text-gray-500">Loading…</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!stop) return null;

  return (
    <div>
      <div className="mb-1 text-gray-400 text-sm font-mono">{stop.stop_id}</div>
      <h1 className="text-2xl font-bold mb-4">{stop.stop_name}</h1>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-6 max-w-sm">
        {stop.stop_code && (
          <>
            <dt className="text-gray-500">Code</dt>
            <dd>{stop.stop_code}</dd>
          </>
        )}
        {stop.stop_lat && (
          <>
            <dt className="text-gray-500">Location</dt>
            <dd>
              {stop.stop_lat}, {stop.stop_lon}
            </dd>
          </>
        )}
      </dl>

      <Link
        to={`/timetable/stop/${stop.stop_id}`}
        className="inline-block bg-blue-700 text-white px-4 py-2 rounded hover:bg-blue-800 text-sm"
      >
        View Timetable
      </Link>
    </div>
  );
}
