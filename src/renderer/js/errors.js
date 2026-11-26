// Collects uncaught errors so they show up in development screenshots and DevTools.
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message) + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => window.__errors.push('promise: ' + String(e.reason && (e.reason.stack || e.reason.message) || e.reason)));
