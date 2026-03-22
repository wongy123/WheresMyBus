import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SearchInput from '../components/SearchInput.jsx';

export default function TimetableIndex() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Timetable</h1>
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="font-semibold mb-3">By Stop</h2>
          <SearchInput type="stop" placeholder="Search stops…" />
          <p className="text-xs text-gray-400 mt-2">Select a stop to view upcoming departures</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="font-semibold mb-3">By Route</h2>
          <SearchInput type="route" placeholder="Search routes…" />
          <p className="text-xs text-gray-400 mt-2">Select a route to view upcoming trips</p>
        </div>
      </div>
    </div>
  );
}
