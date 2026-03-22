import { Link } from 'react-router-dom';

const features = [
  {
    to: '/stops',
    title: 'Stops',
    description: 'Search for bus stops by name or ID.',
  },
  {
    to: '/routes',
    title: 'Routes',
    description: 'Browse and search bus routes.',
  },
  {
    to: '/timetable',
    title: 'Timetable',
    description: 'View upcoming departures for a stop or route.',
  },
];

export default function Home() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">Where's My Bus?</h1>
      <p className="text-gray-600 mb-8">Real-time Translink bus information.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        {features.map((f) => (
          <Link
            key={f.to}
            to={f.to}
            className="block p-5 bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-400 transition"
          >
            <h2 className="text-lg font-semibold mb-1">{f.title}</h2>
            <p className="text-gray-500 text-sm">{f.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
