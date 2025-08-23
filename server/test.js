import { getAllRoutes, getOneRoute, getAllStops, getOneStop, getAllStopTimeUpdates } from './src/services/gtfsQueries.js';

// Example usage of getAllRoutes
getAllRoutes("15").then(routes => {
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

// Example usage of getAllStops
getAllStops("Calamvale").then(stops => {
    console.log(stops);
}).catch(err => {
    console.error('Error fetching all stops:', err);
}); 

/* // Example usage of getOneStop
getOneStop('999').then(stop => {
    console.log(stop);
}).catch(err => {
    console.error('Error fetching stop:', err);
}); */

/* // Example usage of getOneStop
getOneStop('place_qsbs').then(stop => {
    console.log(stop);
}).catch(err => {
    console.error('Error fetching stop:', err);
}); */

/* getAllStopTimeUpdates().then(stopTimeUpdates => {
    console.log(stopTimeUpdates);
}).catch(err => {
    console.error('Error fetching all stop time updates:', err);
}); */
