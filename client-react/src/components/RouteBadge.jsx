export default function RouteBadge({ route }) {
  const bg = route.route_color ? `#${route.route_color}` : '#1d4ed8';
  const color = route.route_text_color ? `#${route.route_text_color}` : '#ffffff';

  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-xs font-bold"
      style={{ backgroundColor: bg, color }}
    >
      {route.route_short_name || route.route_id}
    </span>
  );
}
