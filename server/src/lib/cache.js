// src/lib/cache.js
import Memcached from 'memcached';

const endpoint = process.env.MEMCACHED_ENDPOINT || '';
const ttlDefault = Number(process.env.MEMCACHED_TTL_SECONDS || 20);

let mem = null;
if (endpoint) {
    mem = new Memcached(endpoint, {
        retries: 1,
        retry: 1000,
        timeout: 1000,
        remove: true,
    });
    mem.on('failure', (details) => {
        console.warn('[memcached] failure:', details.server, details.messages);
    });
}

const get = (key) =>
    new Promise((resolve) => {
        if (!mem) return resolve(null);
        mem.get(key, (err, data) => {
            if (err || data == null) return resolve(null);
            try {
                // If we stored JSON, parse; if not JSON, just return raw
                if (typeof data === 'string') {
                    return resolve(JSON.parse(data));
                }
                if (Buffer.isBuffer(data)) {
                    return resolve(JSON.parse(data.toString('utf8')));
                }
                // some clients already give back the original object
                return resolve(data);
            } catch {
                return resolve(data);
            }
        });
    });

const set = (key, value, ttl = ttlDefault) =>
    new Promise((resolve) => {
        if (!mem) return resolve(false);
        let body;
        try {
            body = JSON.stringify(value);
        } catch {
            body = String(value);
        }
        mem.set(key, body, ttl, (err) => {
            if (err) {
                console.warn('[memcached] set failed:', { key, err: String(err) });
                return resolve(false);
            }
            resolve(true);
        });
    });


export const cache = {
    enabled: !!mem,
    ttl: ttlDefault,
    get,
    set,
};
