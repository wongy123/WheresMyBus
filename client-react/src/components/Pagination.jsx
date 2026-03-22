import { Link, useSearchParams } from 'react-router-dom';

export default function Pagination({ page, totalPages }) {
  const [searchParams] = useSearchParams();

  function pageUrl(p) {
    const params = new URLSearchParams(searchParams);
    params.set('page', p);
    return `?${params.toString()}`;
  }

  if (totalPages <= 1) return null;

  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    pages.push(i);
  }

  return (
    <nav className="flex items-center gap-1 mt-4">
      {page > 1 && (
        <Link to={pageUrl(page - 1)} className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-100 text-sm">
          ← Prev
        </Link>
      )}
      {pages.map((p) => (
        <Link
          key={p}
          to={pageUrl(p)}
          className={`px-3 py-1 rounded border text-sm ${
            p === page
              ? 'bg-blue-700 text-white border-blue-700'
              : 'border-gray-300 hover:bg-gray-100'
          }`}
        >
          {p}
        </Link>
      ))}
      {page < totalPages && (
        <Link to={pageUrl(page + 1)} className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-100 text-sm">
          Next →
        </Link>
      )}
    </nav>
  );
}
