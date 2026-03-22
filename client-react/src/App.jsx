import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Home from './pages/Home.jsx';
import StopsIndex from './pages/StopsIndex.jsx';
import StopDetail from './pages/StopDetail.jsx';
import RoutesIndex from './pages/RoutesIndex.jsx';
import RouteDetail from './pages/RouteDetail.jsx';
import TimetableIndex from './pages/TimetableIndex.jsx';
import StopTimetable from './pages/StopTimetable.jsx';
import RouteTimetable from './pages/RouteTimetable.jsx';

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.VITE_BASE_PATH || '/'}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/stops" element={<StopsIndex />} />
          <Route path="/stops/:stopId" element={<StopDetail />} />
          <Route path="/routes" element={<RoutesIndex />} />
          <Route path="/routes/:routeId" element={<RouteDetail />} />
          <Route path="/timetable" element={<TimetableIndex />} />
          <Route path="/timetable/stop/:stopId" element={<StopTimetable />} />
          <Route path="/timetable/route/:routeId" element={<RouteTimetable />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
