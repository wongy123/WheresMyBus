export async function geocodeSearch(req, res, next) {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ data: [] });
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&countrycodes=au&limit=5&addressdetails=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'WheresMyBus/1.0' },
    });
    const raw = await resp.json();
    const data = raw.map(r => ({
      display_name: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
}
