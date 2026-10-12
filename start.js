/* Start-up wrapper: runs the original server unchanged, then adds the Astris route.
 * If the add-on ever fails to load, the original server keeps running exactly as before. */
const app = require('./server');
try { require('./astris-route')(app); console.log('Astris route loaded'); } catch (e) { console.error('Astris route NOT loaded:', e.message); }
