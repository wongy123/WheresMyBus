import { getAllRoutes, getOneRoute} from './src/services/gtfsQueries.js';

// Example usage of getAllRoutes
getAllRoutes().then(routes => {
    console.log(routes);
}).catch(err => {
    console.error('Error fetching all routes:', err);
});

// Example usage of getOneRoute
getOneRoute('60').then(route => {
    console.log(route);
}).catch(err => {
    console.error('Error fetching route 100:', err);
});