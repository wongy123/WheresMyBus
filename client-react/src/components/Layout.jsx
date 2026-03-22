import { Outlet, NavLink } from 'react-router-dom';

export default function Layout() {
  const linkClass = ({ isActive }) =>
    isActive
      ? 'text-white font-semibold underline'
      : 'text-blue-100 hover:text-white';

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <nav className="bg-blue-700 text-white px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center gap-6">
          <NavLink to="/" className="font-bold text-lg text-white">
            Where's My Bus
          </NavLink>
          <NavLink to="/stops" className={linkClass}>Stops</NavLink>
          <NavLink to="/routes" className={linkClass}>Routes</NavLink>
          <NavLink to="/timetable" className={linkClass}>Timetable</NavLink>
        </div>
      </nav>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
        <Outlet />
      </main>

      <footer className="bg-gray-200 text-gray-600 text-sm text-center py-3">
        Where's My Bus — Translink GTFS data
      </footer>
    </div>
  );
}
