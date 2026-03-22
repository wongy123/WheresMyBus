import { delayInfo } from '../utils/delay.js';

const statusClasses = {
  scheduled: 'bg-gray-100 text-gray-600',
  ontime: 'bg-green-100 text-green-800',
  late: 'bg-yellow-100 text-yellow-800',
  early: 'bg-blue-100 text-blue-800',
};

export default function DelayBadge({ delay }) {
  const { status, label } = delayInfo(delay);
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusClasses[status]}`}>
      {label}
    </span>
  );
}
